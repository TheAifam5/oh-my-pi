/**
 * OpenRouter key spending caps, free-model daily requests, and purchased credits.
 *
 * API response contracts:
 * https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
 * https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits
 * https://openrouter.ai/docs/api/reference/limits
 */
import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { finiteNumber } from "./account-balance";
import { knownBilling, moneyFromDecimal, type ProviderBilling, unknownBilling } from "./billing";
import { DAY_MS, usageStatus } from "./shared";

const PROVIDER = "openrouter";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const CANONICAL_HOST = "openrouter.ai";
const KEY_PATH = "/key";
const CREDITS_REQUEST_TIMEOUT_MS = 3_000;
const KEY_LIMIT_ID = "openrouter:key-limit";
const FREE_MODEL_LIMIT_ID = "openrouter:free-model-daily-requests";
/** Block scope of usage-limit errors on free-model requests; it expires by clock only. */
export const OPENROUTER_FREE_BLOCK_SCOPE = "variant:free";
/** Block scope of a spent free-model counter read from a report; a live report showing it recovered lifts it. */
export const OPENROUTER_FREE_QUOTA_BLOCK_SCOPE = "quota:free-models";
/** Block scope of a spent key cap read from a report; a live report showing it recovered lifts it. */
export const OPENROUTER_KEY_CAP_BLOCK_SCOPE = "quota:key-cap";

/** `limit_reset` values used as a window; any other value leaves the cap windowless. */
const RESET_WINDOW_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" } as const;
type LimitReset = keyof typeof RESET_WINDOW_LABELS;

function isLimitReset(value: unknown): value is LimitReset {
	return typeof value === "string" && Object.hasOwn(RESET_WINDOW_LABELS, value);
}

/**
 * Epoch ms of the next `limit_reset` boundary after `now`: resets happen at
 * midnight UTC and weeks run Monday through Sunday. A monthly reset is taken
 * as midnight UTC on the 1st, which the docs imply but do not state.
 */
export function limitResetAt(reset: LimitReset, now: number): number {
	const date = new Date(now);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();
	if (reset === "monthly") return Date.UTC(year, month + 1, 1);
	if (reset === "daily") return Date.UTC(year, month, day + 1);
	// getUTCDay() is 0 on Sunday; a week starting exactly now resets next Monday.
	return Date.UTC(year, month, day + ((8 - date.getUTCDay()) % 7 || 7));
}

/** The key's spending cap in USD; `undefined` for a key without one (`limit: null`). */
function keyLimit(data: Record<string, unknown>, now: number): UsageLimit | undefined {
	const limit = finiteNumber(data.limit);
	if (limit === undefined || limit < 0) return undefined;
	const reported = finiteNumber(data.limit_remaining);
	const remaining = reported === undefined ? undefined : Math.min(limit, Math.max(0, reported));
	const usedFraction = remaining === undefined ? undefined : limit > 0 ? (limit - remaining) / limit : 1;
	const reset = isLimitReset(data.limit_reset) ? data.limit_reset : undefined;
	return {
		id: KEY_LIMIT_ID,
		label: "Key credit limit",
		scope: { provider: PROVIDER, windowId: reset ?? "lifetime" },
		...(reset !== undefined
			? { window: { id: reset, label: RESET_WINDOW_LABELS[reset], resetsAt: limitResetAt(reset, now) } }
			: {}),
		amount: {
			limit,
			...(remaining !== undefined ? { remaining } : {}),
			...(usedFraction !== undefined ? { usedFraction, remainingFraction: 1 - usedFraction } : {}),
			unit: "usd",
		},
		status: usageStatus(usedFraction),
	};
}

