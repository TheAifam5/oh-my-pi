/**
 * Local limits of the top-level `limits` setting and of pools' `routing.limits`: which limits
 * govern a call, and whether the calls counted in the usage ledger have reached them.
 */
import {
	type LocalLimit,
	localLimitCap,
	localLimitWindowResetAt,
	localLimitWindowStart,
	type LocalLimitWindow,
} from "@oh-my-pi/pi-ai/usage/limits";
import type { AccountLimitSource } from "@oh-my-pi/pi-ai/auth-storage";
import { formatDuration, isSqliteBusyError, logger } from "@oh-my-pi/pi-utils";
import { limitKeyScope, parseLimitsSetting, withoutSharedIdConflicts } from "../config/local-limits";
import { cfgLimits } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { type GroupFallbackChain, resolveGroupFallbackChain, resolveRolePoolGroup } from "./retry-fallback-groups";
import { cfgRetryFallbackChains } from "./settings";
import type { UsageLedger, UsageScope, UsageTotals } from "./usage-ledger";

/** Prefix of the error a request fails with when a local budget, limit, or usage reserve refuses it. */
export const USAGE_PREFLIGHT_BLOCKED_PREFIX = "Usage preflight blocked:";

/** One limit governing a model, with every scope its counter covers. */
export interface LimitTarget {
	/** Stable identity: `id:<id>` for a shared limit, else `<key>#<index>`. */
	key: string;
	/** User-facing name: the `id`, else the key and the limit. */
	label: string;
	limit: LocalLimit;
	scopes: UsageScope[];
	/** The `limits` key or pool id the limit is configured under; unset outside the configured scopes. */
	scopeKey?: string;
}

/** A limit that refuses the next call, and why. */
export interface LimitRefusal {
	target: LimitTarget;
	reason: "reached" | "unreadable";
}

/** Limits that refuse the next call, reached `warn` limits that only notify, and `warn` limits not reached. */
export interface LimitEvaluation {
	refused: LimitRefusal[];
	warned: LimitTarget[];
	quiet: LimitTarget[];
}

/** Limits configured for one scope: a top-level `limits` key, or a pool's `routing.limits`. */
interface ScopedLimits {
	/** The `limits` key, or the pool id. */
	key: string;
	scope: UsageScope;
	limits: LocalLimit[];
}

const configuredCache = new WeakMap<Settings, { revision: number; scoped: ScopedLimits[] }>();
const projectWarnings = new WeakMap<Settings, number>();

/**
 * Merged top-level `limits` of the global config, `--config` overlays, and runtime overrides, a
 * later layer replacing a key whole; the project layer is skipped with one warning per revision.
 */
function topLevelLimits(settings: Settings): Map<string, LocalLimit[]> {
	const limits = new Map<string, LocalLimit[]>();
	for (const { source, value } of settings.getLayerValues(cfgLimits)) {
		if (source === "project") {
			if (projectWarnings.get(settings) !== settings.revision) {
				projectWarnings.set(settings, settings.revision);
				logger.warn("limits is read from the user config only; project settings value ignored", {
					cwd: settings.getCwd(),
				});
			}
			continue;
		}
		try {
			for (const [key, entries] of parseLimitsSetting(value)) limits.set(key, entries);
		} catch (error) {
			// Settings loading already rejected an invalid value; a layer that slips through counts nothing.
			logger.warn("Ignoring invalid limits layer", { source, error: String(error) });
		}
	}
	return limits;
}

/**
 * `routing.limits` of every role and chain pool, by pool id: role pools before chain pools, each
 * sorted by name, so the merged layers' key order (which a project entry changes) cannot reorder them.
 */
function poolLimits(settings: Settings): Map<string, LocalLimit[]> {
	const limits = new Map<string, LocalLimit[]>();
	const add = (pool: GroupFallbackChain | undefined) => {
		const configured = pool?.group.routing?.limits;
		if (pool && configured && configured.length > 0) limits.set(pool.poolId, [...configured]);
	};
	for (const role of Object.keys(settings.getModelRoleEntries()).sort()) add(resolveRolePoolGroup(settings, role));
	for (const key of Object.keys(cfgRetryFallbackChains.get(settings)).sort()) {
		add(resolveGroupFallbackChain(settings, key));
	}
	return limits;
}

/**
 * Every configured scope with limits: top-level keys first, then pools in {@link poolLimits} order. A limit that gives a shared `id` a different limit than an earlier scope does is dropped
 * with one warning per settings revision; the rest of its scope stays.
 */
