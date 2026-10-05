/**
 * AI/ML API account balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://docs.aimlapi.com/api-references/service-endpoints/account-balance.md
 * which authenticates with the account's AIMLAPI key.
 */
import { accountBalanceUsageProvider, balanceLimit, finiteNumber, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "aimlapi";
const BALANCE_LIMIT_ID = "aimlapi:balance";

export const aimlapiUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "AI/ML API",
	url: "https://api.aimlapi.com/v2/billing",
	inferenceHost: "api.aimlapi.com",
	acceptsInferenceKey: true,
	parse(payload) {
		const balance = finiteNumber(payload.current_balance);
		if (balance === undefined || payload.currency !== "USD") return undefined;
		return { limits: [balanceLimit(PROVIDER, BALANCE_LIMIT_ID, "Balance", balance, "usd")], metadata: {} };
	},
});

/** AI/ML API billing: one prepaid USD balance. */
export const aimlapiBilling = prepaidBalanceBilling(PROVIDER, [BALANCE_LIMIT_ID]);
