import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FindingsPanel } from "../src/client/routes/FindingsPanel";
import { replayFindings } from "../src/observability";
import type { ObservabilityStats } from "../src/observability-types";

it("renders findings KPIs, status ledger and text equivalents for every chart", () => {
	const findings = replayFindings([
		{
			turn: 1,
			timestamp: 1000,
			findings: [
				{ id: "F1", category: "logic", severity: "blocker", owner: "reviewer", createdTurn: 1, status: "open" },
			],
		},
		{
			turn: 2,
			timestamp: 61000,
			findings: [
				{
					id: "F1",
					category: "logic",
					severity: "blocker",
					owner: "reviewer",
					createdTurn: 1,
					status: "resolved",
					resolution: { by: "user", turn: 2 },
				},
			],
		},
	]);
	const data: ObservabilityStats = {
		headroom: [],
		configurationAvailable: false,
		ledgerAvailable: false,
		routing: [],
		previousCalls: 0,
		models: [],
		cache: [],
		cacheModels: [],
		spend: [],
		advisors: [],
		findings,
		previousFindings: replayFindings([]),
		coverage: { files: 1, unreadable: 0, snapshots: 2, recoveryAnnotations: 0, pendingFiles: 0 },
	};
	const html = renderToStaticMarkup(<FindingsPanel data={data} />);
	for (const text of [
		"Open backlog",
		"Resolved",
		"Expired",
		"Median time to resolve",
		"Findings ledger",
		"Resolution funnel",
		"Severity by category",
		"Time to resolve",
		"Resolution actors",
		"Observed resolution duration histogram",
		"Reviewer",
		"Blocker",
	]) {
		expect(html).toContain(text);
	}
	expect(html).toContain('data-tone="ok"');
	expect(html).toContain('aria-label="Findings by latest status"');
	const categories = ["ui", "concurrency", "migration", "verification"];
	const readable = renderToStaticMarkup(
		<FindingsPanel
			data={{
				...data,
				findings: {
					...findings,
					durationsMs: [242000],
					open: categories.map(category => ({ category, severity: "concern", owner: "reviewer", count: 1 })),
				},
			}}
		/>,
	);
	expect(readable).toContain("4m 2s");
	for (const category of ["UI", "Concurrency", "Migration", "Verification"]) {
		expect(readable).toContain(`>${category}</span>`);
	}
	expect(readable).toContain('class="findings-category-bars"');
	const emptyHtml = renderToStaticMarkup(
		<FindingsPanel data={{ ...data, findings: replayFindings([]), coverage: { ...data.coverage, snapshots: 0 } }} />,
	);
	expect(emptyHtml).toContain("No findings recorded in this range");
});
