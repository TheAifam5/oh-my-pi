import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	addMoney,
	type BillingResult,
	compareMoney,
	MAX_BILLING_CLOCK_SKEW_MS,
	moneyFromDecimal,
	moneyFromMinor,
	type ProviderBilling,
	ProviderBillingRegistry,
	requireFreshBilling,
	scaleDecimal,
	subtractMoney,
} from "@oh-my-pi/pi-ai/usage/billing";
import { charmHyperBilling } from "@oh-my-pi/pi-ai/usage/charm-hyper";
import { claudeBilling, parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { cursorBilling, parseCursorIndividualUsage } from "@oh-my-pi/pi-ai/usage/cursor";
import { factoryDroidBilling, parseFactoryDroidUsage } from "@oh-my-pi/pi-ai/usage/factory-droid";
import { githubCopilotBilling, githubCopilotUsageProvider } from "@oh-my-pi/pi-ai/usage/github-copilot";
import { codexBilling, openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";
import { syntheticBilling, syntheticUsageProvider } from "@oh-my-pi/pi-ai/usage/synthetic";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

function jsonFetch(payload: unknown): FetchImpl {
	const fn = async () => new Response(JSON.stringify(payload), { status: 200 });
	return fn as unknown as FetchImpl;
}

/** The auth broker strips `raw` before sending a report over the wire. */
function overWire(report: UsageReport): UsageReport {
	const { raw: _raw, ...rest } = report;
	return rest;
}

function sources(result: BillingResult) {
	if (result.status !== "known") throw new Error(`expected known billing, got ${result.reason}`);
	return result.snapshot.sources;
}

describe("money", () => {
	it("recovers exact minor units from floats produced by minor / 10^k", () => {
		for (const minor of [1, 1999, 123_456_789]) {
			expect(moneyFromDecimal(minor / 100, "USD", "ceil")).toEqual(usd(minor));
			expect(moneyFromDecimal(minor / 100, "USD", "floor")).toEqual(usd(minor));
		}
		expect(scaleDecimal(1e-7, 9, "floor")).toBe(100);
	});

	it("rounds excess decimal places by the requested mode", () => {
		expect(scaleDecimal("0.125", 2, "floor")).toBe(12);
		expect(scaleDecimal("0.125", 2, "ceil")).toBe(13);
		expect(scaleDecimal("0.125", 2, "half-even")).toBe(12);
		expect(scaleDecimal("0.135", 2, "half-even")).toBe(14);
		expect(scaleDecimal("-0.125", 2, "floor")).toBe(-13);
		// Float noise from a product rounds conservatively instead of disappearing.
		expect(moneyFromDecimal(0.1 + 0.2, "USD", "ceil")).toEqual(usd(31));
	});

	it("uses the ISO 4217 exponent of each currency and rejects unknown codes", () => {
		expect(moneyFromDecimal("1500", "jpy", "floor")).toEqual({ amountMinor: 1500, currency: "JPY" });
		expect(moneyFromDecimal("1.234", "BHD", "floor")).toEqual({ amountMinor: 1234, currency: "BHD" });
		expect(moneyFromMinor(123_456, 4, "USD", "ceil")).toEqual(usd(1235));
		expect(moneyFromDecimal("1", "ZZZ", "floor")).toBeUndefined();
	});

	it("rejects malformed, non-finite, and unsafe amounts", () => {
		expect(scaleDecimal(Number.NaN, 2, "floor")).toBeUndefined();
		expect(scaleDecimal("1,5", 2, "floor")).toBeUndefined();
		expect(scaleDecimal("1e30", 2, "floor")).toBeUndefined();
		expect(moneyFromMinor(1.5, 2, "USD", "floor")).toBeUndefined();
	});

	it("refuses arithmetic across currencies or past the safe integer range", () => {
		expect(addMoney(usd(150), usd(275))).toEqual(usd(425));
		expect(subtractMoney(usd(150), usd(275))).toEqual(usd(-125));
		const eur = { amountMinor: 100, currency: "EUR" };
		expect(addMoney(usd(100), eur)).toBeUndefined();
		expect(compareMoney(usd(100), eur)).toBeUndefined();
		expect(addMoney(usd(Number.MAX_SAFE_INTEGER), usd(1))).toBeUndefined();
	});
});

describe("billing freshness", () => {
	const known: BillingResult = {
		status: "known",
		snapshot: { provider: "anthropic", fetchedAt: 10_000, sources: [] },
	};

	it("keeps evidence up to the bound and turns older evidence into stale unknown", () => {
		expect(requireFreshBilling(known, 15_000, 5_000)).toBe(known);
		expect(requireFreshBilling(known, 15_001, 5_000)).toEqual({
			status: "unknown",
			provider: "anthropic",
			reason: "stale",
			fetchedAt: 10_000,
		});
		expect(() => requireFreshBilling(known, 0, -1)).toThrow(RangeError);
	});

	it("tolerates a future fetch time only within the clock skew bound", () => {
		expect(requireFreshBilling(known, 10_000 - MAX_BILLING_CLOCK_SKEW_MS, 0)).toBe(known);
		expect(requireFreshBilling(known, 10_000 - MAX_BILLING_CLOCK_SKEW_MS - 1, 60_000)).toMatchObject({
			status: "unknown",
			reason: "stale",
		});
	});
});

describe("ProviderBillingRegistry", () => {
	const report: UsageReport = { provider: "anthropic", fetchedAt: 42, limits: [] };

	it("reports why billing is unknown instead of defaulting", () => {
		const throwing: ProviderBilling = {
			id: "cursor",
			readBilling() {
				throw new Error("boom");
			},
		};
		const registry = new ProviderBillingRegistry([claudeBilling, throwing]);
		expect(registry.read("openrouter", null)).toMatchObject({ status: "unknown", reason: "no-reader" });
		expect(registry.read("anthropic", null)).toMatchObject({ status: "unknown", reason: "no-report" });
		expect(registry.read("anthropic", { ...report, provider: "openai-codex" })).toEqual({
			status: "unknown",
			provider: "anthropic",
			reason: "malformed",
			fetchedAt: 42,
		});
		expect(registry.read("cursor", { ...report, provider: "cursor" })).toMatchObject({
			status: "unknown",
			reason: "malformed",
		});
	});

	it("rejects a duplicate registration until the first is removed", () => {
		const registry = new ProviderBillingRegistry();
		const unregister = registry.register(claudeBilling);
		expect(() => registry.register(claudeBilling)).toThrow(/already registered/);
		unregister();
		registry.register(claudeBilling);
		expect(registry.get("anthropic")).toBe(claudeBilling);
	});

	it("applies the freshness bound in readFresh", () => {
		const registry = new ProviderBillingRegistry([claudeBilling]);
		expect(registry.readFresh("anthropic", report, 42 + 1_000, 1_000).status).toBe("known");
		expect(registry.readFresh("anthropic", report, 42 + 1_001, 1_000)).toMatchObject({
			status: "unknown",
			reason: "stale",
		});
	});
});

describe("Claude billing", () => {
	const windows = { five_hour: { utilization: 12, resets_at: "2026-10-03T12:00:00Z" } };

	it("reads paid extra usage exactly from a broker-delivered report", () => {
		const report = parseClaudeUsagePayload(
			{
				...windows,
				spend: {
					enabled: true,
					used: { amount_minor: 1999, exponent: 2, currency: "USD" },
					limit: { amount_minor: 5000, exponent: 2, currency: "USD" },
				},
			},
			{},
			undefined,
			1_000,
		);
		if (!report) throw new Error("fixture did not parse");
		expect(sources(claudeBilling.readBilling(overWire(report)))).toEqual([
			{ mode: "subscription-included", state: "unknown" },
			{
				mode: "paid-extra-usage",
				state: "available",
				allowance: { kind: "money", used: usd(1999), limit: usd(5000), remaining: usd(3001) },
			},
		]);
	});

	it("marks enabled extra usage without a monthly limit as uncapped and available", () => {
		const report = parseClaudeUsagePayload({
			...windows,
			spend: { enabled: true, used: { amount_minor: 4200, exponent: 2, currency: "USD" }, limit: null },
		});
		if (!report) throw new Error("fixture did not parse");
		expect(sources(claudeBilling.readBilling(overWire(report)))[1]).toEqual({
			mode: "paid-extra-usage",
			state: "available",
			allowance: { kind: "money", used: usd(4200), uncapped: true },
		});
	});

	it("distinguishes spent, switched-off, and unreported extra usage", () => {
		const spent = parseClaudeUsagePayload({
			...windows,
			extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 2000, currency: "USD" },
		});
		const off = parseClaudeUsagePayload({ ...windows, extra_usage: { is_enabled: false } });
		const silent = parseClaudeUsagePayload(windows);
		if (!spent || !off || !silent) throw new Error("fixture did not parse");
		expect(sources(claudeBilling.readBilling(spent))[1]).toMatchObject({ state: "exhausted" });
		expect(sources(claudeBilling.readBilling(overWire(off)))[1]).toEqual({
			mode: "paid-extra-usage",
			state: "disabled",
		});
		expect(sources(claudeBilling.readBilling(silent))[1]).toEqual({ mode: "paid-extra-usage", state: "unknown" });
	});
});

describe("Codex billing", () => {
	async function codexReport(extra: Record<string, unknown>): Promise<UsageReport> {
		const payload = {
			plan_type: "plus",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 2_000_000_000 },
			},
			...extra,
		};
		const report = await openaiCodexUsageProvider.fetchUsage(
			{ provider: "openai-codex", credential: { type: "oauth", accessToken: "token", accountId: "acct" } },
			{ fetch: jsonFetch(payload) },
		);
		if (!report) throw new Error("fixture did not parse");
		return overWire(report);
	}

	it("reads the prepaid credit balance through the wire", async () => {
		const report = await codexReport({ credits: { has_credits: true, unlimited: false, balance: "489.25" } });
		expect(sources(codexBilling.readBilling(report))).toEqual([
			{ mode: "subscription-included", state: "unknown" },
			{
				mode: "prepaid-credits",
				state: "available",
				allowance: { kind: "credits", remaining: { amountMinor: 48925, exponent: 2 } },
			},
		]);
	});

	it.each([
		["the overage cap", { credits: { has_credits: true, overage_limit_reached: true, balance: "12" } }],
		["spend control", { credits: { has_credits: true, balance: "12" }, spend_control: { reached: true } }],
		["an empty balance", { credits: { has_credits: false, balance: "0" } }],
	])("marks credits exhausted by %s", async (_name, extra) => {
		expect(sources(codexBilling.readBilling(await codexReport(extra)))[1]).toMatchObject({ state: "exhausted" });
	});

	it("classifies the free plan and leaves absent credits unknown", async () => {
		const report = await codexReport({ plan_type: "free" });
		expect(sources(codexBilling.readBilling(report))).toEqual([
			{ mode: "free", state: "unknown" },
			{ mode: "prepaid-credits", state: "unknown" },
		]);
	});
});

