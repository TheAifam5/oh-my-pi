import { afterEach, beforeAll, expect, it, mock, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { formatUsageBreakdown } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { formatUsageProjection } from "@oh-my-pi/pi-tui/prompt/usage-amounts";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => mock.restore());

const now = Date.parse("2026-10-21T00:00:00Z");
const reports: UsageReport[] = [
	{
		provider: "openrouter",
		fetchedAt: now,
		limits: [
			{
				id: "openrouter:credit-balance",
				label: "Credit balance",
				scope: { provider: "openrouter", shared: true },
				amount: { unit: "usd", limit: 100, used: 70, remaining: 30, spendingRatePerDay: 9.73 },
				projectedExhaustAt: now + (3 * 24 + 2) * 3_600_000,
			},
		],
	},
];

it("shows the daily rate and run-out countdown on the CLI balance row", () => {
	const output = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
	const row = output.split("\n").find(line => line.includes("Credit balance"));
	expect(row).toContain("$9.73/day");
	expect(row).toContain("runs out in 3d 2h");
});

it("shows the daily rate and run-out countdown in the /usage report", () => {
	const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 160));
	expect(output).toContain("$9.73/day");
	expect(output).toContain("runs out in 3d 2h");
});

it("shows the daily rate and countdown in native dashboard details", () => {
	spyOn(Date, "now").mockReturnValue(now);
	const component = new UsageDashboardComponent({
		reports,
		loadActivity: async push => push([]),
		renderDetail: () => "",
		requestRender: () => {},
		onClose: () => {},
	});
	const overview = JSON.stringify(
		component.describe({ cols: 160, reduceMotion: false, dark: true, supports: () => true, feature: () => true }),
	);
	expect(overview).toContain("$9.73/day");
	expect(overview).toContain("runs out in 3d 2h");
	const fallback = stripVTControlCharacters(component.render(160).join("\n"));
	expect(fallback).toContain("$9.73/day");
	expect(fallback).toContain("runs out in 3d 2h");
	component.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
	const output = JSON.stringify(
		component.describe({ cols: 160, reduceMotion: false, dark: true, supports: () => true, feature: () => true }),
	);
	expect(output).toContain("$9.73/day");
	expect(output).toContain("runs out in 3d 2h");
});

it("strips terminal controls and line breaks from a spending-rate currency", () => {
	const output = formatUsageProjection(
		{
			id: "balance",
			label: "Balance",
			scope: { provider: "openrouter" },
			amount: { unit: "unknown", currency: "\u001b[31mEUR\u001b[0m\n", spendingRatePerDay: 4 },
		},
		now,
	);
	expect(output).toBe("4.00 EUR /day");
});
