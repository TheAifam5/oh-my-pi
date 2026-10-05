/**
 * Novita AI account balance usage provider.
 *
 * The response shape follows the official API reference:
 * https://docs.novita.ai/api-reference/basic-get-user-balance.md
 * which authenticates with the inference key (`Authorization: Bearer <API_KEY>`).
 */
import { accountBalanceUsageProvider, balanceLimit, prepaidBalanceBilling } from "./account-balance";

const PROVIDER = "novita";
const CASH_LIMIT_ID = "novita:cash";
/** Amounts are integer strings in units of 1/10000 USD. */
const UNITS_PER_USD = 10_000;

function usdFromUnits(value: unknown): number | undefined {
	// Fifteen digits keep the float division exact.
	if (typeof value !== "string" || !/^-?\d{1,15}$/.test(value)) return undefined;
	return Number(value) / UNITS_PER_USD;
}

export const novitaUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "Novita",
	url: "https://api.novita.ai/openapi/v1/billing/balance/detail",
	inferenceHost: "api.novita.ai",
	acceptsInferenceKey: true,
	parse(payload) {
		const cash = usdFromUnits(payload.cashBalance);
		if (cash === undefined) return undefined;
		// `availableBalance` adds the postpaid credit line to the cash balance, so it stays out of the limit.
		const figures = {
			availableBalanceUsd: usdFromUnits(payload.availableBalance),
			creditLimitUsd: usdFromUnits(payload.creditLimit),
			pendingChargesUsd: usdFromUnits(payload.pendingCharges),
			outstandingInvoicesUsd: usdFromUnits(payload.outstandingInvoices),
		};
		return {
			limits: [balanceLimit(PROVIDER, CASH_LIMIT_ID, "Cash balance", cash, "usd")],
			metadata: Object.fromEntries(Object.entries(figures).filter(([, value]) => value !== undefined)),
		};
	},
});

/** Novita billing: the topped-up cash balance as prepaid credits; the credit line is not a prepaid source. */
export const novitaBilling = prepaidBalanceBilling(PROVIDER, [CASH_LIMIT_ID]);
