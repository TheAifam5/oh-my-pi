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
	if (oneOf(ACCOUNT_EVIDENCE_METRICS, raw.metric)) {
		issues.push({ path: `${path}.metric`, message: `${raw.metric} is only allowed on auth.accountPolicies limits` });
	} else if (!oneOf(LOCAL_LIMIT_METRICS, raw.metric)) {
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

/**
 * Account-only metrics read from the provider instead of the usage ledger: `usage` (the used
 * fraction of the account's plan windows), `credits` (the remaining prepaid credit balance), and
 * `extra-usd` (paid extra usage the provider reports as used, in USD).
 */
export const ACCOUNT_EVIDENCE_METRICS = ["usage", "credits", "extra-usd"] as const;
export type AccountEvidenceMetric = (typeof ACCOUNT_EVIDENCE_METRICS)[number];

/**
 * A limit on provider-reported evidence, over the provider's own windows. `usage` caps the used
 * fraction at `max` (0 < max <= 1); `credits` is a floor: the account is held back while fewer
 * than `max` credits remain; `extra-usd` caps reported paid extra usage at `max` USD.
 */
export interface AccountEvidenceLimit {
	metric: AccountEvidenceMetric;
	/** `usage`: a fraction; `credits` and `extra-usd`: a quoted decimal amount such as `"5.00"`. */
	max: number | string;
	onLimit: LocalLimitAction;
}

/** A limit an account policy may set: on the usage ledger, or on provider evidence. */
export type AccountLimit = LocalLimit | AccountEvidenceLimit;

/** Whether `limit` is counted from provider evidence rather than the usage ledger. */
export function isAccountEvidenceLimit(limit: AccountLimit): limit is AccountEvidenceLimit {
	return oneOf(ACCOUNT_EVIDENCE_METRICS, limit.metric);
}

const DECIMAL_AMOUNT = /^\d{1,12}(?:\.\d{1,9})?$/;

function parseEvidenceLimit(
	raw: Record<string, unknown>,
	path: string,
): { limit?: AccountEvidenceLimit; issues: LocalLimitIssue[] } {
	const issues: LocalLimitIssue[] = [];
	const unknown = Object.keys(raw).filter(key => !["metric", "max", "onLimit"].includes(key));
	if (unknown.length > 0) {
		issues.push({
			path,
			message: `has unknown fields: ${unknown.join(", ")} (provider evidence uses its own windows)`,
		});
	}
	if (raw.metric === "usage") {
		if (typeof raw.max !== "number" || !Number.isFinite(raw.max) || raw.max <= 0 || raw.max > 1) {
			issues.push({ path: `${path}.max`, message: "must be a used fraction above 0 and at most 1" });
		}
	} else if (typeof raw.max !== "string" || !DECIMAL_AMOUNT.test(raw.max)) {
		issues.push({ path: `${path}.max`, message: 'must be a quoted decimal amount, such as "5.00"' });
	}
	if (raw.onLimit !== undefined && !oneOf(LOCAL_LIMIT_ACTIONS, raw.onLimit)) {
		issues.push({ path: `${path}.onLimit`, message: `must be one of: ${LOCAL_LIMIT_ACTIONS.join(", ")}` });
	}
	if (issues.length > 0) return { issues };
	return {
		limit: {
			metric: raw.metric as AccountEvidenceMetric,
			max: raw.max as number | string,
			onLimit: (raw.onLimit as LocalLimitAction | undefined) ?? "skip",
		},
		issues,
	};
}

const ACCOUNT_METRIC_MESSAGE = `must be one of: ${[...LOCAL_LIMIT_METRICS, ...ACCOUNT_EVIDENCE_METRICS].join(", ")}`;

/** `raw` as a non-empty list of account limits (ledger or evidence metrics), with every issue. */
export function parseAccountLimits(raw: unknown, path: string): { limits: AccountLimit[]; issues: LocalLimitIssue[] } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { limits: [], issues: [{ path, message: "must be a non-empty list of limits" }] };
	}
	const limits: AccountLimit[] = [];
	const issues: LocalLimitIssue[] = [];
	raw.forEach((entry, index) => {
		const at = `${path}[${index}]`;
		const parsed =
			isRecord(entry) && oneOf(ACCOUNT_EVIDENCE_METRICS, entry.metric)
				? parseEvidenceLimit(entry, at)
				: parseLocalLimit(entry, at);
		for (const issue of parsed.issues) {
			issues.push(issue.path === `${at}.metric` ? { path: issue.path, message: ACCOUNT_METRIC_MESSAGE } : issue);
		}
		if (parsed.limit) limits.push(parsed.limit);
	});
	return { limits, issues };
}
