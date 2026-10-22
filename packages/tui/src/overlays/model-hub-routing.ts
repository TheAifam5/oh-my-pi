/**
 * Edits of a model pool's raw configuration as the model hub writes it: `routing.quota`,
 * `routing.accounts`, `routing.cache`, `routing.spending` with the `metered` funding class,
 * `routing.limits`, and strategy lists. Each function mutates the draft it is given and leaves
 * validation to the host's strict validator; empty routing mappings are removed.
 */
import { DRAIN_RETURN_TRIGGERS, DRAIN_SPEND_CLASSES } from "@oh-my-pi/pi-ai/auth/types";
import { isRecord } from "@oh-my-pi/pi-utils";

/** `routing.quota.reserveFraction` values `r` cycles through; `undefined` leaves the global reserve. */
export const POOL_RESERVE_CYCLE: readonly (number | undefined)[] = [undefined, 0.05, 0.1, 0.2, 0.3];

/** `routing.quota.unknown` values `u` cycles through; `undefined` keeps members with unknown quota. */
export const POOL_QUOTA_UNKNOWN_CYCLE: readonly ("exclude" | "allow" | undefined)[] = [undefined, "exclude", "allow"];

/** Funding classes a drain target may spend (`routing.accounts.spend`). */
export const POOL_DRAIN_SPEND: readonly string[] = DRAIN_SPEND_CLASSES;

/** Events that return a drained account (`routing.accounts.returnWhen`). */
export const POOL_DRAIN_RETURN: readonly string[] = DRAIN_RETURN_TRIGGERS;

/** Syntax of a local hard budget as the hub reads it. */
export const BUDGET_SPEC_USAGE = "<id> <perRequestMax> <maxSpend> <window: <n>m|<n>h|<n>d>, such as daily 0.50 5.00 1d";

const DURATION_UNITS_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1 } as const;

/** `parent[key]` as a mapping, replacing a missing or non-mapping value with an empty one. */
export function draftRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = parent[key];
	if (isRecord(value)) return value;
	const created: Record<string, unknown> = {};
	parent[key] = created;
	return created;
}

/** `raw.routing[field]` as a mapping; empty when absent. Never mutates `raw`. */
export function routingSection(
	raw: Readonly<Record<string, unknown>> | undefined,
	field: string,
): Record<string, unknown> {
	const routing = raw?.routing;
	const value = isRecord(routing) ? routing[field] : undefined;
	return isRecord(value) ? value : {};
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Remove empty `routing.quota`, `routing.accounts`, `routing.cache`, and then an empty `routing`. */
function pruneRouting(draft: Record<string, unknown>): void {
	const routing = draft.routing;
	if (!isRecord(routing)) return;
	for (const field of ["quota", "accounts", "cache"]) {
		const section = routing[field];
		if (isRecord(section) && Object.keys(section).length === 0) delete routing[field];
	}
	if (Object.keys(routing).length === 0) delete draft.routing;
}

/** `routing.cache[field]`: unset or `false` becomes `true`; `true` is removed (the default is off). */
export function toggleCacheField(draft: Record<string, unknown>, field: "affinity" | "pricing"): void {
	const cache = draftRecord(draftRecord(draft, "routing"), "cache");
	if (cache[field] === true) delete cache[field];
	else cache[field] = true;
	pruneRouting(draft);
}

/** Step `routing.quota[field]` to the entry after its current value in `cycle`; `undefined` removes it. */
function cycleQuotaField(draft: Record<string, unknown>, field: string, cycle: readonly unknown[]): void {
	const quota = draftRecord(draftRecord(draft, "routing"), "quota");
	const next = cycle[(cycle.indexOf(quota[field]) + 1) % cycle.length];
	if (next === undefined) delete quota[field];
	else quota[field] = next;
	pruneRouting(draft);
}

/** `u`: step `routing.quota.unknown` through {@link POOL_QUOTA_UNKNOWN_CYCLE}. */
export function cycleQuotaUnknown(draft: Record<string, unknown>): void {
	cycleQuotaField(draft, "unknown", POOL_QUOTA_UNKNOWN_CYCLE);
}

/** `r`: step `routing.quota.reserveFraction` through {@link POOL_RESERVE_CYCLE}. */
export function cycleQuotaReserve(draft: Record<string, unknown>): void {
	cycleQuotaField(draft, "reserveFraction", POOL_RESERVE_CYCLE);
}

/** Account names `raw` lists in `routing.accounts.order`. */
export function accountOrder(raw: Readonly<Record<string, unknown>> | undefined): string[] {
	return strings(routingSection(raw, "accounts").order);
}

/** Classes or triggers `raw` lists in `routing.accounts[field]`; a lone `returnWhen` string counts as one. */
export function accountList(
	raw: Readonly<Record<string, unknown>> | undefined,
	field: "spend" | "returnWhen",
): string[] {
	return strings(routingSection(raw, "accounts")[field]);
}

/** `routing.accounts.drain`; undefined when unset. */
export function accountDrain(raw: Readonly<Record<string, unknown>> | undefined): string | undefined {
	const drain = routingSection(raw, "accounts").drain;
	return typeof drain === "string" ? drain : undefined;
}

/** Add `value` to the end of `routing.accounts[field]`, or remove it; an emptied list is removed. */
export function toggleAccountEntry(
	draft: Record<string, unknown>,
	field: "order" | "spend" | "returnWhen",
	value: string,
): void {
	const accounts = draftRecord(draftRecord(draft, "routing"), "accounts");
	const list = strings(accounts[field]);
	const index = list.indexOf(value);
	if (index >= 0) list.splice(index, 1);
	else list.push(value);
	if (list.length === 0) delete accounts[field];
	else accounts[field] = list;
	pruneRouting(draft);
}

/** Set `routing.accounts.drain` to `name`; `undefined` removes it. */
export function setAccountDrain(draft: Record<string, unknown>, name: string | undefined): void {
	const accounts = draftRecord(draftRecord(draft, "routing"), "accounts");
	if (name === undefined) delete accounts.drain;
	else accounts.drain = name;
	pruneRouting(draft);
}

/** Strategy names `raw` configures: its strategy, or the entries of its strategy list. */
export function strategyNames(raw: Readonly<Record<string, unknown>> | undefined): string[] {
	return strings(raw?.strategy);
}

/** `strategyOptions` fields each strategy consumes, beyond the `order` of priority and round-robin. */
const STRATEGY_OPTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
	quota: ["objective", "capacityMetric", "tolerance"],
	"least-used": ["window"],
};

