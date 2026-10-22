import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, logger, slugify } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { expandAtImports } from "../discovery/at-imports";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { collectConfigCandidates } from "./watchdog";
import { registerDerivedSessionId } from "../session/request-session-ids";

import {
	ADVISOR_SYNC_BACKLOG_MODES,
	type AdvisorCategoryConfig,
	type AdvisorConfig,
	type AdvisorConfigScope,
	type AdvisorSyncBacklog,
	normalizeAdvisorCategoryEntry,
	type WatchdogConfigDoc,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";

export { ADVISOR_REVIEW_MODES, ADVISOR_SYNC_BACKLOG_MODES } from "@oh-my-pi/pi-tui/overlays/advisor-config";
export type {
	AdvisorCategoryConfig,
	AdvisorReviewMode,
	AdvisorSyncBacklog,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";

/**
 * Runtime health of a single advisor, surfaced in stats and the status line.
 * - `running` — actively processing primary turns
 * - `paused` — user-toggled off via per-advisor switch (runtime disposed)
 * - `quota_exhausted` — provider returned a quota/rate-limit error; the
 *   runtime auto-retries after a cooldown so it can resume without user action
 * - `error` — repeated transient failures; backlog dropped to prevent stall
 * - `no_model` — no model resolved for this advisor's role/explicit model
 */
export type AdvisorRuntimeStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";

/**
 * One category of the active finding taxonomy, with its owner resolved
 * against the roster.
 */
export interface AdvisorCategory {
	id: string;
	description: string;
	/** Owning advisor's configured name. */
	owner?: string;
	/** Rank among categories competing for one finding; higher leads. */
	precedence?: number;
	/** Set on entries of the bundled taxonomy ({@link DEFAULT_ADVISOR_CATEGORIES}). */
	bundled?: true;
}

/**
 * Taxonomy used when no discovered `WATCHDOG.yml` declares `categories`. An
 * `owner` applies only when the roster has an advisor of that name.
 */
export const DEFAULT_ADVISOR_CATEGORIES: readonly Readonly<AdvisorCategory>[] = [
	{ id: "logic", description: "Wrong behavior, logic errors, unhandled edge cases.", owner: "Correctness" },
	{
		id: "security",
		description: "Trust boundaries, injection, secrets, permissions.",
		owner: "Security",
		precedence: 1,
	},
	{
		id: "concurrency",
		description: "Races, ordering, cancellation, resource lifetimes, performance.",
		owner: "Performance and concurrency",
	},
	{
		id: "verification",
		description: "Missing, thin, or unexercised tests and checks; unverified claims.",
		owner: "Verification",
	},
	{ id: "docs", description: "Comments, docs, and changelogs out of step with behavior.", owner: "Documentation" },
	{
		id: "delivery",
		description: "Dependencies, versions, builds, CI, and release.",
		owner: "Dependencies and delivery",
	},
	{
		id: "migration",
		description: "Data and schema migrations, upgrades, rollback, and recovery.",
		owner: "Migration and recovery",
	},
	{ id: "ui", description: "Interface behavior, layout, and accessibility.", owner: "UI and accessibility" },
	{ id: "style", description: "Conventions, naming, formatting, and idioms.", owner: "Code style" },
	{
		id: "architecture",
		description: "Module boundaries, coupling, abstractions, and public APIs.",
		owner: "Architecture",
	},
];

/**
 * The result of walking the `WATCHDOG.yml`/`WATCHDOG.yaml` search path: the
 * deduped advisor roster plus the concatenated top-level `instructions` baseline
 * that is prepended (alongside `WATCHDOG.md`) to every advisor.
 */
export interface DiscoveredAdvisors {
	advisors: AdvisorConfig[];
	sharedInstructions: string | undefined;
	sharedMaxNotesPerUpdate?: number;
	/** Active finding taxonomy (see {@link resolveAdvisorCategories}). */
	categories: AdvisorCategory[];
	/**
	 * Human-readable config problems collected during the walk: unparseable
	 * files and dropped entries. Surfaced as one aggregated session warning so
	 * a broken roster entry never fails silently.
	 */
	warnings: string[];
}

const reviewIntervalSchema = type("1 <= number.integer <= 9007199254740991");
const syncBacklogSchema = type.enumerated(...ADVISOR_SYNC_BACKLOG_MODES);
/** Unquoted `syncBacklog: 3` parses as a number; accept the numeric thresholds alongside the string enum. */
const syncBacklogEntrySchema = type.enumerated(...ADVISOR_SYNC_BACKLOG_MODES, 1, 3, 5);
const SYNC_BACKLOG_NUMERIC_THRESHOLDS = { 1: "1", 3: "3", 5: "5" } as const;

function normalizeSyncBacklog(
	value: AdvisorSyncBacklog | keyof typeof SYNC_BACKLOG_NUMERIC_THRESHOLDS,
): AdvisorSyncBacklog {
	return typeof value === "number" ? SYNC_BACKLOG_NUMERIC_THRESHOLDS[value] : value;
}

const advisorEntrySchema = type({
	name: "string",
	"model?": "string",
	"tools?": "string[]",
	"reviewMode?": "'turn' | 'agent-end'",
	"reviewInterval?": reviewIntervalSchema,
	"syncBacklog?": syncBacklogEntrySchema,
	"instructions?": "string",
	"enabled?": "boolean",
	"maxNotesPerUpdate?": "number",
	"owns?": "string[]",
	"fallback?": "string",
	"budget?": type({
		"reservePct?": "0 <= number <= 100",
		"whenReserved?": "'fallback' | 'skip'",
	}),
});

type AdvisorYamlEntry = typeof advisorEntrySchema.infer;

const categoryEntrySchema = type({
	description: "string",
	"owner?": "string",
	"precedence?": "number",
});

/** Trimmed, non-empty, deduplicated `owns` ids; `undefined` stays `undefined`. */
function normalizeOwns(owns: readonly string[] | undefined): string[] | undefined {
	if (owns === undefined) return undefined;
	return [...new Set(owns.map(id => id.trim()).filter(id => id.length > 0))];
}

/**
 * Validate a document's `categories` mapping per entry. Returns `undefined`
 * when the key is absent or not a mapping; otherwise the valid entries
 * (possibly none), with trimmed descriptions and owners.
 */
function parseCategories(
	raw: unknown,
	path: string,
	warnings: string[],
): Map<string, AdvisorCategoryConfig> | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${path}: categories must be a mapping — ignored`);
		return undefined;
	}
	const categories = new Map<string, AdvisorCategoryConfig>();
	for (const [rawId, rawEntry] of Object.entries(raw)) {
		const result = categoryEntrySchema(rawEntry);
		if (result instanceof type.errors) {
			warnings.push(`${path}: category "${rawId}" dropped — ${result.summary}`);
			continue;
		}
		const normalized = normalizeAdvisorCategoryEntry(rawId, result);
		if ("error" in normalized) {
			warnings.push(`${path}: category "${rawId}" dropped — ${normalized.error}`);
			continue;
		}
		categories.set(normalized.id, normalized.category);
	}
	return categories;
}

/**
 * Validate one parsed `WATCHDOG.yml` document per entry instead of as a whole:
 * a single malformed advisor or category drops out with a warning naming it,
 * while the healthy entries still load. Also reports non-string
 * `instructions`, a non-list `advisors` key, and a non-mapping `categories` key.
 */
function parseWatchdogDoc(
	doc: Record<string, unknown>,
	path: string,
): {
	instructions: string | undefined;
	entries: AdvisorYamlEntry[];
	sharedMaxNotesPerUpdate: number | undefined;
	categories: Map<string, AdvisorCategoryConfig> | undefined;
	warnings: string[];
} {
	const warnings: string[] = [];
	const rawInstructions = doc.instructions;
	const instructions = typeof rawInstructions === "string" ? rawInstructions : undefined;
	if (rawInstructions !== undefined && instructions === undefined) {
		warnings.push(`${path}: instructions must be a string — ignored`);
	}
	const rawMaxNotes = doc.maxNotesPerUpdate;
	const sharedMaxNotesPerUpdate =
		typeof rawMaxNotes === "number" && Number.isFinite(rawMaxNotes) && rawMaxNotes >= 1
			? Math.trunc(rawMaxNotes)
			: undefined;
	const categories = parseCategories(doc.categories, path, warnings);
	const rawAdvisors = doc.advisors;
	if (rawAdvisors !== undefined && !Array.isArray(rawAdvisors)) {
		warnings.push(`${path}: advisors must be a list — ignored`);
	}
	const entries: AdvisorYamlEntry[] = [];
	for (const [index, rawEntry] of (Array.isArray(rawAdvisors) ? rawAdvisors : []).entries()) {
		const result = advisorEntrySchema(rawEntry);
		if (result instanceof type.errors) {
			const rawName =
				rawEntry && typeof rawEntry === "object" ? (rawEntry as Record<string, unknown>).name : undefined;
			const label = typeof rawName === "string" && rawName.trim() ? `"${rawName}"` : `#${index + 1}`;
			warnings.push(`${path}: advisor ${label} dropped — ${result.summary}`);
			continue;
		}
		entries.push(result);
	}
	return { instructions, entries, sharedMaxNotesPerUpdate, categories, warnings };
}

