import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { usageReportSchema } from "@oh-my-pi/pi-ai/usage";
import { usageResponseSchema } from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";
import { openrouterUsageProvider } from "@oh-my-pi/pi-ai/usage/openrouter";

const DAY = 86_400_000;

afterEach(() => {
	spyOn(Date, "now").mockRestore();
});

async function balance(now: number, usage: Record<string, unknown>, remaining = 30) {
	spyOn(Date, "now").mockReturnValue(now);
	const report = await openrouterUsageProvider.fetchUsage(
		{ provider: "openrouter", credential: { type: "api_key", apiKey: "test" } },
		{
			fetch: async input =>
				Response.json({
					data: String(input).endsWith("/credits")
						? { total_credits: 100, total_usage: 100 - remaining }
						: { is_free_tier: false, ...usage },
				}),
		},
	);
	if (!report) throw new Error("Missing OpenRouter report");
	return { report, limit: report.limits.find(limit => limit.id === "openrouter:credit-balance") };
}

describe("OpenRouter credit run-out", () => {
	it("uses monthly spending on Monday 06:00 UTC and preserves projections on the usage wire", async () => {
		const now = Date.parse("2026-10-19T06:00:00Z");
		const { report, limit } = await balance(now, { usage_weekly: 100, usage_monthly: 73 });
		expect(limit?.amount.spendingRatePerDay).toBe(4);
		expect(limit?.projectedExhaustAt).toBe(now + 7.5 * DAY);
		expect(limit?.notes?.join(" ")).toContain("this key only");
		expect(usageReportSchema.assert(report).limits[0]?.projectedExhaustAt).toBe(limit?.projectedExhaustAt);
		expect(
			usageResponseSchema.assert({ generatedAt: now, reports: [report] }).reports[0]?.limits[0]?.amount
				.spendingRatePerDay,
		).toBe(4);
	});

	it("uses weekly spending on Wednesday instead of monthly spending", async () => {
		const now = Date.parse("2026-10-21T00:00:00Z");
		const { limit } = await balance(now, { usage_weekly: 8, usage_monthly: 500 });
		expect(limit?.amount.spendingRatePerDay).toBe(4);
		expect(limit?.projectedExhaustAt).toBe(now + 7.5 * DAY);
	});

	it("switches to weekly spending exactly one day into the UTC week", async () => {
		const now = Date.parse("2026-10-20T00:00:00Z");
		const { limit } = await balance(now, { usage_weekly: 4, usage_monthly: 500 });
		expect(limit?.amount.spendingRatePerDay).toBe(4);
		expect(limit?.projectedExhaustAt).toBe(now + 7.5 * DAY);
	});

	it("projects only a positive balance at a positive pace", async () => {
		const now = Date.parse("2026-10-21T00:00:00Z");
		const positive = await balance(now, { usage_weekly: 8 });
		expect(positive.limit?.projectedExhaustAt).toBe(now + 7.5 * DAY);
		for (const remaining of [0, -1]) {
			const { limit } = await balance(now, { usage_weekly: 8 }, remaining);
			expect(limit?.amount.spendingRatePerDay).toBe(4);
			expect(limit?.projectedExhaustAt).toBeUndefined();
			expect(limit?.status).toBe("exhausted");
		}
		const zeroPace = await balance(now, { usage_weekly: 0 });
		expect(zeroPace.limit?.amount.spendingRatePerDay).toBe(0);
		expect(zeroPace.limit?.projectedExhaustAt).toBeUndefined();
	});

	it("omits unavailable pace instead of using the other period or dividing by zero", async () => {
		const positive = await balance(Date.parse("2026-10-21T00:00:00Z"), { usage_weekly: 8 });
		expect(positive.limit?.amount.spendingRatePerDay).toBe(4);
		for (const [now, usage] of [
			["2026-10-21T00:00:00Z", { usage_monthly: 40 }],
			["2026-10-19T06:00:00Z", { usage_weekly: 8 }],
			["2026-06-01T00:00:00Z", { usage_monthly: 40 }],
			["2026-10-21T00:00:00Z", { usage_weekly: "8" }],
		] as const) {
			const { limit } = await balance(Date.parse(now), usage);
			expect(limit?.amount.spendingRatePerDay).toBeUndefined();
			expect(limit?.projectedExhaustAt).toBeUndefined();
		}
	});
});
