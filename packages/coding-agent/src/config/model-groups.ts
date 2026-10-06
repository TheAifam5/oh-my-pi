/**
 * Model groups: the data model, strict parser, and tolerant loader for pooled
 * values of `modelRoles.<role>`, `retry.fallbackChains.<key>`, and
 * `modelGroups.<name>`.
 *
 * Parsing validates shape only. Model ids are never resolved against the
 * registry here, group references are not checked against `modelGroups`, and
 * absent optional settings stay absent so the resolving layer can apply its
 * own defaults (quota reserve and observation age).
 */

import type { AccountRouting, DrainReturnTrigger } from "@oh-my-pi/pi-ai/auth-storage";
import { type LocalLimit, parseLocalLimits } from "@oh-my-pi/pi-ai/usage/limits";
import { ACCOUNT_NAME, drainFundingIssue, MAX_ACCOUNT_NAME_LENGTH } from "@oh-my-pi/pi-ai/auth/policy";
import { type Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { isRecord } from "@oh-my-pi/pi-utils";
import { splitThinkingSuffix } from "@oh-my-pi/pi-tui/thinking";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	isKindRole,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_ALIAS_PREFIX,
} from "./model-role-ids";

/**
 * Grammar of group names, member aliases, profile names, and budget ids.
 * Lowercase only, so case-insensitive lookups cannot confuse two names.
 */
export const MODEL_GROUP_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Prefix of the group reference shorthand `+<group>` / `+<group>@<profile>`.
 * Every string value starting with it is reserved for group references: a
 * malformed one is an error, never a model selector.
 */
export const GROUP_REF_SIGIL = "+";

/** Separates a group name from a profile name in the shorthand. */
export const GROUP_PROFILE_SEPARATOR = "@";

/**
 * Model-kind roles that accept groups and group references. Every chat role
 * accepts them; the remaining kind roles take only model selectors.
 */
export const POOL_CAPABLE_KIND_ROLES: readonly string[] = ["judge", "image"];

/** Whether `modelRoles.<role>` may hold a group or group reference. */
export function roleAcceptsGroups(role: string): boolean {
	return !isKindRole(role) || POOL_CAPABLE_KIND_ROLES.includes(role);
}

/**
 * Keys that name object internals in JavaScript. They are never accepted as a
 * role, chain key, group name, member alias, or profile name, so no configured
 * key can reach an object's prototype chain.
 */
export const FORBIDDEN_ENTRY_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

const RESERVED_KEY_MESSAGE = `is a reserved key (${FORBIDDEN_ENTRY_KEYS.join(", ")})`;

/** Longest group name, member alias, profile name, or budget id, in characters. */
export const MAX_MODEL_GROUP_NAME_LENGTH = 64;
/** Most members one group may define. */
export const MAX_GROUP_MODELS = 64;
/** Most profiles one group may define. */
export const MAX_GROUP_PROFILES = 32;
/** Longest member `model` id, in characters. */
export const MAX_MEMBER_MODEL_LENGTH = 256;
/** Most integer digits of a budget amount; fractional digits are capped at 9 separately. */
export const MAX_AMOUNT_INTEGER_DIGITS = 12;
/** Longest budget window, in ms (365 days). */
export const MAX_BUDGET_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
/** Longest configured text echoed into a message, in characters. */
const MAX_ECHO_LENGTH = 64;

// Control, line/paragraph separator, and bidirectional formatting characters.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function escapeUnsafe(text: string): string {
	return text.replace(UNSAFE_TEXT, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function truncateEcho(text: string): string {
	return text.length > MAX_ECHO_LENGTH ? `${text.slice(0, MAX_ECHO_LENGTH)}…` : text;
}

/**
 * A configured key as it appears in a settings path of a message: unsafe
 * characters escaped and cut to a bounded length.
 */
export function modelGroupPathKey(key: string): string {
	return escapeUnsafe(truncateEcho(key));
}

/**
 * A configured value as a message shows it: a string quoted, escaped, and cut
 * to a bounded length; a scalar as text; a mapping or list only by its kind.
 * Nested values are never serialized, so shared or cyclic structures cost
 * constant time.
 */
function echo(value: unknown): string {
	if (typeof value === "string") return `"${escapeUnsafe(truncateEcho(value).replaceAll('"', '\\"'))}"`;
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
		return String(value);
	}
	if (Array.isArray(value)) return "a list";
	return typeof value === "object" ? "a mapping" : typeof value;
}

function echoKeys(keys: readonly string[]): string {
	return keys.map(modelGroupPathKey).join(", ");
}

/** Strategies a group may use; each orders members as described at {@link GroupStrategy}. */
export const GROUP_STRATEGIES = [
	"priority",
	"round-robin",
	"weighted-random",
	"random",
	"quota",
	"cheapest",
	"least-used",
	"least-loaded",
	"p2c",
	"shuffle-bag",
] as const;
export type GroupStrategyName = (typeof GROUP_STRATEGIES)[number];

/** Billing classes in the only order funding may list them; `metered` is always last. */
export const BILLING_CLASSES = ["included", "free", "metered"] as const;
export type BillingClass = (typeof BILLING_CLASSES)[number];

/** Window `least-used` counts requests over by default, in ms (24 hours). */
export const DEFAULT_LEAST_USED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A strategy with exactly the options it consumes. `priority` and `round-robin` follow `order`;
 * `random` and `weighted-random` (by member `weight`) draw a new order per use; `quota` tries the
 * most remaining coding-plan quota first, balanced by remaining fraction. `cheapest` orders by
 * input plus output price, `least-used` by requests recorded over the last `windowMs`,
 * `least-loaded` by requests in flight in this process, `p2c` picks the less loaded of two random
 * members, and `shuffle-bag` uses every member once per shuffled cycle.
 */
export type GroupStrategy =
	| { name: "random" }
	| { name: "weighted-random" }
	| { name: "quota" }
	| { name: "cheapest" }
	| { name: "least-loaded" }
	| { name: "p2c" }
	| { name: "shuffle-bag" }
	| { name: "least-used"; windowMs: number }
	/** `order` lists every member alias exactly once. */
	| { name: "round-robin"; order: readonly string[] }
	| { name: "priority"; order: readonly string[] };

export interface GroupQuotaPolicy {
	/** Share of each observed window kept unused, in [0, 1). */
	reserveFraction?: number;
	/** Observations older than this are stale, in milliseconds. */
	maxObservationAgeMs?: number;
	unknown?: "exclude" | "allow";
}

