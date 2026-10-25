import { describe, expect, it } from "bun:test";
import { AdvisorFindingsLedger, renderFindingsDigest } from "../../src/advisor";
import { Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import { runAdvisorFindingsCommand } from "../../src/slash-commands/helpers/advisor-findings";
import type { ToolSession } from "../../src/tools";
import { AdvisorFindingsTool } from "../../src/tools/advisor-findings";

function record(ledger: AdvisorFindingsLedger, category = "logic") {
	return ledger.record({
		advisor: "Correctness",
		category,
		identity: "claim:check",
		anchor: "check",
		kind: "defect",
		severity: "concern",
		defect: "Missing bounds check.",
	}).finding;
}

function toolSession(ledger: AdvisorFindingsLedger, enabled = true): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "advisor.enabled": enabled }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAdvisorFindingsLedger: () => ledger,
	};
}

describe("advisor findings management", () => {
	it("persists agent closure and exposes the author and reason to list, get, and advisor digests", async () => {
		let snapshot: unknown;
		const ledger = new AdvisorFindingsLedger({
			onChange: () => {
				snapshot = structuredClone(ledger.toEntry());
			},
		});
		record(ledger);
		ledger.advanceTurn();
		const tool = new AdvisorFindingsTool(toolSession(ledger));
		await tool.execute("resolve", { op: "resolve", ids: ["f1"], reason: " Bounds check added. " });
		const restored = new AdvisorFindingsLedger();
		restored.load(snapshot);
		const reopenedTool = new AdvisorFindingsTool(toolSession(restored));
		expect((await reopenedTool.execute("open", { op: "list" })).details?.findings).toEqual([]);
		const all = await reopenedTool.execute("all", { op: "list", status: "all" });
		expect(all.details?.findings?.[0]).toMatchObject({
			id: "F1",
			status: "resolved",
			resolution: { by: "agent", reason: "Bounds check added.", turn: 1 },
			defect: "Missing bounds check.",
		});
		const detail = await reopenedTool.execute("get", { op: "get", id: "F1" });
		expect(detail.details?.findings?.[0]?.reports?.[0]?.defect).toBe("Missing bounds check.");
		const digest = renderFindingsDigest(restored.list(), { owns: () => false, canReadAnchor: () => false });
		expect(digest).toContain("F1 logic resolved by agent:");
		expect(digest).toContain("Bounds check added.");
		expect(digest).not.toContain("<open-findings>");
	});

	it("rejects absent and whitespace reasons without mutating any batch finding", async () => {
		const ledger = new AdvisorFindingsLedger();
		record(ledger);
		const tool = new AdvisorFindingsTool(toolSession(ledger));
		await expect(tool.execute("no-reason", { op: "resolve", ids: ["F1"] })).rejects.toThrow("non-empty reason");
		await expect(tool.execute("blank", { op: "reopen", ids: ["F1"], reason: " \t " })).rejects.toThrow(
			"non-empty reason",
		);
		await expect(
			tool.execute("invalid-id", { op: "resolve", ids: ["F1", "bogus"], reason: "Fixed" }),
		).rejects.toThrow("finding ids");
		expect(ledger.get("F1")?.status).toBe("open");
	});

	it("resolves merged aliases, preserves an existing resolution, and reports missing ids per batch", async () => {
		const ledger = new AdvisorFindingsLedger();
		const lead = record(ledger);
		const absorbed = record(ledger, "security");
		ledger.merge(lead, absorbed);
		const tool = new AdvisorFindingsTool(toolSession(ledger));
		const result = await tool.execute("resolve", { op: "resolve", ids: ["F2", "F1", "F99"], reason: "Fixed bounds" });
		expect(result.details?.results).toMatchObject([
			{ id: "F2", result: "merged-into", mergedInto: "F1", outcome: "resolved" },
			{ id: "F1", result: "already resolved" },
			{ id: "F99", result: "missing" },
		]);
		await tool.execute("again", { op: "resolve", ids: ["F1"], reason: "Replacement" });
		expect(lead.resolution?.reason).toBe("Fixed bounds");
	});

	it("refuses superseded reopens and otherwise reopens with resolution metadata cleared", async () => {
		const ledger = new AdvisorFindingsLedger();
		record(ledger);
		const tool = new AdvisorFindingsTool(toolSession(ledger));
		await tool.execute("resolve", { op: "resolve", ids: ["F1"], reason: "Fixed" });
		record(ledger);
		const superseded = await tool.execute("reopen", { op: "reopen", ids: ["F1"], reason: "Regression" });
		expect(superseded.details?.results?.[0]?.result).toBe("superseded");
		await tool.execute("resolve-new", { op: "resolve", ids: ["F2"], reason: "Duplicate fixed" });
		const reopened = await tool.execute("reopen-old", { op: "reopen", ids: ["F1"], reason: "Regression" });
		expect(reopened.details?.results?.[0]?.result).toBe("reopened");
		expect(ledger.get("F1")?.resolution).toBeUndefined();
		expect(ledger.findOpen("logic", "claim:check")?.id).toBe("F1");
	});

	it("loads v1 snapshots and writes subsequent changes as v2", () => {
		const ledger = new AdvisorFindingsLedger();
		record(ledger);
		const restored = new AdvisorFindingsLedger();
		restored.load({ ...structuredClone(ledger.toEntry()), v: 1 });
		expect(restored.findOpen("logic", "claim:check")?.id).toBe("F1");
		restored.resolve("F1", "agent", "Fixed");
		expect(restored.toEntry()).toMatchObject({
			v: 2,
			findings: [{ status: "resolved", resolution: { by: "agent", reason: "Fixed" } }],
		});
	});

	it("records optional slash-command resolution reasons as user and shows them in all", () => {
		const ledger = new AdvisorFindingsLedger();
		record(ledger);
		const session: Pick<AgentSession, "getAdvisorFindings" | "resolveAdvisorFinding" | "reopenAdvisorFinding"> = {
			getAdvisorFindings: () => ledger.list(),
			resolveAdvisorFinding: (id, reason) => ({
				result: ledger.resolve(id, "user", reason) ? "resolved" : "closed",
				finding: ledger.get(id),
			}),
			reopenAdvisorFinding: id => ({ result: ledger.reopen(id), finding: ledger.get(id) }),
		};
		expect(runAdvisorFindingsCommand(session, "resolve f1 Verified bounds check")).toContain("Resolved F1");
		expect(ledger.get("F1")?.resolution).toMatchObject({ by: "user", reason: "Verified bounds check" });
		expect(runAdvisorFindingsCommand(session, "all")).toContain("resolved-by=user reason=Verified bounds check");
		runAdvisorFindingsCommand(session, "reopen F1");
		expect(runAdvisorFindingsCommand(session, "resolve F1")).toContain("Resolved F1");
	});

	it("gates registration on advisor support and classifies only observations as read approval", () => {
		const ledger = new AdvisorFindingsLedger();
		expect(AdvisorFindingsTool.createIf(toolSession(ledger, false))).toBeNull();
		const session = toolSession(ledger);
		delete session.getAdvisorFindingsLedger;
		expect(AdvisorFindingsTool.createIf(session)).toBeNull();
		const tool = new AdvisorFindingsTool(toolSession(ledger));
		expect(tool.approval({ op: "list" })).toBe("read");
		expect(tool.approval({ op: "get" })).toBe("read");
		expect(tool.approval({ op: "resolve" })).toBe("write");
		expect(tool.approval({ op: "reopen" })).toBe("write");
	});
});
