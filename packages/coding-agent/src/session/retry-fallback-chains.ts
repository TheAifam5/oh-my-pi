import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ModelUsageHealth, ModelUsageHealthState } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { cfgModelRoles, type ModelRoleEntry } from "../config/model-settings";
import { formatModelSelectorValue, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { formatModelString, formatModelStringWithRouting } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
} from "@oh-my-pi/pi-tui/thinking";
import { resolveConfiguredModelPatterns, resolveModelRoleValue } from "../config/model-resolver";
import { getRoleInfo, isKindRole } from "../config/model-roles";

import {
	assertModelRoleName,
	type GroupStrategyName,
	isModelGroupForm,
	parseFallbackChainValue,
} from "../config/model-groups";
import { getSelectorFallbackChains } from "./retry-fallback-selector-chains";
import { cfgRetryFallbackChains, cfgRetryFallbackRevertPolicy } from "./settings";

/** Configured fallback chains keyed by role or model selector. */
export type RetryFallbackChains = Record<string, string[]>;

/** Policy controlling restoration of a fallback chain's primary model. */
export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

/** How a fallback chain orders its candidates. A selector-list chain always uses `priority`. */
export type RetryFallbackStrategy = GroupStrategyName;

/** Usage evidence the `quota` strategy ranks one candidate by. */
export interface RetryFallbackQuotaEvidence {
	state: ModelUsageHealthState;
	/** Largest remaining quota fraction (0..1) among the candidate's usable accounts. */
	remainingFraction?: number;
	/** Epoch ms the evidence was observed; missing or older than the max age counts as unknown. */
	observedAt?: number;
}

/** Usage-health lookups shared by the orderings of one fallback walk, keyed by routed model. */
export type RetryFallbackHealthLookups = Map<string, Promise<ModelUsageHealth | undefined>>;

/** Inputs for {@link orderRetryFallbackCandidates}. */
export interface RetryFallbackOrderOptions<T> {
	/** Quota evidence for a candidate; `undefined` counts as unknown. Read only by `quota`. */
	evidence?: (candidate: T) => RetryFallbackQuotaEvidence | undefined;
	/** Current epoch ms used to age evidence. */
	nowMs: number;
	/** Oldest evidence, in ms, that still counts. */
	maxAgeMs: number;
	/** Whether `quota` drops candidates whose fresh evidence is unknown instead of ranking them after known ones. */
	excludeUnknown?: boolean;
	/** Positive relative weight of a candidate; missing means 1. Read only by `weighted-random`. */
	weight?: (candidate: T) => number | undefined;
	/** Uniform source in [0, 1). Read by `random` and `weighted-random`; default `Math.random`. */
	random?: () => number;
	/** A candidate's index in the full effective chain. Read only by `round-robin`. */
	chainPosition?: (candidate: T) => number | undefined;
	/** Length of the full effective chain. Read only by `round-robin`. */
	chainLength?: number;
	/**
	 * Chain index of the entry last applied from this chain. `round-robin` starts
	 * after it; `undefined` keeps the given order.
	 */
	lastAppliedPosition?: number;
	/**
	 * A candidate's rank, lower first; `undefined` ranks after every ranked candidate. Read by
	 * `cheapest` (price), `least-used` (recorded requests), and `least-loaded` and `p2c` (requests in
	 * flight).
	 */
	rank?: (candidate: T) => number | undefined;
	/** A candidate's position in the current shuffle bag; `undefined` (already used) goes after. Read only by `shuffle-bag`. */
	bagPosition?: (candidate: T) => number | undefined;
}

/** Parsed model selector used by retry fallback resolution. */
export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

/** Minimal model lookup needed by fallback-chain resolution. */
export interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	hasProvider(provider: string): boolean;
}

/**
 * Inputs shared by startup (sdk) and runtime (turn-recovery) fallback-chain
 * resolution. `chains` is pre-expanded so callers can apply the default chain
 * to roles beyond the configured model roles (e.g. a subagent fallback role).
 */
export interface RetryFallbackResolutionContext {
	chains: RetryFallbackChains;
	getModelRole(role: string): string | undefined;
	modelLookup: RetryFallbackModelLookup;
	/**
	 * Member selectors of a role assigned a model pool, in configured order; `undefined` for a role
	 * with a legacy value. A pool role's chain starts with the member that is running, followed by
	 * its other members and then its configured entries.
	 */
	getRolePoolMembers?(role: string): readonly string[] | undefined;
}

/** Active retry fallback state retained until the primary can be restored. */
export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
	/**
	 * Set once a turn on the fallback target settles successfully. Until then the
	 * switch is only a routing decision — nothing has been produced by the new
	 * model, so no observer may report the run as having used it.
	 */
	served?: boolean;
}

