/**
 * DeepSeek account balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://api-docs.deepseek.com/api/get-user-balance
 * The API authenticates every endpoint with the same `Authorization: Bearer ${DEEPSEEK_API_KEY}`:
 * https://api-docs.deepseek.com/
 */
import type { UsageLimit, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, balanceLimit, decimalString } from "./account-balance";
import { type BillingSource, knownBilling, moneyFromDecimal, type ProviderBilling, unknownBilling } from "./billing";

const PROVIDER = "deepseek";
/** Balance currencies the API documents. */
const CURRENCIES = new Set(["CNY", "USD"]);

/** One balance per currency, as exact decimal strings in major units. */
interface DeepSeekBalance {
	currency: string;
	total: string;
}

function readBalances(value: unknown, totalKey: "total_balance" | "total"): DeepSeekBalance[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const balances: DeepSeekBalance[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.currency !== "string" || !CURRENCIES.has(entry.currency)) return undefined;
		const total = decimalString(entry[totalKey]);
		if (total === undefined) return undefined;
		balances.push({ currency: entry.currency, total });
	}
	return balances;
}

function parseDeepSeekBalance(payload: Record<string, unknown>): Pick<UsageReport, "limits" | "metadata"> | undefined {
	if (typeof payload.is_available !== "boolean") return undefined;
	const balances = readBalances(payload.balance_infos, "total_balance");
	if (!balances) return undefined;
	const exhausted = !payload.is_available;
	const limits: UsageLimit[] = balances.map(({ currency, total }) =>
		balanceLimit(
			PROVIDER,
			`deepseek:balance:${currency.toLowerCase()}`,
			`${currency} balance`,
			Number(total),
			currency === "USD" ? "usd" : "unknown",
			{ exhausted },
		),
	);
	// Limits carry floats and no CNY unit; billing reads the exact strings.
	return { limits, metadata: { isAvailable: payload.is_available, balances } };
}

export const deepseekUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "DeepSeek",
	url: "https://api.deepseek.com/user/balance",
	inferenceHost: "api.deepseek.com",
	acceptsInferenceKey: true,
	parse: parseDeepSeekBalance,
});

/**
 * DeepSeek billing: one prepaid balance per currency (granted plus topped-up
 * funds), all exhausted when the account reports it cannot be used.
 */
export const deepseekBilling: ProviderBilling = {
	id: PROVIDER,
	readBilling(report) {
		const metadata = report.metadata;
		if (metadata?.balances === undefined) return unknownBilling(report, "no-evidence");
		const balances = readBalances(metadata.balances, "total");
		if (!balances || typeof metadata.isAvailable !== "boolean") return unknownBilling(report, "malformed");
		const sources: BillingSource[] = [];
		for (const { currency, total } of balances) {
			const money = moneyFromDecimal(total, currency, "floor");
			if (!money) return unknownBilling(report, "malformed");
			const remaining = { ...money, amountMinor: Math.max(0, money.amountMinor) };
			const state = metadata.isAvailable && remaining.amountMinor > 0 ? "available" : "exhausted";
			sources.push({ mode: "prepaid-credits", state, allowance: { kind: "money", remaining } });
		}
		return knownBilling(report, sources);
	},
};