/**
 * Resolve the active finding taxonomy for a roster.
 *
 * `declared` is the merged `categories` of every discovered file, or
 * `undefined` when none declares the key; then {@link DEFAULT_ADVISOR_CATEGORIES}
 * apply, each default owner only when the roster has an advisor of that name.
 * A declared description is whitespace-collapsed; a declared `owner` resolves
 * to the roster advisor with the same slug (an unknown owner is warned and
 * kept). Each advisor's `owns` then claims ownerless categories in roster
 * order; claiming an unknown category, or one another advisor already owns, is
 * warned and ignored, so a category's own `owner` wins.
 */
export function resolveAdvisorCategories(
	declared: ReadonlyMap<string, AdvisorCategoryConfig> | undefined,
	advisors: readonly AdvisorConfig[],
): { categories: AdvisorCategory[]; warnings: string[] } {
	const rosterNames = new Map(advisors.map(advisor => [slugifyAdvisorName(advisor.name), advisor.name]));
	const categories = new Map<string, AdvisorCategory>();
	if (declared === undefined) {
		for (const { owner, ...category } of DEFAULT_ADVISOR_CATEGORIES) {
			const rosterOwner = owner === undefined ? undefined : rosterNames.get(slugifyAdvisorName(owner));
			categories.set(
				category.id,
				rosterOwner === undefined
					? { ...category, bundled: true }
					: { ...category, owner: rosterOwner, bundled: true },
			);
		}
	} else {
		for (const [id, config] of declared) {
			const category: AdvisorCategory = { id, description: config.description.trim().replace(/\s+/g, " ") };
			if (config.owner !== undefined) {
				category.owner = rosterNames.get(slugifyAdvisorName(config.owner)) ?? config.owner;
			}
			if (config.precedence !== undefined) category.precedence = config.precedence;
			categories.set(id, category);
		}
	}
	for (const advisor of advisors) {
		for (const id of advisor.owns ?? []) {
			const category = categories.get(id);
			if (category && category.owner === undefined) category.owner = advisor.name;
		}
	}
	const resolved = [...categories.values()];
	return { categories: resolved, warnings: advisorCategoryWarnings(resolved, advisors) };
}