/** Model a session's produced work is attributed to. */
export interface ServingModel {
	/** Full selector including routing and thinking level. */
	selector: string;
	/** Provider/id including routing, with no added thinking suffix. */
	modelIdentity?: string;
	/** Concrete thinking level captured with the attributed model. */
	thinkingLevel?: ThinkingLevel;
	/** Whether fallback routing, rather than the configured primary, owns it. */
	isFallback: boolean;
	/**
	 * Context window of the attributed model, carried verbatim from
	 * {@link Model.contextWindow} (`null` when the model declares none), so
	 * observers size context usage against the model that produced the turn
	 * instead of the one the run started on.
	 */
	contextWindow?: number | null;
}

const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
const RETRY_BACKOFF_JITTER_RATIO = 0.25;

/** Calculates capped exponential retry delay with downward jitter. */
export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/** Parses a configured retry fallback selector. */
export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: Pick<RetryFallbackModelLookup, "find">,
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/** Whether a fallback-chain key is a model selector rather than a role. */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/** Whether a fallback-chain key or entry is a provider wildcard. */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

/** Splits a wildcard selector into provider and optional model-id prefix. */
export function parseRetryFallbackWildcard(
	key: string,
	isKnownProvider: (provider: string) => boolean,
): { provider: string; idPrefix: string | undefined } {
	const template = key.slice(0, -2);
	const slash = template.indexOf("/");
	if (slash < 0 || isKnownProvider(template)) return { provider: template, idPrefix: undefined };
	return { provider: template.slice(0, slash), idPrefix: template.slice(slash + 1) };
}

/** Formats a concrete model and thinking level as a fallback selector. */
export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

/** Formats the model-only portion of a parsed fallback selector. */
function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

/** Whether a provider is registered or configured for discovery. */
export function isKnownProvider(
	modelRegistry: Pick<RetryFallbackModelLookup, "hasProvider">,
	provider: string,
): boolean {
	return modelRegistry.hasProvider(provider);
}

/** Apply the configured default chain to roles without their own chain. */
export function expandDefaultRetryFallbackChains(
	configuredChains: RetryFallbackChains,
	roleNames: readonly string[],
): RetryFallbackChains {
	const chains: RetryFallbackChains = { ...configuredChains };
	const defaultChain = chains.default;
	if (!Array.isArray(defaultChain)) return chains;
	for (const role of roleNames) {
		if (role !== "default" && !isKindRole(role) && chains[role] === undefined) chains[role] = defaultChain;
	}
	return chains;
}

/**
 * Resolves configured selector chains, applying the default chain to named roles. Model-group
 * chains read as unset ({@link getSelectorFallbackChains}).
 */
export function getRetryFallbackChains(settings: Settings): RetryFallbackChains {
	return expandDefaultRetryFallbackChains(getSelectorFallbackChains(settings), Object.keys(settings.getModelRoles()));
}

/**
 * A dynamic role pinned to one model selector with its own fallback chain.
 * Subagents own one under `subagent:<id>`; `session_init` persists it so cold
 * revival restores the same routing the spawn installed.
 */
export interface RetryFallbackRole {
	/** Selector the role is assigned (the chain's primary). */
	primary: string;
	/** Fallback selectors walked after the primary. */
	chain: string[];
}

/** Reads the primary and non-empty chain installed for `role`, if any. */
export function getRetryFallbackRole(settings: Settings, role: string): RetryFallbackRole | undefined {
	const primary = settings.getModelRole(role);
	const chain = getSelectorFallbackChains(settings)[role];
	if (!primary || !Array.isArray(chain) || chain.length === 0) return undefined;
	return { primary, chain };
}

/**
 * Assigns `role` its primary and installs its chain ahead of every configured
 * chain, so another role assigned the same model cannot capture its routing.
 * Overrides are session-scoped: nothing is written to the user's config.
 *
 * @throws ReservedModelRoleError when `role` is `__proto__`, `constructor`, or `prototype`.
 */
export function installRetryFallbackRole(
	settings: Settings,
	role: string,
	{ primary, chain }: RetryFallbackRole,
): void {
	assertModelRoleName(role);
	// Raw entries, not getModelRoles() projections: a pool role must keep its strategy and routing.
	const modelRoles: Record<string, ModelRoleEntry> = {};
	const existingRoles = settings.getModelRoleEntries();
	for (const key in existingRoles) {
		const entry = existingRoles[key];
		if (entry) modelRoles[key] = entry;
	}
	modelRoles[role] = primary;
	cfgModelRoles.override(settings, modelRoles);
	const fallbackChains: RetryFallbackChains = { [role]: chain };
	const existingChains = cfgRetryFallbackChains.get(settings);
	for (const key in existingChains) {
		if (key !== role) fallbackChains[key] = existingChains[key];
	}
	cfgRetryFallbackChains.override(settings, fallbackChains);
}

