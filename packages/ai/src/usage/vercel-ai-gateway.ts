/**
 * Vercel AI Gateway credit balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api
 * which authenticates with the AI Gateway API key (`Authorization: Bearer <api_key>`).
 */
import { accountBalanceUsageProvider, balanceLimit, decimalString, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "vercel-ai-gateway";
const BALANCE_LIMIT_ID = "vercel-ai-gateway:credits";

export const vercelAiGatewayUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "Vercel AI Gateway",
	url: "https://ai-gateway.vercel.sh/v1/credits",
	inferenceHost: "ai-gateway.vercel.sh",
	acceptsInferenceKey: true,
	parse(payload) {
		const balance = decimalString(payload.balance);
		if (balance === undefined) return undefined;
		const totalUsed = decimalString(payload.total_used);
		return {
			limits: [balanceLimit(PROVIDER, BALANCE_LIMIT_ID, "Credit balance", Number(balance), "usd")],
			// Lifetime spend, not a cap: kept out of the limit so it is never read as one.
			metadata: totalUsed !== undefined ? { totalUsedUsd: Number(totalUsed) } : {},
		};
	},
});

/** Vercel AI Gateway billing: the team's prepaid credits; BYOK requests do not draw on them. */
export const vercelAiGatewayBilling = prepaidBalanceBilling(PROVIDER, [BALANCE_LIMIT_ID]);
