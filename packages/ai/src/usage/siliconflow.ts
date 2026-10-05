/**
 * SiliconFlow account balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info
 * which authenticates with the inference key (`Bearer <your api key>`) and
 * documents the endpoint only on `api.siliconflow.com`; China-platform keys
 * (`api.siliconflow.cn`) are not read. The reference states no currency for
 * the balance, so it is reported as credits and never as money.
 */
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, decimalString, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "siliconflow";
const BALANCE_LIMIT_ID = "siliconflow:balance";

export const siliconflowUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "SiliconFlow",
	url: "https://api.siliconflow.com/v1/user/info",
	inferenceHost: "api.siliconflow.com",
	acceptsInferenceKey: true,
	parse(payload) {
		if (payload.code !== 20000 || payload.status !== true || !isRecord(payload.data)) return undefined;
		const total = decimalString(payload.data.totalBalance);
		if (total === undefined) return undefined;
		const limit = balanceLimit(PROVIDER, BALANCE_LIMIT_ID, "Balance", Number(total), "credits");
		// A zero balance may still serve free models, so the limit never blocks the credential; billing reads the amount.
		return { limits: [{ ...limit, status: "ok", notes: ["currency not documented"] }], metadata: {} };
	},
});

/** SiliconFlow billing: the total balance as unit-less prepaid credits. */
export const siliconflowBilling = prepaidBalanceBilling(PROVIDER, [BALANCE_LIMIT_ID]);
