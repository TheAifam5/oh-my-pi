/**
 * NanoGPT account balance and subscription quota usage provider.
 *
 * The response shapes follow the official API references:
 * https://docs.nano-gpt.com/api-reference/endpoint/check-balance
 * https://docs.nano-gpt.com/api-reference/endpoint/subscription-usage
 * Only the USD balance is read; the Nano balance and deposit address are ignored.
 * The balance docs name an `x-api-key` header without saying it takes the
 * inference key; the subscription usage docs say it does.
 */
import type { UsageLimit, UsageProvider, UsageReport, UsageStatus } from "../usage";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, decimalString, finiteNumber } from "./account-balance";
import { type BillingSource, knownBilling, type ProviderBilling, sourceFromLimit, unknownBilling } from "./billing";
import { DAY_MS, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "nanogpt";
const BALANCE_LIMIT_ID = "nanogpt:balance";
const INFERENCE_HOST = "nano-gpt.com";
/** Earliest `resetAt` accepted as epoch milliseconds: 2001-01-01T00:00:00Z. */
const MIN_RESET_AT_MS = Date.UTC(2001, 0, 1);
/** `resetAt` values from 2100-01-01T00:00:00Z on are not epoch milliseconds. */
const MAX_RESET_AT_MS = Date.UTC(2100, 0, 1);

/** Subscription quota counters; images have no usage unit of their own. */
const QUOTAS = [
	{
		field: "dailyInputTokens",
		id: "nanogpt:subscription:daily-input-tokens",
		label: "Daily input tokens",
		unit: "tokens",
		window: { id: "daily", label: "Daily", durationMs: DAY_MS },
	},
	{
		field: "weeklyInputTokens",
		id: "nanogpt:subscription:weekly-input-tokens",
		label: "Weekly input tokens",
		unit: "tokens",
		window: { id: "weekly", label: "Weekly", durationMs: WEEK_MS },
	},
	{
		field: "dailyImages",
		id: "nanogpt:subscription:daily-images",
		label: "Daily images",
		unit: "unknown",
		window: { id: "daily", label: "Daily", durationMs: DAY_MS },
	},
] as const;

/** Documented `routing.recommendedMode` values. */
const RECOMMENDED_MODES = new Set(["subscription", "paygo", "unavailable"]);

const balanceUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "NanoGPT",
	url: "https://api.nano-gpt.com/api/check-balance",
	inferenceHost: INFERENCE_HOST,
	acceptsInferenceKey: false,
	method: "POST",
	authHeaders: apiKey => ({ "x-api-key": apiKey }),
	parse(payload) {
		const balance = decimalString(payload.usd_balance);
		if (balance === undefined) return undefined;
		return { limits: [balanceLimit(PROVIDER, BALANCE_LIMIT_ID, "Balance", Number(balance), "usd")], metadata: {} };
	},
});

function quotaLimit(
	quota: (typeof QUOTAS)[number],
	counter: Record<string, unknown>,
	cap: number | undefined,
	payable: boolean,
): UsageLimit | undefined {
	const used = finiteNumber(counter.used);
	const reported = finiteNumber(counter.remaining);
	// A degraded counter reports nulls.
	if (used === undefined && reported === undefined) return undefined;
	const limit = cap !== undefined && cap >= 0 ? cap : undefined;
	const remaining = reported === undefined ? undefined : Math.max(0, reported);
	const percentUsed = finiteNumber(counter.percentUsed);
	const usedFraction =
		percentUsed !== undefined
			? Math.min(1, Math.max(0, percentUsed))
			: used !== undefined && limit !== undefined && limit > 0
				? Math.min(1, used / limit)
				: undefined;
	const resetAt = finiteNumber(counter.resetAt);
	// Documented as epoch ms; a value outside these bounds is a misreported unit (seconds, microseconds).
	const resetsAt =
		resetAt !== undefined && resetAt >= MIN_RESET_AT_MS && resetAt < MAX_RESET_AT_MS ? resetAt : undefined;
	const status: UsageStatus = remaining === 0 || limit === 0 ? "exhausted" : usageStatus(usedFraction);
	return {
		id: quota.id,
		label: quota.label,
		scope: { provider: PROVIDER, windowId: quota.window.id, shared: true },
		window: { ...quota.window, ...(resetsAt !== undefined ? { resetsAt } : {}) },
		amount: {
			...(used !== undefined ? { used } : {}),
			...(limit !== undefined ? { limit } : {}),
			...(remaining !== undefined ? { remaining } : {}),
			...(usedFraction !== undefined ? { usedFraction, remainingFraction: 1 - usedFraction } : {}),
			unit: quota.unit,
		},
		// A spent window does not stop requests while routing still offers a billing mode.
		status: payable && status === "exhausted" ? "warning" : status,
	};
}