export interface GroupBudget {
	id: string;
	currency: "USD";
	/** Non-negative decimal amount with at most 9 fractional digits; never above `window.maxSpend`. */
	perRequestMax: string;
	window: { type: "rolling"; durationMs: number; maxSpend: string };
}

/**
 * How metered spending is authorized: `provider-managed` leaves limits to the provider;
 * `local-hard-budget` spends only while the local spend ledger shows room in `budget`.
 */
export type GroupSpendingPolicy = { policy: "provider-managed" } | { policy: "local-hard-budget"; budget: GroupBudget };

export interface GroupRouting {
	/** Authorized billing classes in funding order (from `funding.order`); `metered` only last. */
	funding?: readonly BillingClass[];
	quota?: GroupQuotaPolicy;
	/** Present exactly when `funding` includes `metered`. */
	spending?: GroupSpendingPolicy;
	/** Account order, drain target, and drain funding for requests to this group's members (`routing.accounts`). */
	accounts?: AccountRouting;
	/** Local limits on the calls made through this pool (`routing.limits`); see `session/local-limits.ts`. */
	limits?: readonly LocalLimit[];
	/**
	 * `affinity`: an eligible member whose prompt cache is warm for the session goes first. `pricing`:
	 * `cheapest` prices a member's input at its expected prompt-cache hit rate (`routing.cache`).
	 */
	cache?: { affinity?: boolean; pricing?: boolean };
}

/** A concrete `provider/model-id` member. */
export interface ModelMember {
	kind: "model";
	alias: string;
	model: string;
	defaultEffort?: Effort;
	/** Only under `weighted-random`; absent means the strategy's default. */
	weight?: number;
	/** Name of the stored account (`auth.accountPolicies[].name`) tried first for this member's requests; not exclusive. */
	account?: string;
}

export type GroupMember = ModelMember;

export interface GroupProfile {
	/** Execution overrides by member alias; an absent field keeps the member's own. */
	models: ReadonlyMap<string, { effort?: Effort }>;
}

export interface ModelGroup {
	strategy: GroupStrategy;
	routing?: GroupRouting;
	/** Sorted by alias in code-point order; scheduling order comes only from the strategy. */
	models: readonly GroupMember[];
	profiles: ReadonlyMap<string, GroupProfile>;
	/** A profile of this group selected by the value; never set on `modelGroups.<name>`. */
	profile?: string;
}

/** A reference to `modelGroups.<use>`, optionally through one of its profiles. */
export interface GroupRef {
	use: string;
	profile?: string;
}

/**
 * A parsed `modelRoles.<role>` or `retry.fallbackChains.<key>` value.
 * `selector` and `list` carry the input verbatim (same reference for lists).
 * `clear` is an entry-level `null`.
 */
export type ParsedModelValue =
	| { kind: "clear" }
	| { kind: "selector"; value: string }
	| { kind: "list"; value: readonly string[] }
	| { kind: "group"; group: ModelGroup }
	| { kind: "ref"; ref: GroupRef; shorthand: boolean };

export interface ModelGroupIssue {
	/** Settings path, e.g. `modelRoles.engineer.models.astra.model`; list items as `[index]`. */
	path: string;
	message: string;
}

export type ModelGroupParseResult<T> =
	| { ok: true; value: T; warnings: readonly ModelGroupIssue[] }
	| { ok: false; issues: readonly ModelGroupIssue[] };

/** Result of the shorthand grammar: not shorthand, a reference, or a reserved but malformed value. */
export type GroupShorthand = { kind: "none" } | { kind: "ref"; ref: GroupRef } | { kind: "invalid"; message: string };

export interface ModelGroupSections {
	modelRoles?: unknown;
	fallbackChains?: unknown;
	modelGroups?: unknown;
}

const SECTION_PATHS = {
	modelRoles: "modelRoles",
	fallbackChains: "retry.fallbackChains",
	modelGroups: "modelGroups",
} as const;

// ----- shorthand -------------------------------------------------------------

/** Whether `name` is a usable group name, member alias, or profile name. */
function isModelGroupName(name: string): boolean {
	return (
		name.length <= MAX_MODEL_GROUP_NAME_LENGTH && MODEL_GROUP_NAME.test(name) && !FORBIDDEN_ENTRY_KEYS.includes(name)
	);
}

/**
 * Recognizes `+<group>` and `+<group>@<profile>` (surrounding whitespace
 * ignored). Any value whose first non-blank character is the sigil is a
 * reference or invalid; no model selector, role alias, or provider id starts
 * with it.
 */
export function parseGroupShorthand(value: string): GroupShorthand {
	const text = value.trim();
	if (!text.startsWith(GROUP_REF_SIGIL)) return { kind: "none" };
	if (text.includes(",")) {
		return { kind: "invalid", message: "a group reference must be the whole value, not part of a selector list" };
	}
	if (text.includes(":")) {
		return {
			kind: "invalid",
			message: `group reference ${echo(text)} takes no :effort suffix; set efforts in a profile of the group`,
		};
	}
	const parts = text.slice(GROUP_REF_SIGIL.length).split(GROUP_PROFILE_SEPARATOR);
	if (parts.length > 2 || !parts.every(isModelGroupName)) {
		return {
			kind: "invalid",
			message: `${echo(text)} is not a group reference; expected ${GROUP_REF_SIGIL}<group> or ${GROUP_REF_SIGIL}<group>${GROUP_PROFILE_SEPARATOR}<profile> with names matching ${MODEL_GROUP_NAME.source}`,
		};
	}
	const [use, profile] = parts as [string, string?];
	return { kind: "ref", ref: profile === undefined ? { use } : { use, profile } };
}

// ----- issue collection ------------------------------------------------------

interface CollectedIssue extends ModelGroupIssue {
	/** Member alias the issue belongs to; tolerant loading may skip that member alone. */
	member?: string;
}

class Collector {
	readonly issues: CollectedIssue[] = [];
	constructor(
		/** Member aliases to leave out; their issues were already reported. */
		readonly skip: ReadonlySet<string>,
	) {}

	add(path: string, message: string, member?: string): void {
		this.issues.push(member === undefined ? { path, message } : { path, message, member });
	}
}

/** Field names a reader may carry over from elsewhere, mapped to the field this format uses. */
const RENAMED_FIELDS: Readonly<Record<string, string>> = { members: "models" };

