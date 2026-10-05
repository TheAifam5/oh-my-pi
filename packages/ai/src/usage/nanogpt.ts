/**
 * NanoGPT account balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://docs.nano-gpt.com/api-reference/endpoint/check-balance
 * Only the USD balance is read; the Nano balance and deposit address are ignored.
 * The docs name an `x-api-key` header without saying it takes the inference key.
 */
import { accountBalanceUsageProvider, balanceLimit, decimalString, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "nanogpt";
const BALANCE_LIMIT_ID = "nanogpt:balance";

export const nanogptUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "NanoGPT",
	url: "https://api.nano-gpt.com/api/check-balance",
	inferenceHost: "nano-gpt.com",
	acceptsInferenceKey: false,
	method: "POST",
	authHeaders: apiKey => ({ "x-api-key": apiKey }),
	parse(payload) {
		const balance = decimalString(payload.usd_balance);
		if (balance === undefined) return undefined;
		return { limits: [balanceLimit(PROVIDER, BALANCE_LIMIT_ID, "Balance", Number(balance), "usd")], metadata: {} };
	},
});

/** NanoGPT billing: one prepaid USD balance. */
export const nanogptBilling = prepaidBalanceBilling(PROVIDER, [BALANCE_LIMIT_ID]);