describe("Factory billing", () => {
	it("reads the extra usage balance from cents", () => {
		const windows = { limits: { standard: { weekly: { usedPercent: 4, windowEnd: "2099-01-01T00:00:00Z" } } } };
		const report = parseFactoryDroidUsage({ ...windows, extraUsageBalanceCents: 1234 }, 1);
		if (!report) throw new Error("fixture did not parse");
		expect(sources(factoryDroidBilling.readBilling(overWire(report)))[1]).toEqual({
			mode: "prepaid-credits",
			state: "available",
			allowance: { kind: "money", used: usd(0), limit: usd(1234), remaining: usd(1234) },
		});
	});
});

describe("Cursor billing", () => {
	it("reads included and on-demand dollars from usage-summary cents", () => {
		const report = parseCursorIndividualUsage(
			{
				individualUsage: {
					overall: { enabled: true, used: 2000, limit: 2000, remaining: 0 },
					onDemand: { enabled: true, used: 1250, limit: 5000, remaining: 3750 },
				},
			},
			1,
		);
		if (!report) throw new Error("fixture did not parse");
		expect(sources(cursorBilling.readBilling(overWire(report)))).toEqual([
			{
				mode: "subscription-included",
				state: "exhausted",
				allowance: { kind: "money", used: usd(2000), limit: usd(2000), remaining: usd(0) },
			},
			{
				mode: "paid-extra-usage",
				state: "available",
				allowance: { kind: "money", used: usd(1250), limit: usd(5000), remaining: usd(3750) },
			},
		]);
	});
});

