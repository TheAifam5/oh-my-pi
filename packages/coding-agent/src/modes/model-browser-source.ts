import { type Model, resolveModelServiceTier, type ServiceTier, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	type BillingAllowance,
	type BillingUnknownReason,
	currencyMinorUnitExponent,
} from "@oh-my-pi/pi-ai/usage/billing";
import { parseLocalLimit } from "@oh-my-pi/pi-ai/usage/limits";
import type {
	ModelHubLimitSpecResult,
	ModelHubPool,
	ModelHubPoolTarget,
	ModelHubSource,
	ModelHubWriteTarget,
} from "@oh-my-pi/pi-tui/overlays/model-hub";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { formatDuration, isRecord } from "@oh-my-pi/pi-utils";
import {
	formatGroupStrategies,
	type GroupRouting,
	groupConfiguredOrder,
	isModelGroupForm,
	type ModelGroup,
	ModelGroupConfigError,
	type ParsedModelValue,
	parseFallbackChainValue,
	parseModelRoleValue,
	roleAcceptsGroups,
} from "../config/model-groups";
import { findActiveModelPreset, getModelPresetNames } from "../config/model-presets";
import { resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings } from "../config/settings";
import { describeModelCompactionPoint } from "../session/model-compaction-threshold";

import {
	cfgAuthAccountPolicies,
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelGroups,
	cfgModelProviderOrder,
	cfgModelRoleStorage,
} from "../config/model-settings";
import { AccountAdminError, formatAccountLimitSpec, parseAccountLimitSpec } from "../session/account-admin";
import { poolLimitsSummary } from "../session/local-limits";
import {
	chainPoolId,
	DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS,
	providerBillingResults,
	rolePoolId,
} from "../session/retry-fallback-groups";
import {
	cfgDefaultThinkingLevel,
	cfgRetryFallbackChains,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
} from "../session/settings";

/** Optional host data for {@link createModelBrowserSource}. */
export interface ModelBrowserSourceOptions {
	/**
	 * Usage reports already held by the session, read on every billing lookup; it must not fetch.
	 * Without it the source reports no billing.
	 */
	usageReports?: () => readonly UsageReport[] | undefined;
	/**
	 * Base URL of a catalog model, the billing evidence of self-hosted providers. Without it, or
	 * for a model it does not resolve, those providers report no billing.
	 */
	modelBaseUrl?: (provider: string, id: string) => string | undefined;
}

/**
 * Supply live model-overlay preferences and runtime resolution from the host.
 * @param settings - Settings backing preferences, roles, and model perf
 * @param sessionServiceTier - The live session's effective tier for a model
 *   (`/fast`, `/fast ultra`, `/slow`, resumed tiers). Omit only where no session
 *   exists; the configured `tier.*` settings stand in then.
 * @param options - Optional host data such as the session's usage reports
 */
