import type {
	BillingMode,
	BillingResult,
	BillingUnknownReason,
	Provider,
	ProviderBillingRegistry,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { createDefaultBillingRegistry } from "@oh-my-pi/pi-ai/usage/registry";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type BillingClass,
	decimalNanos,
	type GroupBudget,
	type GroupMemberSelector,
	type GroupSpendingPolicy,
	groupMemberSelectors,
	isModelGroupForm,
	type ModelGroup,
	type ParsedModelValue,
} from "../config/model-groups";
import { isKindRole } from "../config/model-role-ids";
import { cfgModelGroups } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "./settings";
import type { SpendLedger } from "./spend-ledger";

/** Oldest usage or billing observation a group acts on when `routing.quota.maxObservationAgeMs` is unset, in ms. */
export const DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Billing readers consulted by group funding filters. Holds the built-in readers; a reader
 * registered here applies to every session in the process.
 */
export const retryFallbackBillingRegistry: ProviderBillingRegistry = createDefaultBillingRegistry();

/** A `retry.fallbackChains` key configured as a model group, resolved to its members. */
export interface GroupFallbackChain {
	group: ModelGroup;
	/** Profile whose efforts the members carry. */
	profile?: string;
	/** Members in configured order; never empty. */
	members: GroupMemberSelector[];
	/**
	 * Identity of the pool in the usage ledger and for `routing.limits`: `role:<role>` for a
	 * `modelRoles` pool, `chain:<key>` for a `retry.fallbackChains` pool, whether the entry is
	 * inline or references `modelGroups`.
	 */
	poolId: string;
}

/** {@link GroupFallbackChain.poolId} of the `modelRoles.<role>` pool. */
export function rolePoolId(role: string): string {
	return `role:${role}`;
}

/** {@link GroupFallbackChain.poolId} of the `retry.fallbackChains.<key>` pool. */
export function chainPoolId(key: string): string {
	return `chain:${key}`;
}

/**
 * The group behind `retry.fallbackChains.<key>`: an inline group, or the `modelGroups.<use>` a
 * reference names through its optional profile. A profile the group does not define selects no
 * effort overrides, as in the role projection. `undefined` for a legacy value, an unset key, or a
 * reference to a missing group (which settings loading already reports).
 */
export function resolveGroupFallbackChain(settings: Settings, key: string): GroupFallbackChain | undefined {
	return groupOfSpec(settings, settings.getFallbackChainSpec(key), chainPoolId(key));
}

/**
 * The group behind `modelRoles.<role>`: an inline pool, or the `modelGroups.<use>` a reference
 * names through its optional profile. `undefined` for a legacy selector, pattern, or list value,
 * an unset role, or a reference to a missing group.
 */
export function resolveRolePoolGroup(settings: Settings, role: string): GroupFallbackChain | undefined {
	if (role.includes("/")) return undefined;
	return groupOfSpec(settings, settings.getModelRoleSpec(role), rolePoolId(role));
}

/** Member selectors of `role`'s pool in configured order ({@link resolveRolePoolGroup}); `undefined` for a legacy role. */
export function rolePoolMemberSelectors(settings: Settings, role: string): string[] | undefined {
	return resolveRolePoolGroup(settings, role)?.members.map(entry => entry.selector);
}

/**
 * `chains` with an empty chain for every chat pool role that has none, so a pool role owns its walk
 * across its own members even without configured fallbacks. Model-kind roles get none.
 */
export function withRolePoolChainKeys(chains: Record<string, string[]>, settings: Settings): Record<string, string[]> {
	let result = chains;
	for (const role of Object.keys(settings.getModelRoles())) {
		// Model-kind roles never own a chain they did not configure, as in expandDefaultRetryFallbackChains.
		if (isKindRole(role) || Object.hasOwn(result, role) || !resolveRolePoolGroup(settings, role)) continue;
		if (result === chains) result = { ...chains };
		result[role] = [];
	}
	return result;
}