function parseSubscriptionUsage(
	payload: Record<string, unknown>,
): Pick<UsageReport, "limits" | "metadata"> | undefined {
	if (typeof payload.active !== "boolean") return undefined;
	const caps = isRecord(payload.limits) ? payload.limits : {};
	const routing = isRecord(payload.routing) ? payload.routing : {};
	const mode =
		typeof routing.recommendedMode === "string" && RECOMMENDED_MODES.has(routing.recommendedMode)
			? routing.recommendedMode
			: undefined;
	const payable = mode === "subscription" || mode === "paygo";
	const limits: UsageLimit[] = [];
	for (const quota of QUOTAS) {
		// Counters are documented at the top level with numeric caps under `limits`; accept them nested there too.
		const counter = isRecord(payload[quota.field]) ? payload[quota.field] : caps[quota.field];
		if (!isRecord(counter)) continue;
		const limit = quotaLimit(quota, counter, finiteNumber(caps[quota.field]), payable);
		if (limit) limits.push(limit);
	}
	const period = isRecord(payload.period) ? payload.period : {};
	const periodEnd = typeof period.currentPeriodEnd === "string" ? Date.parse(period.currentPeriodEnd) : Number.NaN;
	return {
		limits,
		metadata: {
			subscriptionActive: payload.active,
			...(typeof payload.state === "string" ? { subscriptionState: payload.state } : {}),
			...(mode !== undefined ? { recommendedMode: mode } : {}),
			...(typeof routing.paidSpendPolicyAllowsBalance === "boolean"
				? { paidSpendPolicyAllowsBalance: routing.paidSpendPolicyAllowsBalance }
				: {}),
			...(Number.isFinite(periodEnd) ? { subscriptionPeriodEnd: periodEnd } : {}),
		},
	};
}

const subscriptionUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "NanoGPT subscription",
	url: "https://api.nano-gpt.com/api/subscription/v1/usage",
	inferenceHost: INFERENCE_HOST,
	// The docs do not say how the endpoint answers a key without a subscription, so a 401 never purges the key.
	acceptsInferenceKey: false,
	parse: parseSubscriptionUsage,
});

/** Reads the USD balance and the subscription quota together; either alone still yields a report. */
export const nanogptUsageProvider: UsageProvider = {
	...balanceUsageProvider,
	async fetchUsage(params, ctx): Promise<UsageReport | null> {
		const [balance, subscription] = await Promise.all([
			balanceUsageProvider.fetchUsage(params, ctx),
			subscriptionUsageProvider.fetchUsage(params, ctx),
		]);
		if (!balance || !subscription) return balance ?? subscription;
		return {
			provider: PROVIDER,
			fetchedAt: Math.min(balance.fetchedAt, subscription.fetchedAt),
			limits: [...subscription.limits, ...balance.limits],
			metadata: { ...balance.metadata, ...subscription.metadata },
		};
	},
};

/**
 * NanoGPT billing: an active subscription, drawn first, whose state follows
 * `routing.recommendedMode`, then the prepaid USD balance, disabled when the
 * key's policy forbids paid-balance spending and exhausted when routing reports
 * no usable billing mode.
 */
export const nanogptBilling: ProviderBilling = {
	id: PROVIDER,
	readBilling(report) {
		const metadata = report.metadata ?? {};
		const sources: BillingSource[] = [];
		if (metadata.subscriptionActive === true) {
			const mode = metadata.recommendedMode;
			const state = mode === "subscription" ? "available" : mode === undefined ? "unknown" : "exhausted";
			sources.push({ mode: "subscription-included", state });
		}
		const balance = report.limits.find(limit => limit.id === BALANCE_LIMIT_ID);
		if (balance) {
			const source = sourceFromLimit("prepaid-credits", balance);
			if (!source) return unknownBilling(report, "malformed");
			if (metadata.paidSpendPolicyAllowsBalance === false) source.state = "disabled";
			// Routing reports that neither the subscription nor the balance can pay.
			else if (metadata.recommendedMode === "unavailable" && source.state === "available")
				source.state = "exhausted";
			sources.push(source);
		}
		return sources.length > 0 ? knownBilling(report, sources) : unknownBilling(report, "no-evidence");
	},
};