export function createModelBrowserSource(
	settings: Settings,
	sessionServiceTier?: (model: Model) => ServiceTier | undefined,
	options: ModelBrowserSourceOptions = {},
): ModelHubSource {
	const { usageReports, modelBaseUrl } = options;
	return {
		get billingRevision() {
			return usageReports?.();
		},
		billingFor: usageReports
			? (model: string) => {
					const parsed = parseModelString(model);
					if (!parsed) return undefined;
					const baseUrl = modelBaseUrl?.(parsed.provider, parsed.id);
					return billingSummary(parsed.provider, usageReports(), Date.now(), baseUrl);
				}
			: undefined,
		get revision() {
			return settings.revision;
		},
		get defaultThinkingLevel() {
			return cfgDefaultThinkingLevel.get(settings);
		},
		get modelProviderOrder() {
			return cfgModelProviderOrder.get(settings);
		},
		get knownRoleIds() {
			return getKnownRoleIds(settings);
		},
		get mruOrder() {
			return settings.getStorage()?.getModelUsageOrder() ?? [];
		},
		get modelPerf() {
			return settings.getStorage()?.getModelPerf() ?? new Map();
		},
		serviceTierFor: model => {
			const tier = sessionServiceTier
				? sessionServiceTier(model)
				: resolveModelServiceTier(
						buildServiceTierByFamily(
							cfgTierOpenai.get(settings),
							cfgTierAnthropic.get(settings),
							cfgTierGoogle.get(settings),
						),
						model,
					);
			// Label only a tier the request carries as `service_tier`: that is what the
			// provider echoes back as the served tier, which keys the perf row.
			return shouldSendServiceTier(tier, model) ? tier : undefined;
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(settings);
		},
		get fallbackChains() {
			return cfgRetryFallbackChains.get(settings);
		},
		get fallbackChainGroupKeys() {
			const chains = cfgRetryFallbackChains.get(settings);
			return Object.keys(chains).filter(key => isModelGroupForm(chains[key]));
		},
		get modelRoleStorage() {
			return cfgModelRoleStorage.get(settings);
		},
		get cycleOrder() {
			return cfgCycleOrder.get(settings);
		},
		getModelRole: role => settings.getModelRole(role),
		getProjectModelRole: role => settings.getProjectModelRole(role),
		getGlobalModelRole: role => settings.getGlobalModelRole(role),
		getModelRoleSource: role => settings.getModelRoleSource(role),
		getRoleInfo: role => getRoleInfo(role, settings),
		defaultRoleChain: role => rolePriorityDefaults(role),
		resolveRoleValue: (value, models, roleLookup) => resolveModelRoleValue(value, models, { settings, roleLookup }),
		getModelPresets: () => ({ names: getModelPresetNames(settings), active: findActiveModelPreset(settings) }),
		compactionPointFor: model => describeModelCompactionPoint(settings, model),
		getPool: target => withPoolLimits(settings, target, modelHubPool(settings, target)),
		roleAcceptsPools: role => roleAcceptsGroups(role),
		poolWriteBlocker: target => poolWriteBlocker(settings, target),
		get accountNames() {
			return trustedAccountNames(settings);
		},
		parseLimitSpec: spec => parsePoolLimitSpec(spec),
		formatLimit: limit => {
			const parsed = parseLocalLimit(limit, "limit").limit;
			if (!parsed) return undefined;
			const spec = formatAccountLimitSpec(parsed);
			return parsed.id === undefined ? spec : `${spec} (${parsed.id})`;
		},
		get modelGroupNames() {
			return Object.keys(cfgModelGroups.get(settings));
		},
		modelGroupReferences: name => modelGroupReferences(settings, name),
		modelGroupWriteBlocker: name => modelGroupWriteBlocker(settings, name),
	};
}

/** Names from the highest non-project `auth.accountPolicies` layer. */
function trustedAccountNames(settings: Settings): string[] {
	const policies = settings
		.getLayerValues(cfgAuthAccountPolicies)
		.findLast(layer => layer.source !== "project")?.value;
	const names = (Array.isArray(policies) ? policies : []).flatMap(policy =>
		isRecord(policy) && typeof policy.name === "string" ? [policy.name] : [],
	);
	return [...new Set(names)];
}

/**
 * Persist a pool edit from the model hub to the global config: `value` replaces the role's
 * `modelRoles` entry, the `retry.fallbackChains` entry, or the `modelGroups` entry; `undefined`
 * removes it. Account order and drain names the edit adds must belong to the trusted account-policy
 * layer; names already stored in the pool are kept.
 *
 * @returns the refusal message for an invalid value or newly added untrusted account name; nothing is written then.
 */
export function writeModelHubPool(
	settings: Settings,
	target: ModelHubWriteTarget,
	value: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	try {
		const added = routingAccountNames(value);
		if (added.length > 0) {
			const stored = new Set(routingAccountNames(storedGlobalPool(settings, target)).map(entry => entry.name));
			const trustedNames = trustedAccountNames(settings);
			for (const { field, name } of added) {
				if (!stored.has(name) && !trustedNames.includes(name)) {
					return `routing.accounts.${field}: account ${JSON.stringify(name)} is not defined in trusted auth.accountPolicies`;
				}
			}
		}
		if (target.kind === "role") settings.setModelRoleSpec(target.key, value);
		else if (target.kind === "chain") settings.setFallbackChainSpec(target.key, value);
		else settings.setModelGroup(target.key, value);
		return undefined;
	} catch (error) {
		if (error instanceof ModelGroupConfigError) return error.message;
		throw error;
	}
}

/** The raw pool `target` names in the global config, the layer {@link writeModelHubPool} replaces. */
function storedGlobalPool(settings: Settings, target: ModelHubWriteTarget): unknown {
	const global = settings.getGlobalSettings();
	const section =
		target.kind === "role"
			? global.modelRoles
			: target.kind === "chain"
				? isRecord(global.retry)
					? global.retry.fallbackChains
					: undefined
				: global.modelGroups;
	return isRecord(section) ? section[target.key] : undefined;
}