/** A non-negative finite count, or `undefined`. */
function count(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

/**
 * The account's free-model request counter for the current UTC day;
 * `undefined` unless `used`, `limit`, and `remaining` are all non-negative numbers.
 * The counter gates only `:free` model variants: {@link openrouterRankingStrategy}
 * applies it to those requests alone, so a spent counter never blocks paid models.
 */
function freeModelDailyLimit(data: Record<string, unknown>, now: number): UsageLimit | undefined {
	const counter = data.free_model_daily_requests;
	if (!isRecord(counter)) return undefined;
	const used = count(counter.used);
	const limit = count(counter.limit);
	const remaining = count(counter.remaining);
	if (used === undefined || limit === undefined || remaining === undefined) return undefined;
	const usedFraction = limit > 0 ? Math.min(1, Math.max(0, (limit - Math.min(limit, remaining)) / limit)) : 1;
	return {
		id: FREE_MODEL_LIMIT_ID,
		label: "Free model daily requests",
		scope: { provider: PROVIDER, windowId: "daily", shared: true },
		window: { id: "daily", label: RESET_WINDOW_LABELS.daily, resetsAt: limitResetAt("daily", now) },
		amount: { used, limit, remaining, usedFraction, remainingFraction: 1 - usedFraction, unit: "requests" },
		status: usageStatus(usedFraction),
		notes: ["applies to :free models only"],
	};
}

/** USD per second spent by this key only; spending through other keys is excluded. */
function keySpendingPace(data: Record<string, unknown>, now: number): number | undefined {
	const date = new Date(now);
	const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
	const weekElapsed = now - (today - ((date.getUTCDay() + 6) % 7) * DAY_MS);
	const elapsed = weekElapsed >= DAY_MS ? weekElapsed : now - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
	const spent = finiteNumber(weekElapsed >= DAY_MS ? data.usage_weekly : data.usage_monthly);
	return spent === undefined || elapsed <= 0 ? undefined : spent / (elapsed / 1000);
}

function creditBalance(total: number, used: number, data: Record<string, unknown>, now: number): UsageLimit {
	const rounded = Math.round((total - used) * 100) / 100;
	const remaining = rounded === 0 ? 0 : rounded;
	const pace = keySpendingPace(data, now);
	const projectedExhaustAt =
		remaining > 0 && pace !== undefined && pace > 0 ? now + (remaining / pace) * 1000 : undefined;
	return {
		id: "openrouter:credit-balance",
		label: "Credit balance",
		scope: { provider: PROVIDER, shared: true },
		amount: {
			limit: total,
			used,
			remaining,
			unit: "usd",
			...(pace !== undefined ? { spendingRatePerDay: pace * 86400 } : {}),
		},
		...(projectedExhaustAt !== undefined && Number.isFinite(projectedExhaustAt) ? { projectedExhaustAt } : {}),
		status: remaining > 0 ? "ok" : "exhausted",
		notes: ["Spending pace counts this key only; spending through other keys is excluded."],
	};
}

async function fetchOpenRouterUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;
	const baseUrl = (params.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
	const creditsTimeout = AbortSignal.timeout(CREDITS_REQUEST_TIMEOUT_MS);
	const creditsController = new AbortController();
	const creditsSignal = AbortSignal.any([
		creditsTimeout,
		creditsController.signal,
		...(params.signal ? [params.signal] : []),
	]);
	const creditsRequest = (async () => {
		try {
			const response = await ctx.fetch(`${baseUrl}/credits`, {
				headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: "application/json" },
				signal: creditsSignal,
			});
			const payload: unknown = response.ok ? await response.json() : undefined;
			return { response, payload, timedOut: false };
		} catch {
			return { response: undefined, payload: undefined, timedOut: creditsTimeout.aborted };
		}
	})();

	let data: Record<string, unknown> | undefined;
	try {
		const url = new URL(`${baseUrl}${KEY_PATH}`);
		const response = await ctx.fetch(url.href, {
			headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: "application/json" },
			signal: params.signal,
		});
		if (!response.ok) {
			// Only OpenRouter itself can revoke the key; a proxy's auth failure stays transient.
			if (response.status === 401 && url.host === CANONICAL_HOST) {
				throw new ProviderHttpError(`OpenRouter ${url.host}${url.pathname} returned 401`, 401);
			}
			ctx.logger?.warn("OpenRouter usage fetch failed", {
				endpoint: `${url.host}${url.pathname}`,
				status: response.status,
			});
			return null;
		}
		const payload: unknown = await response.json();
		if (isRecord(payload) && isRecord(payload.data)) data = payload.data;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("OpenRouter usage request failed", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	} finally {
		if (!data || data.is_free_tier === true) creditsController.abort();
	}
	if (!data) return null;

	const fetchedAt = Date.now();
	const limits = [keyLimit(data, fetchedAt), freeModelDailyLimit(data, fetchedAt)].filter(
		(limit): limit is UsageLimit => limit !== undefined,
	);
	const metadata: UsageReport["metadata"] =
		typeof data.is_free_tier === "boolean" ? { isFreeTier: data.is_free_tier } : {};
	if (data.is_free_tier !== true) {
		const { response, payload, timedOut } = await creditsRequest;
		if (!response) {
			metadata.creditsUnavailableReason = timedOut ? "timeout" : "no-evidence";
		} else {
			if (response.status === 401 || response.status === 403) {
				metadata.creditsUnavailableReason = "permission-denied";
			} else if (response.ok) {
				if (isRecord(payload) && isRecord(payload.data)) {
					const total = finiteNumber(payload.data.total_credits);
					const used = finiteNumber(payload.data.total_usage);
					if (total !== undefined && total >= 0 && used !== undefined && used >= 0) {
						metadata.totalCredits = total;
						metadata.totalUsage = used;
						limits.push(creditBalance(total, used, data, fetchedAt));
					} else {
						metadata.creditsUnavailableReason = "malformed";
					}
				} else {
					metadata.creditsUnavailableReason = "malformed";
				}
			} else {
				metadata.creditsUnavailableReason = "no-evidence";
			}
		}
	}
	return {
		provider: PROVIDER,
		fetchedAt,
		limits,
		// `is_free_tier` describes the account (it has never purchased credits), not the key.
		metadata,
	};
}