/**
 * Owner-resolution warnings for a resolved taxonomy (see
 * {@link resolveAdvisorCategories}): a category owner that names no roster
 * advisor, then, per advisor in roster order, each `owns` id that is unknown
 * or owned by another advisor.
 */
export function advisorCategoryWarnings(
	categories: readonly AdvisorCategory[],
	advisors: readonly AdvisorConfig[],
): string[] {
	const warnings: string[] = [];
	const roster = new Set(advisors.map(advisor => slugifyAdvisorName(advisor.name)));
	for (const category of categories) {
		if (category.owner !== undefined && !roster.has(slugifyAdvisorName(category.owner))) {
			warnings.push(`category "${category.id}": owner "${category.owner}" is not a configured advisor`);
		}
	}
	const byId = new Map(categories.map(category => [category.id, category]));
	for (const advisor of advisors) {
		for (const id of advisor.owns ?? []) {
			const category = byId.get(id);
			if (!category) {
				warnings.push(`advisor "${advisor.name}": owns unknown category "${id}" — ignored`);
			} else if (
				category.owner !== undefined &&
				slugifyAdvisorName(category.owner) !== slugifyAdvisorName(advisor.name)
			) {
				warnings.push(
					`advisor "${advisor.name}": category "${id}" is owned by "${category.owner}" — ownership kept`,
				);
			}
		}
	}
	return warnings;
}

