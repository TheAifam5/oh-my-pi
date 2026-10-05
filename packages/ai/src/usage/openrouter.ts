/**
 * OpenRouter API key spending cap usage provider.
 *
 * The response shape follows the official API reference:
 * https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
 */
import { ProviderHttpError } from "../error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { knownBilling, type ProviderBilling, unknownBilling } from "./billing";
import { usageStatus } from "./shared";

const PROVIDER = "openrouter";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const CANONICAL_HOST = "openrouter.ai";
const KEY_PATH = "/key";

/** `limit_reset` values used as a window; any other value leaves the cap windowless. */
const RESET_WINDOW_LABELS: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The key's spending cap in USD; `undefined` for a key without one (`limit: null`). */
function keyLimit(data: Record<string, unknown>): UsageLimit | undefined {
	const limit = finiteNumber(data.limit);
	if (limit === undefined || limit < 0) return undefined;
	const reported = finiteNumber(data.limit_remaining);
	const remaining = reported === undefined ? undefined : Math.min(limit, Math.max(0, reported));
	const usedFraction = remaining === undefined ? undefined : limit > 0 ? (limit - remaining) / limit : 1;
	const reset =
		typeof data.limit_reset === "string" && Object.hasOwn(RESET_WINDOW_LABELS, data.limit_reset)
			? data.limit_reset
			: undefined;
	return {
		id: "openrouter:key-limit",
		label: "Key credit limit",
		scope: { provider: PROVIDER, windowId: reset ?? "lifetime" },
		...(reset !== undefined ? { window: { id: reset, label: RESET_WINDOW_LABELS[reset] } } : {}),
		amount: {
			limit,
			...(remaining !== undefined ? { remaining } : {}),
			...(usedFraction !== undefined ? { usedFraction, remainingFraction: 1 - usedFraction } : {}),
			unit: "usd",
		},
		status: usageStatus(usedFraction),
	};
}

async function fetchOpenRouterUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;
	const baseUrl = (params.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

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
	}
	if (!data) return null;

	const cap = keyLimit(data);
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits: cap ? [cap] : [],
		// `is_free_tier` describes the account (it has never purchased credits), not the key.
		metadata: typeof data.is_free_tier === "boolean" ? { isFreeTier: data.is_free_tier } : {},
	};
}

export const openrouterUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchOpenRouterUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};

/**
 * OpenRouter billing: a free-tier account reads `free`. The key's spending cap
 * is a ceiling enforced as a usage limit, not a funding source, so any other
 * report is no evidence, never free.
 */
export const openrouterBilling: ProviderBilling = {
	id: PROVIDER,
	readBilling(report) {
		return report.metadata?.isFreeTier === true
			? knownBilling(report, [{ mode: "free", state: "unknown" }])
			: unknownBilling(report, "no-evidence");
	},
};
