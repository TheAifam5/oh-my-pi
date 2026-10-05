import { describe, expect, it } from "bun:test";
import { type BillingResult, type BillingSource } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { opencodeGoUsageProvider } from "@oh-my-pi/pi-ai/usage/opencode-go";
import { defaultBillingReader } from "@oh-my-pi/pi-ai/usage/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	fundingVerdict,
	getRetryFallbackChainsWithGroups,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-groups";

const NOW = 1_000_000_000;

function known(...sources: BillingSource[]): BillingResult {
	return { status: "known", snapshot: { provider: "openai", fetchedAt: NOW, sources } };
}

describe("group funding verdicts", () => {
	it("draws on the first funding class an account can use, skipping exhausted and disabled sources", () => {
		const included = { mode: "subscription-included", state: "exhausted" } as const;
		const metered = { mode: "paid-extra-usage", state: "available" } as const;

		expect(fundingVerdict(["included", "metered"], [known(included, metered)])).toEqual({
			kind: "funded",
			stage: 1,
			billingClass: "metered",
		});
		expect(fundingVerdict(["included"], [known(included, metered)])).toEqual({
			kind: "skipped",
			reason: { kind: "exhausted" },
		});
		expect(fundingVerdict(["included"], [known({ mode: "subscription-included", state: "disabled" })])).toEqual({
			kind: "skipped",
			reason: { kind: "disabled" },
		});
		// A subscription window's verdict lives with quota ranking, so its unknown state still funds.
		expect(
			fundingVerdict(["free", "included"], [known({ mode: "subscription-included", state: "unknown" })]),
		).toEqual({ kind: "funded", stage: 1, billingClass: "included" });
	});

	it("funds included and free sources in an unknown state but metered sources only when available", () => {
		for (const mode of ["subscription-included", "free"] as const) {
			expect(fundingVerdict(["included", "free"], [known({ mode, state: "unknown" })]).kind).toBe("funded");
		}
		expect(fundingVerdict(["metered"], [known({ mode: "metered", state: "unknown" })]).kind).toBe("skipped");
		expect(fundingVerdict(["metered"], [known({ mode: "metered", state: "available" })])).toEqual({
			kind: "funded",
			stage: 0,
			billingClass: "metered",
		});
	});

	it("never authorizes metered use without evidence that the metered source is available", () => {
		expect(fundingVerdict(["metered"], [{ status: "unknown", provider: "openai", reason: "no-reader" }])).toEqual({
			kind: "skipped",
			reason: { kind: "unknown-evidence", reason: "no-reader" },
		});
		expect(fundingVerdict(["metered"], [known({ mode: "metered", state: "unknown" })])).toEqual({
			kind: "skipped",
			reason: { kind: "unknown-evidence", reason: "no-evidence" },
		});
		expect(fundingVerdict(["free", "metered"], "unavailable")).toEqual({
			kind: "skipped",
			reason: { kind: "unknown-evidence", reason: "unavailable" },
		});
		// Evidence of an unlisted class is not authorization to spend from it.
		expect(fundingVerdict(["included", "free"], [known({ mode: "metered", state: "available" })])).toEqual({
			kind: "skipped",
			reason: { kind: "unauthorized" },
		});
	});

	it("authorizes metered spending under a local hard budget only while a request still fits", () => {
		const budget = {
			policy: "local-hard-budget",
			budget: {
				id: "team",
				currency: "USD",
				perRequestMax: "1",
				window: { type: "rolling", durationMs: 86_400_000, maxSpend: "10" },
			},
		} as const;
		const metered = [known({ mode: "metered", state: "available" })];
		const spent = (nanos: bigint) => () => nanos;

		expect(fundingVerdict(["metered"], metered, budget, spent(9_000_000_000n))).toEqual({
			kind: "funded",
			stage: 0,
			billingClass: "metered",
		});
		// One more request at perRequestMax would pass maxSpend.
		expect(fundingVerdict(["metered"], metered, budget, spent(9_000_000_001n))).toEqual({
			kind: "skipped",
			reason: { kind: "budget-exhausted" },
		});
		// With no per-request headroom, a window spent exactly to maxSpend still admits nothing.
		const noHeadroom = { ...budget, budget: { ...budget.budget, perRequestMax: "0" } };
		expect(fundingVerdict(["metered"], metered, noHeadroom, spent(10_000_000_000n))).toEqual({
			kind: "skipped",
			reason: { kind: "budget-exhausted" },
		});
		expect(fundingVerdict(["metered"], metered, budget, () => "unavailable")).toEqual({
			kind: "skipped",
			reason: { kind: "budget-unreadable" },
		});
		// An exhausted local budget never blocks a source of an earlier, included stage.
		expect(
			fundingVerdict(
				["included", "metered"],
				[known({ mode: "subscription-included", state: "available" }, { mode: "metered", state: "available" })],
				budget,
				spent(10_000_000_000n),
			),
		).toEqual({ kind: "funded", stage: 0, billingClass: "included" });
	});
});