export const openrouterUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchOpenRouterUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};

/**
 * Whether `modelId` is a request the free-model counter gates: an OpenRouter
 * `:free` variant, where the suffix after the last `:` of the bare id (after the
 * last `/`) is `free`, or the `openrouter/free` router, which OpenRouter documents
 * as picking one of its free models at random. Both match case-insensitively.
 *
 * This reads the id served to OpenRouter, whose variant suffix decides which
 * quota a request draws on; it is the usage counter's own contract, not catalog
 * policy, so it stays with the usage reader rather than in the KDL rules. OpenRouter
 * takes one variant per id, and `applyOpenRouterRoutingVariant` appends none to an
 * id that already carries one, so a `:free` id reaches the wire unchanged. An id
 * whose last suffix is another variant (`x:free:nitro`) is not read as free.
 */
export function isOpenRouterFreeModelId(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const segments = modelId.trim().toLowerCase().split("/");
	const bareId = segments.at(-1) ?? "";
	if (bareId === "free" && segments.at(-2) === "openrouter") return true;
	const separator = bareId.lastIndexOf(":");
	return separator !== -1 && bareId.slice(separator + 1) === "free";
}

/**
 * Limits gating a request: a `:free` request sees the free-model counter and the
 * key's cap (OpenRouter does not document whether a spent cap admits $0 requests);
 * any other request, including one with no model, sees the key's cap alone.
 */
function openRouterLimits(report: UsageReport, free: boolean): UsageLimit[] {
	return report.limits.filter(limit => limit.id === KEY_LIMIT_ID || (free && limit.id === FREE_MODEL_LIMIT_ID));
}

/**
 * Ranks OpenRouter keys. A usage-limit error blocks the request's own scope for
 * its retry hint: {@link OPENROUTER_FREE_BLOCK_SCOPE} for a free-model request,
 * unscoped for a paid one, and neither heals early, because the error may carry
 * a retry hint or a cause (exhausted account credits) the report cannot show.
 * A spent limit read from a report blocks the key until the limit's reset, under
 * {@link OPENROUTER_KEY_CAP_BLOCK_SCOPE} (every request) or
 * {@link OPENROUTER_FREE_QUOTA_BLOCK_SCOPE} (free-model requests), and a live
 * report showing that limit recovered lifts it.
 */
