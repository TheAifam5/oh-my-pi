import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsPanels } from "../src/client/routes/AnalyticsPanels";
import { RoutingPanel } from "../src/client/routes/RoutingPanel";
import { replayFindings } from "../src/observability";
import type { ObservabilityStats } from "../src/observability-types";

const data: ObservabilityStats = {
	headroom: [],
	configurationAvailable: false,
	ledgerAvailable: true,
	routing: [],
	previousCalls: 0,
	models: [],
	cache: [],
	cacheModels: [],
	spend: [],
	advisors: [],
	findings: replayFindings([]),
	previousFindings: null,
	coverage: { files: 0, unreadable: 0, snapshots: 0, recoveryAnnotations: 0, pendingFiles: 0 },
};

it("keeps missing configuration and zero-cap usage explicit", () => {
	expect(renderToStaticMarkup(<AnalyticsPanels data={data} panel="headroom" />)).toContain(
		"Effective configuration unavailable",
	);
	const html = renderToStaticMarkup(
		<AnalyticsPanels
			panel="headroom"
			data={{
				...data,
				configurationAvailable: true,
				headroom: [
					{
						label: "Daily requests",
						metric: "requests",
						used: 0,
						cap: 0,
						samples: 0,
						resetAt: null,
						recoveryAt: null,
						previous: null,
						burn: [],
					},
				],
			}}
		/>,
	);
	expect(html).toContain("At capacity");
	expect(html).not.toContain("NaN");
	expect(html).not.toContain("Infinity");
});

it("keeps subscription quotas out of local caps and formats configured cap recovery", () => {
	const html = renderToStaticMarkup(
		<AnalyticsPanels
			panel="headroom"
			data={{
				...data,
				configurationAvailable: true,
				headroom: [
					{
						label: "provider/Account 2: provider:7d",
						metric: "quota fraction",
						used: 0.8,
						cap: 1,
						samples: 1,
						resetAt: Date.now() + 172800000,
						recoveryAt: null,
						previous: null,
						burn: [],
					},
					{
						label: "Daily request limit",
						metric: "requests",
						used: 75,
						cap: 100,
						samples: 75,
						resetAt: Date.now() + 172800000,
						recoveryAt: null,
						previous: null,
						burn: [],
					},
				],
			}}
		/>,
	);
	expect(html).not.toContain("provider · Account 2");
	expect(html).not.toContain("Subscription quota</span>");
	expect(html).toContain("Daily request limit");
	expect(html).toContain("75% used");
	expect(html).toContain("75");
	expect(html).toContain("Resets in 2d 0h");
	expect(html).not.toContain("Previous period");
	expect(html).not.toContain("Usage trend");
});

it("labels cache totals and renders a table-first text equivalent", () => {
	const html = renderToStaticMarkup(
		<AnalyticsPanels
			panel="cache"
			data={{
				...data,
				cache: [{ bucket: 1000, input: 10, read: 80, write: 10, savings: 2, samples: 3 }],
				cacheModels: [{ model: "Example", provider: "Provider", hitRate: 0.8, samples: 3 }],
			}}
		/>,
	);
	expect(html).toContain("80.0%");
	expect(html).toContain("80 cache reads");
	expect(html.indexOf("Model cache efficiency")).toBeLessThan(html.indexOf("Input token composition"));
	expect(html).not.toContain("Token hit rate");
	expect(html).not.toContain("Reused tokens");
	expect(html).not.toContain("Savings coverage");
	expect(html).toContain("Cache reads ÷ (uncached input + cache reads)");
});

it("aggregates routing buckets into serving combinations without dropping anonymous accounts", () => {
	const row = {
		pool: "role:review",
		model: "Example",
		account: "Account 1",
		bucket: 1000,
		requests: 3,
		cost: 1,
		tokens: 10,
	};
	const html = renderToStaticMarkup(
		<RoutingPanel data={{ ...data, routing: [row, { ...row, bucket: 2000, requests: 2 }] }} />,
	);
	expect(html).toContain("1 serving combinations");
	expect(html).toContain("Role · review");
	expect(html).toContain("Account 1");
	expect(html).toContain("100.0% of selection");
	expect(html).not.toContain("role:review");
	expect(html).toContain('scope="rowgroup"');
	expect(html).toContain("Largest pool share");
	expect(html).not.toContain("Ledger coverage");
});

it("does not imply advisor benefit or a cost ratio when no resolutions exist", () => {
	const html = renderToStaticMarkup(<AnalyticsPanels data={data} panel="economics" />);
	expect(html).toContain("No advisor transcripts in this range");
	expect(html).toContain("No transcript requests recorded");
	expect(html).toContain("aggregate ratio, not causal benefit");
	expect(html).not.toContain("NaN");
});

it("preserves UI acronyms in advisor labels", () => {
	const html = renderToStaticMarkup(
		<AnalyticsPanels
			panel="economics"
			data={{
				...data,
				advisors: [
					{
						advisor: "ui-and-accessibility",
						model: "Example",
						cost: 1,
						samples: 1,
						latency: null,
						latencySamples: 0,
					},
				],
			}}
		/>,
	);
	expect(html).toContain("UI and Accessibility");
	expect(html).not.toContain("Ui And Accessibility");
});