/** Account names in a pool's `routing.accounts.order` and `routing.accounts.drain`. */
function routingAccountNames(pool: unknown): { field: "order" | "drain"; name: string }[] {
	const routing = isRecord(pool) ? pool.routing : undefined;
	const accounts = isRecord(routing) ? routing.accounts : undefined;
	if (!isRecord(accounts)) return [];
	const names: { field: "order" | "drain"; name: string }[] = [];
	if (Array.isArray(accounts.order)) {
		for (const name of accounts.order) if (typeof name === "string") names.push({ field: "order", name });
	}
	if (typeof accounts.drain === "string") names.push({ field: "drain", name: accounts.drain });
	return names;
}

/** A pool limit from the `/account` limit syntax; values are checked when the pool is written. */
function parsePoolLimitSpec(spec: string): ModelHubLimitSpecResult {
	try {
		return { limit: parseAccountLimitSpec(spec) };
	} catch (error) {
		if (error instanceof AccountAdminError) return { error: error.message };
		throw error;
	}
}

/**
 * Role and fallback-chain entries that reference `modelGroups.<name>`: the effective entries, plus
 * global-layer entries a higher layer shadows.
 */
function modelGroupReferences(settings: Settings, name: string): ModelHubPoolTarget[] {
	const references = new Map<string, ModelHubPoolTarget>();
	const add = (target: ModelHubPoolTarget, spec: ParsedModelValue | undefined) => {
		if (spec?.kind === "ref" && spec.ref.use === name) references.set(`${target.kind}:${target.key}`, target);
	};
	for (const role of Object.keys(settings.getModelRoleEntries())) {
		add({ kind: "role", key: role }, settings.getModelRoleSpec(role));
	}
	for (const key of Object.keys(cfgRetryFallbackChains.get(settings))) {
		add({ kind: "chain", key }, settings.getFallbackChainSpec(key));
	}
	const global = settings.getGlobalSettings();
	const roles = isRecord(global.modelRoles) ? global.modelRoles : {};
	for (const [role, value] of Object.entries(roles)) {
		const parsed = isModelGroupForm(value) ? parseModelRoleValue(role, value, "tolerant") : undefined;
		add({ kind: "role", key: role }, parsed?.ok ? parsed.value : undefined);
	}
	const chains = isRecord(global.retry) && isRecord(global.retry.fallbackChains) ? global.retry.fallbackChains : {};
	for (const [key, value] of Object.entries(chains)) {
		const parsed = isModelGroupForm(value) ? parseFallbackChainValue(key, value, "tolerant") : undefined;
		add({ kind: "chain", key }, parsed?.ok ? parsed.value : undefined);
	}
	return [...references.values()];
}

/**
 * Why a global write of `modelGroups.<name>` would be shadowed: a layer above global defines that
 * entry. Undefined when the global layer supplies it or no layer does.
 */
function modelGroupWriteBlocker(settings: Settings, name: string): string | undefined {
	const owner = settings
		.getLayerValues(cfgModelGroups)
		.findLast(layer => isRecord(layer.value) && Object.hasOwn(layer.value, name));
	return owner === undefined || owner.source === "global" ? undefined : `set in the ${owner.source} layer`;
}

/**
 * Pool view of a role or chain entry; undefined for a legacy value or an unset entry. A global role
 * entry the settings merge drops as invalid yields a view with `invalid` set
 * ({@link invalidGlobalRolePool}); any other invalid entry yields undefined.
 */
function modelHubPool(settings: Settings, target: ModelHubPoolTarget): ModelHubPool | undefined {
	const spec =
		target.kind === "role" ? settings.getModelRoleSpec(target.key) : settings.getFallbackChainSpec(target.key);
	if (spec === undefined && target.kind === "role") return invalidGlobalRolePool(settings, target.key);
	if (spec?.kind !== "group" && spec?.kind !== "ref") return undefined;
	if (spec.kind === "ref") {
		const source = {
			kind: "ref" as const,
			group: spec.ref.use,
			...(spec.ref.profile ? { profile: spec.ref.profile } : {}),
		};
		const group = settings.getModelGroup(spec.ref.use);
		if (!group) {
			return {
				source,
				strategy: "",
				members: [],
				funding: [],
				readOnly: `modelGroups.${spec.ref.use} is not defined`,
			};
		}
		const view = { ...describeGroup(group, spec.ref.profile), source };
		const blocker = modelGroupWriteBlocker(settings, spec.ref.use);
		if (blocker !== undefined) return { ...view, readOnly: `modelGroups.${spec.ref.use} is ${blocker}` };
		const raw = cfgModelGroups.get(settings)[spec.ref.use];
		return isRecord(raw) ? { ...view, raw } : { ...view, readOnly: `modelGroups.${spec.ref.use} is not a mapping` };
	}
	const view = { ...describeGroup(spec.group, spec.group.profile), source: { kind: "inline" as const } };
	const blocker = poolWriteBlocker(settings, target);
	if (blocker !== undefined) return { ...view, readOnly: blocker };
	const raw =
		target.kind === "role"
			? settings.getModelRoleEntries()[target.key]
			: (cfgRetryFallbackChains.get(settings) as Record<string, unknown>)[target.key];
	if (!isRecord(raw)) return { ...view, readOnly: "not an inline group" };
	return { ...view, raw };
}

