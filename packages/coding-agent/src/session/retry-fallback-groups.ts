import type {
	BillingMode,
	BillingResult,
	BillingUnknownReason,
	Provider,
	ProviderBillingRegistry,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { createDefaultBillingRegistry } from "@oh-my-pi/pi-ai/usage/registry";
import {
	type BillingClass,
	type GroupMemberSelector,
	groupMemberSelectors,
	isModelGroupForm,
	type ModelGroup,
	type ParsedModelValue,
} from "../config/model-groups";
import { isKindRole } from "../config/model-role-ids";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "./settings";

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
}

/**
 * The group behind `retry.fallbackChains.<key>`: an inline group, or the `modelGroups.<use>` a
 * reference names through its optional profile. A profile the group does not define selects no
 * effort overrides, as in the role projection. `undefined` for a legacy value, an unset key, or a
 * reference to a missing group (which settings loading already reports).
 */
export function resolveGroupFallbackChain(settings: Settings, key: string): GroupFallbackChain | undefined {
	return groupOfSpec(settings, settings.getFallbackChainSpec(key));
}

/**
 * The group behind `modelRoles.<role>`: an inline pool, or the `modelGroups.<use>` a reference
 * names through its optional profile. `undefined` for a legacy selector, pattern, or list value,
 * an unset role, or a reference to a missing group.
 */
export function resolveRolePoolGroup(settings: Settings, role: string): GroupFallbackChain | undefined {
	if (role.includes("/")) return undefined;
	return groupOfSpec(settings, settings.getModelRoleSpec(role));
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

function groupOfSpec(settings: Settings, spec: ParsedModelValue | undefined): GroupFallbackChain | undefined {
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
	return { group, ...(profile !== undefined ? { profile } : {}), members };
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
 */
export type FundingSkipReason =
	| { kind: "unknown-evidence"; reason: BillingUnknownReason | "unavailable" }
	| { kind: "exhausted" }
	| { kind: "disabled" }
	| { kind: "unauthorized" };

/** Funding stage a candidate draws on, or why it is skipped. `stage` indexes `funding.order`. */
export type FundingVerdict =
	| { kind: "funded"; stage: number; billingClass: BillingClass }
	| { kind: "skipped"; reason: FundingSkipReason };

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
 * is never read as free.
 */
export function fundingVerdict(
	funding: readonly BillingClass[],
	results: readonly BillingResult[] | "unavailable",
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
		if (usable) return { kind: "funded", stage, billingClass };
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
	}
}