function groupOfSpec(
	settings: Settings,
	spec: ParsedModelValue | undefined,
	poolId: string,
): GroupFallbackChain | undefined {
	let group: ModelGroup | undefined;
	let profile: string | undefined;
	if (spec?.kind === "group") {
		group = spec.group;
		profile = group.profile;
	} else if (spec?.kind === "ref") {
		group = settings.getModelGroup(spec.ref.use);
		profile = spec.ref.profile;
	}
	if (!group) return undefined;
	const members = groupMemberSelectors(group, profile);
	if (members.length === 0) return undefined;
	return { group, ...(profile !== undefined ? { profile } : {}), members, poolId };
}

/**
 * Configured `retry.fallbackChains` in configured key order, with each model-group entry replaced
 * by its member selectors ({@link resolveGroupFallbackChain}). A group entry that resolves to no
 * group reads as unset.
 */
export function getRetryFallbackChainsWithGroups(settings: Settings): Record<string, string[]> {
	const configured = cfgRetryFallbackChains.get(settings);
	if (!configured || typeof configured !== "object") return {};
	const entries: [string, string[]][] = [];
	for (const key in configured) {
		if (!Object.hasOwn(configured, key)) continue;
		const value = configured[key];
		if (!isModelGroupForm(value)) {
			entries.push([key, value]);
			continue;
		}
		const chain = resolveGroupFallbackChain(settings, key);
		if (chain) entries.push([key, chain.members.map(entry => entry.selector)]);
	}
	return Object.fromEntries(entries);
}

/**
 * The group whose strategy and routing govern the walk of `chainKey`: the role's own pool
 * ({@link resolveRolePoolGroup}), else the chain's ({@link resolveChainGroupPolicy}).
 */
export function resolveRetryFallbackGroupPolicy(settings: Settings, chainKey: string): GroupFallbackChain | undefined {
	return resolveRolePoolGroup(settings, chainKey) ?? resolveChainGroupPolicy(settings, chainKey);
}

/**
 * The group of `retry.fallbackChains` that governs `chainKey`'s configured entries: its own group
 * entry, or, for a chat role key without a usable chain of its own, the group at `default` (the
 * chain it walks). A model-kind role never inherits `default`, matching the chains it walks.
 * `undefined` when the chain is a legacy selector list, which keeps configured order and no
 * funding filter.
 */
export function resolveChainGroupPolicy(settings: Settings, chainKey: string): GroupFallbackChain | undefined {
	const configured = cfgRetryFallbackChains.get(settings);
	if (Object.hasOwn(configured, chainKey)) {
		if (!isModelGroupForm(configured[chainKey])) return undefined;
		const own = resolveGroupFallbackChain(settings, chainKey);
		if (own) return own;
	}
	if (chainKey === "default" || chainKey.includes("/") || isKindRole(chainKey)) return undefined;
	return Object.hasOwn(configured, "default") && isModelGroupForm(configured.default)
		? resolveGroupFallbackChain(settings, "default")
		: undefined;
}

// ----- funding ---------------------------------------------------------------

/** Billing class a funding source of `mode` draws on; `undefined` when the mode is unknown. */
export function billingClassOfMode(mode: BillingMode): BillingClass | undefined {
	switch (mode) {
		case "subscription-included":
			return "included";
		case "free":
			return "free";
		case "metered":
		case "paid-extra-usage":
		case "prepaid-credits":
			return "metered";
		case "unknown":
			return undefined;
	}
}

/**
 * Why a candidate was left out by its group's funding policy.
 *
 * - `unknown-evidence`: no fresh, usable billing evidence; `unavailable` means the usage reports
 *   could not be read in time.
 * - `exhausted` / `disabled`: every source of an authorized class is exhausted or disabled.
 * - `unauthorized`: the account draws only on classes `funding.order` does not list.
 * - `budget-exhausted`: metered funding under `local-hard-budget` whose window has no room left
 *   for another request ({@link meteredSpendingRefusal}).
 * - `budget-unreadable`: metered funding under `local-hard-budget` whose spend ledger could not be
 *   read, so the budget cannot be checked.
 */
export type FundingSkipReason =
	| { kind: "unknown-evidence"; reason: BillingUnknownReason | "unavailable" }
	| { kind: "exhausted" }
	| { kind: "disabled" }
	| { kind: "unauthorized" }
	| { kind: "budget-exhausted" }
	| { kind: "budget-unreadable" };

/** Funding stage a candidate draws on, or why it is skipped. `stage` indexes `funding.order`. */
export type FundingVerdict =
	| { kind: "funded"; stage: number; billingClass: BillingClass }
	| { kind: "skipped"; reason: FundingSkipReason };