function configuredLimits(settings: Settings): ScopedLimits[] {
	const cached = configuredCache.get(settings);
	if (cached?.revision === settings.revision) return cached.scoped;
	const scopes = new Map<string, UsageScope>();
	const all = new Map<string, LocalLimit[]>();
	for (const [key, limits] of topLevelLimits(settings)) {
		const scope = limitKeyScope(key);
		if (!scope) continue;
		scopes.set(key, scope);
		all.set(key, limits);
	}
	for (const [poolId, limits] of poolLimits(settings)) {
		scopes.set(poolId, { pool: poolId });
		all.set(poolId, limits);
	}
	const checked = withoutSharedIdConflicts(all);
	for (const { key, id } of checked.dropped) {
		logger.warn("Ignoring a limit whose shared id differs from an earlier scope's", { scope: key, id });
	}
	const scoped = [...checked.limits].map(([key, limits]) => ({ key, scope: scopes.get(key)!, limits }));
	configuredCache.set(settings, { revision: settings.revision, scoped });
	return scoped;
}

/** Whether `settings` configures any local limit, top-level or on a pool. */
export function hasLocalLimits(settings: Settings): boolean {
	return configuredLimits(settings).length > 0;
}

function windowLabel(window: LocalLimitWindow): string {
	return window.type === "calendar" ? window.period : formatDuration(window.durationMs);
}

/** User-facing name of `limit` configured under `key`: its `id`, else the key, cap, and window. */
export function localLimitLabel(key: string, limit: LocalLimit): string {
	if (limit.id !== undefined) return limit.id;
	const unit = limit.metric === "usd" ? "USD" : limit.metric;
	return `${key}: ${limit.max} ${unit} per ${windowLabel(limit.window)}`;
}

function scopeMatches(scope: UsageScope, provider: string, modelId: string, poolId: string | undefined): boolean {
	if (scope.pool !== undefined) return scope.pool === poolId;
	return (
		(scope.provider === undefined || scope.provider === provider) &&
		(scope.model === undefined || scope.model === modelId)
	);
}

/**
 * The limits governing a call to `provider/modelId` made through the pool `poolId` (unset outside
 * a pool), a shared `id` once with every scope that declares it.
 */
export function limitTargets(settings: Settings, provider: string, modelId: string, poolId?: string): LimitTarget[] {
	return targetsWhere(settings, scope => scopeMatches(scope, provider, modelId, poolId));
}

/** Every configured limit (top-level keys, then pools), a shared `id` once; `poolId` keeps one pool's. */
export function configuredLimitTargets(settings: Settings, poolId?: string): LimitTarget[] {
	return targetsWhere(settings, scope => poolId === undefined || scope.pool === poolId);
}

function targetsWhere(settings: Settings, include: (scope: UsageScope) => boolean): LimitTarget[] {
	const configured = configuredLimits(settings);
	if (configured.length === 0) return [];
	const targets = new Map<string, LimitTarget>();
	for (const { key, scope, limits } of configured) {
		if (!include(scope)) continue;
		limits.forEach((limit, index) => {
			const targetKey = limit.id !== undefined ? `id:${limit.id}` : `${key}#${index}`;
			if (targets.has(targetKey)) return;
			const scopes =
				limit.id === undefined
					? [scope]
					: configured.flatMap(other => (other.limits.some(entry => entry.id === limit.id) ? [other.scope] : []));
			targets.set(targetKey, { key: targetKey, label: localLimitLabel(key, limit), limit, scopes, scopeKey: key });
		});
	}
	return [...targets.values()];
}

function metricTotal(totals: UsageTotals, limit: LocalLimit): bigint {
	return limit.metric === "usd" ? totals.costNanos : limit.metric === "requests" ? totals.requests : totals.tokens;
}

/** Attempts at reading one total while agent.db is busy; reads are synchronous, so retries are immediate. */
const TOTALS_READ_ATTEMPTS = 3;

function readTotals(ledger: UsageLedger, scopes: readonly UsageScope[], sinceMs: number): UsageTotals {
	for (let attempt = 1; ; attempt++) {
		try {
			return ledger.totals(scopes, sinceMs);
		} catch (error) {
			if (!isSqliteBusyError(error) || attempt >= TOTALS_READ_ATTEMPTS) throw error;
		}
	}
}

/**
 * What `target` has counted in its window at `nowMs`, in counter units (nano-USD for `usd`).
 *
 * @throws Error when no ledger is open or the read fails.
 */
function countedUsage(ledger: UsageLedger | undefined, target: LimitTarget, nowMs: number): bigint {
	if (!ledger) throw new Error("no usage ledger is open");
	const { window } = target.limit;
	const start = localLimitWindowStart(window, nowMs);
	// The ledger counts calls after `sinceMs`; a calendar window includes its first millisecond.
	return metricTotal(readTotals(ledger, target.scopes, window.type === "calendar" ? start - 1 : start), target.limit);
}

