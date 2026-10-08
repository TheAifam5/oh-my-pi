import type { Api, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { MAX_THINKING_SUFFIX_OPTIONS, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { isModelGroupForm, modelGroupPathKey } from "../config/model-groups";
import { cfgDisabledProviders } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "./settings";

/** `Settings.warnState.items` id remembering the model-group chain keys already logged. */
const GROUP_CHAIN_WARN_ID = `${cfgRetryFallbackChains.id}#model-group`;

/** `Settings.warnState.items` id prefix remembering, per candidate pool, the entries logged as unmatched. */
const UNMATCHED_ENTRY_WARN_ID = `${cfgRetryFallbackChains.id}#unmatched-entry`;

/**
 * Candidate set a consumer resolves fallback-chain entries against. Consumers with different sets
 * (live session registry, a role's credentialed pool, a caller's tiny-model pool, the eval bridge's
 * available models) can disagree about one entry, so each keeps its own re-arm state.
 */
export type RetryFallbackEntryPool = "session" | "role-chain" | "tiny" | "eval";

const ENTRY_POOLS: readonly RetryFallbackEntryPool[] = ["session", "role-chain", "tiny", "eval"];

/** Registry facts that classify an unmatched entry; `ModelRegistry` satisfies it. */
export interface RetryFallbackEntryLookup {
	/** Whether `provider` may still add models through in-flight discovery. */
	isProviderDiscoveryPending(provider: string): boolean;
	/** Exact catalog model, whether or not its provider has credentials. */
	find(provider: string, id: string): Model<Api> | undefined;
}

/**
 * Records the outcome of resolving a `retry.fallbackChains` entry exactly against `pool`.
 *
 * A miss is logged once per entry and settings instance, across every pool. The message tells a
 * disabled provider, a catalog model whose provider has no usable credentials (known only with
 * `lookup`), and an entry that names no model apart; the last names the model pattern matching
 * would have chosen (`nearest`, called only when the warning is emitted). A miss while the entry's
 * provider is still discovering models neither warns nor records anything. A match re-arms only
 * the warning recorded for the same pool, so pools that disagree about an entry do not alternate.
 */
export function noteRetryFallbackEntryResolution(
	settings: Settings,
	entry: string,
	resolved: Model<Api> | undefined,
	context: {
		pool: RetryFallbackEntryPool;
		nearest: () => Model<Api> | undefined;
		lookup?: RetryFallbackEntryLookup;
	},
): void {
	const items = settings.warnState.items;
	const poolId = `${UNMATCHED_ENTRY_WARN_ID}:${context.pool}`;
	if (resolved) {
		items.get(poolId)?.delete(entry);
		return;
	}
	const parsed = parseModelString(entry, MAX_THINKING_SUFFIX_OPTIONS);
	if (parsed && context.lookup?.isProviderDiscoveryPending(parsed.provider)) return;
	if (ENTRY_POOLS.some(pool => items.get(`${UNMATCHED_ENTRY_WARN_ID}:${pool}`)?.has(entry))) return;
	let logged = items.get(poolId);
	if (!logged) {
		logged = new Set();
		items.set(poolId, logged);
	}
	logged.add(entry);
	if (parsed && cfgDisabledProviders.get(settings).includes(parsed.provider)) {
		logger.warn("Settings: retry.fallbackChains entry names a disabled provider; the entry is skipped", {
			entry,
			provider: parsed.provider,
		});
		return;
	}
	if (parsed && context.lookup?.find(parsed.provider, parsed.id)) {
		logger.warn(
			"Settings: retry.fallbackChains entry names a model whose provider has no usable credentials; the entry is skipped",
			{ entry, provider: parsed.provider },
		);
		return;
	}
	const neighbor = context.nearest();
	logger.warn("Settings: retry.fallbackChains entry matches no model exactly; the entry is skipped", {
		entry,
		nearest: neighbor ? `${neighbor.provider}/${neighbor.id}` : undefined,
	});
}

/**
 * Configured `retry.fallbackChains` without its model-group entries (a mapping or a `+group`
 * string). Consumers that cannot apply a group's strategy and funding policy (startup model
 * selection, subagent and tiny-model candidates, the eval completion bridge) read such a key as
 * unset: a role key falls back to the `default` chain, and a group at `default` leaves roles without
 * a default chain. Each such key is logged once per settings instance while it stays configured as
 * a group.
 */
export function getSelectorFallbackChains(settings: Settings): Record<string, string[]> {
	const configured = cfgRetryFallbackChains.get(settings);
	if (!configured || typeof configured !== "object") return {};
	let chains: Record<string, string[]> | undefined;
	const groupKeys: string[] = [];
	for (const key in configured) {
		if (!Object.hasOwn(configured, key) || !isModelGroupForm(configured[key])) continue;
		chains ??= { ...configured };
		delete chains[key];
		groupKeys.push(key);
	}
	logGroupChainsOnce(settings, groupKeys);
	return chains ?? configured;
}

function logGroupChainsOnce(settings: Settings, groupKeys: readonly string[]): void {
	const items = settings.warnState.items;
	let logged = items.get(GROUP_CHAIN_WARN_ID);
	// A key no longer configured as a group re-arms, so configuring one again is logged again.
	for (const key of logged ?? []) if (!groupKeys.includes(key)) logged?.delete(key);
	for (const key of groupKeys) {
		if (logged?.has(key)) continue;
		if (!logged) {
			logged = new Set();
			items.set(GROUP_CHAIN_WARN_ID, logged);
		}
		logged.add(key);
		logger.warn(
			"Settings: model-group fallback chains apply to chat-session and advisor fallback only; other consumers treat the key as unset",
			{
				setting: `${cfgRetryFallbackChains.id}.${modelGroupPathKey(key)}`,
			},
		);
	}
}