/**
 * Spend charged to `budget` in its rolling window ending now, in nano-USD, or `unavailable` when
 * the spend ledger cannot be read.
 */
export type BudgetSpendReader = (budget: GroupBudget) => bigint | "unavailable";

/**
 * A {@link BudgetSpendReader} over `ledger` for the window ending at `nowMs`, reading each budget
 * window once. Without a ledger, or when a read fails, every budget reads `unavailable`.
 */
export function ledgerBudgetSpend(ledger: SpendLedger | undefined, nowMs: number): BudgetSpendReader {
	const spent = new Map<string, bigint | "unavailable">();
	return budget => {
		if (!ledger) return "unavailable";
		const key = `${budget.id}\n${budget.window.durationMs}`;
		let result = spent.get(key);
		if (result === undefined) {
			try {
				result = ledger.spentInWindow(budget.id, budget.window.durationMs, nowMs);
			} catch (error) {
				logger.warn("Spend ledger could not be read; local budget members are skipped", {
					budget: budget.id,
					error: String(error),
				});
				result = "unavailable";
			}
			spent.set(key, result);
		}
		return result;
	};
}

/**
 * Why metered spending may not proceed under `spending`, or `undefined` when it may.
 *
 * Only `local-hard-budget` is checked: it admits a request while its window's spend plus
 * `perRequestMax` stays within `window.maxSpend`. A request's cost is known only after it
 * completes, so the window can overshoot by what one request costs above `perRequestMax`. A
 * budget whose spend cannot be read, including one checked without `budgetSpend`, is refused.
 */
export function meteredSpendingRefusal(
	spending: GroupSpendingPolicy | undefined,
	budgetSpend: BudgetSpendReader | undefined,
): FundingSkipReason | undefined {
	if (spending?.policy !== "local-hard-budget") return undefined;
	const spent = budgetSpend?.(spending.budget) ?? "unavailable";
	const maxSpend = decimalNanos(spending.budget.window.maxSpend);
	const perRequestMax = decimalNanos(spending.budget.perRequestMax);
	if (spent === "unavailable" || maxSpend === undefined || perRequestMax === undefined) {
		return { kind: "budget-unreadable" };
	}
	return spent >= maxSpend || spent + perRequestMax > maxSpend ? { kind: "budget-exhausted" } : undefined;
}

/**
 * Funding verdict for one candidate from the billing results of its provider's accounts (one per
 * usage report, freshness already applied). The first class in `funding` that some account can
 * draw on wins.
 *
 * Source-state contract: an `included` or `free` source counts unless it is `exhausted` or
 * `disabled`, so its `unknown` state is usable (subscription windows are model-scoped and their
 * exhaustion is judged by quota ranking, see `BillingSourceState`). A `metered` source counts only
 * when reported `available`, since an unknown state is not authorization to spend.
 * Results that are all `unknown`, or `unavailable` reports, skip the candidate: missing evidence
 * is never read as free. A usable metered source is further gated by `spending`
 * ({@link meteredSpendingRefusal}).
 */
export function fundingVerdict(
	funding: readonly BillingClass[],
	results: readonly BillingResult[] | "unavailable",
	spending?: GroupSpendingPolicy,
	budgetSpend?: BudgetSpendReader,
): FundingVerdict {
	if (results === "unavailable") {
		return { kind: "skipped", reason: { kind: "unknown-evidence", reason: "unavailable" } };
	}
	const sources = results.flatMap(result => (result.status === "known" ? result.snapshot.sources : []));
	if (sources.length === 0) {
		const unknown = results.find(result => result.status === "unknown");
		return {
			kind: "skipped",
			reason: { kind: "unknown-evidence", reason: unknown?.status === "unknown" ? unknown.reason : "no-report" },
		};
	}
	let blocked: FundingSkipReason | undefined;
	for (const [stage, billingClass] of funding.entries()) {
		const ofClass = sources.filter(source => billingClassOfMode(source.mode) === billingClass);
		const usable = ofClass.some(
			source =>
				source.state !== "exhausted" &&
				source.state !== "disabled" &&
				(billingClass !== "metered" || source.state === "available"),
		);
		if (usable) {
			const refused = billingClass === "metered" ? meteredSpendingRefusal(spending, budgetSpend) : undefined;
			if (refused) return { kind: "skipped", reason: refused };
			return { kind: "funded", stage, billingClass };
		}
		if (ofClass.some(source => source.state === "disabled")) blocked ??= { kind: "disabled" };
		else if (ofClass.some(source => source.state === "exhausted")) blocked ??= { kind: "exhausted" };
		else if (ofClass.length > 0) blocked ??= { kind: "unknown-evidence", reason: "no-evidence" };
	}
	if (blocked) return { kind: "skipped", reason: blocked };
	if (sources.every(source => billingClassOfMode(source.mode) === undefined)) {
		return { kind: "skipped", reason: { kind: "unknown-evidence", reason: "no-evidence" } };
	}
	return { kind: "skipped", reason: { kind: "unauthorized" } };
}

