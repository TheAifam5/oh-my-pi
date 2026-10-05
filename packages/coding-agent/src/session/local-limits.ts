/**
 * Local limits of the top-level `limits` setting: which limits govern a model, and whether the
 * calls counted in the usage ledger have reached them.
 */
import {
	type LocalLimit,
	localLimitCap,
	localLimitWindowStart,
	type LocalLimitWindow,
} from "@oh-my-pi/pi-ai/usage/limits";
import { formatDuration, logger } from "@oh-my-pi/pi-utils";
import { limitKeyScope, parseLimitsSetting, withoutSharedIdConflicts } from "../config/local-limits";
import { cfgLimits } from "../config/model-settings";
import type { Settings } from "../config/settings";
import type { UsageLedger, UsageScope, UsageTotals } from "./usage-ledger";

/** One limit governing a model, with every scope its counter covers. */
export interface LimitTarget {
	/** Stable identity: `id:<id>` for a shared limit, else `<key>#<index>`. */
	key: string;
	/** User-facing name: the `id`, else the key and the limit. */
	label: string;
	limit: LocalLimit;
	scopes: UsageScope[];
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

const configuredCache = new WeakMap<Settings, { revision: number; limits: Map<string, LocalLimit[]> }>();
const projectWarnings = new WeakMap<Settings, number>();

/**
 * Merged `limits` of the global config, `--config` overlays, and runtime overrides, a later layer
 * replacing a key whole. The project layer is skipped, and a key whose shared `id` conflicts with
 * an earlier key is dropped, each with one warning per settings revision.
 */
function configuredLimits(settings: Settings): Map<string, LocalLimit[]> {
	const cached = configuredCache.get(settings);
	if (cached?.revision === settings.revision) return cached.limits;
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
	const checked = withoutSharedIdConflicts(limits);
	for (const { key, id } of checked.dropped) {
		logger.warn("Ignoring limits key whose shared id differs from another key's", { key, id });
	}
	configuredCache.set(settings, { revision: settings.revision, limits: checked.limits });
	return checked.limits;
}

/** Whether `settings` configures any local limit. */
export function hasLocalLimits(settings: Settings): boolean {
	return configuredLimits(settings).size > 0;
}

function windowLabel(window: LocalLimitWindow): string {
	return window.type === "calendar" ? window.period : formatDuration(window.durationMs);
}

function limitLabel(key: string, limit: LocalLimit): string {
	if (limit.id !== undefined) return limit.id;
	const unit = limit.metric === "usd" ? "USD" : limit.metric;
	return `${key}: ${limit.max} ${unit} per ${windowLabel(limit.window)}`;
}

function scopeMatches(scope: UsageScope, provider: string, modelId: string): boolean {
	return (
		(scope.provider === undefined || scope.provider === provider) &&
		(scope.model === undefined || scope.model === modelId)
	);
}

/** The limits governing calls to `provider/modelId`, a shared `id` once. */
export function limitTargets(settings: Settings, provider: string, modelId: string): LimitTarget[] {
	const configured = configuredLimits(settings);
	if (configured.size === 0) return [];
	const targets = new Map<string, LimitTarget>();
	for (const [key, limits] of configured) {
		const scope = limitKeyScope(key);
		if (!scope || !scopeMatches(scope, provider, modelId)) continue;
		limits.forEach((limit, index) => {
			const targetKey = limit.id !== undefined ? `id:${limit.id}` : `${key}#${index}`;
			if (targets.has(targetKey)) return;
			const scopes =
				limit.id === undefined
					? [scope]
					: [...configured].flatMap(([otherKey, others]) => {
							const other = limitKeyScope(otherKey);
							return other && others.some(entry => entry.id === limit.id) ? [other] : [];
						});
			targets.set(targetKey, { key: targetKey, label: limitLabel(key, limit), limit, scopes });
		});
	}
	return [...targets.values()];
}

function metricTotal(totals: UsageTotals, limit: LocalLimit): bigint {
	return limit.metric === "usd" ? totals.costNanos : limit.metric === "requests" ? totals.requests : totals.tokens;
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
			if (!ledger) throw new Error("no usage ledger is open");
			const { window } = target.limit;
			const start = localLimitWindowStart(window, nowMs);
			// The ledger counts calls after `sinceMs`; a calendar window includes its first millisecond.
			const totals = ledger.totals(target.scopes, window.type === "calendar" ? start - 1 : start);
			reached = metricTotal(totals, target.limit) >= localLimitCap(target.limit);
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
