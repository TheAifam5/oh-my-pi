/**
 * Local usage limits: the shape every scope shares (model, provider, global,
 * pool, account), its parser, and window arithmetic. Counting calls against a
 * limit and enforcing it belong to the caller that keeps the usage ledger.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

/** What a local limit counts. */
export const LOCAL_LIMIT_METRICS = ["usd", "requests", "tokens"] as const;
export type LocalLimitMetric = (typeof LOCAL_LIMIT_METRICS)[number];

/** What happens once a limit is reached: `skip` passes the target over, `warn` only notifies. */
export const LOCAL_LIMIT_ACTIONS = ["skip", "warn"] as const;
export type LocalLimitAction = (typeof LOCAL_LIMIT_ACTIONS)[number];

/** Calendar periods, in local time; weeks start on Monday. */
export const LOCAL_LIMIT_PERIODS = ["day", "week", "month"] as const;
export type LocalLimitPeriod = (typeof LOCAL_LIMIT_PERIODS)[number];

/** Longest rolling window, in ms (365 days). */
export const MAX_LOCAL_LIMIT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** Decimal places of a `usd` cap: caps compare against integer nano-USD. */
export const LOCAL_LIMIT_USD_EXPONENT = 9;

export type LocalLimitWindow = { type: "rolling"; durationMs: number } | { type: "calendar"; period: LocalLimitPeriod };

/** One configured limit. */
export interface LocalLimit {
	/** Limits that share an `id` share one counter across their scopes. */
	id?: string;
	metric: LocalLimitMetric;
	/** `usd`: a quoted decimal amount such as `"5.00"`; `requests` and `tokens`: a positive integer. */
	max: string | number;
	window: LocalLimitWindow;
	onLimit: LocalLimitAction;
}

/** A problem with a configured limit: a dotted path and a message that follows it. */
export interface LocalLimitIssue {
	path: string;
	message: string;
}

const LIMIT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_LIMIT_ID_LENGTH = 64;
const USD_AMOUNT = /^(\d{1,12})(?:\.(\d{1,9}))?$/;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
	return (allowed as readonly unknown[]).includes(value);
}

/** `amount` in nano-USD, or undefined when it is not a quoted decimal amount. */
function usdNanos(amount: unknown): bigint | undefined {
	const match = typeof amount === "string" ? USD_AMOUNT.exec(amount) : null;
	if (!match) return undefined;
	return BigInt(match[1]!) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(LOCAL_LIMIT_USD_EXPONENT, "0"));
}

function parseWindow(raw: unknown, path: string, issues: LocalLimitIssue[]): LocalLimitWindow | undefined {
	if (!isRecord(raw)) {
		issues.push({ path, message: "must be { type: rolling, durationMs } or { type: calendar, period }" });
		return undefined;
	}
	if (raw.type === "rolling") {
		const extra = Object.keys(raw).filter(key => key !== "type" && key !== "durationMs");
		if (extra.length > 0) issues.push({ path, message: `has unknown fields: ${extra.join(", ")}` });
		const { durationMs } = raw;
		if (
			typeof durationMs !== "number" ||
			!Number.isSafeInteger(durationMs) ||
			durationMs <= 0 ||
			durationMs > MAX_LOCAL_LIMIT_WINDOW_MS
		) {
			issues.push({
				path: `${path}.durationMs`,
				message: `must be a positive whole number of ms, at most ${MAX_LOCAL_LIMIT_WINDOW_MS} (365 days)`,
			});
			return undefined;
		}
		return extra.length > 0 ? undefined : { type: "rolling", durationMs };
	}
	if (raw.type === "calendar") {
		const extra = Object.keys(raw).filter(key => key !== "type" && key !== "period");
		if (extra.length > 0) issues.push({ path, message: `has unknown fields: ${extra.join(", ")}` });
		if (!oneOf(LOCAL_LIMIT_PERIODS, raw.period)) {
			issues.push({ path: `${path}.period`, message: `must be one of: ${LOCAL_LIMIT_PERIODS.join(", ")}` });
			return undefined;
		}
		return extra.length > 0 ? undefined : { type: "calendar", period: raw.period };
	}
	issues.push({ path: `${path}.type`, message: "must be rolling or calendar" });
	return undefined;
}