/**
 * Pool view of the global `modelRoles.<role>` entry when it is in group form and fails validation;
 * undefined otherwise. `invalid` lists the validator's problems.
 */
function invalidGlobalRolePool(settings: Settings, role: string): ModelHubPool | undefined {
	const roles = settings.getGlobalSettings().modelRoles;
	const value = isRecord(roles) && Object.hasOwn(roles, role) ? roles[role] : undefined;
	if (!isModelGroupForm(value)) return undefined;
	const parsed = parseModelRoleValue(role, value, "tolerant");
	if (parsed.ok) return undefined;
	return {
		source: { kind: "inline" },
		strategy: "",
		members: [],
		funding: [],
		invalid: parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; "),
	};
}

/** `pool` with its local limits summary ({@link poolLimitsSummary}) when it has any. */
function withPoolLimits(
	settings: Settings,
	target: ModelHubPoolTarget,
	pool: ModelHubPool | undefined,
): ModelHubPool | undefined {
	if (!pool) return pool;
	const poolId = target.kind === "role" ? rolePoolId(target.key) : chainPoolId(target.key);
	const limits = poolLimitsSummary(settings, poolId, settings.getStorage()?.usageLedger, Date.now());
	return limits ? { ...pool, limits } : pool;
}

/** `amountMinor * 10^-exponent` as an exact decimal string. */
function decimalText(amountMinor: number, exponent: number): string {
	const digits = Math.abs(amountMinor)
		.toString()
		.padStart(exponent + 1, "0");
	const text = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
	return amountMinor < 0 ? `-${text}` : text;
}

/** What remains of `allowance` as display text (`$12.30`, `-$0.50`, `12.30 EUR`, `489.25 credits`, `uncapped`). */
function remainingText(allowance: BillingAllowance | undefined): string | undefined {
	if (!allowance) return undefined;
	if (allowance.uncapped) return "uncapped";
	if (allowance.kind === "credits") {
		const credits = allowance.remaining;
		return credits ? `${decimalText(credits.amountMinor, credits.exponent)} credits` : undefined;
	}
	const money = allowance.remaining;
	if (!money) return undefined;
	const exponent = currencyMinorUnitExponent(money.currency);
	// Without the ISO exponent the minor-unit count is still exact, so show it as such.
	if (exponent === undefined) return `${money.amountMinor} ${money.currency} minor units`;
	if (money.currency !== "USD") return `${decimalText(money.amountMinor, exponent)} ${money.currency}`;
	const sign = money.amountMinor < 0 ? "-" : "";
	return `${sign}$${decimalText(Math.abs(money.amountMinor), exponent)}`;
}

/**
 * Compact billing state of `provider` from `reports` (the session's last polled usage reports):
 * each funding source of every account with known evidence as `mode state [remaining]`,
 * deduplicated, then `(+N unknown)` for the accounts without it; or `unknown (reason)` when no
 * account has evidence; or `undefined` when the provider has no billing reader. Evidence older
 * than the pool funding bound ({@link DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS}) counts as unknown
 * (`stale`). A self-hosted provider is judged from the model's `baseUrl` ({@link providerBillingResults}).
 */
