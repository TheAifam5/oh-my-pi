import { describe, expect, it } from "bun:test";
import { TeamsTier } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	addMoney,
	type BillingAllowance,
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
import { devinBilling } from "@oh-my-pi/pi-ai/usage/devin";
import { factoryDroidBilling, parseFactoryDroidUsage } from "@oh-my-pi/pi-ai/usage/factory-droid";
import { githubCopilotBilling, githubCopilotUsageProvider } from "@oh-my-pi/pi-ai/usage/github-copilot";
import { googleGeminiCliUsageProvider } from "@oh-my-pi/pi-ai/usage/gemini";
import { localEndpointUsageReport } from "@oh-my-pi/pi-ai/usage/local-endpoint";
import { minimaxCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/minimax-code";
import { ollamaUsageProvider } from "@oh-my-pi/pi-ai/usage/ollama";
import { codexBilling, openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";
import { opencodeGoUsageProvider } from "@oh-my-pi/pi-ai/usage/opencode-go";
import { limitResetAt, openrouterBilling, openrouterUsageProvider } from "@oh-my-pi/pi-ai/usage/openrouter";
import { defaultBillingReader } from "@oh-my-pi/pi-ai/usage/registry";
import { syntheticBilling, syntheticUsageProvider } from "@oh-my-pi/pi-ai/usage/synthetic";
import { xaiOauthBilling } from "@oh-my-pi/pi-ai/usage/xai-oauth";
import { zaiBilling, zaiUsageProvider } from "@oh-my-pi/pi-ai/usage/zai";

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

describe("Devin billing", () => {
	/** A `devin:credits:*` limit shaped as the seat-management usage provider reports it. */
	function devinCredits(bucket: string, used: number, remaining: number, limit: number): UsageLimit {
		return {
			id: `devin:credits:${bucket}`,
			label: "Credits",
			scope: { provider: "devin", windowId: "monthly" },
			window: { id: "monthly", label: "Plan Period", resetsAt: 2_000 },
			amount: {
				used,
				remaining,
				limit,
				usedFraction: used / limit,
				remainingFraction: 1 - used / limit,
				unit: "unknown",
			},
			status: "ok",
		};
	}
	const credits = (amountMinor: number) => ({ amountMinor, exponent: 0 });

	it("reads plan credit grants before purchased flex credits", () => {
		const report: UsageReport = {
			provider: "devin",
			fetchedAt: 1,
			limits: [
				devinCredits("flex", 200, 0, 200),
				devinCredits("prompt", 125, 375, 500),
				devinCredits("flow", 250, 800, 1000),
			],
		};
		expect(sources(devinBilling.readBilling(report))).toEqual([
			{
				mode: "subscription-included",
				state: "available",
				allowance: { kind: "credits", used: credits(125), limit: credits(500), remaining: credits(375) },
				resetsAt: 2_000,
			},
			{
				mode: "subscription-included",
				state: "available",
				allowance: { kind: "credits", used: credits(250), limit: credits(1000), remaining: credits(800) },
				resetsAt: 2_000,
			},
			{
				mode: "prepaid-credits",
				state: "exhausted",
				allowance: { kind: "credits", used: credits(200), limit: credits(200), remaining: credits(0) },
			},
		]);
	});

	it("reads plan grants as free on the free tier and claims nothing for a trial", () => {
		const report = (teamsTier: TeamsTier): UsageReport => ({
			provider: "devin",
			fetchedAt: 1,
			limits: [devinCredits("prompt", 125, 375, 500), devinCredits("flex", 0, 50, 50)],
			metadata: { teamsTier },
		});
		const modes = (teamsTier: TeamsTier) =>
			sources(devinBilling.readBilling(report(teamsTier))).map(source => source.mode);
		expect(modes(TeamsTier.DEVIN_FREE)).toEqual(["free", "prepaid-credits"]);
		expect(modes(TeamsTier.DEVIN_TRIAL)).toEqual(["unknown", "prepaid-credits"]);
		expect(modes(TeamsTier.TRIAL)).toEqual(["unknown", "prepaid-credits"]);
		expect(modes(TeamsTier.DEVIN_PRO)).toEqual(["subscription-included", "prepaid-credits"]);
	});

	it("reports no evidence for a quota-only report", () => {
		const daily: UsageLimit = {
			id: "devin:quota:daily",
			label: "Daily Quota",
			scope: { provider: "devin", windowId: "1d" },
			amount: { used: 60, limit: 100, remaining: 40, usedFraction: 0.6, remainingFraction: 0.4, unit: "percent" },
			status: "ok",
		};
		expect(devinBilling.readBilling({ provider: "devin", fetchedAt: 1, limits: [daily] })).toMatchObject({
			status: "unknown",
			reason: "no-evidence",
		});
	});
});

describe("OpenRouter billing", () => {
	/** The documented `GET /key` example response (documentation-derived fixture). */
	const documentedKey = {
		label: "sk-or-v1-au7...890",
		limit: 100,
		limit_remaining: 74.5,
		limit_reset: "monthly",
		usage: 25.5,
		usage_daily: 25.5,
		usage_weekly: 25.5,
		usage_monthly: 25.5,
		is_free_tier: false,
		is_management_key: false,
		include_byok_in_limit: false,
	};

	type Seen = { url: string; authorization: string | null };

	async function openrouterReport(body: unknown, options: { status?: number; baseUrl?: string } = {}) {
		const seen: Seen[] = [];
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return new Response(JSON.stringify(body), { status: options.status ?? 200 });
		}) as unknown as FetchImpl;
		const report = await openrouterUsageProvider.fetchUsage(
			{
				provider: "openrouter",
				credential: { type: "api_key", apiKey: "sk-or-v1-test" },
				...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
			},
			{ fetch },
		);
		return { report: report ? overWire(report) : null, seen };
	}

	async function keyReport(data: Record<string, unknown>) {
		const { report } = await openrouterReport({ data });
		if (!report) throw new Error("fixture did not parse");
		return report;
	}

	it("keeps the documented key cap as a usage limit but not as a funding source", async () => {
		const { report, seen } = await openrouterReport({ data: documentedKey });
		if (!report) throw new Error("fixture did not parse");
		expect(seen).toEqual([{ url: "https://openrouter.ai/api/v1/key", authorization: "Bearer sk-or-v1-test" }]);
		expect(report.limits).toMatchObject([
			{
				id: "openrouter:key-limit",
				window: { id: "monthly" },
				amount: { limit: 100, remaining: 74.5, unit: "usd" },
				status: "ok",
			},
		]);
		expect(openrouterBilling.readBilling(report)).toMatchObject({ status: "unknown", reason: "no-evidence" });
		const { is_free_tier: _tier, ...unreported } = documentedKey;
		expect(openrouterBilling.readBilling(await keyReport(unreported))).toMatchObject({ reason: "no-evidence" });
	});

	it("reads a capped free-tier key as free only, even with the cap exhausted", async () => {
		const capped = await keyReport({ ...documentedKey, is_free_tier: true });
		const spent = await keyReport({ ...documentedKey, is_free_tier: true, limit_remaining: -3 });
		expect(sources(openrouterBilling.readBilling(capped))).toEqual([{ mode: "free", state: "unknown" }]);
		expect(sources(openrouterBilling.readBilling(spent))).toEqual([{ mode: "free", state: "unknown" }]);
		expect(spent.limits[0]).toMatchObject({ amount: { remaining: 0 }, status: "exhausted" });
	});

	it("resets the key cap at the next midnight UTC boundary of its period", async () => {
		// Sunday 2025-12-28 15:30 UTC.
		const now = Date.UTC(2025, 11, 28, 15, 30);
		expect(limitResetAt("daily", now)).toBe(Date.UTC(2025, 11, 29));
		expect(limitResetAt("weekly", now)).toBe(Date.UTC(2025, 11, 29));
		expect(limitResetAt("weekly", Date.UTC(2025, 11, 29))).toBe(Date.UTC(2026, 0, 5));
		expect(limitResetAt("monthly", now)).toBe(Date.UTC(2026, 0, 1));
		const report = await keyReport({ ...documentedKey, limit_reset: "daily" });
		const resetsAt = report.limits[0]?.window?.resetsAt;
		expect(resetsAt).toBe(limitResetAt("daily", report.fetchedAt));
	});

	it("leaves an unlisted limit_reset windowless", async () => {
		const report = await keyReport({ ...documentedKey, limit_reset: "hourly" });
		expect(report.limits[0]?.window).toBeUndefined();
		expect(report.limits[0]?.scope.windowId).toBe("lifetime");
	});

	it("purges a key OpenRouter rejects but treats a proxy's 401 as transient", async () => {
		await expect(openrouterReport({ error: { code: 401 } }, { status: 401 })).rejects.toThrow(/401/);
		const proxied = await openrouterReport(
			{ error: { code: 401 } },
			{ status: 401, baseUrl: "https://proxy.example/openrouter/v1/" },
		);
		expect(proxied.report).toBeNull();
		expect(proxied.seen).toEqual([
			{ url: "https://proxy.example/openrouter/v1/key", authorization: "Bearer sk-or-v1-test" },
		]);
	});

	it("returns no report for a payload without data or a server error", async () => {
		expect((await openrouterReport({ label: "no envelope" })).report).toBeNull();
		expect((await openrouterReport({ data: documentedKey }, { status: 500 })).report).toBeNull();
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

describe("subscription coding-plan billing", () => {
	function readDefault(report: UsageReport): BillingResult {
		const reader = defaultBillingReader(report.provider);
		if (!reader) throw new Error(`no billing reader for ${report.provider}`);
		return reader.readBilling(report);
	}

	async function zaiReport(limits: unknown[]): Promise<UsageReport> {
		const report = await zaiUsageProvider.fetchUsage(
			{ provider: "zai", credential: { type: "api_key", apiKey: "key" } },
			{ fetch: jsonFetch({ success: true, data: { limits, level: "pro" } }) },
		);
		if (!report) throw new Error("fixture did not parse");
		return overWire(report);
	}

	it("reads the ZAI credit allowance from the longest window and exhausts it with any spent window", async () => {
		const weekly = {
			type: "CREDIT_LIMIT",
			unit: 6,
			number: 1,
			usage: 60000,
			currentValue: 2254,
			remaining: 57745,
			percentage: 3,
			nextResetTime: 1788223121997,
		};
		const fiveHour = { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, nextResetTime: 1787804173065 };
		const weeklyAllowance: BillingAllowance = {
			kind: "credits",
			used: { amountMinor: 2254, exponent: 0 },
			limit: { amountMinor: 60000, exponent: 0 },
			remaining: { amountMinor: 57745, exponent: 0 },
		};

		const fresh = await zaiReport([{ ...fiveHour, currentValue: 1438, remaining: 10561 }, weekly]);
		expect(sources(zaiBilling.readBilling(fresh))).toEqual([
			{ mode: "subscription-included", state: "available", allowance: weeklyAllowance, resetsAt: 1788223121997 },
		]);

		const spent = await zaiReport([{ ...fiveHour, currentValue: 12000, remaining: 0 }, weekly]);
		expect(sources(zaiBilling.readBilling(spent))).toEqual([
			{ mode: "subscription-included", state: "exhausted", allowance: weeklyAllowance, resetsAt: 1788223121997 },
		]);
	});

	it("leaves the ZAI plan unknown while a quota window has no status, and reads no plan windows as no evidence", async () => {
		const tokens = { type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1782656863894, unit: 3 };
		const report = await zaiReport([tokens]);
		expect(sources(zaiBilling.readBilling(report))).toEqual([{ mode: "subscription-included", state: "available" }]);

		const statusless = await zaiReport([tokens, { type: "TOKENS_LIMIT", nextResetTime: 1788223121997, unit: 6 }]);
		expect(sources(zaiBilling.readBilling(statusless))).toEqual([
			{ mode: "subscription-included", state: "unknown" },
		]);
		expect(zaiBilling.readBilling({ ...report, limits: [] })).toMatchObject({
			status: "unknown",
			reason: "no-evidence",
		});
	});

	it("derives MiniMax plan state from the shared bucket, not per-model buckets", async () => {
		const bucket = (model_name: string, status: number) => ({
			model_name,
			start_time: 1_785_009_600_000,
			end_time: 1_785_024_000_000,
			current_interval_total_count: 0,
			current_interval_usage_count: 0,
			current_interval_remaining_percent: 90,
			current_interval_status: status,
			weekly_start_time: 1_784_505_600_000,
			weekly_end_time: 1_785_110_400_000,
			current_weekly_total_count: 0,
			current_weekly_usage_count: 0,
			current_weekly_remaining_percent: 78,
			current_weekly_status: 1,
		});
		const read = async (...buckets: unknown[]) => {
			const report = await minimaxCodeUsageProvider.fetchUsage(
				{ provider: "minimax-code", credential: { type: "api_key", apiKey: "sk-cp-test" } },
				{ fetch: jsonFetch({ model_remains: buckets, base_resp: { status_code: 0, status_msg: "success" } }) },
			);
			if (!report) throw new Error("fixture did not parse");
			return readDefault(overWire(report));
		};

		expect(sources(await read(bucket("general", 1), bucket("video", 2)))).toEqual([
			{ mode: "subscription-included", state: "available" },
		]);
		expect(sources(await read(bucket("general", 2), bucket("video", 1)))).toEqual([
			{ mode: "subscription-included", state: "exhausted" },
		]);
		// A report with only model buckets carries no plan-wide window.
		expect(await read(bucket("video", 1))).toMatchObject({ status: "unknown", reason: "no-evidence" });
	});

	it("does not let an OpenCode Go monthly window exhaust the plan", async () => {
		const window = (status: string, percent: number, resetsAt: string) => ({ status, percent, resetsAt });
		const report = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{
				fetch: jsonFetch({
					usage: {
						rolling: window("ok", 12, "2026-08-12T15:09:04.847Z"),
						weekly: window("ok", 8, "2026-08-17T00:00:00.847Z"),
						monthly: window("rate-limited", 100, "2026-08-19T00:31:53.847Z"),
					},
				}),
			},
		);
		if (!report) throw new Error("fixture did not parse");
		expect(sources(readDefault(overWire(report)))).toEqual([{ mode: "subscription-included", state: "available" }]);
	});

	it("reads the SuperGrok plan from its overall window and on-demand usage as paid extra usage", () => {
		const scope = { provider: "xai-oauth", windowId: "1w", shared: true as const };
		const row = (id: string, usedFraction: number): UsageLimit => ({
			id,
			label: id,
			scope,
			amount: { used: usedFraction * 100, usedFraction, unit: "percent" },
			status: usedFraction >= 1 ? "exhausted" : "ok",
		});
		const onDemand = (used: number): UsageLimit => ({
			id: "xai-oauth:on-demand",
			label: "On-demand",
			scope: { provider: "xai-oauth", shared: true },
			amount: { used, limit: 50, remaining: 50 - used, usedFraction: used / 50, unit: "unknown" },
			status: used >= 50 ? "exhausted" : "ok",
		});
		const report = (overall: number, ...extra: UsageLimit[]): UsageReport => ({
			provider: "xai-oauth",
			fetchedAt: 1,
			limits: [row("xai-oauth:credits:1w", overall), row("xai-oauth:product:api:1w", 1), ...extra],
		});

		expect(sources(xaiOauthBilling.readBilling(report(0.2)))).toEqual([
			{ mode: "subscription-included", state: "available" },
		]);
		expect(sources(xaiOauthBilling.readBilling(report(1, onDemand(10))))).toEqual([
			{ mode: "subscription-included", state: "exhausted" },
			{ mode: "paid-extra-usage", state: "available" },
		]);
		expect(sources(xaiOauthBilling.readBilling(report(1, onDemand(50))))).toEqual([
			{ mode: "subscription-included", state: "exhausted" },
			{ mode: "paid-extra-usage", state: "exhausted" },
		]);
	});

	it("reads Kimi Code plan state from the 5-hour and 7-day windows only", () => {
		const limit = (index: number, windowId: string, usedFraction: number | undefined): UsageLimit => ({
			id: `kimi-code:${index}`,
			label: windowId,
			scope: { provider: "kimi-code", windowId, shared: true },
			window: { id: windowId, label: windowId, resetsAt: 2_000 },
			amount: { ...(usedFraction === undefined ? {} : { usedFraction }), unit: "unknown" },
			status: usedFraction === undefined ? "unknown" : usedFraction >= 1 ? "exhausted" : "ok",
		});
		const report = (fiveHour: number | undefined): UsageReport => ({
			provider: "kimi-code",
			fetchedAt: 1,
			limits: [limit(0, "7d", 0.4), limit(1, "5h", fiveHour), limit(2, "limit_month_total", 1)],
		});

		expect(sources(readDefault(report(0.1)))).toEqual([{ mode: "subscription-included", state: "available" }]);
		expect(sources(readDefault(report(1)))).toEqual([{ mode: "subscription-included", state: "exhausted" }]);
		expect(sources(readDefault(report(undefined)))).toEqual([{ mode: "subscription-included", state: "unknown" }]);
	});

	it("reads Gemini CLI billing from the Code Assist tier", async () => {
		const read = async (currentTier: { id: string; name: string } | undefined) => {
			const report = await googleGeminiCliUsageProvider.fetchUsage(
				{ provider: "google-gemini-cli", credential: { type: "oauth", accessToken: "token", projectId: "proj" } },
				{
					fetch: jsonFetch({
						...(currentTier ? { currentTier } : {}),
						buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0, resetTime: "2026-10-06T00:00:00Z" }],
					}),
				},
			);
			if (!report) throw new Error("fixture did not parse");
			return readDefault(overWire(report));
		};

		expect(sources(await read({ id: "free-tier", name: "Gemini Code Assist for individuals" }))).toEqual([
			{ mode: "free", state: "unknown" },
		]);
		expect(sources(await read({ id: "standard-tier", name: "Gemini Code Assist Standard" }))).toEqual([
			{ mode: "subscription-included", state: "unknown" },
		]);
		expect(await read({ id: "legacy-tier", name: "Legacy" })).toMatchObject({
			status: "unknown",
			reason: "no-evidence",
		});
		expect(await read(undefined)).toMatchObject({ status: "unknown", reason: "no-evidence" });
	});

	it("reads an Alibaba window without a shared flag as account-wide", () => {
		const report: UsageReport = {
			provider: "alibaba-token-plan",
			fetchedAt: 1,
			limits: [
				{
					id: "credits:5h",
					label: "5 Hour",
					scope: { provider: "alibaba-token-plan", windowId: "5h" },
					amount: { used: 100, usedFraction: 1, unit: "percent" },
					status: "exhausted",
				},
			],
		};
		expect(sources(readDefault(report))).toEqual([{ mode: "subscription-included", state: "exhausted" }]);
	});

	it("reports no evidence for providers whose usage reports carry no funding fields", async () => {
		const ollama = await ollamaUsageProvider.fetchUsage(
			{ provider: "ollama", credential: { type: "api_key", apiKey: "key" } },
			{ fetch: jsonFetch({}) },
		);
		if (!ollama) throw new Error("fixture did not parse");
		expect(readDefault(ollama)).toEqual({
			status: "unknown",
			provider: "ollama",
			reason: "no-evidence",
			fetchedAt: ollama.fetchedAt,
		});
		expect(readDefault({ ...ollama, provider: "ollama-cloud" })).toMatchObject({ reason: "no-evidence" });
		// Umans request windows meter throughput; its prepaid token wallet is not in the report.
		const umans: UsageReport = {
			provider: "umans",
			fetchedAt: 1,
			limits: [
				{
					id: "umans:requests",
					label: "Requests",
					scope: { provider: "umans", windowId: "5h", shared: true },
					amount: { used: 20, limit: 200, usedFraction: 0.1, unit: "requests" },
					status: "ok",
				},
			],
		};
		expect(readDefault(umans)).toMatchObject({ status: "unknown", reason: "no-evidence" });
	});
});

describe("self-hosted endpoint billing", () => {
	function readEndpoint(provider: string, baseUrl: string): BillingResult {
		const report = localEndpointUsageReport(provider, baseUrl, 7);
		if (!report) throw new Error(`${provider} is not a self-hosted provider`);
		const reader = defaultBillingReader(provider);
		if (!reader) throw new Error(`no billing reader for ${provider}`);
		return reader.readBilling(report);
	}

	it.each([
		["lm-studio", "http://localhost:1234/v1"],
		["lm-studio", "http://LOCALHOST:1234/v1"],
		["llama.cpp", "http://127.0.0.2:8080"],
		["vllm", "http://[::1]:8000/v1"],
		["local", "local://inference"],
		["apple", "local://apple-foundation-models"],
		["vllm", "unix:/run/vllm.sock"],
	])("treats %s at %s as free and uncapped", (provider, baseUrl) => {
		expect(sources(readEndpoint(provider, baseUrl))).toEqual([
			{ mode: "free", state: "available", allowance: { kind: "money", uncapped: true } },
		]);
	});

	it.each([
		["link-local metadata address", "http://169.254.169.254/v1"],
		["cloud metadata host", "http://metadata.google.internal/v1"],
		["unspecified address", "http://0.0.0.0:8000/v1"],
		["mDNS host", "http://foo.local:8000/v1"],
		["10/8 host", "http://10.0.0.1:8000/v1"],
		["192.168/16 host", "http://192.168.1.1:8000/v1"],
		["loopback userinfo before a remote host", "http://127.0.0.1@evil.com/v1"],
		["localhost userinfo before a public IP", "http://localhost@8.8.8.8/v1"],
		["localhost-prefixed domain", "http://localhost.evil.com/v1"],
		["loopback-prefixed domain", "http://127.0.0.1.evil.com/v1"],
		["trailing-dot localhost", "http://localhost./v1"],
		["IPv4-mapped IPv6 loopback", "http://[::ffff:7f00:1]/v1"],
		["public host", "https://vllm.example.com/v1"],
		["malformed URL", "not a url"],
		["host-bearing non-HTTP scheme", "ftp://localhost/v1"],
	])("reads a %s as no evidence, never free", (_label, baseUrl) => {
		expect(readEndpoint("vllm", baseUrl)).toEqual({
			status: "unknown",
			provider: "vllm",
			reason: "no-evidence",
			fetchedAt: 7,
		});
	});

	it("reads a report without a base URL as no evidence and synthesizes reports only for self-hosted providers", () => {
		const reader = defaultBillingReader("vllm");
		expect(reader?.readBilling({ provider: "vllm", fetchedAt: 7, limits: [] })).toMatchObject({
			status: "unknown",
			reason: "no-evidence",
		});
		expect(
			reader?.readBilling({ provider: "vllm", fetchedAt: 7, limits: [], metadata: { baseUrl: 1 } }),
		).toMatchObject({
			status: "unknown",
			reason: "no-evidence",
		});
		expect(localEndpointUsageReport("openai", "http://localhost:8000/v1", 7)).toBeUndefined();
	});
});
