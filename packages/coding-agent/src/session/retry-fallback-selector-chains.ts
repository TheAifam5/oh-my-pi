import { logger } from "@oh-my-pi/pi-utils";
import { isModelGroupForm, modelGroupPathKey } from "../config/model-groups";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "./settings";

/** `Settings.warnState.items` id remembering the model-group chain keys already logged. */
const GROUP_CHAIN_WARN_ID = `${cfgRetryFallbackChains.id}#model-group`;

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
