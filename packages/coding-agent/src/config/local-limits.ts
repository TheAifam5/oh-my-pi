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

/** The calls a `limits` key covers, or `undefined` for a malformed key. */
export function limitKeyScope(key: string): UsageScope | undefined {
	if (key === GLOBAL_LIMIT_KEY) return {};
	if (key.trim() !== key || key.length === 0) return undefined;
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
		if (!limitKeyScope(key)) throw new Error(`limits key "${key}" must be provider/model-id, provider, or *`);
		const { limits, issues } = parseLocalLimits(value, `limits["${key}"]`);
		const [issue] = issues;
		if (issue) throw new Error(`${issue.path} ${issue.message}`);
		parsed.set(key, limits);
	}
	return parsed;
}

/**
 * `limits` without each key that gives a shared `id` a different limit than an earlier key does,
 * with the dropped keys and the ids they conflicted on.
 */
export function withoutSharedIdConflicts(limits: ReadonlyMap<string, LocalLimit[]>): {
	limits: Map<string, LocalLimit[]>;
	dropped: { key: string; id: string }[];
} {
	const kept = new Map<string, LocalLimit[]>();
	const dropped: { key: string; id: string }[] = [];
	const byId = new Map<string, LocalLimit>();
	for (const [key, entries] of limits) {
		const conflict = entries.find(limit => {
			const previous = limit.id === undefined ? undefined : byId.get(limit.id);
			return previous !== undefined && !Bun.deepEquals(previous, limit);
		});
		if (conflict?.id !== undefined) {
			dropped.push({ key, id: conflict.id });
			continue;
		}
		for (const limit of entries) if (limit.id !== undefined && !byId.has(limit.id)) byId.set(limit.id, limit);
		kept.set(key, entries);
	}
	return { limits: kept, dropped };
}