/** Reports unknown fields and explicit nulls; returns false when `value` is not a mapping. */
function checkFields(
	c: Collector,
	path: string,
	value: unknown,
	allowed: readonly string[],
	member?: string,
): value is Record<string, unknown> {
	if (!isRecord(value)) {
		c.add(path, `expected a mapping with ${allowed.length > 0 ? allowed.join(", ") : "no fields"}`, member);
		return false;
	}
	for (const [key, field] of Object.entries(value)) {
		if (!allowed.includes(key)) {
			const renamed = Object.hasOwn(RENAMED_FIELDS, key) ? RENAMED_FIELDS[key] : undefined;
			c.add(
				`${path}.${modelGroupPathKey(key)}`,
				renamed !== undefined && allowed.includes(renamed)
					? `unsupported field; use ${renamed}`
					: `unsupported field; supported: ${allowed.length > 0 ? allowed.join(", ") : "none"}`,
				member,
			);
		} else if (field === null) {
			c.add(`${path}.${key}`, "must not be null; omit it instead", member);
		}
	}
	return true;
}

function present(record: Record<string, unknown>, key: string): boolean {
	return record[key] !== undefined && record[key] !== null;
}

function readOneOf<T extends string>(
	c: Collector,
	path: string,
	allowed: readonly T[],
	value: unknown,
	member?: string,
): T | undefined {
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	c.add(path, `${echo(value)} is not one of: ${allowed.join(", ")}`, member);
	return undefined;
}

function readPositive(
	c: Collector,
	path: string,
	value: unknown,
	integer: boolean,
	member?: string,
): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value))) {
		return value;
	}
	c.add(path, `must be a positive ${integer ? "integer" : "number"}`, member);
	return undefined;
}

function readFraction(c: Collector, path: string, value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1) return value;
	c.add(path, "must be a number in [0, 1)");
	return undefined;
}

function readEffort(c: Collector, path: string, value: unknown, member?: string): Effort | undefined {
	const effort = THINKING_EFFORTS.find(candidate => candidate === value);
	if (effort === undefined) {
		c.add(path, `${echo(value)} is not an effort; expected one of: ${THINKING_EFFORTS.join(", ")}`, member);
	}
	return effort;
}

function readName(c: Collector, path: string, what: string, value: string, member?: string): boolean {
	if (isModelGroupName(value)) return true;
	if (value.length > MAX_MODEL_GROUP_NAME_LENGTH) {
		c.add(path, `${what} ${echo(value)} is longer than ${MAX_MODEL_GROUP_NAME_LENGTH} characters`, member);
	} else if (FORBIDDEN_ENTRY_KEYS.includes(value)) {
		c.add(path, `${what} ${echo(value)} is reserved`, member);
	} else {
		c.add(path, `${what} ${echo(value)} must match ${MODEL_GROUP_NAME.source}`, member);
	}
	return false;
}

function compareCodePoints(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ----- members ---------------------------------------------------------------

const WILDCARD_CHARS = ["*", "?", "["];

/** Reason a member `model` is not a concrete `provider/model-id`, if it is not. */
function memberModelProblem(model: string): string | undefined {
	if (model.length === 0) return "must be a non-empty provider/model-id";
	if (model.length > MAX_MEMBER_MODEL_LENGTH) return `must be at most ${MAX_MEMBER_MODEL_LENGTH} characters`;
	if (model.trim() !== model || /\s/.test(model)) return "must not contain whitespace";
	if (model.includes(",")) return "must name one model, not a selector list";
	if (model.startsWith(GROUP_REF_SIGIL)) return "must be a concrete model; groups do not nest";
	if (model === DEFAULT_MODEL_ROLE_ALIAS || model.startsWith(MODEL_ROLE_ALIAS_PREFIX)) {
		return "must be a concrete model, not a role alias";
	}
	if (model.toLowerCase().startsWith(LEGACY_MODEL_ROLE_ALIAS_PREFIX)) {
		return "must be a concrete model, not a role alias";
	}
	if (WILDCARD_CHARS.some(char => model.includes(char))) return "must be a concrete model, not a wildcard pattern";
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) return "must be a provider/model-id";
	if (splitThinkingSuffix(model, slash).level !== undefined) {
		return "takes no :effort suffix; set defaultEffort instead";
	}
	return undefined;
}

function parseMember(
	c: Collector,
	path: string,
	alias: string,
	raw: unknown,
	strategy: GroupStrategyName | undefined,
): ModelMember | undefined {
	const before = c.issues.length;
	readName(c, path, "member alias", alias, alias);
	if (!checkFields(c, path, raw, ["model", "defaultEffort", "weight", "account"], alias)) return undefined;
	let model: string | undefined;
	if (raw.model === undefined) {
		c.add(`${path}.model`, "is required", alias);
	} else if (raw.model !== null && typeof raw.model !== "string") {
		c.add(`${path}.model`, "must be a provider/model-id string", alias);
	} else if (raw.model !== null) {
		const problem = memberModelProblem(raw.model);
		if (problem !== undefined) c.add(`${path}.model`, problem, alias);
		else model = raw.model;
	}
	const defaultEffort = present(raw, "defaultEffort")
		? readEffort(c, `${path}.defaultEffort`, raw.defaultEffort, alias)
		: undefined;
	let weight: number | undefined;
	if (present(raw, "weight")) {
		if (strategy !== undefined && strategy !== "weighted-random") {
			c.add(`${path}.weight`, "applies only to strategy weighted-random", alias);
		} else {
			weight = readPositive(c, `${path}.weight`, raw.weight, false, alias);
		}
	}
	let account: string | undefined;
	if (present(raw, "account")) {
		if (
			typeof raw.account !== "string" ||
			raw.account.length > MAX_ACCOUNT_NAME_LENGTH ||
			!ACCOUNT_NAME.test(raw.account)
		) {
			c.add(`${path}.account`, `must be an account name matching ${ACCOUNT_NAME.source}`, alias);
		} else {
			account = raw.account;
		}
	}
	if (c.issues.length > before || model === undefined) return undefined;
	return {
		kind: "model",
		alias,
		model,
		...(defaultEffort !== undefined ? { defaultEffort } : {}),
		...(weight !== undefined ? { weight } : {}),
		...(account !== undefined ? { account } : {}),
	};
}

// ----- strategy --------------------------------------------------------------

