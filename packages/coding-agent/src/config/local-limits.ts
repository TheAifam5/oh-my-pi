/**
 * The top-level `limits` setting: local limits keyed by `provider/model-id`, `provider`, or `*`
 * (every call). Each key holds a list of {@link LocalLimit}s; see `session/local-limits.ts` for
 * counting and enforcement.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { type LocalLimit, parseLocalLimits } from "@oh-my-pi/pi-ai/usage/limits";
import type { UsageScope } from "../session/usage-ledger";

/** Key of the limits that apply to every call. */
export const GLOBAL_LIMIT_KEY = "*";

/** Prefix of a pool id (`role:<role>`, `chain:<key>`); a `limits` key may not take that form. */
const POOL_ID_PREFIX = /^(?:role|chain):/;

/** The calls a `limits` key covers, or `undefined` for a malformed key or one spelled as a pool id. */
export function limitKeyScope(key: string): UsageScope | undefined {
	if (key === GLOBAL_LIMIT_KEY) return {};
	if (key.trim() !== key || key.length === 0 || POOL_ID_PREFIX.test(key)) return undefined;
	const slash = key.indexOf("/");
	if (slash === -1) return { provider: key };
	const provider = key.slice(0, slash);
	const model = key.slice(slash + 1);
	return provider && model ? { provider, model } : undefined;
}

/**
 * `raw` as the `limits` setting, every key valid and every entry a valid limit; `null` reads as
 * unset. Whether limits sharing an `id` agree is checked on the merged layers
 * ({@link withoutSharedIdConflicts}).
 *
 * @throws Error naming the first problem.
 */
export function parseLimitsSetting(raw: unknown): Map<string, LocalLimit[]> {
	const parsed = new Map<string, LocalLimit[]>();
	if (raw === null || raw === undefined) return parsed;
	if (!isRecord(raw)) throw new Error("limits must map provider/model, provider, or * to a list of limits");
	for (const [key, value] of Object.entries(raw)) {
		if (POOL_ID_PREFIX.test(key)) {
			throw new Error(`limits key "${key}" names a pool; set pool limits in its routing.limits`);
		}
		if (!limitKeyScope(key)) throw new Error(`limits key "${key}" must be provider/model-id, provider, or *`);
		const { limits, issues } = parseLocalLimits(value, `limits["${key}"]`);
		const [issue] = issues;
		if (issue) throw new Error(`${issue.path} ${issue.message}`);
		parsed.set(key, limits);
	}
	return parsed;
}

/**
 * `limits` (in key order) without each limit that gives a shared `id` a different limit than an
 * earlier key does, with the keys and ids of the dropped limits; a key left with no limits is
 * dropped too.
 */
export function withoutSharedIdConflicts(limits: ReadonlyMap<string, LocalLimit[]>): {
	limits: Map<string, LocalLimit[]>;
	dropped: { key: string; id: string }[];
} {
	const kept = new Map<string, LocalLimit[]>();
	const dropped: { key: string; id: string }[] = [];
	const byId = new Map<string, LocalLimit>();
	for (const [key, entries] of limits) {
		const agreeing = entries.filter(limit => {
			if (limit.id === undefined) return true;
			const previous = byId.get(limit.id);
			if (previous === undefined) {
				byId.set(limit.id, limit);
				return true;
			}
			if (Bun.deepEquals(previous, limit)) return true;
			dropped.push({ key, id: limit.id });
			return false;
		});
		if (agreeing.length > 0) kept.set(key, agreeing);
	}
	return { limits: kept, dropped };
}
