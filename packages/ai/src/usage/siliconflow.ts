/**
 * SiliconFlow account balance usage providers for the international
 * (`api.siliconflow.com`) and China (`api.siliconflow.cn`) platforms.
 *
 * The response shape follows the official API reference:
 * https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info
 * which authenticates with the inference key (`Bearer <your api key>`) and
 * documents the endpoint on `api.siliconflow.com`. The China platform serves the
 * same `GET /v1/user/info` path for its own keys; each platform's key is sent only
 * to its own host. The reference states no currency for the balance, so it is
 * reported as credits and never as money.
 */
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, decimalString, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "siliconflow";
const BALANCE_LIMIT_ID = "siliconflow:balance";
const CN_PROVIDER = "siliconflow-cn";
const CN_BALANCE_LIMIT_ID = "siliconflow-cn:balance";

function parseUserInfo(
	provider: Provider,
	limitId: string,
	payload: Record<string, unknown>,
): Pick<UsageReport, "limits" | "metadata"> | undefined {
	if (payload.code !== 20000 || payload.status !== true || !isRecord(payload.data)) return undefined;
	const total = decimalString(payload.data.totalBalance);
	if (total === undefined) return undefined;
	const limit = balanceLimit(provider, limitId, "Balance", Number(total), "credits");
	// A zero balance may still serve free models, so the limit never blocks the credential; billing reads the amount.
	return { limits: [{ ...limit, status: "ok", notes: ["currency not documented"] }], metadata: {} };
}

export const siliconflowUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "SiliconFlow",
	url: "https://api.siliconflow.com/v1/user/info",
	inferenceHost: "api.siliconflow.com",
	acceptsInferenceKey: true,
	parse: payload => parseUserInfo(PROVIDER, BALANCE_LIMIT_ID, payload),
});

export const siliconflowCnUsageProvider = accountBalanceUsageProvider({
	provider: CN_PROVIDER,
	name: "SiliconFlow China",
	url: "https://api.siliconflow.cn/v1/user/info",
	inferenceHost: "api.siliconflow.cn",
	acceptsInferenceKey: true,
	parse: payload => parseUserInfo(CN_PROVIDER, CN_BALANCE_LIMIT_ID, payload),
});

/** SiliconFlow billing: the total balance as unit-less prepaid credits. */
export const siliconflowBilling = prepaidBalanceBilling(PROVIDER, [BALANCE_LIMIT_ID]);

/** SiliconFlow China billing: the total balance as unit-less prepaid credits. */
export const siliconflowCnBilling = prepaidBalanceBilling(CN_PROVIDER, [CN_BALANCE_LIMIT_ID]);