function parseOrder(c: Collector, path: string, value: unknown, aliases: readonly string[]): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_GROUP_MODELS || value.some(item => typeof item !== "string")) {
		c.add(path, `must be a list of at most ${MAX_GROUP_MODELS} member aliases`);
		return undefined;
	}
	const order: string[] = [];
	const seen = new Set<string>();
	let valid = true;
	for (const alias of value as string[]) {
		if (c.skip.has(alias)) continue;
		if (!aliases.includes(alias)) {
			c.add(path, `names unknown alias ${echo(alias)}; aliases: ${echoKeys(aliases)}`);
			valid = false;
		} else if (seen.has(alias)) {
			c.add(path, `lists ${echo(alias)} twice`);
			valid = false;
		} else {
			seen.add(alias);
			order.push(alias);
		}
	}
	const missing = aliases.filter(alias => !seen.has(alias));
	if (missing.length > 0) {
		c.add(path, `must list every alias exactly once; missing: ${echoKeys(missing)}`);
		valid = false;
	}
	return valid ? order : undefined;
}

function parseStrategy(
	c: Collector,
	path: string,
	strategy: GroupStrategyName,
	rawOptions: unknown,
	aliases: readonly string[],
): GroupStrategy | undefined {
	const at = `${path}.strategyOptions`;
	const before = c.issues.length;
	const options = (allowed: readonly string[]): Record<string, unknown> | undefined => {
		const value = rawOptions ?? {};
		return checkFields(c, at, value, allowed) ? value : undefined;
	};
	const failed = () => c.issues.length > before;
	switch (strategy) {
		case "random":
		case "weighted-random":
		case "cheapest":
		case "least-loaded":
		case "p2c":
		case "shuffle-bag":
			options([]);
			return failed() ? undefined : { name: strategy };
		case "least-used": {
			const o = options(["window"]);
			if (!o) return undefined;
			let windowMs = DEFAULT_LEAST_USED_WINDOW_MS;
			const windowPath = `${at}.window`;
			if (present(o, "window") && checkFields(c, windowPath, o.window, ["type", "durationMs"])) {
				const w = o.window;
				if (w.type !== "rolling") c.add(`${windowPath}.type`, 'must be "rolling"');
				if (w.durationMs === undefined) c.add(windowPath, "durationMs is required");
				else {
					const durationMs = readPositive(c, `${windowPath}.durationMs`, w.durationMs, true);
					if (durationMs !== undefined && durationMs > MAX_BUDGET_WINDOW_MS) {
						c.add(`${windowPath}.durationMs`, `must be at most ${MAX_BUDGET_WINDOW_MS} (365 days)`);
					} else if (durationMs !== undefined) windowMs = durationMs;
				}
			}
			return failed() ? undefined : { name: strategy, windowMs };
		}
		case "round-robin":
		case "priority": {
			const o = options(["order"]);
			if (!o) return undefined;
			if (!present(o, "order")) {
				c.add(at, `${strategy} requires order listing every member alias exactly once`);
				return undefined;
			}
			const order = parseOrder(c, `${at}.order`, o.order, aliases);
			return order && !failed() ? { name: strategy, order } : undefined;
		}
		case "quota": {
			// Quota balances remaining fraction; these options may only restate that.
			const o = options(["objective", "capacityMetric"]);
			if (!o) return undefined;
			if (present(o, "objective")) readOneOf(c, `${at}.objective`, ["balance"] as const, o.objective);
			if (present(o, "capacityMetric")) {
				readOneOf(c, `${at}.capacityMetric`, ["fraction"] as const, o.capacityMetric);
			}
			return failed() ? undefined : { name: strategy };
		}
	}
}

// ----- routing ---------------------------------------------------------------

const DECIMAL_AMOUNT = new RegExp(`^(\\d{1,${MAX_AMOUNT_INTEGER_DIGITS}})(?:\\.(\\d{1,9}))?$`);

