/**
 * Moonshot (Kimi platform) account balance usage provider.
 *
 * The response shape follows the official API references:
 * https://platform.kimi.ai/docs/api/balance (international, USD)
 * https://platform.kimi.com/docs/api/balance (China, `api.moonshot.cn`, CNY)
 * both of which authenticate with the inference key (`Authorization: Bearer {MOONSHOT_API_KEY}`).
 * The two platforms issue separate keys, so each balance endpoint is read only
 * when inference for the credential goes to its own host.
 */
import { $env } from "@oh-my-pi/pi-utils";
import type { UsageLimit, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, finiteNumber } from "./account-balance";
import {
	type BillingSource,
	knownBilling,
	moneyFromDecimal,
	type ProviderBilling,
	sourceFromLimit,
	unknownBilling,
} from "./billing";

const PROVIDER = "moonshot";
const BALANCE_LIMIT_ID = "moonshot:balance";
const CNY_BALANCE_LIMIT_ID = "moonshot:balance:cny";

interface MoonshotBalance {
	available: number;
	voucher?: number;
	cash?: number;
}

function parseBalance(payload: Record<string, unknown>): MoonshotBalance | undefined {
	if ((payload.code !== undefined && payload.code !== 0) || payload.status === false) return undefined;
	if (!isRecord(payload.data)) return undefined;
	const available = finiteNumber(payload.data.available_balance);
	if (available === undefined) return undefined;
	return {
		available,
		voucher: finiteNumber(payload.data.voucher_balance),
		cash: finiteNumber(payload.data.cash_balance),
	};
}

const internationalUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "Moonshot",
	url: "https://api.moonshot.ai/v1/users/me/balance",
	inferenceHost: "api.moonshot.ai",
	// Inference honors this over any configured base URL, so a China-platform setting skips the read.
	baseUrlOverride: () => $env.MOONSHOT_BASE_URL,
	acceptsInferenceKey: true,
	parse(payload) {
		const balance = parseBalance(payload);
		if (!balance) return undefined;
		const { available, voucher, cash } = balance;
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

const chinaUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "Moonshot China",
	url: "https://api.moonshot.cn/v1/users/me/balance",
	inferenceHost: "api.moonshot.cn",
	requiresConfiguredBaseUrl: true,
	baseUrlOverride: () => $env.MOONSHOT_BASE_URL,
	acceptsInferenceKey: true,
	parse(payload) {
		const balance = parseBalance(payload);
		if (!balance) return undefined;
		const { available, voucher, cash } = balance;
		return {
			// The China platform reports yuan, which the payload does not name.
			limits: [
				balanceLimit(PROVIDER, CNY_BALANCE_LIMIT_ID, "CNY balance", available, "unknown", {
					exhausted: available <= 0,
					currency: "CNY",
				}),
			],
			metadata: {
				availableBalanceCny: available,
				...(voucher !== undefined ? { voucherBalanceCny: voucher } : {}),
				...(cash !== undefined ? { cashBalanceCny: cash } : {}),
			},
		};
	},
});

/** Reads the balance of whichever platform the credential's inference host belongs to; at most one is fetched. */
export const moonshotUsageProvider: UsageProvider = {
	...internationalUsageProvider,
	async fetchUsage(params, ctx): Promise<UsageReport | null> {
		return (
			(await internationalUsageProvider.fetchUsage(params, ctx)) ??
			(await chinaUsageProvider.fetchUsage(params, ctx))
		);
	},
};

function cnySource(limit: UsageLimit): BillingSource | undefined {
	if (limit.amount.unit !== "unknown" || limit.amount.currency !== "CNY" || limit.amount.remaining === undefined) {
		return undefined;
	}
	const money = moneyFromDecimal(limit.amount.remaining, "CNY", "floor");
	if (!money) return undefined;
	const remaining = { ...money, amountMinor: Math.max(0, money.amountMinor) };
	const state = limit.status !== "exhausted" && remaining.amountMinor > 0 ? "available" : "exhausted";
	return { mode: "prepaid-credits", state, allowance: { kind: "money", remaining } };
}

/** Moonshot billing: one prepaid balance combining cash and vouchers, in USD or, on the China platform, CNY. */
export const moonshotBilling: ProviderBilling = {
	id: PROVIDER,
	readBilling(report) {
		const usd = report.limits.find(limit => limit.id === BALANCE_LIMIT_ID);
		const cny = report.limits.find(limit => limit.id === CNY_BALANCE_LIMIT_ID);
		if (!usd && !cny) return unknownBilling(report, "no-evidence");
		const source = usd ? sourceFromLimit("prepaid-credits", usd) : cny && cnySource(cny);
		return source ? knownBilling(report, [source]) : unknownBilling(report, "malformed");
	},
};