/**
 * Normalize an advisor name into a filesystem-/id-safe slug used for its
 * transcript filename and session id: lowercase, non-alphanumerics collapsed to
 * `-`, leading/trailing `-` trimmed. Falls back to `"advisor"` when nothing
 * survives; callers dedupe collisions.
 */
export function slugifyAdvisorName(name: string): string {
	return slugify(name) || "advisor";
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR = "\u0000";

/**
 * Returns a stable provider-facing UUIDv7 for one advisor within one primary session.
 *
 * Codex treats `session_id`/`conversation_id` as a UUID-shaped routing identity,
 * so advisor labels such as `-advisor` stay local-only.
 */
export function getOrCreateAdvisorProviderSessionId(
	ids: Map<string, string>,
	primarySessionId: string | undefined,
	slug: string,
	randomSessionId: () => string = () => Bun.randomUUIDv7(),
): string | undefined {
	if (!primarySessionId) return undefined;
	const key = `${primarySessionId}${ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR}${slug}`;
	const existing = ids.get(key);
	if (existing) return existing;

	const next = randomSessionId();
	if (!UUID_V7_PATTERN.test(next)) {
		throw new Error("Advisor provider session id generator returned a non-UUIDv7 value");
	}
	ids.set(key, next);
	registerDerivedSessionId(next, primarySessionId);
	return next;
}

/** Built tool names, for validating an advisor's `tools` list. */
const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);

/**
 * Keep only valid tool names from an advisor's `tools` list, dropping unknowns
 * with a warning. The advisor is a full agent, so any built tool may be granted;
 * the runtime further filters to what's actually available this session.
 * `undefined` means "use the default subset" (read/grep/glob); only an explicit
 * raw empty list means "no tools".
 */
function filterAdvisorTools(tools: string[] | undefined, sourcePath: string): string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) return [];
	// Normalize legacy aliases (search→grep, find→glob) and dedupe before validating.
	const filtered = normalizeToolNames(tools).filter(name => {
		if (KNOWN_TOOL_NAMES.has(name)) return true;
		logger.warn("Advisor config: dropping unknown tool", { path: sourcePath, tool: name });
		return false;
	});
	return filtered.length > 0 ? filtered : undefined;
}

/**
 * Discover advisor configs from `WATCHDOG.yml`/`WATCHDOG.yaml` files on the same
 * user + project search path as `WATCHDOG.md`. Advisors are keyed by slug; a
 * more-specific file (project leaf > project ancestor > user) replaces an earlier
 * entry with the same slug, and a more-specific `categories` entry replaces an
 * earlier one with the same id; the taxonomy resolves against the merged roster
 * via {@link resolveAdvisorCategories}. Top-level `instructions` across all
 * files concatenate into the shared baseline. A malformed file is logged and
 * skipped — never thrown — so a bad project config can't kill the session.
 */
