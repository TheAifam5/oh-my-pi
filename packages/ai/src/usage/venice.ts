/**
 * Venice account balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://docs.venice.ai/api-reference/endpoint/billing/balance
 * The docs describe the Bearer token as a JWT, not as the inference API key.
 */
import type { UsageLimit } from "../usage";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, finiteNumber, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "venice";

/** Balances in documented order, keyed by their `consumptionCurrency` value. */
const BALANCES = [
	{ currency: "USD", field: "usd", id: "venice:usd", label: "USD balance", unit: "usd" },
	{ currency: "DIEM", field: "diem", id: "venice:diem", label: "DIEM balance", unit: "credits" },
	{
		currency: "BUNDLED_CREDITS",
		field: "bundledCredits",
		id: "venice:bundled-credits",
		label: "Bundled credits",
		unit: "credits",
	},
	{
		currency: "EARNED_CREDITS",
		field: "earnedCredits",
		id: "venice:earned-credits",
		label: "Earned credits",
		unit: "credits",
	},
] as const;

export const veniceUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "Venice",
	url: "https://api.venice.ai/api/v1/billing/balance",
	inferenceHost: "api.venice.ai",
	acceptsInferenceKey: false,
	parse(payload) {
		if (typeof payload.canConsume !== "boolean" || !isRecord(payload.balances)) return undefined;
		const balances = payload.balances;
		const exhausted = !payload.canConsume;
		const allocation = finiteNumber(payload.diemEpochAllocation);
		const limits: UsageLimit[] = [];
		for (const { currency, field, id, label, unit } of BALANCES) {
			const remaining = finiteNumber(balances[field]);
			if (remaining === undefined) continue;
			const limit = balanceLimit(PROVIDER, id, label, remaining, unit, {
				exhausted,
				// The epoch allocation caps DIEM only while it covers the balance.
				...(currency === "DIEM" && allocation !== undefined && allocation > 0 && remaining <= allocation
					? { limit: allocation }
					: {}),
			});
			// The balance the account currently spends from is drawn first.
			if (currency === payload.consumptionCurrency) limits.unshift(limit);
			else limits.push(limit);
		}
		if (limits.length === 0) return undefined;
		return { limits, metadata: {} };
	},
});

/**
 * Venice billing: each reported balance is a prepaid source (USD as money,
 * DIEM and credits as credits), the currently consumed one first, all
 * exhausted when the account reports it cannot consume.
 */
export const veniceBilling = prepaidBalanceBilling(
	PROVIDER,
	BALANCES.map(balance => balance.id),
);
