/**
 * Usage accounting for model requests outside a session's own turns: titles, commit messages,
 * memories, judgment, compaction and handoff, advisors, and other one-shot calls. Every
 * `streamSimple` request not marked `usageRecorded` is checked against the top-level `limits`
 * for its model (global, provider, and model keys; never pool limits) before it is sent, and
 * recorded in the usage and cache ledgers when it completes.
 */
import { getStreamUsageObserver, setStreamUsageObserver, type StreamUsageObserver } from "@oh-my-pi/pi-ai";
import { accountUsageKey } from "@oh-my-pi/pi-ai/auth/policy";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AuthStorage } from "./auth-storage";
import { cacheEntryOf, recordCacheEntry } from "./cache-ledger";
import {
	describeLimitRefusal,
	evaluateLimits,
	hasLocalLimits,
	limitTargets,
	limitWarningKey,
	USAGE_PREFLIGHT_BLOCKED_PREFIX,
} from "./local-limits";
import { recordUsageEntry, usageEntryOf } from "./usage-ledger";
import { requestOwnerSessionId } from "./request-session-ids";

/** Ledger writes of recorded background requests still running. */
const pendingWrites = new Set<Promise<void>>();

/** Waits for the ledger writes of background requests recorded so far. */
export async function flushBackgroundUsage(): Promise<void> {
	await Promise.all(pendingWrites);
}

/** Observers of live sessions, oldest first; the newest is installed. */
const installed: StreamUsageObserver[] = [];
/** The observer that was installed before the first session's, restored when every session is gone. */
let outside: StreamUsageObserver | undefined;

/**
 * Install the process-wide observer for `settings` and `authStorage`; returns the teardown. The
 * newest live session's observer is the installed one, so a disposed session hands it back to
 * the newest session still alive.
 *
 * A request a `skip` limit refuses fails with a `Usage preflight blocked:` error before reaching
 * the provider, as any other request failure its caller already handles; usage that cannot be
 * read refuses too. A reached `warn` limit is logged once per calendar period, or for a rolling
 * window once until it drops below its cap. Calls are attributed to the requesting session's
 * account when the request carries a session id.
 */
export function installStreamUsageObserver(settings: Settings, authStorage: AuthStorage): () => void {
	const warnedWindows = new Set<string>();
	const observer: StreamUsageObserver = {
		admit(model) {
			if (!hasLocalLimits(settings)) return undefined;
			const nowMs = Date.now();
			const targets = limitTargets(settings, model.provider, model.id);
			const { refused, warned, quiet } = evaluateLimits(settings.getStorage()?.usageLedger, targets, nowMs);
			for (const target of quiet) {
				if (target.limit.window.type === "rolling") warnedWindows.delete(limitWarningKey(target, nowMs));
			}
			for (const target of warned) {
				const key = limitWarningKey(target, nowMs);
				if (warnedWindows.has(key)) continue;
				warnedWindows.add(key);
				logger.warn("Local limit reached", { limit: target.label });
			}
			if (refused.length === 0) return undefined;
			return `${USAGE_PREFLIGHT_BLOCKED_PREFIX} local limit refused ${model.provider}/${model.id} (${refused.map(describeLimitRefusal).join(", ")})`;
		},
		record(model, message, options) {
			const storage = settings.getStorage();
			const cacheEntry = storage ? cacheEntryOf(message, Date.now(), model.baseUrl) : undefined;
			if (storage && cacheEntry) {
				const cacheWrite = recordCacheEntry(storage.cacheLedger, cacheEntry)
					.catch(error =>
						logger.warn("Cache ledger could not record a background model call", {
							provider: message.provider,
							model: message.model,
							error: String(error),
						}),
					)
					.finally(() => pendingWrites.delete(cacheWrite));
				pendingWrites.add(cacheWrite);
			}
			const ledger = storage?.usageLedger;
			if (!ledger) return;
			const sessionId = options?.sessionId;
			const active = sessionId
				? authStorage.sessions
						.accounts(message.provider, requestOwnerSessionId(sessionId))
						.find(account => account.active)
				: undefined;
			const entry = usageEntryOf(message, Date.now(), active ? { account: accountUsageKey(active) } : {});
			if (!entry) return;
			const write = recordUsageEntry(ledger, entry)
				.catch(error =>
					logger.warn("Usage ledger could not record a background model call", {
						provider: message.provider,
						model: message.model,
						error: String(error),
					}),
				)
				.finally(() => pendingWrites.delete(write));
			pendingWrites.add(write);
		},
	};
	if (installed.length === 0) outside = getStreamUsageObserver();
	installed.push(observer);
	setStreamUsageObserver(observer);
	return () => {
		const index = installed.indexOf(observer);
		if (index === -1) return;
		installed.splice(index, 1);
		setStreamUsageObserver(installed.at(-1) ?? outside);
	};
}