describe("GitHub Copilot billing", () => {
	it.each([
		[true, "available"],
		[false, "disabled"],
	] as const)("maps overage_permitted=%s to a %s paid overage source", async (permitted, state) => {
		const premium = {
			entitlement: 300,
			remaining: 0,
			percent_remaining: 0,
			unlimited: false,
			overage_count: 3,
			overage_permitted: permitted,
		};
		const report = await githubCopilotUsageProvider.fetchUsage(
			{ provider: "github-copilot", credential: { type: "oauth", accessToken: "token", accountId: "octo" } },
			{
				fetch: jsonFetch({
					copilot_plan: "individual",
					quota_reset_date: "2026-11-01",
					quota_snapshots: { premium_interactions: premium },
				}),
			},
		);
		if (!report) throw new Error("fixture did not parse");
		expect(sources(githubCopilotBilling.readBilling(overWire(report)))).toEqual([
			{ mode: "subscription-included", state: "unknown" },
			{ mode: "paid-extra-usage", state },
		]);
	});
});

describe("Synthetic billing", () => {
	it("keeps the reported remaining dollars instead of deriving them from a percentage", async () => {
		const report = await syntheticUsageProvider.fetchUsage(
			{ provider: "synthetic", credential: { type: "api_key", apiKey: "key" } },
			{
				fetch: jsonFetch({
					rollingFiveHourLimit: { remaining: 500, max: 500, limited: false },
					weeklyTokenLimit: { percentRemaining: 7.615, maxCredits: "$24.00", remainingCredits: "$1.82" },
				}),
			},
		);
		if (!report) throw new Error("fixture did not parse");
		expect(sources(syntheticBilling.readBilling(overWire(report)))[0]).toMatchObject({
			mode: "subscription-included",
			state: "available",
			allowance: { kind: "money", limit: usd(2400), remaining: usd(182) },
		});
	});
});

describe("credit-balance billing", () => {
	it("marks an empty prepaid balance exhausted and a report without one as no evidence", () => {
		const empty: UsageReport = {
			provider: "charm-hyper",
			fetchedAt: 1,
			limits: [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: { provider: "charm-hyper", windowId: "balance", shared: true },
					amount: { remaining: 0, unit: "credits" },
				},
			],
		};
		expect(sources(charmHyperBilling.readBilling(empty))).toEqual([
			{
				mode: "prepaid-credits",
				state: "exhausted",
				allowance: { kind: "credits", remaining: { amountMinor: 0, exponent: 0 } },
			},
		]);
		expect(charmHyperBilling.readBilling({ ...empty, limits: [] })).toEqual({
			status: "unknown",
			provider: "charm-hyper",
			reason: "no-evidence",
			fetchedAt: 1,
		});
	});
});
