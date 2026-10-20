import { describe, expect, it } from "bun:test";
import {
	describedWindowLimits,
	isUsageLimitReached,
	scopedUsageLimits,
	usageWindowDescribed,
} from "@oh-my-pi/pi-ai/auth/usage-report";
import type { CredentialRankingStrategy, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { parseCodexRateLimitHeaders } from "@oh-my-pi/pi-ai/usage/openai-codex";

const NOW = Date.now();
const HOUR_MS = 60 * 60_000;

const strategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({ primary: report.limits[0] }),
	windowDefaults: { primaryMs: 5 * HOUR_MS, secondaryMs: 7 * 24 * HOUR_MS },
};

function spent(resetsAt: number, resetLabel?: string): UsageLimit {
	return {
		id: "test:5h",
		label: "5 Hour",
		scope: { provider: "test", windowId: "5h" },
		window: { id: "5h", label: "5 Hour", resetsAt, ...(resetLabel ? { resetLabel } : {}) },
		amount: { usedFraction: 1, unit: "percent" },
		status: "exhausted",
	};
}

function report(fetchedAt: number, limit: UsageLimit): UsageReport {
	return { provider: "test", fetchedAt, limits: [limit] };
}

describe("usage windows a report still describes", () => {
	it("drops a spent window whose reset passed after a retained report was fetched", () => {
		const retained = report(NOW - 2 * HOUR_MS, spent(NOW - HOUR_MS));
		expect(isUsageLimitReached(scopedUsageLimits(strategy, retained, {}))).toBe(false);
		expect(describedWindowLimits(strategy, retained, {}).primary).toBeUndefined();
	});

	it("keeps a spent window a fresh report still shows past its stated reset", () => {
		const fresh = report(NOW, spent(NOW - HOUR_MS));
		expect(isUsageLimitReached(scopedUsageLimits(strategy, fresh, {}))).toBe(true);
		expect(describedWindowLimits(strategy, fresh, {}).primary?.id).toBe("test:5h");
	});

	it("keeps a spent rolling window whose regeneration tick passed, since a tick does not restore the quota", () => {
		const retained = report(NOW - 2 * HOUR_MS, spent(NOW - HOUR_MS, "tick"));
		expect(isUsageLimitReached(scopedUsageLimits(strategy, retained, {}))).toBe(true);
	});

	describe("parsed provider windows", () => {
		const reset = Math.floor((NOW - HOUR_MS) / 1000) * 1000;
		/** A spent 5-hour window parsed at `fetchedAt`, the way each provider reports it. */
		const parsed: Record<string, (fetchedAt: number) => UsageReport | null> = {
			claude: fetchedAt =>
				parseClaudeUsagePayload(
					{ five_hour: { utilization: 100, resets_at: new Date(reset).toISOString() } },
					{},
					undefined,
					fetchedAt,
				),
			codex: fetchedAt =>
				parseCodexRateLimitHeaders(
					{
						"x-codex-primary-used-percent": "100",
						"x-codex-primary-window-minutes": "300",
						"x-codex-primary-reset-at": String(Math.floor(reset / 1000)),
					},
					fetchedAt,
				),
		};

		for (const [provider, parse] of Object.entries(parsed)) {
			it(`${provider}: a spent window stops describing the account once its reset passes after the fetch`, () => {
				const retained = parse(reset - 10 * 60_000);
				const fresh = parse(reset + 10 * 60_000);
				const limit = retained?.limits[0];
				if (!retained || !fresh || !limit || !fresh.limits[0]) throw new Error("fixture did not parse");
				expect(limit.window?.resetsAt).toBe(reset);
				expect(usageWindowDescribed(limit, retained, NOW)).toBe(false);
				expect(usageWindowDescribed(fresh.limits[0], fresh, NOW)).toBe(true);
				const rolling = { ...limit, window: { ...limit.window, id: "5h", label: "5h", resetLabel: "tick" } };
				expect(usageWindowDescribed(rolling, retained, NOW)).toBe(true);
			});
		}
	});
});
