/**
 * Moonshot (Kimi platform) account balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://platform.kimi.ai/docs/api/balance
 * which authenticates with the inference key (`Authorization: Bearer {MOONSHOT_API_KEY}`).
 * China-platform keys (`api.moonshot.cn`) are a separate account system and are not read.
 */
import { $env } from "@oh-my-pi/pi-utils";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, finiteNumber, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "moonshot";
const BALANCE_LIMIT_ID = "moonshot:balance";

export const moonshotUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "Moonshot",
	url: "https://api.moonshot.ai/v1/users/me/balance",
	inferenceHost: "api.moonshot.ai",
	// Inference honors this over any configured base URL, so a China-platform setting skips the read.
	baseUrlOverride: () => $env.MOONSHOT_BASE_URL,
	acceptsInferenceKey: true,
	parse(payload) {
		if ((payload.code !== undefined && payload.code !== 0) || payload.status === false) return undefined;
		if (!isRecord(payload.data)) return undefined;
		const available = finiteNumber(payload.data.available_balance);
		if (available === undefined) return undefined;
		const voucher = finiteNumber(payload.data.voucher_balance);
		const cash = finiteNumber(payload.data.cash_balance);
		return {
			// The API refuses inference once the available balance is zero or less.
			limits: [balanceLimit(PROVIDER, BALANCE_LIMIT_ID, "Balance", available, "usd", { exhausted: available <= 0 })],
			metadata: {
				...(voucher !== undefined ? { voucherBalanceUsd: voucher } : {}),
				...(cash !== undefined ? { cashBalanceUsd: cash } : {}),
			},
		};
	},
});

/** Moonshot billing: one prepaid USD balance combining cash and vouchers. */
export const moonshotBilling = prepaidBalanceBilling(PROVIDER, [BALANCE_LIMIT_ID]);