/**
 * Billing results of `provider`'s accounts from `reports`, with known evidence older than
 * `maxAgeMs` turned `stale`. `reports` undefined means the reports could not be read. A provider
 * with no report yields one `unknown` result naming why.
 */
export function providerBillingResults(
	provider: Provider,
	reports: readonly UsageReport[] | undefined,
	nowMs: number,
	maxAgeMs: number,
	registry: ProviderBillingRegistry = retryFallbackBillingRegistry,
): BillingResult[] | "unavailable" {
	if (reports === undefined) return "unavailable";
	const own = reports.filter(report => report.provider === provider);
	if (own.length === 0) return [registry.read(provider, null)];
	return own.map(report => registry.readFresh(provider, report, nowMs, maxAgeMs));
}

/** Short user-facing description of a skip reason. */
export function describeFundingSkip(reason: FundingSkipReason): string {
	switch (reason.kind) {
		case "unknown-evidence":
			return reason.reason === "unavailable"
				? "billing evidence unavailable"
				: `billing evidence unknown (${reason.reason})`;
		case "exhausted":
			return "funding exhausted";
		case "disabled":
			return "funding disabled";
		case "unauthorized":
			return "billing class not authorized";
		case "budget-exhausted":
			return "local budget exhausted";
		case "budget-unreadable":
			return "local budget spend unreadable";
	}
}

/**
 * Whether a completed call funded by `results` is charged to a local budget: every call except one
 * that `funding` would fund from an `included` or `free` source. Missing or unknown evidence charges
 * the call, so a budget over-counts rather than under-counts.
 */
export function chargesLocalBudget(
	funding: readonly BillingClass[],
	results: readonly BillingResult[] | "unavailable",
): boolean {
	// No spending gate: a call that already ran is classified, not authorized.
	const verdict = fundingVerdict(funding, results);
	return verdict.kind !== "funded" || verdict.billingClass === "metered";
}

/**
 * Whether {@link chargesLocalBudget} needs billing evidence for `funding`: only an `included` or
 * `free` stage can leave a call uncharged, so a metered-only order charges every call.
 */
export function chargeNeedsBillingEvidence(funding: readonly BillingClass[]): boolean {
	return funding.some(billingClass => billingClass !== "metered");
}

/** Whether a settings instance configures a local budget, recomputed only when its revision moves on. */
const localBudgetsCache = new WeakMap<Settings, { revision: number; configured: boolean }>();

/**
 * Whether any effective model group, role pool, or fallback chain of `settings` uses
 * `local-hard-budget`. Computed once per settings revision.
 */
export function hasLocalBudgets(settings: Settings): boolean {
	const revision = settings.revision;
	const cached = localBudgetsCache.get(settings);
	if (cached?.revision === revision) return cached.configured;
	const groups: (ModelGroup | undefined)[] = [];
	for (const name of Object.keys(cfgModelGroups.get(settings))) groups.push(settings.getModelGroup(name));
	for (const role of Object.keys(settings.getModelRoles())) groups.push(resolveRolePoolGroup(settings, role)?.group);
	for (const key of Object.keys(cfgRetryFallbackChains.get(settings))) {
		groups.push(resolveGroupFallbackChain(settings, key)?.group);
	}
	const configured = groups.some(group => group?.routing?.spending?.policy === "local-hard-budget");
	localBudgetsCache.set(settings, { revision, configured });
	return configured;
}