/**
 * Add `name` to the end of the draft's strategy list, or remove it. One remaining entry is written
 * as a plain strategy. `strategyOptions` keeps only the fields a remaining entry consumes; a new
 * priority or round-robin entry orders the members as `aliases`; without weighted-random the
 * member weights are dropped.
 */
export function toggleStrategy(draft: Record<string, unknown>, name: string, aliases: readonly string[]): void {
	const names = strategyNames(draft);
	const index = names.indexOf(name);
	if (index >= 0) names.splice(index, 1);
	else names.push(name);
	const options = isRecord(draft.strategyOptions) ? draft.strategyOptions : {};
	const next: Record<string, unknown> = {};
	if (names.includes("priority") || names.includes("round-robin")) {
		next.order = Array.isArray(options.order) ? options.order : [...aliases];
	}
	for (const strategy of names) {
		for (const field of STRATEGY_OPTION_FIELDS[strategy] ?? []) {
			if (Object.hasOwn(options, field)) next[field] = options[field];
		}
	}
	draft.strategy = names.length === 1 ? names[0] : names;
	if (Object.keys(next).length > 0) draft.strategyOptions = next;
	else delete draft.strategyOptions;
	if (!names.includes("weighted-random")) {
		const models = draft.models;
		if (isRecord(models)) for (const member of Object.values(models)) if (isRecord(member)) delete member.weight;
	}
}

/** Set `strategyOptions.tolerance`; `undefined` removes it. */
export function setQuotaTolerance(draft: Record<string, unknown>, tolerance: number | undefined): void {
	const options = draftRecord(draft, "strategyOptions");
	if (tolerance === undefined) delete options.tolerance;
	else options.tolerance = tolerance;
	if (Object.keys(options).length === 0) delete draft.strategyOptions;
}

/** Funding classes `raw` lists in `routing.funding.order`; undefined without a funding order. */
export function fundingOrder(raw: Readonly<Record<string, unknown>> | undefined): string[] | undefined {
	const routing = raw?.routing;
	const order = isRecord(routing) && isRecord(routing.funding) ? routing.funding.order : undefined;
	return Array.isArray(order) ? strings(order) : undefined;
}

