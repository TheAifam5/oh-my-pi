import { type Model, resolveModelServiceTier, type ServiceTier, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import type { ModelHubPool, ModelHubPoolTarget, ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isModelGroupForm, type ModelGroup, ModelGroupConfigError, roleAcceptsGroups } from "../config/model-groups";
import { findActiveModelPreset, getModelPresetNames } from "../config/model-presets";
import { resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings } from "../config/settings";

import {
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelProviderOrder,
	cfgModelRoleStorage,
} from "../config/model-settings";
import { poolLimitsSummary } from "../session/local-limits";
import { chainPoolId, rolePoolId } from "../session/retry-fallback-groups";
import {
	cfgDefaultThinkingLevel,
	cfgRetryFallbackChains,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
} from "../session/settings";

/**
 * Supply live model-overlay preferences and runtime resolution from the host.
 * @param settings - Settings backing preferences, roles, and model perf
 * @param sessionServiceTier - The live session's effective tier for a model
 *   (`/fast`, `/fast ultra`, `/slow`, resumed tiers). Omit only where no session
 *   exists; the configured `tier.*` settings stand in then.
 */
export function createModelBrowserSource(
	settings: Settings,
	sessionServiceTier?: (model: Model) => ServiceTier | undefined,
): ModelHubSource {
	return {
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
		getPool: target => withPoolLimits(settings, target, modelHubPool(settings, target)),
		roleAcceptsPools: role => roleAcceptsGroups(role),
		poolWriteBlocker: target => poolWriteBlocker(settings, target),
	};
}

/**
 * Persist a pool edit from the model hub to the global config: `value` replaces the role's
 * `modelRoles` entry or the `retry.fallbackChains` entry; `undefined` removes it.
 *
 * @returns the validator's message when the value is refused; nothing is written then.
 */
export function writeModelHubPool(
	settings: Settings,
	target: ModelHubPoolTarget,
	value: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	try {
		if (target.kind === "role") settings.setModelRoleSpec(target.key, value);
		else settings.setFallbackChainSpec(target.key, value);
		return undefined;
	} catch (error) {
		if (error instanceof ModelGroupConfigError) return error.message;
		throw error;
	}
}

/** Pool view of a role or chain entry; undefined for a legacy value, an unset entry, or a value that fails validation. */
function modelHubPool(settings: Settings, target: ModelHubPoolTarget): ModelHubPool | undefined {
	const spec =
		target.kind === "role" ? settings.getModelRoleSpec(target.key) : settings.getFallbackChainSpec(target.key);
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
		return {
			...describeGroup(group, spec.ref.profile),
			source,
			readOnly: `edit modelGroups.${spec.ref.use} in config`,
		};
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
	const strategy = group.strategy;
	const order =
		strategy.name === "priority" || strategy.name === "round-robin"
			? strategy.order
			: group.models.map(member => member.alias);
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
	return {
		strategy: strategy.name,
		members,
		funding: routing?.funding ?? [],
		...(routing?.spending ? { spending: routing.spending.policy } : {}),
	};
}
