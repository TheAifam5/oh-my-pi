/**
 * DeepInfra account state usage provider.
 *
 * The response shape follows the official API reference:
 * https://docs.deepinfra.com/api-reference/billing/get-checklist.md
 * It documents the sign of `stripe_balance` (negative: funds ready to spend;
 * positive: money owed) but not its unit, nor the units of `recent` and
 * `limit`, so only the sign, the suspension verdict, and the cent-denominated
 * scoped credits are read. The reference names an HTTP Bearer scheme without
 * stating that this endpoint accepts the inference API key
 * (https://docs.deepinfra.com/account/authentication.md), so a 401 is not
 * treated as a rejected key.
 *
 * A suspension is reported as an exhausted account limit without a reset
 * time, so credential selection blocks the key for the default block period
 * and re-blocks it while cached reports still show the suspension; the block
 * stops being renewed once a refreshed report no longer carries the limit.
 */
import type { UsageLimit, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { accountBalanceUsageProvider, finiteNumber } from "./account-balance";
import { type BillingSourceState, knownBilling, type ProviderBilling, unknownBilling } from "./billing";

const PROVIDER = "deepinfra";

/** Documented `suspend_reason` values and the funding state each implies. */
const SUSPEND_STATES: Readonly<Record<string, BillingSourceState>> = {
	balance: "exhausted",
	"limit-reached": "exhausted",
	"payment-method": "disabled",
	"overdue-invoices": "disabled",
	admin: "disabled",
	"bad-cc": "disabled",
	"missing-address": "disabled",
};

/** An unexpired model-scoped credit, in cents. */
interface ScopedCredit {
	grantedCents: number;
	remainingCents: number;
}

function readSuspendReason(value: unknown): string | null | undefined {
	if (value === null || value === undefined) return null;
	return typeof value === "string" && Object.hasOwn(SUSPEND_STATES, value) ? value : undefined;
}

function readScopedCredits(value: unknown): ScopedCredit[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const credits: ScopedCredit[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return undefined;
		if (entry.expired === true) continue;
		const grantedCents = finiteNumber(entry.granted_cents);
		const remainingCents = finiteNumber(entry.remaining_cents);
		if (grantedCents === undefined || remainingCents === undefined) return undefined;
		credits.push({ grantedCents, remainingCents });
	}
	return credits;
}

function parseChecklist(payload: Record<string, unknown>): Pick<UsageReport, "limits" | "metadata"> | undefined {
	const stripeBalance = finiteNumber(payload.stripe_balance);
	const suspended = payload.suspended ?? false;
	// A reason only matters, and is only validated, while the account is suspended.
	const suspendReason = suspended === true ? readSuspendReason(payload.suspend_reason) : null;
	const scopedCredits = readScopedCredits(payload.scoped_credits);
	if (stripeBalance === undefined || typeof suspended !== "boolean" || suspendReason === undefined || !scopedCredits) {
		return undefined;
	}
	const limits: UsageLimit[] = suspended
		? [
				{
					id: "deepinfra:account",
					label: "Account",
					scope: { provider: PROVIDER, windowId: "balance", shared: true },
					amount: { unit: "unknown" },
					status: "exhausted",
					notes: [suspendReason ? `suspended: ${suspendReason}` : "suspended"],
				},
			]
		: [];
	return {
		limits,
		metadata: {
			suspended,
			...(suspendReason ? { suspendReason } : {}),
			fundsReady: stripeBalance < 0,
			// Each credit is spendable only on certain models, so none of them funds the account as a whole.
			...(scopedCredits.length > 0 ? { scopedCredits } : {}),
		},
	};
}

export const deepinfraUsageProvider = accountBalanceUsageProvider({
	provider: PROVIDER,
	name: "DeepInfra",
	url: "https://api.deepinfra.com/payment/checklist",
	inferenceHost: "api.deepinfra.com",
	acceptsInferenceKey: false,
	parse: parseChecklist,
});

/**
 * DeepInfra billing: a negative Stripe balance is a prepaid source of
 * unreported size; a suspension makes the account's source exhausted (balance
 * or spending limit) or disabled (any other reason). An active account
 * without ready funds is no evidence, because postpaid acceptance is not documented.
 */
export const deepinfraBilling: ProviderBilling = {
	id: PROVIDER,
	readBilling(report) {
		const metadata = report.metadata;
		if (metadata?.suspended === undefined) return unknownBilling(report, "no-evidence");
		const { suspended, fundsReady } = metadata;
		const suspendReason = readSuspendReason(metadata.suspendReason);
		if (typeof suspended !== "boolean" || typeof fundsReady !== "boolean" || suspendReason === undefined) {
			return unknownBilling(report, "malformed");
		}
		const mode = fundsReady ? "prepaid-credits" : "unknown";
		if (suspended) {
			const state = (suspendReason && SUSPEND_STATES[suspendReason]) || "disabled";
			return knownBilling(report, [{ mode, state }]);
		}
		return fundsReady ? knownBilling(report, [{ mode, state: "available" }]) : unknownBilling(report, "no-evidence");
	},
};