/**
 * Catalog slice covering every provider a selector's patterns name, or
 * `undefined` when a pattern is provider-less and needs the whole catalog.
 */
function providerScopedPool(
	modelRegistry: Pick<ModelRegistry, "find" | "getProviderModels">,
	patterns: readonly string[],
): Model[] | undefined {
	const providers = new Set<string>();
	for (const pattern of patterns) {
		const parsed = parseRetryFallbackSelector(pattern, modelRegistry);
		if (!parsed) return undefined;
		providers.add(parsed.provider);
	}
	const pool: Model[] = [];
	for (const provider of providers) pool.push(...modelRegistry.getProviderModels(provider));
	return pool;
}

/**
 * Validates configured fallback chains and reports each warning via `warn`.
 *
 * `options.isDiscoveryPending` suppresses "unknown model" warnings for
 * selectors whose config-declared discovery provider has not yet populated the
 * registry (a cold discovery cache after `omp update` bumps the cache
 * namespace, #10048). Such selectors are re-checked once background discovery
 * settles. Logging is the caller's responsibility so a post-discovery re-run
 * does not double-log persistent warnings.
 */
export function validateRetryFallbackChains(
	settings: Settings,
	modelRegistry: Pick<ModelRegistry, "getAll" | "find" | "hasProvider" | "getProviderModels">,
	warn: (message: string) => void,
	options: { isDiscoveryPending?: (provider: string) => boolean } = {},
): void {
	const configuredChains = cfgRetryFallbackChains.get(settings);
	if (configuredChains === undefined) return;
	const report = warn;
	const isDiscoveryPending = options.isDiscoveryPending ?? (() => false);
	if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
		report("retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.");
		return;
	}

	for (const key in configuredChains) {
		const chain = configuredChains[key];
		const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
		if (keyKind === "model") {
			if (isRetryFallbackWildcardKey(key)) {
				const { provider } = parseRetryFallbackWildcard(key, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`retry.fallbackChains wildcard key references unknown provider: ${key}`);
				}
			} else {
				const parsedKey = parseRetryFallbackSelector(key, modelRegistry);
				if (!parsedKey) {
					report(`Invalid model selector key in retry.fallbackChains: ${key}`);
				} else if (
					!modelRegistry.find(parsedKey.provider, parsedKey.id) &&
					!isDiscoveryPending(parsedKey.provider)
				) {
					report(`retry.fallbackChains key references unknown model: ${key}`);
				}
			}
		}
		if (isModelGroupForm(chain)) {
			const parsed = parseFallbackChainValue(key, chain, "strict");
			if (!parsed.ok) for (const issue of parsed.issues) report(`${issue.path}: ${issue.message}`);
			continue;
		}
		if (!Array.isArray(chain)) {
			report(`Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`);
			continue;
		}
		// Compatibility is a catalog property, independent of credentials and enabled providers.
		const kindRole = keyKind === "role" && isKindRole(key) ? getRoleInfo(key, settings) : undefined;
		// Provider-qualified selectors are checked against their providers' slices
		// first; the full catalog (expensive to compose) only backs a failed check,
		// so warnings are unchanged while the happy path stays cheap.
		let kindRoleCatalog: Model[] | undefined;
		const resolvesForKindRole = (selectorStr: string, pool: Model[] | undefined): boolean =>
			pool !== undefined &&
			kindRole !== undefined &&
			resolveModelRoleValue(selectorStr, pool.filter(kindRole.accepts), { settings }).model !== undefined;
		for (const selectorStr of chain) {
			if (typeof selectorStr !== "string") {
				report(`Fallback chain for ${keyKind} '${key}' contains a non-string selector.`);
				continue;
			}
			if (kindRole) {
				const patterns = resolveConfiguredModelPatterns(selectorStr, settings);
				if (resolvesForKindRole(selectorStr, providerScopedPool(modelRegistry, patterns))) continue;
				kindRoleCatalog ??= modelRegistry.getAll("all");
				if (resolvesForKindRole(selectorStr, kindRoleCatalog)) continue;

				const pending =
					patterns.length > 0 &&
					patterns.every(pattern => {
						const parsed = parseRetryFallbackSelector(pattern, modelRegistry);
						return parsed ? isDiscoveryPending(parsed.provider) : false;
					});
				if (!pending) {
					report(`Fallback chain for role '${key}' does not resolve to a compatible model: ${selectorStr}`);
				}
				continue;
			}
			if (isRetryFallbackWildcardKey(selectorStr)) {
				const { provider } = parseRetryFallbackWildcard(selectorStr, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`);
				}
				continue;
			}
			const parsed = parseRetryFallbackSelector(selectorStr, modelRegistry);
			if (!parsed) {
				report(`Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`);
				continue;
			}
			if (!modelRegistry.find(parsed.provider, parsed.id) && !isDiscoveryPending(parsed.provider)) {
				report(`Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`);
			}
		}
	}
}

/** Returns the configured fallback-primary restoration policy. */
export function getRetryFallbackRevertPolicy(settings: Settings): RetryFallbackRevertPolicy {
	return cfgRetryFallbackRevertPolicy.get(settings) === "never" ? "never" : "cooldown-expiry";
}

/** Resolves the primary selector represented by a fallback-chain key. */
function getRetryFallbackPrimarySelector(
	context: RetryFallbackResolutionContext,
	chainKey: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(chainKey)) return undefined;
	if (isRetryFallbackModelKey(chainKey)) return parseRetryFallbackSelector(chainKey, context.modelLookup);
	const configuredSelector = context.getModelRole(chainKey);
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, context.modelLookup) : undefined;
}

/** How a chain key's primary selector matches the current selector. */
type SelectorMatchKind = "exact" | "normalized" | "base" | "effort" | "none";

/** Strength of each {@link SelectorMatchKind}; higher wins. */
const SELECTOR_MATCH_RANK: Record<SelectorMatchKind, number> = { exact: 4, normalized: 3, base: 2, effort: 1, none: 0 };

/** Parsed members of a pool role, deduplicated in configured order; `undefined` for a legacy role. */
function rolePoolMembers(
	context: RetryFallbackResolutionContext,
	chainKey: string,
): RetryFallbackSelector[] | undefined {
	if (isRetryFallbackModelKey(chainKey)) return undefined;
	const selectors = context.getRolePoolMembers?.(chainKey);
	if (!selectors) return undefined;
	const seen = new Set<string>();
	const members: RetryFallbackSelector[] = [];
	for (const selector of selectors) {
		const parsed = parseRetryFallbackSelector(selector, context.modelLookup);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		members.push(parsed);
	}
	return members;
}

/** The pool member matching the current selector most strongly, with how it matches. */
function bestRolePoolMember(
	members: readonly RetryFallbackSelector[],
	current: RetryFallbackSelector | undefined,
	currentPlain: RetryFallbackSelector | undefined,
	currentModel: Model | null | undefined,
): { member: RetryFallbackSelector | undefined; kind: SelectorMatchKind } {
	let best: { member: RetryFallbackSelector | undefined; kind: SelectorMatchKind } = {
		member: undefined,
		kind: "none",
	};
	if (!current) return best;
	for (const member of members) {
		const kind = selectorMatchKind(member, current, currentPlain, currentModel);
		if (SELECTOR_MATCH_RANK[kind] > SELECTOR_MATCH_RANK[best.kind]) best = { member, kind };
	}
	return best;
}

/**
 * Classify how a chain key's primary selector matches the current selector.
 * Comparisons use parsed model + thinking-level values, so effort aliases
 * (`hi`/`med`/`min`) match their canonical forms (`high`/`medium`/`minimal`).
 *
 * - `exact` — same provider/model and parsed effort.
 * - `normalized` — same provider/model and both efforts clamp to the same
 *   level supported by the active model (`max` and `high` on a high-capped
 *   model).
 * - `base` — a suffixless key naming the same provider/model, so it applies
 *   to that model at any effort.
 * - `effort` — same provider/model at an explicit effort that stays distinct
 *   after model normalization. Model-selector keys treat this as no match;
 *   role keys accept it as their weakest tier, since a role's chain follows
 *   its assigned model across runtime effort changes.
 * - `none` — a different model, or no primary.
 */
function selectorMatchKind(
	primary: RetryFallbackSelector | undefined,
	current: RetryFallbackSelector,
	currentPlain: RetryFallbackSelector | undefined,
	currentModel: Model | null | undefined,
): SelectorMatchKind {
	if (!primary) return "none";
	const provider = primary.provider;
	const id = primary.id;
	const level = primary.thinkingLevel;
	let matchedCurrent: RetryFallbackSelector | undefined;
	if (provider === current.provider && id === current.id) {
		matchedCurrent = current;
	} else if (currentPlain !== undefined && provider === currentPlain.provider && id === currentPlain.id) {
		matchedCurrent = currentPlain;
	}
	if (!matchedCurrent) return "none";
	if (level === matchedCurrent.thinkingLevel) return "exact";
	if (level === undefined) return "base";
	if (
		currentModel &&
		resolveThinkingLevelForModel(currentModel, level) ===
			resolveThinkingLevelForModel(currentModel, matchedCurrent.thinkingLevel)
	) {
		return "normalized";
	}
	return "effort";
}

/**
 * Resolve the chain key for a concrete selector by specificity: exact model,
 * longest matching wildcard, hinted role, then matching role keys with
 * `default` preferred over other shared assignments, then default.
 */
export function resolveRetryFallbackChainKey(
	context: RetryFallbackResolutionContext,
	currentSelector: string,
	currentModel?: Model | null,
	roleHint?: string,
): string | undefined {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) {
		if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
		return undefined;
	}
	const parsedPlainCurrent =
		currentPlainSelector && currentPlainSelector !== currentSelector
			? (parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) ?? parsedCurrent)
			: undefined;

	// 1. Model-selector keys — most specific. Parsed exact effort beats
	//    model-normalized effort, which beats a suffixless (any-effort) key,
	//    regardless of object/YAML order. Efforts that remain distinct after
	//    normalization never match.
	let normalizedModelKey: string | undefined;
	let baseModelKey: string | undefined;
	for (const key in context.chains) {
		if (!isRetryFallbackModelKey(key) || isRetryFallbackWildcardKey(key)) continue;
		const kind = selectorMatchKind(
			getRetryFallbackPrimarySelector(context, key),
			parsedCurrent,
			parsedPlainCurrent,
			currentModel,
		);
		if (kind === "exact") return key;
		if (kind === "normalized") normalizedModelKey ??= key;
		if (kind === "base") baseModelKey ??= key;
	}
	if (normalizedModelKey) return normalizedModelKey;
	if (baseModelKey) return baseModelKey;

	// 2. Provider wildcards — an id-prefixed key (`openrouter/google/*`)
	//    beats the plain `provider/*` key for ids under its prefix.
	let wildcardMatch: string | undefined;
	let wildcardPrefixLength = -1;
	for (const key in context.chains) {
		if (!isRetryFallbackWildcardKey(key) || !Array.isArray(context.chains[key])) continue;
		const { provider, idPrefix } = parseRetryFallbackWildcard(key, provider =>
			context.modelLookup.hasProvider(provider),
		);
		if (provider !== parsedCurrent.provider) continue;
		if (idPrefix !== undefined && !parsedCurrent.id.startsWith(`${idPrefix}/`)) continue;
		const prefixLength = idPrefix?.length ?? 0;
		if (prefixLength > wildcardPrefixLength) {
			wildcardMatch = key;
			wildcardPrefixLength = prefixLength;
		}
	}
	if (wildcardMatch) return wildcardMatch;

	// 3. The hinted role, then role keys matched by their assigned model.
	// A shared assignment (default and vision both the same model) must not
	// let yaml insertion order steal the live role's chain. Prefer the hint,
	// then `default` when it also matches. A role assigned the live model at a
	// different explicit effort (spawn `effort`, `/thinking`) still owns it,
	// but only after every role whose effort matches.
	if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
	let matchedRole: string | undefined;
	let effortRole: string | undefined;
	for (const key in context.chains) {
		if (isRetryFallbackModelKey(key)) continue;
		const poolMembers = rolePoolMembers(context, key);
		const kind = poolMembers
			? bestRolePoolMember(poolMembers, parsedCurrent, parsedPlainCurrent, currentModel).kind
			: selectorMatchKind(
					getRetryFallbackPrimarySelector(context, key),
					parsedCurrent,
					parsedPlainCurrent,
					currentModel,
				);
		if (kind === "none") continue;
		if (kind === "effort") {
			if (key === "default" || effortRole === undefined) effortRole = key;
			continue;
		}
		if (key === "default") return "default";
		matchedRole ??= key;
	}
	if (matchedRole) return matchedRole;
	if (effortRole) return effortRole;

	// 4. The default chain. Use it even when `default` has an explicit role
	//    primary that is a *different* model than the live one (#12421): a
	//    /model switch or a mid-chain hop onto Fable/Astra must still reach
	//    glm/grok/… instead of resolving no key and aborting on wait > maxDelayMs.
	const defaultChain = context.chains.default;
	if (Array.isArray(defaultChain) && defaultChain.length > 0) {
		return "default";
	}
	return undefined;
}

/**
 * Parse one configured chain entry. A `provider/*` entry keeps the failing
 * model's id and swaps the provider (google-antigravity/x → google/x); an
 * id-prefixed `provider/prefix/*` entry re-prefixes the failing model's
 * bare id instead (openrouter/google/* : google-antigravity/x →
 * openrouter/google/x). Ids the target provider lacks are skipped by the
 * candidate loop's registry lookup.
 */
function parseRetryFallbackChainEntry(
	context: RetryFallbackResolutionContext,
	entry: string,
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector | undefined {
	if (!isRetryFallbackWildcardKey(entry)) return parseRetryFallbackSelector(entry, context.modelLookup);
	if (!current) return undefined;
	const { provider, idPrefix } = parseRetryFallbackWildcard(entry, candidate =>
		context.modelLookup.hasProvider(candidate),
	);
	const bareId = current.id.slice(current.id.lastIndexOf("/") + 1);
	let id: string;
	if (idPrefix !== undefined) {
		id = `${idPrefix}/${bareId}`;
	} else if (
		bareId !== current.id &&
		!context.modelLookup.find(provider, current.id) &&
		context.modelLookup.find(provider, bareId)
	) {
		// Aggregator → direct: the failing id carries a vendor prefix the
		// target provider does not use (openrouter/google/x → google-vertex/x).
		id = bareId;
	} else {
		id = current.id;
	}
	return { raw: `${provider}/${id}`, provider, id, thinkingLevel: undefined };
}

/** The effective chain for `chainKey`: its primary selector followed by its entries. */
export function getRetryFallbackChain(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel?: Model | null,
): RetryFallbackSelector[] {
	return getRetryFallbackEffectiveChain(context, chainKey, currentSelector, currentModel, false);
}

/** Builds a fallback chain beginning with its effective primary selector. */
function getRetryFallbackEffectiveChain(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel: Model | null | undefined,
	allowMissingPrimary: boolean,
): RetryFallbackSelector[] {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const parsedCurrent =
		parsedConfigured ??
		(currentModel
			? parseRetryFallbackSelector(
					formatModelSelectorValue(formatModelString(currentModel), undefined),
					context.modelLookup,
				)
			: undefined);
	const seen = new Set<string>();
	const chain: RetryFallbackSelector[] = [];
	const poolMembers = rolePoolMembers(context, chainKey);
	if (poolMembers && poolMembers.length > 0) {
		// The running member is the primary; the rest of the pool follows in configured order.
		const currentPlain = currentModel
			? parseRetryFallbackSelector(
					formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel),
					context.modelLookup,
				)
			: undefined;
		const primary =
			bestRolePoolMember(poolMembers, parsedCurrent, currentPlain, currentModel).member ?? poolMembers[0];
		for (const member of [primary, ...poolMembers]) {
			if (seen.has(member.raw)) continue;
			seen.add(member.raw);
			chain.push(member);
		}
	} else if (isRetryFallbackWildcardKey(chainKey)) {
		// A wildcard key has no fixed primary: the active model is the
		// primary, followed by the configured provider-level fallbacks.
		if (parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		}
	} else {
		const primarySelector = getRetryFallbackPrimarySelector(context, chainKey);
		if (primarySelector) {
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		} else if ((chainKey === "default" || allowMissingPrimary) && parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		} else if (!allowMissingPrimary) {
			return [];
		}
	}
	for (const selector of context.chains[chainKey] ?? []) {
		const parsed = parseRetryFallbackChainEntry(context, selector, parsedCurrent);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

/**
 * Return candidates after the current selector in an effective chain.
 * `wrapAround` additionally appends entries before the current selector,
 * without returning the current selector itself.
 */
export function findRetryFallbackCandidates(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel?: Model | null,
	options?: { allowMissingPrimary?: boolean; wrapAround?: boolean },
): RetryFallbackSelector[] {
	const chain = getRetryFallbackEffectiveChain(
		context,
		chainKey,
		currentSelector,
		currentModel,
		options?.allowMissingPrimary === true,
	);
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) return chain;
	if (chain.length <= 1) return [];
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;
	const exactIndex = chain.findIndex(
		selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
	);
	if (exactIndex >= 0) {
		const candidatesAfter = chain.slice(exactIndex + 1);
		return options?.wrapAround ? [...candidatesAfter, ...chain.slice(0, exactIndex)] : candidatesAfter;
	}
	const baseIndex = currentBaseSelector
		? chain.findIndex(selector => {
				const selectorBase = formatRetryFallbackBaseSelector(selector);
				return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
			})
		: -1;
	if (baseIndex >= 0) {
		const candidatesAfter = chain.slice(baseIndex + 1);
		return options?.wrapAround ? [...candidatesAfter, ...chain.slice(0, baseIndex)] : candidatesAfter;
	}
	return chain;
}

/** Rank of a quota state; lower is tried first. Depleted is known non-viable, so it follows unknown. */
const QUOTA_STATE_RANK: Record<ModelUsageHealthState, number> = { healthy: 0, reserve: 1, unknown: 2, depleted: 3 };

/**
 * Orders fallback candidates by `strategy`, returning a new array.
 *
 * - `priority` keeps the given order.
 * - `round-robin` orders by chain position, starting after
 *   `lastAppliedPosition` and wrapping; a candidate with no position goes last.
 * - `random` is a uniform random permutation; `weighted-random` draws without
 *   replacement with probability proportional to each remaining weight.
 * - `quota` sorts healthy before reserve before unknown before depleted, and
 *   by larger remaining fraction within a state, with a fraction-less entry
 *   after those reporting one. Missing evidence, and evidence older than
 *   `maxAgeMs`, counts as unknown; `excludeUnknown` drops those candidates.
 *   Ties keep the given order.
 * - `cheapest`, `least-used`, and `least-loaded` sort by `rank`, unranked last,
 *   ties in given order.
 * - `p2c` draws two distinct candidates with `random` and puts the lower-ranked
 *   first (the first drawn on a tie), then the rest in given order.
 * - `shuffle-bag` puts candidates still in the bag first, in bag order, then the
 *   rest in given order.
 */
export function orderRetryFallbackCandidates<T>(
	candidates: readonly T[],
	strategy: RetryFallbackStrategy,
	options: RetryFallbackOrderOptions<T>,
): T[] {
	if (strategy === "random" || strategy === "weighted-random") {
		const random = options.random ?? Math.random;
		const weight = (candidate: T): number => {
			if (strategy === "random") return 1;
			const value = options.weight?.(candidate);
			return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
		};
		// Efraimidis-Spirakis: sorting by u^(1/w) descending samples without replacement by weight.
		return candidates
			.map((candidate, index) => ({ candidate, index, key: random() ** (1 / weight(candidate)) }))
			.sort((a, b) => b.key - a.key || a.index - b.index)
			.map(entry => entry.candidate);
	}
	if (strategy === "priority" || (candidates.length <= 1 && strategy !== "quota")) return [...candidates];
	if (strategy === "cheapest" || strategy === "least-used" || strategy === "least-loaded") {
		return sortByKey(candidates, options.rank);
	}
	if (strategy === "p2c") {
		const random = options.random ?? Math.random;
		const first = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
		// The second draw skips the first index, so the two are always distinct.
		let second = Math.min(candidates.length - 2, Math.floor(random() * (candidates.length - 1)));
		if (second >= first) second++;
		const rank = (index: number) => options.rank?.(candidates[index]!) ?? Number.POSITIVE_INFINITY;
		const chosen = rank(second) < rank(first) ? second : first;
		return [candidates[chosen]!, ...candidates.filter((_candidate, index) => index !== chosen)];
	}
	if (strategy === "shuffle-bag") return sortByKey(candidates, options.bagPosition);
	if (strategy === "round-robin") {
		const { chainPosition, chainLength, lastAppliedPosition } = options;
		if (lastAppliedPosition === undefined || !chainPosition || !chainLength) return [...candidates];
		const distance = (candidate: T): number => {
			const position = chainPosition(candidate);
			return position === undefined ? chainLength : (position - lastAppliedPosition - 1 + chainLength) % chainLength;
		};
		return candidates
			.map((candidate, index) => ({ candidate, index, distance: distance(candidate) }))
			.sort((a, b) => a.distance - b.distance || a.index - b.index)
			.map(entry => entry.candidate);
	}
	const ranked = candidates.map((candidate, index) => {
		const evidence = options.evidence?.(candidate);
		const fresh =
			evidence?.observedAt !== undefined && options.nowMs - evidence.observedAt <= options.maxAgeMs
				? evidence
				: undefined;
		return {
			candidate,
			index,
			rank: QUOTA_STATE_RANK[fresh?.state ?? "unknown"],
			remaining: fresh?.state === "unknown" ? undefined : fresh?.remainingFraction,
		};
	});
	const considered = options.excludeUnknown ? ranked.filter(entry => entry.rank !== QUOTA_STATE_RANK.unknown) : ranked;
	considered.sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		if (a.remaining !== b.remaining) {
			if (a.remaining === undefined) return 1;
			if (b.remaining === undefined) return -1;
			return b.remaining - a.remaining;
		}
		return a.index - b.index;
	});
	return considered.map(entry => entry.candidate);
}

/** `candidates` sorted by `key` ascending, keyless last, ties in given order. */
function sortByKey<T>(candidates: readonly T[], key: ((candidate: T) => number | undefined) | undefined): T[] {
	return candidates
		.map((candidate, index) => ({ candidate, index, key: key?.(candidate) ?? Number.POSITIVE_INFINITY }))
		.sort((a, b) => a.key - b.key || a.index - b.index)
		.map(entry => entry.candidate);
}

/**
 * Quota evidence summarizing a candidate's usage health: its aggregate state,
 * the largest remaining fraction among healthy or reserve accounts, and the
 * newest observation. An account's observation is its usage report's fetch
 * time; a depleted account with no report reflects a live credential block,
 * observed at `nowMs`.
 */
export function retryFallbackQuotaEvidence(
	health: ModelUsageHealth | undefined,
	nowMs: number,
): RetryFallbackQuotaEvidence | undefined {
	if (!health) return undefined;
	let remainingFraction: number | undefined;
	let observedAt: number | undefined;
	for (const account of health.accounts) {
		const accountObservedAt = account.fetchedAt ?? (account.state === "depleted" ? nowMs : undefined);
		if (accountObservedAt !== undefined) observedAt = Math.max(observedAt ?? accountObservedAt, accountObservedAt);
		if ((account.state === "healthy" || account.state === "reserve") && account.remainingFraction !== undefined) {
			remainingFraction = Math.max(remainingFraction ?? account.remainingFraction, account.remainingFraction);
		}
	}
	return { state: health.state, remainingFraction, observedAt };
}

/**
 * Chain index of the entry each round-robin chain last applied, keyed by the
 * chain's selectors so every session and subagent in this process walking the
 * same chain shares one position. Not persisted; bounded by the number of
 * distinct configured chains.
 */
const roundRobinPositions = new Map<string, number>();

function roundRobinChainId(chain: readonly RetryFallbackSelector[]): string {
	return chain.map(selector => selector.raw).join("\n");
}

/** Chain index of the entry last applied from `chain` in this process, if any. */
export function getRetryFallbackRoundRobinPosition(chain: readonly RetryFallbackSelector[]): number | undefined {
	return roundRobinPositions.get(roundRobinChainId(chain));
}

/** Records that `selector` was applied from `chain`; a selector outside the chain is ignored. */
export function recordRetryFallbackRoundRobinPosition(
	chain: readonly RetryFallbackSelector[],
	selector: RetryFallbackSelector,
): void {
	const position = chain.findIndex(entry => entry.raw === selector.raw);
	if (position >= 0) roundRobinPositions.set(roundRobinChainId(chain), position);
}

/**
 * Selectors each shuffle-bag chain has not used in its current cycle, in shuffled order, keyed
 * like {@link roundRobinPositions} and likewise shared by the process and not persisted. A member
 * that is never picked (filtered out by funding, limits, or cooldown) stays in the bag.
 */
const shuffleBags = new Map<string, string[]>();

/**
 * The selectors of `chain` not yet used in its current shuffle-bag cycle, in bag order. A bag
 * holding none of `candidates` (the members eligible now; empty keeps the bag) is refilled with
 * every chain selector, shuffled with `random`, so members that cannot be picked never stall a cycle.
 */
export function getRetryFallbackShuffleBag(
	chain: readonly RetryFallbackSelector[],
	candidates: readonly string[],
	random: () => number = Math.random,
): readonly string[] {
	const id = roundRobinChainId(chain);
	const bag = shuffleBags.get(id);
	if (bag && (candidates.length === 0 || bag.some(selector => candidates.includes(selector)))) return bag;
	const refilled = chain.map(selector => selector.raw);
	for (let i = refilled.length - 1; i > 0; i--) {
		const j = Math.min(i, Math.floor(random() * (i + 1)));
		[refilled[i], refilled[j]] = [refilled[j]!, refilled[i]!];
	}
	shuffleBags.set(id, refilled);
	return refilled;
}

/**
 * Records that `selector` was applied from `chain` under `strategy`: `round-robin` moves its
 * position, `shuffle-bag` takes it out of the current bag; other strategies keep no state.
 */
export function recordRetryFallbackUse(
	strategy: RetryFallbackStrategy,
	chain: readonly RetryFallbackSelector[],
	selector: RetryFallbackSelector,
): void {
	if (strategy === "round-robin") recordRetryFallbackRoundRobinPosition(chain, selector);
	else if (strategy === "shuffle-bag") {
		const bag = shuffleBags.get(roundRobinChainId(chain));
		const index = bag?.indexOf(selector.raw) ?? -1;
		if (index >= 0) bag?.splice(index, 1);
	}
}

/** Forgets every recorded round-robin position and shuffle bag, so isolated tests start from configured order. */
export function resetRetryFallbackRoundRobinPositions(): void {
	roundRobinPositions.clear();
	shuffleBags.clear();
}