export const openrouterRankingStrategy: CredentialRankingStrategy = {
	// The `/key` report describes the very key it was fetched with.
	healsApiKeyBlocks: true,
	findWindowLimits(report, context) {
		const keyLimit = report.limits.find(limit => limit.id === KEY_LIMIT_ID);
		if (!isOpenRouterFreeModelId(context?.modelId)) return { primary: keyLimit };
		return { primary: report.limits.find(limit => limit.id === FREE_MODEL_LIMIT_ID), secondary: keyLimit };
	},
	scopeLimits: (report, context) => openRouterLimits(report, isOpenRouterFreeModelId(context?.modelId)),
	blockScope(context) {
		return isOpenRouterFreeModelId(context?.modelId) ? OPENROUTER_FREE_BLOCK_SCOPE : undefined;
	},
	/** A spent key cap gates every request, so it wins over a spent free counter. */
	reportBlockScope(exhausted) {
		if (exhausted.some(limit => limit.id === KEY_LIMIT_ID)) return OPENROUTER_KEY_CAP_BLOCK_SCOPE;
		return OPENROUTER_FREE_QUOTA_BLOCK_SCOPE;
	},
	blockScopes(context) {
		if (context && !isOpenRouterFreeModelId(context.modelId)) return [OPENROUTER_KEY_CAP_BLOCK_SCOPE];
		return [OPENROUTER_FREE_BLOCK_SCOPE, OPENROUTER_FREE_QUOTA_BLOCK_SCOPE, OPENROUTER_KEY_CAP_BLOCK_SCOPE];
	},
	/** Each report scope heals on its own limit alone, and only when the report carries it. */
	healableBlockScopes(report) {
		const scopes: { blockScope: string; limits: UsageLimit[] }[] = [];
		const freeCounter = report.limits.filter(limit => limit.id === FREE_MODEL_LIMIT_ID);
		if (freeCounter.length > 0) scopes.push({ blockScope: OPENROUTER_FREE_QUOTA_BLOCK_SCOPE, limits: freeCounter });
		const keyCap = report.limits.filter(limit => limit.id === KEY_LIMIT_ID);
		if (keyCap.length > 0) scopes.push({ blockScope: OPENROUTER_KEY_CAP_BLOCK_SCOPE, limits: keyCap });
		return scopes;
	},
	windowDefaults: { primaryMs: DAY_MS, secondaryMs: 30 * DAY_MS },
};

/**
 * OpenRouter billing: free-tier accounts read `free`; paid accounts use
 * purchased USD credits minus usage from `/credits`, rounded to cents.
 * A refused credits request reads unknown; key caps are not funding sources.
 */
export const openrouterBilling: ProviderBilling = {
	id: PROVIDER,
	readBilling(report) {
		if (report.metadata?.isFreeTier === true) return knownBilling(report, [{ mode: "free", state: "unknown" }]);
		const reason = report.metadata?.creditsUnavailableReason;
		if (reason === "permission-denied" || reason === "malformed" || reason === "timeout") {
			return unknownBilling(report, reason);
		}
		const total = report.metadata?.totalCredits;
		const used = report.metadata?.totalUsage;
		if (typeof total !== "number" || typeof used !== "number") return unknownBilling(report, "no-evidence");
		const limit = moneyFromDecimal(total, "USD", "floor");
		const spent = moneyFromDecimal(used, "USD", "ceil");
		const balance = Math.round((total - used) * 100) / 100;
		const remaining = moneyFromDecimal(balance === 0 ? 0 : balance, "USD", "half-even");
		if (!limit || !spent || !remaining) return unknownBilling(report, "malformed");
		return knownBilling(report, [
			{
				mode: "prepaid-credits",
				state: remaining.amountMinor > 0 ? "available" : "exhausted",
				allowance: { kind: "money", limit, used: spent, remaining },
			},
		]);
	},
};
