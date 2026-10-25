import { describe, expect, it } from "bun:test";
import { createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import {
	ADVISOR_FINDING_EXPIRY_TURNS,
	ADVISOR_FINDING_REPORTS_CAPACITY,
	ADVISOR_FINDINGS_CAPACITY,
	type AdviseParams,
	AdviseTool,
	type AdvisorAdvice,
	AdvisorEmissionGuard,
	AdvisorFindingsLedger,
	type AdvisorReportInput,
	formatAdvisorBatchContent,
} from "../../src/advisor";

function input(overrides: Partial<AdvisorReportInput> = {}): AdvisorReportInput {
	return {
		advisor: "Correctness",
		category: "security",
		identity: "file:server.ts:1043",
		anchor: "server.ts:1043",
		kind: "defect",
		severity: "concern",
		defect: "Token compared with ==.",
		impact: "Timing leak.",
		fix: "Use timingSafeEqual.",
		...overrides,
	};
}

function params(topic: string, defect: string, severity: AdviseParams["severity"] = "nit"): AdviseParams {
	return { kind: "suggestion", category: "logic", where: { type: "approach", topic }, defect, severity };
}

describe("AdvisorFindingsLedger", () => {
	it("keys findings on category plus anchor identity", () => {
		const ledger = new AdvisorFindingsLedger();
		expect(ledger.record(input()).type).toBe("new");
		const attached = ledger.record(input({ advisor: "Performance", defect: "Timing side channel." }));
		expect(attached.type).toBe("attached");
		expect(ledger.record(input({ category: "logic" })).type).toBe("new");
		expect(ledger.list().map(finding => finding.id)).toEqual(["F1", "F2"]);
	});

	it("records an exact repeat once per advisor as a duplicate and an escalation as attached", () => {
		const ledger = new AdvisorFindingsLedger();
		ledger.record(input());
		expect(ledger.record(input({ defect: "token compared with ==" })).type).toBe("duplicate");
		expect(ledger.record(input({ advisor: "Security" })).type).toBe("duplicate");
		const escalation = ledger.record(input({ severity: "blocker" }));
		expect(escalation).toMatchObject({ type: "attached", escalated: true });
		const [finding] = ledger.list();
		expect(finding?.severity).toBe("blocker");
		expect(finding?.reports.map(report => report.advisor)).toEqual(["Correctness", "Security", "Correctness"]);
	});

	it("lists reporters owner first and flags owner reports", () => {
		const ledger = new AdvisorFindingsLedger({
			ownerOf: category => (category === "security" ? "Security" : undefined),
		});
		ledger.record(input());
		ledger.record(input({ advisor: "Security", defect: "Non-constant-time check." }));
		const [finding] = ledger.list();
		expect(finding?.owner).toBe("Security");
		expect(ledger.reporters(finding!)).toEqual(["Security", "Correctness"]);
		expect(finding?.reports.map(report => report.owner)).toEqual([false, true]);
	});

	it("expires findings untouched for the expiry window and opens a new one afterwards", () => {
		const ledger = new AdvisorFindingsLedger();
		ledger.record(input());
		for (let i = 0; i < ADVISOR_FINDING_EXPIRY_TURNS - 1; i++) ledger.advanceTurn();
		expect(ledger.list()[0]?.status).toBe("open");
		ledger.advanceTurn();
		expect(ledger.list()[0]?.status).toBe("expired");
		expect(ledger.record(input()).type).toBe("new");
	});

	it("caps reports per finding, keeping the first report and owner reports", () => {
		const ledger = new AdvisorFindingsLedger({ ownerOf: () => "Security" });
		ledger.record(input({ advisor: "Correctness", defect: "lead" }));
		ledger.record(input({ advisor: "Security", defect: "owner view" }));
		for (let i = 0; i < ADVISOR_FINDING_REPORTS_CAPACITY * 2; i++) {
			ledger.record(input({ advisor: "Performance", defect: `variant ${i}` }));
		}
		const [finding] = ledger.list();
		expect(finding?.reports).toHaveLength(ADVISOR_FINDING_REPORTS_CAPACITY);
		expect(finding?.reports[0]?.defect).toBe("lead");
		expect(finding?.reports.some(report => report.defect === "owner view")).toBe(true);
		expect(finding?.reports.at(-1)?.defect).toBe(`variant ${ADVISOR_FINDING_REPORTS_CAPACITY * 2 - 1}`);
	});

	it("keeps only open concern and blocker findings on compaction", () => {
		const ledger = new AdvisorFindingsLedger();
		ledger.record(input({ identity: "a", severity: "nit" }));
		ledger.record(input({ identity: "b", severity: "concern" }));
		ledger.record(input({ identity: "c", severity: "blocker" }));
		ledger.compact();
		expect(ledger.list().map(finding => finding.identity)).toEqual(["b", "c"]);
	});

	it("caps the ledger, evicting closed findings before open ones", () => {
		const ledger = new AdvisorFindingsLedger();
		ledger.record(input({ identity: "old" }));
		for (let i = 0; i < ADVISOR_FINDING_EXPIRY_TURNS; i++) ledger.advanceTurn();
		for (let i = 0; i < ADVISOR_FINDINGS_CAPACITY; i++) ledger.record(input({ identity: `id-${i}` }));
		expect(ledger.list()).toHaveLength(ADVISOR_FINDINGS_CAPACITY);
		expect(ledger.list().some(finding => finding.identity === "old")).toBe(false);
		ledger.record(input({ identity: "overflow" }));
		expect(ledger.list()[0]?.identity).toBe("id-1");
	});

	it("round-trips a snapshot and continues numbering after the highest id", () => {
		const ledger = new AdvisorFindingsLedger();
		ledger.record(input({ identity: "a" }));
		ledger.record(input({ identity: "b" }));
		ledger.advanceTurn();
		const restored = new AdvisorFindingsLedger();
		restored.load(structuredClone(ledger.toEntry()));
		expect(restored.turn).toBe(1);
		expect(restored.record(input({ identity: "a", advisor: "Performance", defect: "x" })).type).toBe("attached");
		expect(restored.record(input({ identity: "c" }))).toMatchObject({ type: "new", finding: { id: "F3" } });
	});

	it("ignores an unknown version and a malformed snapshot", () => {
		const ledger = new AdvisorFindingsLedger();
		ledger.record(input());
		ledger.load({ v: 99, findings: [] });
		expect(ledger.list()).toEqual([]);
		ledger.load({ v: 1, findings: "nope" });
		expect(ledger.list()).toEqual([]);
		ledger.load(undefined);
		expect(ledger.list()).toEqual([]);
	});
});

describe("AdviseTool with a shared ledger", () => {
	it("charges the per-update budget for new findings only", async () => {
		const ledger = new AdvisorFindingsLedger();
		const routed: AdvisorAdvice[] = [];
		const first = new AdviseTool(advice => routed.push(advice), new AdvisorEmissionGuard({ budgetPerUpdate: 1 }), {
			ledger,
			advisor: "Correctness",
		});
		const second = new AdviseTool(advice => routed.push(advice), new AdvisorEmissionGuard({ budgetPerUpdate: 1 }), {
			ledger,
			advisor: "Performance",
		});
		await first.execute("a", params("retry window", "Retry window is off by one."));
		// Attaching to Correctness's finding leaves Performance's budget untouched.
		const attach = await second.execute("b", params("retry window", "Retry window double counts the first try."));
		expect(attach.content).toEqual([{ type: "text", text: "Delivered." }]);
		const fresh = await second.execute("c", params("cache eviction", "Cache eviction never fires."));
		expect(fresh.content).toEqual([{ type: "text", text: "Delivered." }]);
		const over = await second.execute("d", params("lock order", "Lock order inverts under load."));
		expect(over.content).toEqual([{ type: "text", text: "Dropped: this update's advice budget is spent." }]);
		expect(routed.map(advice => advice.finding)).toEqual(["F1", "F1", "F2"]);
	});

	it("withdraws a displaced pending report from the ledger", async () => {
		const ledger = new AdvisorFindingsLedger();
		const tool = new AdviseTool(() => {}, new AdvisorEmissionGuard({ budgetPerUpdate: 1 }), { ledger });
		tool.beginUpdate(true);
		await tool.execute("a", params("naming", "Rename the helper for clarity.", "nit"));
		await tool.execute("b", params("locking", "The helper drops the lock early.", "concern"));
		expect(ledger.list()).toHaveLength(1);
		expect(ledger.list()[0]?.reports[0]?.defect).toBe("The helper drops the lock early.");
	});
});

describe("finding rendering", () => {
	it("leads a ledger advisory with finding, category, and owner and escapes free text", () => {
		const content = formatAdvisorBatchContent([
			{
				note: "a < b & c",
				severity: "blocker",
				kind: "defect",
				advisor: "Correctness",
				finding: "F7",
				category: "security",
				owner: "Security",
				reporters: ["Security", "Correctness"],
			},
		]);
		expect(content).toBe(
			'<advisory finding="F7" category="security" owner="Security" severity="blocker" kind="defect" reporters="Security,Correctness" advisor="Correctness" guidance="weigh, don\'t blindly obey">\na &lt; b &amp; c\n</advisory>',
		);
	});

	it("groups card notes by finding and shows category and reporter count", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const card = createAdvisorMessageCard(
			{
				notes: [
					{
						note: "first finding",
						severity: "concern",
						finding: "F1",
						category: "security",
						reporters: ["A", "B"],
					},
					{ note: "other finding", severity: "nit", finding: "F2", category: "logic", reporters: ["A"] },
					{ note: "corroboration", severity: "nit", finding: "F1", category: "security", reporters: ["A", "B"] },
					{ note: "legacy note", severity: "nit" },
				],
			},
			() => true,
			theme,
		);
		const text = Bun.stripANSI(card.render(200).join("\n"));
		expect(text).toContain("F1 security · 2 reporters");
		expect(text).toContain("F2 logic · 1 reporter");
		expect(text.indexOf("corroboration")).toBeLessThan(text.indexOf("other finding"));
		expect(text).toMatch(/nit\S*\s+legacy note/);
	});
});