/** `raw` as a limit, or the issues that reject it; `onLimit` defaults to `skip`. */
export function parseLocalLimit(raw: unknown, path: string): { limit?: LocalLimit; issues: LocalLimitIssue[] } {
	const issues: LocalLimitIssue[] = [];
	if (!isRecord(raw)) {
		return { issues: [{ path, message: "must be a mapping with metric, max, window, and optional onLimit, id" }] };
	}
	const unknown = Object.keys(raw).filter(key => !["id", "metric", "max", "window", "onLimit"].includes(key));
	if (unknown.length > 0) issues.push({ path, message: `has unknown fields: ${unknown.join(", ")}` });
	if (
		raw.id !== undefined &&
		(typeof raw.id !== "string" || raw.id.length > MAX_LIMIT_ID_LENGTH || !LIMIT_ID.test(raw.id))
	) {
		issues.push({ path: `${path}.id`, message: `must match ${LIMIT_ID.source}` });
	}
	if (!oneOf(LOCAL_LIMIT_METRICS, raw.metric)) {
		issues.push({ path: `${path}.metric`, message: `must be one of: ${LOCAL_LIMIT_METRICS.join(", ")}` });
	} else if (raw.metric === "usd") {
		const nanos = usdNanos(raw.max);
		if (nanos === undefined || nanos === 0n) {
			issues.push({ path: `${path}.max`, message: 'must be a positive quoted decimal amount, such as "5.00"' });
		}
	} else if (typeof raw.max !== "number" || !Number.isSafeInteger(raw.max) || raw.max <= 0) {
		issues.push({ path: `${path}.max`, message: "must be a positive whole number" });
	}
	const window = parseWindow(raw.window, `${path}.window`, issues);
	if (raw.onLimit !== undefined && !oneOf(LOCAL_LIMIT_ACTIONS, raw.onLimit)) {
		issues.push({ path: `${path}.onLimit`, message: `must be one of: ${LOCAL_LIMIT_ACTIONS.join(", ")}` });
	}
	if (issues.length > 0 || !window) return { issues };
	return {
		limit: {
			...(raw.id !== undefined ? { id: raw.id as string } : {}),
			metric: raw.metric as LocalLimitMetric,
			max: raw.max as string | number,
			window,
			onLimit: (raw.onLimit as LocalLimitAction | undefined) ?? "skip",
		},
		issues,
	};
}

/** `raw` as a non-empty list of limits, with every issue of every entry. */
export function parseLocalLimits(raw: unknown, path: string): { limits: LocalLimit[]; issues: LocalLimitIssue[] } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { limits: [], issues: [{ path, message: "must be a non-empty list of limits" }] };
	}
	const limits: LocalLimit[] = [];
	const issues: LocalLimitIssue[] = [];
	raw.forEach((entry, index) => {
		const parsed = parseLocalLimit(entry, `${path}[${index}]`);
		issues.push(...parsed.issues);
		if (parsed.limit) limits.push(parsed.limit);
	});
	return { limits, issues };
}

/** The cap of `limit` in counter units: nano-USD for `usd`, calls for `requests`, tokens for `tokens`. */
export function localLimitCap(limit: LocalLimit): bigint {
	return limit.metric === "usd" ? (usdNanos(limit.max) ?? 0n) : BigInt(limit.max);
}

function startOfLocalDay(ms: number): Date {
	const date = new Date(ms);
	date.setHours(0, 0, 0, 0);
	return date;
}

function calendarStart(period: LocalLimitPeriod, nowMs: number): Date {
	const start = startOfLocalDay(nowMs);
	if (period === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
	if (period === "month") start.setDate(1);
	return start;
}

/** Epoch ms the window counting at `nowMs` started; calls stamped after it count. */
export function localLimitWindowStart(window: LocalLimitWindow, nowMs: number): number {
	return window.type === "rolling" ? nowMs - window.durationMs : calendarStart(window.period, nowMs).getTime();
}

/** Epoch ms the calendar window counting at `nowMs` ends; `undefined` for a rolling window, which never resets. */
export function localLimitWindowResetAt(window: LocalLimitWindow, nowMs: number): number | undefined {
	if (window.type === "rolling") return undefined;
	const end = calendarStart(window.period, nowMs);
	if (window.period === "day") end.setDate(end.getDate() + 1);
	if (window.period === "week") end.setDate(end.getDate() + 7);
	if (window.period === "month") end.setMonth(end.getMonth() + 1);
	return end.getTime();
}