export async function discoverAdvisorConfigs(cwd: string, agentDir?: string): Promise<DiscoveredAdvisors> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	const advisors = new Map<string, AdvisorConfig>();
	const sharedParts: string[] = [];
	let sharedMaxNotesPerUpdate: number | undefined;
	/** Merged `categories` by id, deeper files winning; undefined while no file declares the key. */
	let declaredCategories: Map<string, AdvisorCategoryConfig> | undefined;
	const warnings: string[] = [];
	const warn = (message: string, context?: Record<string, unknown>): void => {
		warnings.push(message);
		logger.warn("Advisor config", { ...context, error: message });
	};

	for (const item of items) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			warn(`${item.path}: failed to parse YAML (${String(err)}) — file skipped`, { path: item.path });
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warn(`${item.path}: expected a YAML mapping — file skipped`, { path: item.path });
			continue;
		}
		const {
			instructions,
			entries,
			sharedMaxNotesPerUpdate: docSharedMaxNotes,
			categories: docCategories,
			warnings: docWarnings,
		} = parseWatchdogDoc(parsed as Record<string, unknown>, item.path);
		for (const message of docWarnings) warn(message, { path: item.path });

		if (instructions?.trim()) {
			const expanded = (await expandAtImports(instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}

		if (docSharedMaxNotes !== undefined) sharedMaxNotesPerUpdate = docSharedMaxNotes;

		if (docCategories !== undefined) {
			declaredCategories ??= new Map();
			for (const [id, category] of docCategories) declaredCategories.set(id, category);
		}

		for (const entry of entries) {
			const slug = slugifyAdvisorName(entry.name);
			const entryInstructions = entry.instructions?.trim()
				? (await expandAtImports(entry.instructions, item.path)).trim() || undefined
				: undefined;
			advisors.set(slug, {
				name: entry.name,
				model: entry.model?.trim() || undefined,
				tools: filterAdvisorTools(entry.tools, item.path),
				reviewMode: entry.reviewMode,
				reviewInterval: entry.reviewInterval,
				syncBacklog: entry.syncBacklog === undefined ? undefined : normalizeSyncBacklog(entry.syncBacklog),
				maxNotesPerUpdate:
					typeof entry.maxNotesPerUpdate === "number" &&
					Number.isFinite(entry.maxNotesPerUpdate) &&
					entry.maxNotesPerUpdate >= 1
						? Math.trunc(entry.maxNotesPerUpdate)
						: undefined,
				enabled: entry.enabled,
				instructions: entryInstructions,
				owns: normalizeOwns(entry.owns),
				fallback: entry.fallback?.trim() || undefined,
				budget: entry.budget,
			});
		}
	}

	const roster = [...advisors.values()];
	const { categories, warnings: categoryWarnings } = resolveAdvisorCategories(declaredCategories, roster);
	for (const message of categoryWarnings) warn(message);
	return {
		advisors: roster,
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
		sharedMaxNotesPerUpdate,
		categories,
		warnings,
	};
}

/**
 * Resolve the `WATCHDOG.yml` path for a scope: `project` → `<projectDir>/WATCHDOG.yml`
 * (discovered by the project-level walk), `user` → `<agentDir>/WATCHDOG.yml` (the
 * user-level candidate).
 */
export function advisorConfigFilePath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, "WATCHDOG.yml");
}

/**
 * Resolve which `WATCHDOG.{yml,yaml}` to edit for a scope: prefer the canonical
 * `.yml`, but when only a `.yaml` exists for that scope, edit it in place so an
 * existing `.yaml` user isn't shown a blank editor and left with two files at the
 * same precedence. Falls back to `.yml` when neither exists.
 */
export async function resolveAdvisorConfigEditPath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): Promise<string> {
	const dir = scope === "user" ? dirs.agentDir : dirs.projectDir;
	const yml = path.join(dir, "WATCHDOG.yml");
	const yaml = path.join(dir, "WATCHDOG.yaml");
	if (!(await Bun.file(yml).exists()) && (await Bun.file(yaml).exists())) return yaml;
	return yml;
}

/**
 * Load one `WATCHDOG.yml` file for editing — raw, un-merged, un-expanded. Missing
 * or unparseable files yield an empty doc (never throws) so the editor opens
 * cleanly on a fresh or broken file. Validation is per entry, matching
 * discovery: malformed entries drop out of `advisors` and land in `warnings`
 * instead of blanking the whole editor.
 */
