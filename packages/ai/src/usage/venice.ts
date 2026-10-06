/**
 * Venice API key rate limits and balances usage provider.
 *
 * The response shape follows the official API reference:
 * https://docs.venice.ai/api-reference/endpoint/api_keys/rate_limits
 * which, unlike the admin-only billing balance endpoint, accepts the inference key:
 * https://docs.venice.ai/overview/guides/generating-api-key
 */
import type { UsageLimit } from "../usage";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, finiteNumber } from "./account-balance";
import { type BillingSource, knownBilling, type ProviderBilling, sourceFromLimit, unknownBilling } from "./billing";

const PROVIDER = "venice";

/** Balances in documented field order; Venice documents no draw order between them. */
const BALANCES = [
	{ field: "USD", id: "venice:usd", label: "USD balance", unit: "usd" },
	{ field: "DIEM", id: "venice:diem", label: "DIEM balance", unit: "credits" },
	{ field: "BUNDLED_CREDITS", id: "venice:bundled-credits", label: "Bundled credits", unit: "credits" },
] as const;
const BALANCE_IDS = new Set<string>(BALANCES.map(balance => balance.id));

export const veniceUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "Venice",
	url: "https://api.venice.ai/api/v1/api_keys/rate_limits",
	inferenceHost: "api.venice.ai",
	acceptsInferenceKey: true,
	parse(payload) {
		const data = payload.data;
		if (!isRecord(data) || typeof data.accessPermitted !== "boolean" || !isRecord(data.balances)) return undefined;
		const balances = data.balances;
		const epochEnd = typeof data.nextEpochBegins === "string" ? Date.parse(data.nextEpochBegins) : Number.NaN;
		const limits: UsageLimit[] = [];
		for (const { field, id, label, unit } of BALANCES) {
			const remaining = finiteNumber(balances[field]);
			if (remaining === undefined) continue;
			const limit = balanceLimit(PROVIDER, id, label, remaining, unit);
			// DIEM is allocated per epoch (the billing balance API reports `diemEpochAllocation`).
			if (field === "DIEM" && Number.isFinite(epochEnd)) {
				limits.push({
					...limit,
					scope: { ...limit.scope, windowId: "epoch" },
					window: { id: "epoch", label: "Epoch", resetsAt: epochEnd },
				});
			} else {
				limits.push(limit);
			}
		}
		if (limits.length === 0) return undefined;
		const tier = isRecord(data.apiTier) ? data.apiTier : undefined;
		return {
			limits,
			metadata: {
				accessPermitted: data.accessPermitted,
				...(typeof tier?.id === "string" ? { apiTier: tier.id } : {}),
				...(typeof tier?.isCharged === "boolean" ? { apiTierCharged: tier.isCharged } : {}),
			},
		};
	},
});

/**
 * Venice billing: each reported balance is a prepaid source (USD as money,
 * DIEM and bundled credits as credits) in documented field order. A balance
 * whose amount cannot be represented is left out rather than failing the
 * others. When the key reports that it may not consume inference, a funded
 * balance reads `unknown`, since the docs do not say why access was refused.
 */
export const veniceBilling: ProviderBilling = {
	id: PROVIDER,
	readBilling(report) {
		const limits = report.limits.filter(limit => BALANCE_IDS.has(limit.id));
		if (limits.length === 0) return unknownBilling(report, "no-evidence");
		const refused = report.metadata?.accessPermitted === false;
		const sources: BillingSource[] = [];
		for (const limit of limits) {
			const source = sourceFromLimit("prepaid-credits", limit);
			if (!source) continue;
			sources.push(refused && source.state === "available" ? { ...source, state: "unknown" } : source);
		}
		return sources.length > 0 ? knownBilling(report, sources) : unknownBilling(report, "malformed");
	},
};