/** Amount in nano-units, or undefined when `value` is not a quoted decimal amount. */
export function decimalNanos(value: unknown): bigint | undefined {
	const match = typeof value === "string" ? DECIMAL_AMOUNT.exec(value) : null;
	if (!match) return undefined;
	return BigInt(match[1]!) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

function readAmount(c: Collector, path: string, value: unknown): bigint | undefined {
	const nanos = decimalNanos(value);
	if (nanos === undefined) {
		c.add(
			path,
			`must be a quoted decimal amount with at most ${MAX_AMOUNT_INTEGER_DIGITS} integer and 9 fractional digits, such as "0.25"`,
		);
	}
	return nanos;
}

function parseBudget(c: Collector, path: string, raw: unknown): GroupBudget | undefined {
	const before = c.issues.length;
	if (!checkFields(c, path, raw, ["id", "currency", "perRequestMax", "window"])) return undefined;
	for (const field of ["id", "currency", "perRequestMax", "window"]) {
		if (raw[field] === undefined) c.add(path, `${field} is required`);
	}
	if (raw.id !== undefined && raw.id !== null) {
		if (typeof raw.id !== "string") c.add(`${path}.id`, "must be a string");
		else readName(c, `${path}.id`, "budget id", raw.id);
	}
	if (raw.currency !== undefined && raw.currency !== null && raw.currency !== "USD") {
		c.add(`${path}.currency`, 'must be "USD"');
	}
	const perRequestMax = present(raw, "perRequestMax")
		? readAmount(c, `${path}.perRequestMax`, raw.perRequestMax)
		: undefined;
	let durationMs: number | undefined;
	let maxSpend: bigint | undefined;
	const windowPath = `${path}.window`;
	if (present(raw, "window") && checkFields(c, windowPath, raw.window, ["type", "durationMs", "maxSpend"])) {
		const w = raw.window;
		if (w.type !== undefined && w.type !== null && w.type !== "rolling") {
			c.add(`${windowPath}.type`, 'must be "rolling"');
		}
		for (const field of ["type", "durationMs", "maxSpend"]) {
			if (w[field] === undefined) c.add(windowPath, `${field} is required`);
		}
		if (present(w, "durationMs")) durationMs = readPositive(c, `${windowPath}.durationMs`, w.durationMs, true);
		if (durationMs !== undefined && durationMs > MAX_BUDGET_WINDOW_MS) {
			c.add(`${windowPath}.durationMs`, `must be at most ${MAX_BUDGET_WINDOW_MS} (365 days)`);
		}
		if (present(w, "maxSpend")) maxSpend = readAmount(c, `${windowPath}.maxSpend`, w.maxSpend);
	}
	if (perRequestMax !== undefined && maxSpend !== undefined && perRequestMax > maxSpend) {
		c.add(path, "perRequestMax exceeds window.maxSpend");
	}
	if (c.issues.length > before || durationMs === undefined) return undefined;
	return {
		id: raw.id as string,
		currency: "USD",
		perRequestMax: raw.perRequestMax as string,
		window: { type: "rolling", durationMs, maxSpend: (raw.window as Record<string, unknown>).maxSpend as string },
	};
}

function parseSpending(c: Collector, path: string, raw: unknown): GroupSpendingPolicy | undefined {
	const before = c.issues.length;
	if (!checkFields(c, path, raw, ["policy", "budget"])) return undefined;
	if (!present(raw, "policy")) {
		c.add(path, "policy is required: provider-managed or local-hard-budget");
		return undefined;
	}
	const policy = readOneOf(c, `${path}.policy`, ["provider-managed", "local-hard-budget"] as const, raw.policy);
	if (policy === "provider-managed") {
		if (present(raw, "budget")) {
			c.add(`${path}.budget`, "provider-managed takes no budget; use policy local-hard-budget for a local limit");
		}
		return c.issues.length > before ? undefined : { policy };
	}
	if (policy === "local-hard-budget") {
		if (!present(raw, "budget")) {
			c.add(path, "local-hard-budget requires a budget");
			return undefined;
		}
		const budget = parseBudget(c, `${path}.budget`, raw.budget);
		return budget && c.issues.length === before ? { policy, budget } : undefined;
	}
	return undefined;
}

function parseFunding(c: Collector, path: string, raw: unknown): BillingClass[] | undefined {
	if (!checkFields(c, path, raw, ["order"])) return undefined;
	const at = `${path}.order`;
	if (!Array.isArray(raw.order) || raw.order.length === 0) {
		c.add(at, `must list billing classes (${BILLING_CLASSES.join(", ")})`);
		return undefined;
	}
	const before = c.issues.length;
	const funding = raw.order.map(item => readOneOf(c, at, BILLING_CLASSES, item));
	if (c.issues.length > before) return undefined;
	const classes = funding as BillingClass[];
	if (new Set(classes).size !== classes.length) {
		c.add(at, "lists a class twice");
		return undefined;
	}
	// A route billed as metered belongs to the last stage, so no earlier stage can hide its spending.
	if (classes.includes("metered") && classes.at(-1) !== "metered") {
		c.add(at, "metered must be the last class");
		return undefined;
	}
	return classes;
}

function isAccountName(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_ACCOUNT_NAME_LENGTH && ACCOUNT_NAME.test(value);
}

function parseAccountRouting(c: Collector, path: string, raw: unknown): AccountRouting | undefined {
	const before = c.issues.length;
	if (!checkFields(c, path, raw, ["order", "drain", "spend", "returnWhen"])) return undefined;
	if (!["order", "drain", "spend", "returnWhen"].some(field => present(raw, field))) {
		c.add(path, "must set at least one of order, drain, spend, returnWhen");
		return undefined;
	}
	const nameRule = `account names matching ${ACCOUNT_NAME.source}`;
	if (present(raw, "order")) {
		if (!Array.isArray(raw.order) || raw.order.length === 0 || !raw.order.every(isAccountName)) {
			c.add(`${path}.order`, `must be a non-empty list of ${nameRule}`);
		} else if (new Set(raw.order).size !== raw.order.length) {
			c.add(`${path}.order`, "lists an account twice");
		}
	}
	if (present(raw, "drain") && !isAccountName(raw.drain)) c.add(`${path}.drain`, `must be one of the ${nameRule}`);
	const issue = drainFundingIssue(raw.spend ?? undefined, raw.returnWhen ?? undefined);
	if (issue) c.add(`${path}.${issue.field}`, issue.message);
	if (c.issues.length > before) return undefined;
	const returnWhen = raw.returnWhen ?? undefined;
	return {
		...(present(raw, "order") ? { order: [...(raw.order as string[])] } : {}),
		...(present(raw, "drain") ? { drain: raw.drain as string } : {}),
		...(present(raw, "spend") ? { spend: [...(raw.spend as NonNullable<AccountRouting["spend"]>)] } : {}),
		...(returnWhen !== undefined
			? { returnWhen: [returnWhen as DrainReturnTrigger | DrainReturnTrigger[]].flat() }
			: {}),
	};
}

function parseRouting(c: Collector, path: string, raw: unknown): GroupRouting | undefined {
	const before = c.issues.length;
	if (!checkFields(c, path, raw, ["funding", "quota", "spending", "accounts", "limits", "cache"])) return undefined;
	const routing: GroupRouting = {};
	const funding = present(raw, "funding") ? parseFunding(c, `${path}.funding`, raw.funding) : undefined;
	const spendingRaw = present(raw, "spending") ? raw.spending : undefined;
	const spending = spendingRaw === undefined ? undefined : parseSpending(c, `${path}.spending`, spendingRaw);
	// An unparseable funding block is already reported; pairing checks against it would only repeat it.
	if (!present(raw, "funding") || funding !== undefined) {
		const metered = funding?.includes("metered") === true;
		if (metered && spendingRaw === undefined) {
			c.add(path, "funding includes metered, which requires spending.policy: provider-managed or local-hard-budget");
		}
		if (!metered && spendingRaw !== undefined) {
			c.add(`${path}.spending`, "applies only when funding includes metered");
		}
	}
	if (funding) routing.funding = funding;
	if (spending) routing.spending = spending;

	if (
		present(raw, "quota") &&
		checkFields(c, `${path}.quota`, raw.quota, ["reserveFraction", "maxObservationAgeMs", "unknown"])
	) {
		const q = raw.quota;
		const quota: GroupQuotaPolicy = {};
		if (present(q, "reserveFraction"))
			quota.reserveFraction = readFraction(c, `${path}.quota.reserveFraction`, q.reserveFraction);
		if (present(q, "maxObservationAgeMs")) {
			quota.maxObservationAgeMs = readPositive(c, `${path}.quota.maxObservationAgeMs`, q.maxObservationAgeMs, true);
		}
		if (present(q, "unknown"))
			quota.unknown = readOneOf(c, `${path}.quota.unknown`, ["exclude", "allow"] as const, q.unknown);
		routing.quota = quota;
	}
	if (present(raw, "limits")) {
		const { limits, issues } = parseLocalLimits(raw.limits, `${path}.limits`);
		for (const issue of issues) c.add(issue.path, issue.message);
		if (issues.length === 0) routing.limits = limits;
	}
	if (present(raw, "accounts")) {
		const accounts = parseAccountRouting(c, `${path}.accounts`, raw.accounts);
		if (accounts) routing.accounts = accounts;
	}
	if (present(raw, "cache") && checkFields(c, `${path}.cache`, raw.cache, ["affinity", "pricing"])) {
		const fields = raw.cache;
		const cache: { affinity?: boolean; pricing?: boolean } = {};
		for (const key of ["affinity", "pricing"] as const) {
			const value = fields[key];
			// An explicit null is already reported by checkFields.
			if (typeof value === "boolean") cache[key] = value;
			else if (value !== undefined && value !== null) c.add(`${path}.cache.${key}`, "must be true or false");
		}
		if (fields.affinity === undefined && fields.pricing === undefined) {
			c.add(`${path}.cache`, "set at least one of affinity or pricing");
		} else {
			routing.cache = cache;
		}
	}
	return c.issues.length > before ? undefined : routing;
}

// ----- profiles --------------------------------------------------------------

function parseProfiles(
	c: Collector,
	path: string,
	raw: unknown,
	aliases: readonly string[],
): Map<string, GroupProfile> | undefined {
	const profiles = new Map<string, GroupProfile>();
	if (raw === undefined) return profiles;
	if (!isRecord(raw)) {
		c.add(path, "must be a mapping of profile names to member overrides");
		return undefined;
	}
	if (Object.keys(raw).length > MAX_GROUP_PROFILES) {
		c.add(path, `defines more than ${MAX_GROUP_PROFILES} profiles`);
		return undefined;
	}
	const before = c.issues.length;
	for (const name of Object.keys(raw).sort(compareCodePoints)) {
		const at = `${path}.${modelGroupPathKey(name)}`;
		const entries = raw[name];
		readName(c, at, "profile name", name);
		if (!isRecord(entries)) {
			c.add(at, "expected a mapping of member aliases (use {} for an empty profile)");
			continue;
		}
		const profile: { models: Map<string, { effort?: Effort }> } = { models: new Map() };
		for (const alias of Object.keys(entries).sort(compareCodePoints)) {
			const entryPath = `${at}.${modelGroupPathKey(alias)}`;
			const override = entries[alias];
			if (override === null) {
				c.add(entryPath, "must not be null; omit it instead");
				continue;
			}
			if (c.skip.has(alias)) continue;
			if (!aliases.includes(alias)) {
				c.add(entryPath, `unknown member alias; aliases: ${echoKeys(aliases)}`);
				continue;
			}
			if (!checkFields(c, entryPath, override, ["effort"])) continue;
			const effort = present(override, "effort") ? readEffort(c, `${entryPath}.effort`, override.effort) : undefined;
			profile.models.set(alias, effort !== undefined ? { effort } : {});
		}
		profiles.set(name, profile);
	}
	return c.issues.length > before ? undefined : profiles;
}

// ----- groups ----------------------------------------------------------------

const GROUP_FIELDS = ["strategy", "strategyOptions", "routing", "models", "profiles"] as const;
const INLINE_GROUP_FIELDS = [...GROUP_FIELDS, "profile"] as const;

function parseGroupBody(
	c: Collector,
	path: string,
	raw: Record<string, unknown>,
	inline: boolean,
): ModelGroup | undefined {
	const before = c.issues.length;
	checkFields(c, path, raw, inline ? INLINE_GROUP_FIELDS : GROUP_FIELDS);

	let strategyName: GroupStrategyName | undefined;
	if (raw.strategy === undefined) c.add(path, `strategy is required: ${GROUP_STRATEGIES.join(", ")}`);
	else if (raw.strategy !== null) strategyName = readOneOf(c, `${path}.strategy`, GROUP_STRATEGIES, raw.strategy);

	const modelsPath = `${path}.models`;
	const models: ModelMember[] = [];
	// Every declared key counts for `order` and profile checks, so one bad member reports once.
	let declared: string[] = [];
	if (Array.isArray(raw.models)) {
		c.add(
			modelsPath,
			"must be a mapping of member aliases to { model, defaultEffort?, weight?, account? }; lists are not accepted",
		);
	} else if (!isRecord(raw.models) || Object.keys(raw.models).length === 0) {
		// A misspelled `members` block is reported by the field check alone.
		if (raw.models !== null && !(raw.models === undefined && Object.hasOwn(raw, "members"))) {
			c.add(modelsPath, "must define at least one model");
		}
	} else if (Object.keys(raw.models).length > MAX_GROUP_MODELS) {
		c.add(modelsPath, `defines more than ${MAX_GROUP_MODELS} models`);
	} else {
		declared = Object.keys(raw.models).sort(compareCodePoints);
		for (const alias of declared) {
			if (c.skip.has(alias)) continue;
			const member = parseMember(
				c,
				`${modelsPath}.${modelGroupPathKey(alias)}`,
				alias,
				raw.models[alias],
				strategyName,
			);
			if (member) models.push(member);
		}
	}
	const aliases = declared.filter(alias => !c.skip.has(alias));
	if (declared.length > 0 && aliases.length === 0) c.add(modelsPath, "no valid model remains");

	const strategy =
		strategyName === undefined ? undefined : parseStrategy(c, path, strategyName, raw.strategyOptions, aliases);
	const routing = present(raw, "routing") ? parseRouting(c, `${path}.routing`, raw.routing) : undefined;
	const profiles = parseProfiles(c, `${path}.profiles`, present(raw, "profiles") ? raw.profiles : undefined, aliases);

	let profile: string | undefined;
	if (inline && present(raw, "profile")) {
		if (typeof raw.profile !== "string") {
			c.add(`${path}.profile`, "must be a profile name");
		} else if (readName(c, `${path}.profile`, "profile name", raw.profile)) {
			const defined = isRecord(raw.profiles) ? Object.keys(raw.profiles) : [];
			if (!defined.includes(raw.profile)) {
				c.add(
					`${path}.profile`,
					`names no profile of this group; ${defined.length > 0 ? `profiles: ${echoKeys(defined.sort(compareCodePoints))}` : "it defines no profiles"}`,
				);
			} else {
				profile = raw.profile;
			}
		}
	}

	if (c.issues.length > before || !strategy || !profiles) return undefined;
	return {
		strategy,
		...(routing !== undefined ? { routing } : {}),
		models,
		profiles,
		...(profile !== undefined ? { profile } : {}),
	};
}

function parseGroupRef(c: Collector, path: string, raw: Record<string, unknown>): GroupRef | undefined {
	const before = c.issues.length;
	checkFields(c, path, raw, ["use", "profile"]);
	let use: string | undefined;
	if (raw.use === undefined || (raw.use !== null && typeof raw.use !== "string")) {
		c.add(`${path}.use`, "must be a group name");
	} else if (typeof raw.use === "string" && readName(c, `${path}.use`, "group name", raw.use)) {
		use = raw.use;
	}
	let profile: string | undefined;
	if (present(raw, "profile")) {
		if (typeof raw.profile !== "string") c.add(`${path}.profile`, "must be a profile name");
		else if (readName(c, `${path}.profile`, "profile name", raw.profile)) profile = raw.profile;
	}
	if (c.issues.length > before || use === undefined) return undefined;
	return profile === undefined ? { use } : { use, profile };
}

type ValueSlot = { kind: "role"; role: string } | { kind: "chain" };

function checkLegacyPatterns(c: Collector, path: string, value: string): void {
	for (const pattern of value.split(",")) {
		if (pattern.trim().startsWith(GROUP_REF_SIGIL)) {
			c.add(path, "a group reference must be the whole value, not part of a selector list");
			return;
		}
	}
}

function parseValue(c: Collector, path: string, raw: unknown, slot: ValueSlot): ParsedModelValue | undefined {
	if (raw === null) return { kind: "clear" };
	const kindRole = slot.kind === "role" && !roleAcceptsGroups(slot.role) ? slot.role : undefined;
	const rejectPool = (): undefined => {
		c.add(
			path,
			`${kindRole} takes a model selector or list; model groups are supported only for chat roles, ${POOL_CAPABLE_KIND_ROLES.join(" and ")}`,
		);
		return undefined;
	};
	if (typeof raw === "string") {
		const shorthand = parseGroupShorthand(raw);
		if (shorthand.kind === "invalid") {
			c.add(path, shorthand.message);
			return undefined;
		}
		if (shorthand.kind === "ref")
			return kindRole ? rejectPool() : { kind: "ref", ref: shorthand.ref, shorthand: true };
		if (slot.kind === "chain") {
			c.add(path, "expected a list of selectors, an inline group with models, or a group reference");
			return undefined;
		}
		const before = c.issues.length;
		checkLegacyPatterns(c, path, raw);
		return c.issues.length > before ? undefined : { kind: "selector", value: raw };
	}
	if (Array.isArray(raw)) {
		const before = c.issues.length;
		raw.forEach((item, index) => {
			if (typeof item !== "string") c.add(`${path}[${index}]`, "must be a model selector string");
			else checkLegacyPatterns(c, `${path}[${index}]`, item);
		});
		return c.issues.length > before ? undefined : { kind: "list", value: raw as readonly string[] };
	}
	if (isRecord(raw)) {
		const isGroup = Object.hasOwn(raw, "models");
		const isRef = Object.hasOwn(raw, "use");
		if (isGroup && isRef) {
			c.add(path, "is either an inline group (models) or a group reference (use), not both");
			return undefined;
		}
		if (isGroup || isRef) {
			if (kindRole) return rejectPool();
			if (isGroup) {
				const group = parseGroupBody(c, path, raw, true);
				return group ? { kind: "group", group } : undefined;
			}
			const ref = parseGroupRef(c, path, raw);
			return ref ? { kind: "ref", ref, shorthand: false } : undefined;
		}
		if (Object.hasOwn(raw, "members")) {
			c.add(`${path}.members`, "unsupported field; use models");
			return undefined;
		}
	}
	c.add(
		path,
		slot.kind === "role"
			? "expected a model selector string, a list of selectors, an inline group with models, or a group reference with use"
			: "expected a list of selectors, an inline group with models, or a group reference with use",
	);
	return undefined;
}

/** Rejects a role or chain key that names object internals ({@link FORBIDDEN_ENTRY_KEYS}). */
function checkEntryKey(c: Collector, path: string, key: string): boolean {
	if (!FORBIDDEN_ENTRY_KEYS.includes(key)) return true;
	c.add(path, RESERVED_KEY_MESSAGE);
	return false;
}

// ----- strict and tolerant entry points --------------------------------------

type EntryParser<T> = (c: Collector) => T | undefined;

function runStrict<T>(parse: EntryParser<T>): ModelGroupParseResult<T> {
	const c = new Collector(new Set());
	const value = parse(c);
	if (c.issues.length > 0 || value === undefined) {
		return { ok: false, issues: c.issues.map(({ path, message }) => ({ path, message })) };
	}
	return { ok: true, value, warnings: [] };
}

/**
 * Tolerant parse of one entry. Member-scoped problems skip only those members
 * when at least one member survives and the rest of the value still validates
 * (an `order` or profile naming a skipped alias drops that alias). Any other
 * problem invalidates the entry.
 */
function runTolerant<T>(parse: EntryParser<T>): ModelGroupParseResult<T> {
	const first = new Collector(new Set());
	const value = parse(first);
	if (first.issues.length === 0 && value !== undefined) return { ok: true, value, warnings: [] };
	const failure = { ok: false as const, issues: first.issues.map(({ path, message }) => ({ path, message })) };
	if (!first.issues.every(issue => issue.member !== undefined)) return failure;
	const skip = new Set(first.issues.map(issue => issue.member!));
	const second = new Collector(skip);
	const repaired = parse(second);
	if (second.issues.length > 0 || repaired === undefined) return failure;
	const skipped = first.issues.map(({ path, message }) => ({ path, message: `${message}; member skipped` }));
	return { ok: true, value: repaired, warnings: skipped };
}

function pick<T>(mode: "strict" | "tolerant", parse: EntryParser<T>): ModelGroupParseResult<T> {
	return mode === "strict" ? runStrict(parse) : runTolerant(parse);
}

/** Parses `modelRoles.<role>`; kind roles outside {@link POOL_CAPABLE_KIND_ROLES} reject groups and group references. */
export function parseModelRoleValue(
	role: string,
	value: unknown,
	mode: "strict" | "tolerant" = "strict",
): ModelGroupParseResult<ParsedModelValue> {
	const path = `${SECTION_PATHS.modelRoles}.${modelGroupPathKey(role)}`;
	return pick(mode, c =>
		checkEntryKey(c, path, role) ? parseValue(c, path, value, { kind: "role", role }) : undefined,
	);
}

/** Parses `retry.fallbackChains.<key>`: a selector list, an inline group, or a group reference. */
export function parseFallbackChainValue(
	key: string,
	value: unknown,
	mode: "strict" | "tolerant" = "strict",
): ModelGroupParseResult<ParsedModelValue> {
	const path = `${SECTION_PATHS.fallbackChains}.${modelGroupPathKey(key)}`;
	return pick(mode, c => (checkEntryKey(c, path, key) ? parseValue(c, path, value, { kind: "chain" }) : undefined));
}

/** Parses `modelGroups.<name>`: an inline group without `profile`. */
export function parseModelGroupDefinition(
	name: string,
	value: unknown,
	mode: "strict" | "tolerant" = "strict",
): ModelGroupParseResult<ModelGroup> {
	const path = `${SECTION_PATHS.modelGroups}.${modelGroupPathKey(name)}`;
	return pick(mode, c => {
		const named = readName(c, path, "group name", name);
		if (!isRecord(value)) {
			c.add(path, "expected a group mapping with strategy and models");
			return undefined;
		}
		const group = parseGroupBody(c, path, value, false);
		return named ? group : undefined;
	});
}

type SectionKey = keyof typeof SECTION_PATHS;

function sectionEntries(
	sections: ModelGroupSections,
	key: SectionKey,
	onInvalid: (issue: ModelGroupIssue) => void,
): [string, unknown][] {
	const raw = sections[key];
	if (raw === undefined || raw === null) return [];
	if (!isRecord(raw)) {
		onInvalid({ path: SECTION_PATHS[key], message: "must be a mapping" });
		return [];
	}
	return Object.entries(raw);
}

/** Every problem in the three sections, with paths; empty when all values are valid. */
export function validateModelGroupSections(sections: ModelGroupSections): ModelGroupIssue[] {
	const issues: ModelGroupIssue[] = [];
	const collect = (result: ModelGroupParseResult<unknown>) => {
		if (!result.ok) issues.push(...result.issues);
	};
	for (const [role, value] of sectionEntries(sections, "modelRoles", issue => issues.push(issue))) {
		collect(parseModelRoleValue(role, value, "strict"));
	}
	for (const [key, value] of sectionEntries(sections, "fallbackChains", issue => issues.push(issue))) {
		collect(parseFallbackChainValue(key, value, "strict"));
	}
	for (const [name, value] of sectionEntries(sections, "modelGroups", issue => issues.push(issue))) {
		collect(parseModelGroupDefinition(name, value, "strict"));
	}
	return issues;
}

/** A model group value refused by a strict write; `issues` lists every problem with its settings path. */
export class ModelGroupConfigError extends Error {
	constructor(readonly issues: readonly ModelGroupIssue[]) {
		super(`Invalid model group configuration: ${issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
		this.name = "ModelGroupConfigError";
	}
}

/** A settings write that names a model role one of {@link FORBIDDEN_ENTRY_KEYS}; `issues` holds that one problem. */
export class ReservedModelRoleError extends ModelGroupConfigError {
	constructor(readonly role: string) {
		super([{ path: `${SECTION_PATHS.modelRoles}.${modelGroupPathKey(role)}`, message: RESERVED_KEY_MESSAGE }]);
		this.name = "ReservedModelRoleError";
		this.message = `Invalid model role ${JSON.stringify(modelGroupPathKey(role))}: ${FORBIDDEN_ENTRY_KEYS.map(key => `"${key}"`).join(", ")} are reserved names`;
	}
}

/**
 * Refuses a `modelRoles` role name that is one of {@link FORBIDDEN_ENTRY_KEYS}, for setting and clearing alike.
 *
 * @throws ReservedModelRoleError naming the role.
 */
export function assertModelRoleName(role: string): void {
	if (FORBIDDEN_ENTRY_KEYS.includes(role)) throw new ReservedModelRoleError(role);
}

/**
 * Whether a `modelRoles` or `retry.fallbackChains` value uses a form only model
 * groups define: a mapping (inline group or `use` reference) or a string that
 * starts with {@link GROUP_REF_SIGIL}. Selector strings and lists are legacy
 * forms and never are.
 */
export function isModelGroupForm(value: unknown): boolean {
	if (typeof value === "string") return value.trim().startsWith(GROUP_REF_SIGIL);
	return isRecord(value);
}

/**
 * Strict check of the entries a write puts into one section mapping. In
 * `modelRoles` and `fallbackChains` only {@link isModelGroupForm} entries are
 * checked, so legacy values keep their existing write behavior; every
 * `modelGroups` entry is checked. A reserved role name ({@link assertModelRoleName}) is refused in
 * any `modelRoles` entry.
 *
 * @throws ModelGroupConfigError listing every problem found.
 */
export function assertModelGroupSectionWritable(section: keyof ModelGroupSections, value: unknown): void {
	if (!isRecord(value)) return;
	if (section === "modelRoles") for (const role of Object.keys(value)) assertModelRoleName(role);
	const entries =
		section === "modelGroups"
			? value
			: Object.fromEntries(Object.entries(value).filter(([, entry]) => isModelGroupForm(entry)));
	const issues = validateModelGroupSections({ [section]: entries });
	if (issues.length > 0) throw new ModelGroupConfigError(issues);
}

/** One member of a group as the selector it is applied with. */
export interface GroupMemberSelector {
	member: GroupMember;
	/** `provider/model-id[:effort]`. */
	selector: string;
}

/**
 * The members of `group` as selectors, in configured order: the strategy's
 * `order` for `priority` and `round-robin`, else alias order. Each model takes
 * the effort of `profile` (default: the group's selected profile), else its
 * `defaultEffort`.
 */
export function groupMemberSelectors(
	group: ModelGroup,
	profile: string | undefined = group.profile,
): GroupMemberSelector[] {
	const strategy = group.strategy;
	const order =
		strategy.name === "priority" || strategy.name === "round-robin"
			? strategy.order
			: group.models.map(member => member.alias);
	const members = new Map(group.models.map(member => [member.alias, member]));
	const overrides = profile === undefined ? undefined : group.profiles.get(profile)?.models;
	const selectors: GroupMemberSelector[] = [];
	for (const alias of order) {
		const member = members.get(alias);
		if (member === undefined) continue;
		const effort = overrides?.get(alias)?.effort ?? member.defaultEffort;
		selectors.push({ member, selector: effort === undefined ? member.model : `${member.model}:${effort}` });
	}
	return selectors;
}

/**
 * Comma-separated {@link groupMemberSelectors} standing in for `group` where
 * only a selector string fits (role aliases, string accessors).
 */
export function groupSelectorProjection(group: ModelGroup, profile: string | undefined = group.profile): string {
	return groupMemberSelectors(group, profile)
		.map(entry => entry.selector)
		.join(",");
}