describe("group funding verdicts from provider billing readers", () => {
	function billingOf(report: UsageReport): BillingResult {
		const reader = defaultBillingReader(report.provider);
		if (!reader) throw new Error(`no billing reader for ${report.provider}`);
		return reader.readBilling(report);
	}

	it("keeps an OpenCode Go account whose only spent window is the monthly one", async () => {
		const fetch = (async () =>
			Response.json({
				usage: {
					rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
					weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
					monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-19T00:31:53.847Z" },
				},
			})) as unknown as FetchImpl;
		const report = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch },
		);
		if (!report) throw new Error("fixture did not parse");
		expect(fundingVerdict(["included"], [billingOf(report)])).toEqual({
			kind: "funded",
			stage: 0,
			billingClass: "included",
		});
	});

	it("falls back to SuperGrok on-demand usage only while it has headroom", () => {
		const report = (onDemandUsed: number): UsageReport => {
			const onDemandFraction = onDemandUsed / 50;
			const limits: UsageLimit[] = [
				{
					id: "xai-oauth:credits:1w",
					label: "SuperGrok Weekly Credits",
					scope: { provider: "xai-oauth", windowId: "1w", shared: true },
					amount: { used: 100, usedFraction: 1, unit: "percent" },
					status: "exhausted",
				},
				{
					id: "xai-oauth:on-demand",
					label: "On-demand",
					scope: { provider: "xai-oauth", shared: true },
					amount: { used: onDemandUsed, limit: 50, usedFraction: onDemandFraction, unit: "unknown" },
					status: onDemandFraction >= 1 ? "exhausted" : "ok",
				},
			];
			return { provider: "xai-oauth", fetchedAt: NOW, limits };
		};

		expect(fundingVerdict(["included", "metered"], [billingOf(report(10))])).toEqual({
			kind: "funded",
			stage: 1,
			billingClass: "metered",
		});
		expect(fundingVerdict(["included", "metered"], [billingOf(report(50))])).toEqual({
			kind: "skipped",
			reason: { kind: "exhausted" },
		});
	});
});

describe("group fallback chain resolution", () => {
	it("resolves group entries to member selectors in configured key order and keeps legacy lists unchanged", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["openai/gpt-4o", "google/*"],
				smol: "+fast@deep",
				"anthropic/claude-sonnet-4-5": {
					strategy: "priority",
					strategyOptions: { order: ["z", "a"] },
					models: {
						a: { model: "openai/gpt-4o-mini" },
						z: { model: "google/gemini-2.5-flash", defaultEffort: "low" },
					},
				},
				slow: "+missing",
				vision: "+fast@unknown",
			},
			modelGroups: {
				fast: {
					strategy: "random",
					models: { a: { model: "openai/gpt-4o-mini" }, b: { model: "openai/gpt-4o", defaultEffort: "low" } },
					profiles: { deep: { a: { effort: "high" } } },
				},
			},
		});

		const chains = getRetryFallbackChainsWithGroups(settings);

		expect(Object.entries(chains)).toEqual([
			["default", ["openai/gpt-4o", "google/*"]],
			["smol", ["openai/gpt-4o-mini:high", "openai/gpt-4o:low"]],
			["anthropic/claude-sonnet-4-5", ["google/gemini-2.5-flash:low", "openai/gpt-4o-mini"]],
			// A missing group reads as unset; a missing profile keeps the members' own efforts.
			["vision", ["openai/gpt-4o-mini", "openai/gpt-4o:low"]],
		]);
	});
});