export async function loadWatchdogConfigFile(filePath: string): Promise<WatchdogConfigDoc> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err))
			logger.warn("Advisor config: failed to read for edit", { path: filePath, error: String(err) });
		return { advisors: [] };
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (err) {
		logger.warn("Advisor config: failed to parse for edit", { path: filePath, error: String(err) });
		return { advisors: [], warnings: [`${filePath}: failed to parse YAML (${String(err)})`] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		// Parity with discovery: a non-mapping document is reported, not silently blanked.
		const message = `${filePath}: expected a YAML mapping — file skipped`;
		logger.warn("Advisor config", { path: filePath, error: message });
		return { advisors: [], warnings: [message] };
	}
	const { instructions, entries, sharedMaxNotesPerUpdate, categories, warnings } = parseWatchdogDoc(
		parsed as Record<string, unknown>,
		filePath,
	);
	for (const message of warnings) logger.warn("Advisor config", { path: filePath, error: message });
	const advisors = entries.map(a => {
		const advisor: AdvisorConfig = { name: a.name };
		if (a.model?.trim()) advisor.model = a.model;
		if (a.tools !== undefined) advisor.tools = [...a.tools];
		if (a.reviewMode !== undefined) advisor.reviewMode = a.reviewMode;
		if (a.reviewInterval !== undefined) advisor.reviewInterval = a.reviewInterval;
		if (a.syncBacklog !== undefined) advisor.syncBacklog = normalizeSyncBacklog(a.syncBacklog);
		if (a.budget !== undefined) advisor.budget = { ...a.budget };
		if (a.instructions?.trim()) advisor.instructions = a.instructions;
		if (a.enabled !== undefined) advisor.enabled = a.enabled;
		if (typeof a.maxNotesPerUpdate === "number" && Number.isFinite(a.maxNotesPerUpdate) && a.maxNotesPerUpdate >= 1) {
			advisor.maxNotesPerUpdate = Math.trunc(a.maxNotesPerUpdate);
		}
		const owns = normalizeOwns(a.owns);
		if (owns !== undefined) advisor.owns = owns;
		if (a.fallback?.trim()) advisor.fallback = a.fallback.trim();
		return advisor;
	});
	const doc: WatchdogConfigDoc = { advisors };
	if (instructions?.trim()) doc.instructions = instructions;
	if (sharedMaxNotesPerUpdate !== undefined) doc.maxNotesPerUpdate = sharedMaxNotesPerUpdate;
	if (categories !== undefined) doc.categories = Object.fromEntries(categories);
	if (warnings.length > 0) doc.warnings = warnings;
	return doc;
}

/**
 * Serialize an editable doc back to canonical, hand-editable `WATCHDOG.yml`.
 * Multiline instruction fields use literal block scalars while scalar quoting
 * delegates to Bun's YAML encoder. Round-trips through {@link loadWatchdogConfigFile}.
 * Returns `""` for an empty doc.
 */

function appendYamlString(lines: string[], indent: string, key: string, value: string): void {
	const hasSignificantLeadingWhitespace = value.split("\n").some(line => /^[ \t]/.test(line));
	if (!value.includes("\n") || hasSignificantLeadingWhitespace) {
		lines.push(`${indent}${key}: ${YAML.stringify(value)}`);
		return;
	}
	const normalized = value.replaceAll("\r\n", "\n");
	let trailingNewlines = 0;
	for (let index = normalized.length - 1; index >= 0 && normalized[index] === "\n"; index--) {
		trailingNewlines++;
	}
	const chomp = trailingNewlines === 0 ? "|2-" : trailingNewlines === 1 ? "|2" : "|2+";
	const body = trailingNewlines === 0 ? normalized : normalized.slice(0, -trailingNewlines);
	lines.push(`${indent}${key}: ${chomp}`);
	for (const line of body.split("\n")) {
		lines.push(`${indent}  ${line}`);
	}
	for (let index = 1; index < trailingNewlines; index++) {
		lines.push(`${indent}  `);
	}
}

