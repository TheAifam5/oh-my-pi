/**
 * `defaultTools` resolution: the main session's startup tool selection, layered per settings scope.
 */
import type { Settings } from "../config/settings";
import { sanitizeNoticeLine } from "../utils/notice-text";
import { normalizeToolName } from "./builtin-names";
import { cfgDefaultTools, defaultToolsListReplaces, parseDefaultToolsEntry } from "./settings";

/**
 * Built-in tools a plain-name list never removes and a project `-name` cannot remove: the
 * user-interaction and run-control tools, and the session-managed built-ins. A user-layer `-name`
 * still removes them.
 */
export const PROTECTED_DEFAULT_TOOL_NAMES: readonly string[] = [
	"ask",
	"resolve",
	"yield",
	"manage_skill",
	"learn",
	"context_notes",
	"new_context",
];

/**
 * Trust of the settings layer an entry came from: `"project"` for the repository's project layer,
 * `"user"` for every other layer (global, `--config` overlay, runtime override, overlay parent).
 */
export type DefaultToolsSource = "user" | "project";

/** What `defaultTools` entries may change, decided by the caller's registry and policy. */
export interface DefaultToolsPolicy {
	/** Inherited tools a list with plain names replaces (the built-in tools). */
	isReplaceable(name: string): boolean;
	/** Tools no plain-name list removes and no project `-name` removes ({@link PROTECTED_DEFAULT_TOOL_NAMES}). */
	isProtected(name: string): boolean;
	/** Tools a plain name or `+name` from `source` may select; other named tools are skipped. */
	canSelect(name: string, source: DefaultToolsSource): boolean;
}

/** Registry facts {@link createDefaultToolsPolicy} needs about one registered tool. */
export interface DefaultToolsCandidate {
	hidden?: boolean;
	defaultInactive?: boolean;
}

/**
 * The standard policy over a session's registry. `isBuiltIn` limits replacement and protection to
 * built-in provenance. `lookup` returns `undefined` for an unregistered tool. `isDenied` names tools
 * no entry may select (an approval `deny`). A hidden tool outside `baseline` is selectable by no
 * layer; a `defaultInactive` tool outside `baseline` only by a user-layer entry.
 */
export function createDefaultToolsPolicy(options: {
	baseline: readonly string[];
	isBuiltIn(name: string): boolean;
	lookup(name: string): DefaultToolsCandidate | undefined;
	isDenied(name: string): boolean;
}): DefaultToolsPolicy {
	const { baseline, isBuiltIn, lookup, isDenied } = options;
	return {
		isReplaceable: isBuiltIn,
		isProtected: name => isBuiltIn(name) && PROTECTED_DEFAULT_TOOL_NAMES.includes(name),
		canSelect: (name, source) => {
			const tool = lookup(name);
			if (tool === undefined || isDenied(name)) return false;
			if (baseline.includes(name)) return true;
			if (tool.hidden === true) return false;
			return source === "user" || tool.defaultInactive !== true;
		},
	};
}

/**
 * Applies one `defaultTools` list from `source` to the selection it inherits. A list holding only
 * `+name` and `-name` entries changes the inherited selection; a list with at least one plain
 * name, or an empty list, replaces the inherited replaceable, unprotected tools with its plain
 * names and keeps the rest. `+name` and `-name` then apply in list order. Plain names and `+name`
 * entries the policy cannot select for `source` are skipped; `-name` removes, except that a
 * project `-name` skips a protected tool. The result preserves first-seen order without duplicates.
 */
export function applyDefaultToolsList(
	list: readonly string[],
	inherited: readonly string[],
	policy: DefaultToolsPolicy,
	source: DefaultToolsSource = "user",
): string[] {
	const plain: string[] = [];
	const modifiers: { op: "+" | "-"; name: string }[] = [];
	for (const raw of list) {
		const entry = parseDefaultToolsEntry(raw);
		if (!entry) continue;
		const name = normalizeToolName(entry.name);
		if (entry.op) modifiers.push({ op: entry.op, name });
		else plain.push(name);
	}
	let selection = defaultToolsListReplaces(list)
		? [
				...inherited.filter(name => !policy.isReplaceable(name) || policy.isProtected(name)),
				...plain.filter(name => policy.canSelect(name, source)),
			]
		: [...inherited];
	for (const { op, name } of modifiers) {
		if (op === "-") {
			if (source === "project" && policy.isProtected(name)) continue;
			selection = selection.filter(selected => selected !== name);
		} else if (!selection.includes(name) && policy.canSelect(name, source)) {
			selection.push(name);
		}
	}
	return [...new Set(selection)];
}