/** A limit and what its counter holds now, for display. */
export interface LimitStatus {
	/** The limit's `id`, else the scope it is configured under (`limits` key, pool id, or account). */
	name: string;
	metric: LocalLimit["metric"];
	max: string | number;
	window: LocalLimitWindow;
	onLimit: LocalLimit["onLimit"];
	/** Counted so far: a decimal USD string for `usd`, a count otherwise; undefined when unreadable. */
	used?: string | number;
	/** Epoch ms a calendar window resets; undefined for a rolling window. */
	resetsAt?: number;
}

/** {@link LimitStatus} of `target` named `name`, read from `ledger` at `nowMs`. */
export function limitStatus(
	ledger: UsageLedger | undefined,
	target: LimitTarget,
	name: string,
	nowMs: number,
): LimitStatus {
	const { limit } = target;
	let used: string | number | undefined;
	try {
		const counted = countedUsage(ledger, target, nowMs);
		used = limit.metric === "usd" ? formatNanoUsd(counted) : Number(counted);
	} catch {
		used = undefined;
	}
	const resetsAt = localLimitWindowResetAt(limit.window, nowMs);
	return {
		name: limit.id ?? name,
		metric: limit.metric,
		max: limit.max,
		window: limit.window,
		onLimit: limit.onLimit,
		...(used !== undefined ? { used } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

/** Statuses of every configured top-level and pool limit, or of one pool's (`poolId`). */
export function configuredLimitStatuses(
	settings: Settings,
	ledger: UsageLedger | undefined,
	nowMs: number,
	poolId?: string,
): LimitStatus[] {
	return configuredLimitTargets(settings, poolId).map(target =>
		limitStatus(ledger, target, target.scopeKey ?? target.key, nowMs),
	);
}

/** Nano-USD as a decimal USD string with at least two and at most nine fractional digits. */
function formatNanoUsd(nanos: bigint): string {
	const whole = nanos / 1_000_000_000n;
	const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "").padEnd(2, "0");
	return `${whole}.${fraction}`;
}

/** A status as `<used> / <max> <unit> per <window>`, then the reset or `rolling`; `?` for unreadable usage. */
export function formatLimitUsage(status: LimitStatus, nowMs: number): string {
	const unit = status.metric === "usd" ? "USD" : status.metric;
	const reset =
		status.resetsAt !== undefined ? `resets in ${formatDuration(Math.max(0, status.resetsAt - nowMs))}` : "rolling";
	const warn = status.onLimit === "warn" ? " · warn only" : "";
	return `${status.used ?? "?"} / ${status.max} ${unit} per ${windowLabel(status.window)} · ${reset}${warn}`;
}

/** Lines of a "Local limits" report section for every configured top-level and pool limit; empty without any. */
export function localLimitsReport(settings: Settings, ledger: UsageLedger | undefined, nowMs: number): string[] {
	const statuses = configuredLimitStatuses(settings, ledger, nowMs);
	return statuses.length === 0
		? []
		: ["Local limits", ...statuses.map(status => `  ${formatLimitStatus(status, nowMs)}`)];
}

/**
 * One-line summary of a pool's limits for the model hub: how many, then the one closest to its
 * cap ({@link formatLimitUsage}), `skip` limits before warn-only ones; undefined for a pool
 * without limits.
 */
export function poolLimitsSummary(
	settings: Settings,
	poolId: string,
	ledger: UsageLedger | undefined,
	nowMs: number,
): string | undefined {
	const statuses = configuredLimitStatuses(settings, ledger, nowMs, poolId);
	if (statuses.length === 0) return undefined;
	const share = (status: LimitStatus) => (status.used === undefined ? -1 : Number(status.used) / Number(status.max));
	const rank = (status: LimitStatus) => (status.onLimit === "skip" ? 1 : 0);
	const closest = statuses.reduce((best, status) =>
		rank(status) > rank(best) || (rank(status) === rank(best) && share(status) > share(best)) ? status : best,
	);
	const count = `${statuses.length} limit${statuses.length === 1 ? "" : "s"}`;
	return `${count}, closest ${formatLimitUsage(closest, nowMs)}`;
}

/**
 * The JSON shape of a listed limit: `metric`, `max`, `used` (a decimal USD string for `usd`, a
 * count otherwise), `window`, and `resetsAt` (epoch ms), each `null` when unknown or not applicable.
 */
export function localLimitJson(limit: {
	metric: string;
	max: string | number;
	used?: string | number;
	window?: LocalLimitWindow;
	resetsAt?: number;
}): {
	metric: string;
	max: string | number;
	used: string | number | null;
	window: LocalLimitWindow | null;
	resetsAt: number | null;
} {
	return {
		metric: limit.metric,
		max: limit.max,
		used: limit.used ?? null,
		window: limit.window ?? null,
		resetsAt: limit.resetsAt ?? null,
	};
}

/** {@link formatLimitUsage} prefixed with the status name. */
export function formatLimitStatus(status: LimitStatus, nowMs: number): string {
	return `${status.name}: ${formatLimitUsage(status, nowMs)}`;
}

/**
 * Of `targets`, the limits whose counted calls reached their cap at `nowMs`: `skip` limits that
 * refuse the next call, and `warn` limits that only notify. A `skip` limit whose usage cannot be
 * read (no ledger, or a failed read) refuses too; a `warn` limit then stays quiet.
 */
export function evaluateLimits(
	ledger: UsageLedger | undefined,
	targets: readonly LimitTarget[],
	nowMs: number,
): LimitEvaluation {
	const refused: LimitRefusal[] = [];
	const warned: LimitTarget[] = [];
	const quiet: LimitTarget[] = [];
	for (const target of targets) {
		let reached: boolean;
		try {
			reached = countedUsage(ledger, target, nowMs) >= localLimitCap(target.limit);
		} catch (error) {
			if (target.limit.onLimit === "skip") {
				logger.debug("Local limit usage could not be read", { limit: target.label, error: String(error) });
				refused.push({ target, reason: "unreadable" });
			}
			continue;
		}
		if (!reached) {
			if (target.limit.onLimit === "warn") quiet.push(target);
			continue;
		}
		if (target.limit.onLimit === "skip") refused.push({ target, reason: "reached" });
		else warned.push(target);
	}
	return { refused, warned, quiet };
}

/** Short user-facing description of a refusal. */
export function describeLimitRefusal(refusal: LimitRefusal): string {
	return `${refusal.target.label}: ${refusal.reason === "reached" ? "local limit reached" : "local limit usage unreadable"}`;
}

/**
 * Key that a reached `warn` limit notifies under once: the target and its calendar period, or for
 * a rolling window the target alone, cleared once the limit is seen below its cap.
 */
export function limitWarningKey(target: LimitTarget, nowMs: number): string {
	const { window } = target.limit;
	return window.type === "calendar" ? `${target.key}\0${localLimitWindowStart(window, nowMs)}` : target.key;
}

/** A short stable digest of an account usage key, for logs. */
function accountLogId(account: string): string {
	return `#${Bun.hash(account).toString(16).padStart(16, "0").slice(0, 8)}`;
}

/**
 * The account limit source the auth store consults ({@link AccountLimitSource}): each limit counts
 * the calls `account` made to `provider` in the usage `ledger()`. A reached `warn` limit is logged
 * once per calendar period, or for a rolling window once until it drops below its cap; usage that
 * cannot be read refuses with `unreadable`, logged once per account.
 */
export function createAccountLimitSource(ledger: () => UsageLedger | undefined): AccountLimitSource {
	const warnedWindows = new Set<string>();
	const warnedUnreadable = new Set<string>();
	return {
		refuses(provider, account, limits, nowMs) {
			// Account keys can be emails; logs name the account by a digest.
			const accountId = accountLogId(account);
			const subject = `${provider} account ${accountId}`;
			const targets = limits.map((limit, index) => ({
				key: `account:${provider}/${account}#${index}`,
				label: localLimitLabel(subject, limit),
				limit,
				scopes: [{ provider, account }],
			}));
			const { refused, warned, quiet } = evaluateLimits(ledger(), targets, nowMs);
			for (const target of quiet) {
				if (target.limit.window.type === "rolling") warnedWindows.delete(limitWarningKey(target, nowMs));
			}
			for (const target of warned) {
				const key = limitWarningKey(target, nowMs);
				if (warnedWindows.has(key)) continue;
				warnedWindows.add(key);
				logger.warn("Local account limit reached", { limit: target.label });
			}
			if (refused.some(refusal => refusal.reason === "reached")) return "reached";
			if (refused.length === 0) return undefined;
			const accountKey = `${provider}\0${account}`;
			if (!warnedUnreadable.has(accountKey)) {
				warnedUnreadable.add(accountKey);
				logger.warn("Local account limit usage could not be read; the account is not used", {
					provider,
					account: accountId,
				});
			}
			return "unreadable";
		},
	};
}