/**
 * Authorize `metered` with `spending` (`routing.spending`), appending `metered` to the funding order,
 * which starts as `included` when the pool has none; `undefined` removes the spending policy and
 * `metered`.
 */
export function setMeteredSpending(
	draft: Record<string, unknown>,
	spending: Readonly<Record<string, unknown>> | undefined,
): void {
	const routing = draftRecord(draft, "routing");
	const order = fundingOrder(draft);
	const funding = isRecord(routing.funding) ? routing.funding : {};
	if (spending !== undefined) {
		routing.funding = {
			...funding,
			order: [...(order ?? ["included"]).filter(entry => entry !== "metered"), "metered"],
		};
		routing.spending = { ...spending };
	} else {
		delete routing.spending;
		if (order !== undefined) routing.funding = { ...funding, order: order.filter(entry => entry !== "metered") };
	}
	pruneRouting(draft);
}

/** `routing.limits` of `raw`; empty when unset. */
export function poolLimitList(raw: Readonly<Record<string, unknown>> | undefined): unknown[] {
	const limits = isRecord(raw?.routing) ? raw.routing.limits : undefined;
	return Array.isArray(limits) ? limits : [];
}

/** Append `limit` to `routing.limits`. */
export function appendPoolLimit(draft: Record<string, unknown>, limit: Readonly<Record<string, unknown>>): void {
	const routing = draftRecord(draft, "routing");
	routing.limits = [...poolLimitList(draft), { ...limit }];
}

/** Remove entry `index` of `routing.limits`; an emptied list is removed. */
export function removePoolLimit(draft: Record<string, unknown>, index: number): void {
	const routing = draftRecord(draft, "routing");
	const limits = poolLimitList(draft).filter((_, at) => at !== index);
	if (limits.length === 0) delete routing.limits;
	else routing.limits = limits;
	pruneRouting(draft);
}

/** `ms` as `<n>d`, `<n>h`, `<n>m`, or `<n>ms`, whichever unit divides it. */
function durationSpec(ms: number): string {
	for (const unit of ["d", "h", "m"] as const) {
		if (ms % DURATION_UNITS_MS[unit] === 0) return `${ms / DURATION_UNITS_MS[unit]}${unit}`;
	}
	return `${ms}ms`;
}

/**
 * A `local-hard-budget` spending policy from `<id> <perRequestMax> <maxSpend> <window>`, where the
 * window is `<n>m`, `<n>h`, `<n>d`, or `<n>ms` and amounts may lead with `$`; or why the text does
 * not have that shape. Values are checked by the validator.
 */
export function parseBudgetSpec(spec: string): { spending: Record<string, unknown> } | { error: string } {
	const words = spec.trim().split(/\s+/);
	const window = /^(\d+)(ms|m|h|d)$/.exec(words[3] ?? "");
	if (words.length !== 4 || !window) return { error: `Budget: ${BUDGET_SPEC_USAGE}` };
	const unit = window[2] as keyof typeof DURATION_UNITS_MS;
	const amount = (word: string) => word.replace(/^\$/, "");
	return {
		spending: {
			policy: "local-hard-budget",
			budget: {
				id: words[0],
				currency: "USD",
				perRequestMax: amount(words[1]!),
				window: {
					type: "rolling",
					durationMs: Number(window[1]) * DURATION_UNITS_MS[unit],
					maxSpend: amount(words[2]!),
				},
			},
		},
	};
}

/** The `local-hard-budget` of `raw` in the {@link parseBudgetSpec} syntax; empty when there is none. */
export function formatBudgetSpec(raw: Readonly<Record<string, unknown>> | undefined): string {
	const spending = routingSection(raw, "spending");
	const budget = isRecord(spending.budget) ? spending.budget : undefined;
	const window = isRecord(budget?.window) ? budget.window : undefined;
	if (!budget || !window || typeof window.durationMs !== "number") return "";
	return [budget.id, budget.perRequestMax, window.maxSpend, durationSpec(window.durationMs)].join(" ");
}

/** `routing.spending.policy` of `raw`; undefined when unset. */
export function spendingPolicy(raw: Readonly<Record<string, unknown>> | undefined): string | undefined {
	const policy = routingSection(raw, "spending").policy;
	return typeof policy === "string" ? policy : undefined;
}
