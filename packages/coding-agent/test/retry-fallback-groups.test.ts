import { describe, expect, it } from "bun:test";
import { type BillingResult, type BillingSource } from "@oh-my-pi/pi-ai";
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