export function billingSummary(
	provider: string,
	reports: readonly UsageReport[] | undefined,
	nowMs: number,
	baseUrl?: string,
): string | undefined {
	const results = providerBillingResults(provider, reports ?? [], nowMs, DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS, {
		baseUrl,
	});
	const parts = new Set<string>();
	let unknownCount = 0;
	let firstUnknown: BillingUnknownReason | undefined;
	for (const result of results) {
		if (result.status === "unknown") {
			if (result.reason === "no-reader") continue;
			unknownCount++;
			firstUnknown ??= result.reason;
			continue;
		}
		for (const source of result.snapshot.sources) {
			const remaining = remainingText(source.allowance);
			parts.add(`${source.mode} ${source.state}${remaining ? ` ${remaining}` : ""}`);
		}
	}
	if (parts.size === 0) return firstUnknown ? `unknown (${firstUnknown})` : undefined;
	const known = [...parts].join(", ");
	return unknownCount > 0 ? `${known} (+${unknownCount} unknown)` : known;
}

/**
 * Why a global write at `target` would be shadowed: the entry comes from a layer above global.
 * Fallback chains report the provenance of the whole `retry.fallbackChains` record.
 */
function poolWriteBlocker(settings: Settings, target: ModelHubPoolTarget): string | undefined {
	const provenance =
		target.kind === "role"
			? settings.getModelRoleProvenance(target.key)
			: settings.getProvenance(cfgRetryFallbackChains);
	return provenance === "global" || provenance === "default" ? undefined : `set in the ${provenance} layer`;
}

/** Members in scheduling order with the efforts `profile` selects, plus routing as display text. */
function describeGroup(group: ModelGroup, profile: string | undefined): Omit<ModelHubPool, "source"> {
	const order = groupConfiguredOrder(group);
	const byAlias = new Map(group.models.map(member => [member.alias, member]));
	const overrides = profile === undefined ? undefined : group.profiles.get(profile)?.models;
	const members: ModelHubPool["members"][number][] = [];
	for (const alias of order) {
		const member = byAlias.get(alias);
		if (!member) continue;
		const effort = overrides?.get(alias)?.effort ?? member.defaultEffort;
		members.push({
			alias,
			model: member.model,
			...(effort !== undefined ? { effort } : {}),
			...(member.weight !== undefined ? { weight: member.weight } : {}),
		});
	}
	const routing = group.routing;
	const quota = routingQuotaText(routing);
	const accounts = routingAccountsText(routing);
	const cache = routingCacheText(routing);
	return {
		strategy: formatGroupStrategies(group),
		members,
		funding: routing?.funding ?? [],
		...(routing?.spending ? { spending: spendingText(routing.spending) } : {}),
		...(quota ? { quota } : {}),
		...(accounts ? { accounts } : {}),
		...(cache ? { cache } : {}),
	};
}

/** A spending policy as display text; a local budget adds its id, window cap, and per-request cap. */
function spendingText(spending: NonNullable<GroupRouting["spending"]>): string {
	if (spending.policy !== "local-hard-budget") return spending.policy;
	const { budget } = spending;
	const window = formatDuration(budget.window.durationMs);
	return `${spending.policy} ${budget.id}: $${budget.window.maxSpend} per ${window}, $${budget.perRequestMax} per request`;
}

/** `routing.quota` as display text; undefined when it sets nothing. */
function routingQuotaText(routing: GroupRouting | undefined): string | undefined {
	const quota = routing?.quota;
	const parts = [
		quota?.reserveFraction !== undefined ? `reserve ${quota.reserveFraction}` : undefined,
		quota?.maxObservationAgeMs !== undefined ? `max age ${formatDuration(quota.maxObservationAgeMs)}` : undefined,
		quota?.unknown !== undefined ? `unknown ${quota.unknown}` : undefined,
	].filter(part => part !== undefined);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

/** `routing.accounts` as display text; undefined when unset. */
function routingAccountsText(routing: GroupRouting | undefined): string | undefined {
	const accounts = routing?.accounts;
	if (!accounts) return undefined;
	const parts = [
		accounts.order ? `order ${accounts.order.join(" → ")}` : undefined,
		accounts.drain !== undefined ? `drain ${accounts.drain}` : undefined,
		accounts.spend ? `spend ${accounts.spend.length > 0 ? accounts.spend.join("+") : "none"}` : undefined,
		accounts.returnWhen ? `return ${accounts.returnWhen.join("+")}` : undefined,
	].filter(part => part !== undefined);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

/** `routing.cache` as display text: each configured flag, `off` when set false; undefined when unset. */
function routingCacheText(routing: GroupRouting | undefined): string | undefined {
	const cache = routing?.cache;
	if (!cache) return undefined;
	const parts = (["affinity", "pricing"] as const).flatMap(field =>
		cache[field] === undefined ? [] : [cache[field] ? field : `${field} off`],
	);
	return parts.length > 0 ? parts.join(", ") : undefined;
}