interface LayerList {
	list: readonly string[];
	source: DefaultToolsSource;
}

/** The selection `layers` produce from `baseline`, folding them with the setting's `merge` rule. */
function applyLayers(
	layers: readonly { source: DefaultToolsSource; value: unknown }[],
	baseline: readonly string[],
	policy: DefaultToolsPolicy,
): string[] {
	let effective: LayerList[] = [];
	for (const { source, value } of layers) {
		if (!Array.isArray(value)) effective = [];
		else if (defaultToolsListReplaces(value)) effective = [{ list: value, source }];
		else effective.push({ list: value, source });
	}
	let selection = [...baseline];
	for (const { list, source } of effective) selection = applyDefaultToolsList(list, selection, policy, source);
	return selection;
}

/**
 * The startup tool selection `defaultTools` produces from `baseline` (the selection without the
 * setting). Each layer's list applies in precedence order under the setting's `merge` rule, with
 * the project layer's entries checked as `"project"`. The result never holds a tool the user
 * layers alone leave out of the selection, so a project list only narrows it: a user-layer `-name`
 * or allow-list wins over any project entry. `undefined` when no layer configures `defaultTools`,
 * so the caller keeps `baseline`.
 */
export function resolveDefaultToolSelection(
	settings: Settings,
	baseline: readonly string[],
	policy: DefaultToolsPolicy,
): string[] | undefined {
	return resolveDefaultToolLayers(settings, baseline, policy)?.selection;
}

/** The effective `defaultTools` selection together with the selection the user layers alone produce. */
export interface DefaultToolsResolution {
	/** The startup selection ({@link resolveDefaultToolSelection}); a subset of `userSelection`. */
	selection: string[];
	/** The selection every layer except the project layer produces from the baseline. */
	userSelection: string[];
	/** Tools of `userSelection` the project layer leaves out of `selection`, in `userSelection` order. */
	projectRemoved: string[];
}

/**
 * {@link resolveDefaultToolSelection} with the user-layer selection it narrows and the tools the
 * project layer removed from it. `undefined` when no layer configures `defaultTools`.
 */
export function resolveDefaultToolLayers(
	settings: Settings,
	baseline: readonly string[],
	policy: DefaultToolsPolicy,
): DefaultToolsResolution | undefined {
	// Decided per layer: a merged `null` reads as unset even while a lower layer holds a list.
	const layers = settings.getLayerValues(cfgDefaultTools).map(({ source, value }) => ({
		source: source === "project" ? ("project" as const) : ("user" as const),
		value,
	}));
	if (layers.length === 0) return undefined;
	const userSelection = applyLayers(
		layers.filter(layer => layer.source === "user"),
		baseline,
		policy,
	);
	const allowed = new Set(userSelection);
	const selection = applyLayers(layers, baseline, policy).filter(name => allowed.has(name));
	const selected = new Set(selection);
	return { selection, userSelection, projectRemoved: userSelection.filter(name => !selected.has(name)) };
}

/** Most tool names {@link formatProjectRemovedToolsNotice} lists before summarizing the rest. */
const MAX_NOTICE_TOOL_NAMES = 10;

/**
 * The warning shown when the project layer's `defaultTools` removes `names` from the user's
 * selection. Lists at most {@link MAX_NOTICE_TOOL_NAMES} names, each through
 * {@link sanitizeNoticeLine}, on one line.
 */
export function formatProjectRemovedToolsNotice(names: readonly string[]): string {
	const listed = names
		.slice(0, MAX_NOTICE_TOOL_NAMES)
		.map(name => sanitizeNoticeLine(name))
		.join(", ");
	const rest = names.length - MAX_NOTICE_TOOL_NAMES;
	return `Project defaultTools removed ${names.length === 1 ? "a tool" : `${names.length} tools`} from your selection: ${listed}${rest > 0 ? `, and ${rest} more` : ""}.`;
}