export function serializeWatchdogConfig(doc: WatchdogConfigDoc): string {
	const lines: string[] = [];
	if (doc.instructions?.trim()) appendYamlString(lines, "", "instructions", doc.instructions);
	if (
		typeof doc.maxNotesPerUpdate === "number" &&
		Number.isFinite(doc.maxNotesPerUpdate) &&
		doc.maxNotesPerUpdate >= 1
	) {
		lines.push(`maxNotesPerUpdate: ${Math.trunc(doc.maxNotesPerUpdate)}`);
	}
	if (doc.categories !== undefined) {
		const entries = Object.entries(doc.categories);
		if (entries.length === 0) lines.push("categories: {}");
		else lines.push("categories:");
		for (const [id, category] of entries) {
			lines.push(`  ${YAML.stringify(id)}:`);
			appendYamlString(lines, "    ", "description", category.description);
			if (category.owner?.trim()) lines.push(`    owner: ${YAML.stringify(category.owner)}`);
			if (category.precedence !== undefined && Number.isFinite(category.precedence)) {
				lines.push(`    precedence: ${category.precedence}`);
			}
		}
	}
	if (doc.advisors.length > 0) {
		lines.push("advisors:");
		for (const advisor of doc.advisors) {
			lines.push(`  - name: ${YAML.stringify(advisor.name)}`);
			if (advisor.model?.trim()) lines.push(`    model: ${YAML.stringify(advisor.model)}`);
			if (advisor.tools !== undefined) {
				if (advisor.tools.length === 0) {
					lines.push("    tools: []");
				} else {
					lines.push("    tools:");
					for (const tool of advisor.tools) {
						lines.push(`      - ${YAML.stringify(tool)}`);
					}
				}
			}
			if (advisor.owns !== undefined) {
				if (advisor.owns.length === 0) {
					lines.push("    owns: []");
				} else {
					lines.push("    owns:");
					for (const id of advisor.owns) {
						lines.push(`      - ${YAML.stringify(id)}`);
					}
				}
			}
			if (advisor.reviewMode !== undefined) lines.push(`    reviewMode: ${YAML.stringify(advisor.reviewMode)}`);
			if (advisor.syncBacklog !== undefined) {
				syncBacklogSchema.assert(advisor.syncBacklog);
				lines.push(`    syncBacklog: ${YAML.stringify(advisor.syncBacklog)}`);
			}
			if (advisor.instructions?.trim()) {
				appendYamlString(lines, "    ", "instructions", advisor.instructions);
			}
			if (advisor.enabled !== undefined) lines.push(`    enabled: ${advisor.enabled}`);
			if (advisor.fallback?.trim()) lines.push(`    fallback: ${YAML.stringify(advisor.fallback.trim())}`);
			if (advisor.budget !== undefined) {
				advisorEntrySchema.assert(advisor);
				lines.push("    budget:");
				for (const line of YAML.stringify(advisor.budget).trim().split("\n")) lines.push(`      ${line}`);
			}
			if (
				typeof advisor.maxNotesPerUpdate === "number" &&
				Number.isFinite(advisor.maxNotesPerUpdate) &&
				advisor.maxNotesPerUpdate >= 1
			) {
				lines.push(`    maxNotesPerUpdate: ${Math.trunc(advisor.maxNotesPerUpdate)}`);
			}
			if (advisor.reviewInterval !== undefined) {
				reviewIntervalSchema.assert(advisor.reviewInterval);
				lines.push(`    reviewInterval: ${advisor.reviewInterval}`);
			}
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Write an editable doc to `WATCHDOG.yml`. An empty doc removes the file so
 * discovery falls back to the legacy single-advisor path rather than leaving an
 * empty config behind.
 */
export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
	const content = serializeWatchdogConfig(doc);
	if (!content.trim()) {
		try {
			await fs.rm(filePath, { force: true });
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return;
	}
	await Bun.write(filePath, content);
}
