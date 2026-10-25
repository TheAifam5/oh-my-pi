import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import type { Component } from "@oh-my-pi/pi-tui";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_FINDINGS_ENTRY_TYPE,
	type AdviseParams,
	AdviseTool,
	type AdvisorCategory,
	AdvisorFindingsLedger,
	type AdvisorReportInput,
	formatAdvisorBatchContent,
} from "../src/advisor";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const CATEGORIES: AdvisorCategory[] = [
	{ id: "security", description: "Trust boundaries.", owner: "Security", precedence: 1 },
	{ id: "logic", description: "Correctness.", owner: "Correctness" },
	{ id: "concurrency", description: "Races.", owner: "Performance" },
];

const ROSTER: AdvisorConfig[] = [{ name: "Security" }, { name: "Correctness" }, { name: "Performance" }];

const ANCHOR = { type: "file", path: "packages/ai/src/auth-broker/server.ts", line: 1043 } as const;

function report(category: string, defect: string, severity: AdviseParams["severity"] = "concern"): AdviseParams {
	return {
		kind: "defect",
		category,
		where: ANCHOR,
		defect,
		impact: `${defect} impact`,
		fix: `${defect} fix`,
		severity,
	};
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	return content.map(part => (part.type === "text" ? part.text : "")).join("");
}

describe("advisor findings delivery", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		__resetDirsFromEnvForTests();
	});

	function createSession(manager: SessionManager): AgentSession {
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({ "compaction.enabled": false, "advisor.immuneTurns": 0 });
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: manager, settings, modelRegistry, advisorTools: [] });
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-findings-");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
		sessionManager = SessionManager.inMemory(tempDir.path());
		session = createSession(sessionManager);
	});

	afterEach(async () => {
		await session?.dispose();
		await tempDir?.remove().catch(() => {});
	});

	function enable(roster: AdvisorConfig[] = ROSTER): Map<string, AdviseTool> {
		expect(session.setAdvisorEnabled(true)).toBe(true);
		session.applyAdvisorConfigs(roster, undefined, undefined, CATEGORIES);
		return adviseTools(roster);
	}

	function adviseTools(roster: AdvisorConfig[]): Map<string, AdviseTool> {
		const tools = new Map<string, AdviseTool>();
		const agents = session.getAdvisorAgents();
		const live = roster.filter(config => config.enabled !== false);
		agents.forEach((agent, index) => {
			const tool = agent.state.tools?.find(candidate => candidate.name === "advise");
			if (!(tool instanceof AdviseTool)) throw new Error("Expected advise tool");
			tools.set(live[index]!.name, tool);
		});
		return tools;
	}

	async function advise(tool: AdviseTool | undefined, params: AdviseParams): Promise<string> {
		if (!tool) throw new Error("Expected advisor tool");
		const result = await tool.execute("call", params);
		await Bun.sleep(0);
		return result.content.map(part => (part.type === "text" ? part.text : "")).join("");
	}

	function steered(): string[] {
		return session.agent.peekSteeringQueue().map(textOf);
	}

	function asides(): string[] {
		return session.yieldQueue.drainLazy().map(build => textOf(build() as AgentMessage));
	}

	it("interrupts once per finding: three advisors on one anchor give one steer plus asides, owner first", async () => {
		const tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			await advise(tools.get("Performance"), report("security", "Token comparison leaks timing."));
			await advise(tools.get("Security"), report("security", "Non-constant-time token check."));
			const steers = steered();
			expect(steers).toHaveLength(1);
			expect(steers[0]).toContain('<advisory finding="F1" category="security" owner="Security" severity="concern"');
			expect(steers[0]).toContain('reporters="Correctness"');
			const queued = asides();
			expect(queued).toHaveLength(1);
			expect(queued[0]).toContain('advisor="Performance"');
			expect(queued[0]).toContain('advisor="Security"');
			expect(queued[0]).toContain('reporters="Security,Correctness,Performance"');
			expect(session.getAdvisorFindings()).toHaveLength(1);
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("lets a later report interrupt again only when it raises the finding's severity", async () => {
		const tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			await advise(tools.get("Security"), report("security", "Non-constant-time token check.", "blocker"));
			const steers = steered();
			expect(steers).toHaveLength(2);
			expect(steers[1]).toContain('severity="blocker"');
			expect(steers[1]).toContain('reporters="Security,Correctness"');
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("routes an owner's later report at the same severity as an aside under the finding", async () => {
		const tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			await advise(tools.get("Security"), report("security", "Non-constant-time token check."));
			expect(steered()).toHaveLength(1);
			const queued = asides();
			expect(queued).toHaveLength(1);
			expect(queued[0]).toContain('finding="F1" category="security" owner="Security"');
			expect(queued[0]).toContain('reporters="Security,Correctness"');
			expect(queued[0]).toContain("Non-constant-time token check.");
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("delivers a non-owner report when the owner stays silent", async () => {
		const tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			const steers = steered();
			expect(steers).toHaveLength(1);
			expect(steers[0]).toContain('owner="Security"');
			expect(steers[0]).toContain('reporters="Correctness"');
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("delivers a report on a category whose owner is not live, without naming an owner", async () => {
		const roster: AdvisorConfig[] = [{ name: "Security", enabled: false }, { name: "Correctness" }];
		const tools = enable(roster);
		expect(session.advisorCategoryHasLiveOwner("security")).toBe(false);
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			const steers = steered();
			expect(steers).toHaveLength(1);
			expect(steers[0]).toContain('<advisory finding="F1" category="security" severity="concern"');
			expect(steers[0]).not.toContain("owner=");
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("interrupts once per anchor: three categories on one anchor give one steer plus asides", async () => {
		const tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Security"), report("security", "Token compared with ==."));
			await advise(tools.get("Correctness"), report("logic", "Off-by-one in the retry window."));
			await advise(tools.get("Performance"), report("concurrency", "Token cache read races the refresh."));
			const steers = steered();
			expect(steers).toHaveLength(1);
			expect(steers[0]).toContain('finding="F1" category="security" owner="Security"');
			const queued = asides().join("\n");
			expect(queued).toContain('finding="F2" category="logic"');
			expect(queued).toContain('finding="F3" category="concurrency"');
			expect(session.getAdvisorFindings().map(finding => finding.category)).toEqual([
				"security",
				"logic",
				"concurrency",
			]);
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("lets another finding on an interrupted anchor interrupt once more only at a strictly higher severity", async () => {
		const tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Security"), report("security", "Token compared with ==."));
			await advise(tools.get("Correctness"), report("logic", "Retry window never closes.", "blocker"));
			await advise(tools.get("Performance"), report("concurrency", "Refresh deadlocks.", "blocker"));
			const steers = steered();
			expect(steers).toHaveLength(2);
			expect(steers[1]).toContain('finding="F2" category="logic"');
			expect(asides().join("\n")).toContain('finding="F3" category="concurrency"');
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("caps one advisor's attached asides per update at its budget and records the rest", async () => {
		const roster: AdvisorConfig[] = [
			{ name: "Security" },
			{ name: "Correctness" },
			{ name: "Performance", maxNotesPerUpdate: 2 },
		];
		const tools = enable(roster);
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			const acks: string[] = [];
			for (const defect of ["First addition.", "Second addition.", "Third addition."]) {
				acks.push(await advise(tools.get("Performance"), report("security", defect, "nit")));
			}
			expect(steered()).toHaveLength(1);
			expect(
				asides()
					.join("\n")
					.match(/<advisory /g),
			).toHaveLength(2);
			expect(acks[2]).toContain("Recorded under F1");
			const [finding] = session.getAdvisorFindings();
			expect(finding?.reports.map(r => r.defect)).toEqual([
				"Token compared with ==.",
				"First addition.",
				"Second addition.",
				"Third addition.",
			]);
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	describe("relations", () => {
		function related(
			category: string,
			defect: string,
			relatesTo: string,
			relation: NonNullable<AdviseParams["relation"]>,
			severity: AdviseParams["severity"] = "concern",
		): AdviseParams {
			return { ...report(category, defect, severity), relatesTo, relation };
		}

		async function withOpenFinding(run: (tools: Map<string, AdviseTool>) => Promise<void>): Promise<void> {
			const tools = enable();
			session.agent.state.isStreaming = true;
			try {
				await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
				expect(steered()).toHaveLength(1);
				session.agent.clearSteeringQueue();
				await run(tools);
			} finally {
				session.agent.clearSteeringQueue();
				session.agent.state.isStreaming = false;
			}
		}

		it("accepts a duplicate only when the host anchor identity matches", async () => {
			await withOpenFinding(async tools => {
				const elsewhere = { ...related("logic", "Timing leak.", "F1", "duplicate"), where: { ...ANCHOR, line: 7 } };
				await advise(tools.get("Performance"), elsewhere);
				expect(session.getAdvisorFindings().map(finding => finding.id)).toEqual(["F1", "F2"]);
				expect(steered().join("\n")).toContain('finding="F2" category="logic"');

				await advise(tools.get("Performance"), related("logic", "Timing leak.", "F1", "duplicate"));
				const queued = asides().join("\n");
				expect(queued).toContain('finding="F1"');
				expect(queued).toContain('relation="duplicate"');
				expect(session.getAdvisorFindings()).toHaveLength(2);
			});
		});

		it("links a duplicate between approach anchors with different topics", async () => {
			const tools = enable();
			session.agent.state.isStreaming = true;
			try {
				await advise(tools.get("Correctness"), {
					...report("logic", "Edits land in the main checkout."),
					where: { type: "approach", topic: "worktree isolation" },
				});
				session.agent.clearSteeringQueue();
				await advise(tools.get("Performance"), {
					...related("logic", "Changes bypass the sibling worktree.", "F1", "duplicate"),
					where: { type: "approach", topic: "editing the wrong checkout" },
				});
				const findings = session.getAdvisorFindings();
				expect(findings.map(finding => finding.id)).toEqual(["F1"]);
				expect(findings[0]?.reports.map(r => r.advisor)).toEqual(["Correctness", "Performance"]);
				expect(steered()).toHaveLength(0);
				expect(asides().join("\n")).toContain('relation="duplicate"');
			} finally {
				session.agent.clearSteeringQueue();
				session.agent.state.isStreaming = false;
			}
		});

		it("records a duplicate repeating the lead report without delivering it", async () => {
			await withOpenFinding(async tools => {
				const ack = await advise(
					tools.get("Performance"),
					related("security", "Token compared with ==.", "F1", "duplicate"),
				);
				expect(ack).toContain("Already raised");
				expect(steered()).toHaveLength(0);
				expect(asides()).toHaveLength(0);
				expect(session.getAdvisorFindings()[0]?.reports.map(r => r.advisor)).toEqual([
					"Correctness",
					"Performance",
				]);
			});
		});

		it("delivers adds and disputes as asides under the finding", async () => {
			await withOpenFinding(async tools => {
				await advise(tools.get("Performance"), related("logic", "Also leaks via logs.", "F1", "adds", "blocker"));
				await advise(tools.get("Security"), related("security", "Comparison is constant-time.", "F1", "disputes"));
				expect(steered()).toHaveLength(0);
				const queued = asides().join("\n");
				expect(queued).toContain('finding="F1" category="security" owner="Security" severity="blocker"');
				expect(queued).toContain('relation="adds"');
				expect(queued).toContain('relation="disputes"');
				expect(session.getAdvisorFindings()).toHaveLength(1);
			});
		});

		it("keeps an adds report an aside even when it raises a finding that never interrupted", async () => {
			const tools = enable();
			session.agent.state.isStreaming = true;
			try {
				await advise(tools.get("Correctness"), report("security", "Token compared with ==.", "nit"));
				await advise(tools.get("Performance"), related("logic", "Also leaks via logs.", "F1", "adds", "blocker"));
				expect(steered()).toHaveLength(0);
				expect(asides().join("\n")).toContain('relation="adds"');
				expect(session.getAdvisorFindings()[0]?.severity).toBe("blocker");
			} finally {
				session.agent.clearSteeringQueue();
				session.agent.state.isStreaming = false;
			}
		});

		it("lets escalates interrupt only at a strictly higher severity", async () => {
			await withOpenFinding(async tools => {
				await advise(tools.get("Performance"), related("logic", "Still leaking.", "F1", "escalates"));
				expect(steered()).toHaveLength(0);
				expect(asides().join("\n")).toContain('relation="escalates"');
				await advise(
					tools.get("Performance"),
					related("logic", "Exploitable remotely.", "F1", "escalates", "blocker"),
				);
				const steers = steered();
				expect(steers).toHaveLength(1);
				expect(steers[0]).toContain('finding="F1"');
				expect(steers[0]).toContain('severity="blocker"');
			});
		});

		it("turns resolved from a non-owner into disputes and lets the owner resolve", async () => {
			await withOpenFinding(async tools => {
				await advise(
					tools.get("Correctness"),
					related("security", "Fixed by hmac compare.", "F1", "resolved", "nit"),
				);
				expect(asides().join("\n")).toContain('relation="disputes"');
				expect(session.getAdvisorFindings()[0]?.status).toBe("open");
				await advise(
					tools.get("Security"),
					related("security", "Constant-time compare landed.", "F1", "resolved", "nit"),
				);
				expect(asides().join("\n")).toContain('relation="resolved"');
				expect(session.getAdvisorFindings()[0]?.status).toBe("resolved");
			});
		});

		it("treats an unknown finding id as no relation", async () => {
			await withOpenFinding(async tools => {
				await advise(tools.get("Performance"), related("security", "Timing leak.", "F99", "disputes", "nit"));
				const queued = asides().join("\n");
				expect(queued).toContain('finding="F1"');
				expect(queued).not.toContain("relation=");
				expect(session.getAdvisorFindings()[0]?.reports.at(-1)?.relation).toBeUndefined();
			});
		});
	});

	it("records an exact repeat as a reporter without delivering it again", async () => {
		const tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			const ack = await advise(tools.get("Performance"), report("security", "Token compared with ==."));
			expect(ack).toContain("Already raised");
			expect(steered()).toHaveLength(1);
			expect(asides()).toHaveLength(0);
			const [finding] = session.getAdvisorFindings();
			expect(finding?.reports.map(r => r.advisor)).toEqual(["Correctness", "Performance"]);
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("keeps the ledger across an advisor rebuild", async () => {
		let tools = enable();
		session.agent.state.isStreaming = true;
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
			session.agent.clearSteeringQueue();
			session.applyAdvisorConfigs([...ROSTER], undefined, undefined, CATEGORIES);
			tools = adviseTools(ROSTER);
			await advise(tools.get("Performance"), report("security", "Token comparison leaks timing."));
			expect(steered()).toHaveLength(0);
			expect(asides()).toHaveLength(1);
			const findings = session.getAdvisorFindings();
			expect(findings).toHaveLength(1);
			expect(findings[0]?.reports).toHaveLength(2);
		} finally {
			session.agent.clearSteeringQueue();
			session.agent.state.isStreaming = false;
		}
	});

	it("persists the ledger as a versioned session entry that a resumed session restores", async () => {
		// Without a live owner the finding carries no owner.
		const tools = enable([{ name: "Security", enabled: false }, { name: "Correctness" }]);
		await advise(tools.get("Correctness"), report("security", "Token compared with ==."));
		const entries = sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === ADVISOR_FINDINGS_ENTRY_TYPE);
		expect(entries.length).toBeGreaterThan(0);
		const last = entries.at(-1);
		expect(last?.type === "custom" ? last.data : undefined).toMatchObject({
			v: 2,
			findings: [{ id: "F1", category: "security", status: "open", reports: [{ advisor: "Correctness" }] }],
		});
		const resumed = createSession(sessionManager);
		try {
			expect(resumed.getAdvisorFindings().map(finding => finding.id)).toEqual(["F1"]);
		} finally {
			await resumed.dispose();
		}
	});

	it("saves a finding in its original session before a same-tick session switch", async () => {
		const tools = enable();
		const originalId = sessionManager.getSessionId();
		const branchPoint = sessionManager.appendCustomEntry("before-finding", {});
		let originalEntries = structuredClone(sessionManager.getEntries());
		const record = AdvisorFindingsLedger.prototype.record;
		const recordSpy = spyOn(AdvisorFindingsLedger.prototype, "record").mockImplementation(function (
			this: AdvisorFindingsLedger,
			input: AdvisorReportInput,
		) {
			const result = record.call(this, input);
			originalEntries = structuredClone(sessionManager.getEntries());
			sessionManager.createBranchedSession(branchPoint);
			return result;
		});
		try {
			await advise(tools.get("Correctness"), report("security", "Token compared with ==.", "nit"));
			expect(sessionManager.getSessionId()).not.toBe(originalId);
			expect(
				originalEntries.filter(
					entry => entry.type === "custom" && entry.customType === ADVISOR_FINDINGS_ENTRY_TYPE,
				),
			).toEqual([
				expect.objectContaining({
					data: expect.objectContaining({
						findings: [
							expect.objectContaining({
								id: "F1",
								reports: [expect.objectContaining({ advisor: "Correctness" })],
							}),
						],
					}),
				}),
			]);
			expect(
				sessionManager
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === ADVISOR_FINDINGS_ENTRY_TYPE),
			).toEqual([]);
		} finally {
			recordSpy.mockRestore();
		}
	});

	describe("resume", () => {
		const persisted = {
			id: "F4",
			category: "security",
			identity: "file\0packages/ai/src/auth-broker/server.ts\0x",
			anchor: "packages/ai/src/auth-broker/server.ts:1043",
			status: "open",
			severity: "concern",
			reports: [{ advisor: "Correctness", kind: "defect", severity: "concern", defect: "d", turn: 0, owner: false }],
			createdTurn: 0,
			lastTouchedTurn: 0,
			interrupted: true,
		};

		async function resumeWith(data: unknown): Promise<AgentSession> {
			await session.dispose();
			const manager = SessionManager.inMemory(tempDir.path());
			manager.appendCustomMessageEntry("advisor", '<advisory severity="concern">\nold note\n</advisory>', true, {
				notes: [{ note: "old note", severity: "concern" }],
			});
			if (data !== undefined) manager.appendCustomEntry(ADVISOR_FINDINGS_ENTRY_TYPE, data);
			session = createSession(manager);
			return session;
		}

		it("starts a pre-feature session with an empty ledger and renders old notes unchanged", async () => {
			const resumed = await resumeWith(undefined);
			expect(resumed.getAdvisorFindings()).toEqual([]);
			expect(
				resumed.sessionManager
					.getEntries()
					.some(entry => entry.type === "custom" && entry.customType === ADVISOR_FINDINGS_ENTRY_TYPE),
			).toBe(false);
			expect(formatAdvisorBatchContent([{ note: "old note", severity: "concern", advisor: "Security" }])).toBe(
				'<advisory advisor="Security" severity="concern" guidance="weigh, don\'t blindly obey">\nold note\n</advisory>',
			);
		});

		it("restores a persisted ledger, skipping malformed findings", async () => {
			const resumed = await resumeWith({ v: 1, turn: 3, findings: [persisted, { id: "bogus" }] });
			expect(resumed.getAdvisorFindings().map(f => f.id)).toEqual(["F4"]);
		});

		it("ignores a ledger with an unknown version", async () => {
			const resumed = await resumeWith({ v: 99, turn: 3, findings: [persisted] });
			expect(resumed.getAdvisorFindings()).toEqual([]);
		});
	});

	it("leads a terminal-boundary batch's anchor group with the highest-precedence category in one delivery", async () => {
		await session.dispose();
		const call = (category: string, defect: string) => ({
			type: "toolCall" as const,
			name: "advise",
			arguments: { ...report(category, defect), where: { type: "approach", topic: "token check" } },
		});
		const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["done"] }] });
		const advisorMock = createMockModel({
			provider: "anthropic",
			responses: [
				{
					content: [
						call("logic", "Retry window never closes."),
						call("security", "Token compared with ==."),
						call("concurrency", "Refresh races the read."),
					],
				},
			],
		});
		const settings = Settings.isolated({
			"advisor.syncBacklog": "strict",
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		const roster: AdvisorConfig[] = [{ name: "Correctness" }];
		enable(roster);
		await session.prompt("ship the auth change");
		expect(await session.waitForAdvisorCatchup(2000, { strictWithoutDeadline: true })).toBe(true);
		const cards = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "advisor",
		);
		expect(cards).toHaveLength(1);
		const content = textOf(cards[0]!);
		const order = ["security", "logic", "concurrency"].map(category => content.indexOf(`category="${category}"`));
		expect(order.every(index => index >= 0)).toBe(true);
		expect(order[0]).toBeLessThan(order[1]!);
		expect(order[1]).toBeLessThan(order[2]!);
	});

	describe("digest", () => {
		async function reviewContexts(digestEnabled: boolean): Promise<Map<string, string>> {
			await session.dispose();
			const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["done"] }] });
			const advisorMock = createMockModel({
				provider: "anthropic",
				responses: Array.from({ length: 4 }, () => ({ content: ["Reviewed."] })),
			});
			const reviews = new Map<string, string>();
			const settings = Settings.isolated({
				"advisor.syncBacklog": "strict",
				"advisor.findingsDigest": digestEnabled,
				"compaction.enabled": false,
				"todo.enabled": false,
			});
			settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model: primaryMock, systemPrompt: [], tools: [] },
					streamFn: primaryMock.stream,
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry,
				advisorTools: [],
				advisorStreamFn: (streamModel, context, options) => {
					const name = JSON.stringify(context.systemPrompt ?? "").includes("security-marker")
						? "Security"
						: "Correctness";
					reviews.set(name, JSON.stringify(context.messages));
					return advisorMock.stream(streamModel, context, options);
				},
			});
			const roster: AdvisorConfig[] = [
				{ name: "Security", instructions: "security-marker" },
				{ name: "Correctness", instructions: "correctness-marker" },
			];
			const tools = enable(roster);
			await advise(tools.get("Correctness"), {
				...report("security", "Token compared with ==.", "nit"),
				where: { type: "claim", quote: "claim-quote-marker" },
			});
			await session.prompt("ship the auth change");
			expect(await session.waitForAdvisorCatchup(2000, { strictWithoutDeadline: true })).toBe(true);
			return reviews;
		}

		it("appends the open findings to each advisor's review without report or anchor text", async () => {
			const reviews = await reviewContexts(true);
			expect([...reviews.keys()].sort()).toEqual(["Correctness", "Security"]);
			for (const context of reviews.values()) {
				expect(context).toContain("<open-findings>");
				expect(context).toContain("F1 security nit owner=Security reporters=1");
				const digest = context.slice(context.indexOf("<open-findings>"), context.indexOf("</open-findings>"));
				expect(digest).not.toContain("claim-quote-marker");
				expect(digest).not.toContain("Token compared");
			}
		});

		it("omits the digest when advisor.findingsDigest is off", async () => {
			const reviews = await reviewContexts(false);
			expect(reviews.size).toBe(2);
			for (const context of reviews.values()) expect(context).not.toContain("<open-findings>");
		});
	});

	describe("judge pass", () => {
		const SOURCE = "test://advisor-findings-judge";
		const FAKE = {
			id: "",
			name: "",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		};

		interface JudgeHarness {
			/** The judge answers only after this settles. */
			judgeHold?: Promise<void>;
			/** Called, not awaited, on the first judge request with the live request list. */
			onFirstJudgeRequest?: (requests: readonly string[]) => void;
		}

		/**
		 * One primary turn reviewed by Security and Correctness, each reporting
		 * the shared anchor in its own category; the `judge` role is a
		 * `fakeco` model answering `same`. Returns the judge's requests.
		 */
		async function reviewWithJudge(advisorModel: string, harness: JudgeHarness = {}): Promise<string[]> {
			await session.dispose();
			authStorage.keys.setRuntime("fakeco", "test-key");
			const registry = new ModelRegistry(authStorage);
			const judgeMock = createMockModel({
				provider: "fakeco",
				handler: async () => {
					await harness.judgeHold;
					return { content: ["same"] };
				},
			});
			const judgeRequests: string[] = [];
			registry.registerProvider(
				"fakeco",
				{
					baseUrl: "https://fakeco.invalid/v1",
					apiKey: "FAKECO_TEST_KEY",
					api: "fakeco-chat",
					streamSimple: (streamModel, context, options) => {
						judgeRequests.push(JSON.stringify(context.messages));
						if (judgeRequests.length === 1) harness.onFirstJudgeRequest?.(judgeRequests);
						return judgeMock.stream(streamModel, context, options);
					},
					models: [
						{ ...FAKE, id: "judge-1", name: "Judge" },
						{ ...FAKE, id: "adv-1", name: "Advisor" },
					],
				},
				SOURCE,
			);
			const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["done"] }] });
			const advisorMock = (params: AdviseParams) =>
				createMockModel({
					provider: "fakeco",
					responses: [{ content: [{ type: "toolCall", name: "advise", arguments: { ...params } }] }],
				});
			const advisorMocks: Record<"Security" | "Correctness", MockModel> = {
				Security: advisorMock(report("security", "Non-constant-time token check.")),
				Correctness: advisorMock(report("logic", "Token compared with ==.")),
			};
			const settings = Settings.isolated({
				"advisor.syncBacklog": "strict",
				"advisor.aggregation.judge.enabled": true,
				"compaction.enabled": false,
				"todo.enabled": false,
			});
			settings.setModelRole("advisor", advisorModel);
			settings.setModelRole("judge", "fakeco/judge-1");
			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model: primaryMock, systemPrompt: [], tools: [] },
					streamFn: primaryMock.stream,
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry: registry,
				advisorTools: [],
				advisorStreamFn: (streamModel, context, options) => {
					const name = JSON.stringify(context.systemPrompt ?? "").includes("security-marker")
						? "Security"
						: "Correctness";
					return advisorMocks[name].stream(streamModel, context, options);
				},
			});
			try {
				enable([
					{ name: "Security", instructions: "security-marker" },
					{ name: "Correctness", instructions: "correctness-marker" },
				]);
				await session.prompt("ship the auth change");
				expect(await session.waitForAdvisorCatchup(5000, { strictWithoutDeadline: true })).toBe(true);
				return judgeRequests;
			} finally {
				registry.clearSourceRegistrations(SOURCE);
			}
		}

		it("merges same-provider advisors' findings on one anchor after one judge call", async () => {
			const requests = await reviewWithJudge("fakeco/adv-1");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toContain("Non-constant-time token check.");
			expect(requests[0]).toContain("Token compared with ==.");
			const findings = session.getAdvisorFindings();
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({ category: "security", status: "open" });
			expect(findings[0]?.merged?.map(merged => merged.category)).toEqual(["logic"]);
			expect(findings[0]?.reports).toHaveLength(2);
		});

		it("does not call the judge when the advisors run on another provider", async () => {
			const requests = await reviewWithJudge("anthropic/claude-sonnet-4-5");
			expect(requests).toEqual([]);
			expect(
				session
					.getAdvisorFindings()
					.map(finding => finding.category)
					.sort(),
			).toEqual(["logic", "security"]);
		});

		it("runs the judge passes of advisors finishing together one at a time", async () => {
			const release = Promise.withResolvers<void>();
			const bothUpdatesReady = Promise.withResolvers<void>();
			const bothQueued = Promise.withResolvers<void>();
			const queuePass = SessionAdvisors.prototype.queueFindingsJudgePass;
			let queued = 0;
			let ready = 0;
			const candidatePassSpy = spyOn(ChainJudge.prototype, "withCandidate");
			let inFlight = -1;
			const queuedSpy = spyOn(SessionAdvisors.prototype, "queueFindingsJudgePass").mockImplementation(
				async function (this: SessionAdvisors, reportsBefore) {
					if (++ready === 2) bothUpdatesReady.resolve();
					await bothUpdatesReady.promise;
					const pass = queuePass.call(this, reportsBefore);
					if (++queued === 2) bothQueued.resolve();
					return pass;
				},
			);
			try {
				const requests = await reviewWithJudge("fakeco/adv-1", {
					judgeHold: release.promise,
					onFirstJudgeRequest: async () => {
						await bothQueued.promise;
						inFlight = candidatePassSpy.mock.calls.length;
						release.resolve();
					},
				});
				expect(queued).toBe(2);
				expect(inFlight).toBe(1);
				expect(candidatePassSpy).toHaveBeenCalledTimes(1);
				expect(requests).toHaveLength(1);
				const findings = session.getAdvisorFindings();
				expect(findings).toHaveLength(1);
				expect(findings[0]?.merged?.map(merged => merged.category)).toEqual(["logic"]);
			} finally {
				release.resolve();
				queuedSpy.mockRestore();
				candidatePassSpy.mockRestore();
			}
		});
	});

	describe("/advisor findings", () => {
		beforeAll(async () => {
			await initTheme(false);
		});

		it("reuses the native findings sheet and persists its resolve and reopen actions", async () => {
			const tools = enable();
			await advise(tools.get("Security"), report("security", "Token compared with ==."));
			session.agent.clearSteeringQueue();
			const overlays: Component[] = [];
			const ctx = createInteractiveModeContext({
				session,
				sessionManager: session.sessionManager,
				settings: session.settings,
				editor: { setText: () => {}, addToHistory: () => {} },
				ui: {
					showOverlay: (component: Component) => {
						overlays.push(component);
						return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
					},
					requestRender: () => {},
					terminal: { rows: 40 },
				},
				showStatus: () => {},
			});
			const controller = new SelectorController(ctx);
			ctx.showAdvisorFindings = filter => controller.showAdvisorFindings(filter);
			await executeBuiltinSlashCommand("/advisor findings all", { ctx });
			await executeBuiltinSlashCommand("/advisor findings all", { ctx });
			expect(overlays).toHaveLength(1);
			const overlay = overlays[0]!;
			const tree = (): NativeNode | null | undefined =>
				overlay.describe?.({
					cols: 80,
					dark: true,
					reduceMotion: false,
					supports: () => true,
					feature: () => true,
				});
			expect(tree()?.k).toBe("picker");
			expect(JSON.stringify(tree())).toContain("Token compared with ==");
			overlay.handleNativeEvent?.({ type: "action", key: "", act: "resolve", mods: [] });
			expect(session.getAdvisorFindings()[0]?.status).toBe("resolved");
			overlay.handleNativeEvent?.({ type: "action", key: "", act: "reopen", mods: [] });
			expect(session.getAdvisorFindings()[0]?.status).toBe("open");
			const persisted = session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === ADVISOR_FINDINGS_ENTRY_TYPE);
			expect(persisted.length).toBeGreaterThanOrEqual(3);
			await executeBuiltinSlashCommand("/advisor findings open", { ctx });
			expect(overlays).toHaveLength(1);
			const filtered = tree();
			expect(filtered?.k === "picker" ? filtered.p?.tab : undefined).toBe("open");
			expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(overlay);
			overlay.handleNativeEvent?.({ type: "action", key: "", act: "close", mods: [] });
			expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
			await executeBuiltinSlashCommand("/advisor findings all", { ctx });
			expect(overlays).toHaveLength(2);
		});

		async function runFindings(mode: "TUI" | "text", args: string): Promise<string> {
			const text = `/advisor findings ${args}`.trim();
			if (mode === "text") {
				let out = "";
				await executeAcpBuiltinSlashCommand(text, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: value => {
						out += value;
					},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				});
				return out;
			}
			let status = "";
			const ctx = createInteractiveModeContext({
				session,
				sessionManager: session.sessionManager,
				settings: session.settings,
				editor: { setText: () => {}, addToHistory: () => {} },
				ui: {
					showOverlay: (component: Component) => {
						status = component.render(120).join("\n");
						return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
					},
					requestRender: () => {},
					terminal: { rows: 40 },
				},
				showStatus: value => {
					status = value;
				},
				showError: () => {},
			});
			const controller = new SelectorController(ctx);
			ctx.showAdvisorFindings = filter => controller.showAdvisorFindings(filter);
			await executeBuiltinSlashCommand(text, { ctx });
			return status;
		}

		for (const mode of ["TUI", "text"] as const) {
			it(`lists, resolves, and reopens findings (${mode})`, async () => {
				const tools = enable();
				await advise(tools.get("Security"), report("security", "Token compared with ==."));
				await advise(tools.get("Correctness"), report("logic", "Wrong branch on null token."));
				session.agent.clearSteeringQueue();
				const open = await runFindings(mode, "");
				expect(open).toContain("F1 [open] concern security");
				expect(open).toContain("Token compared with ==.");
				expect(open).toContain("F2 [open] concern logic");
				expect(await runFindings(mode, "resolve f1")).toBe("Resolved F1.");
				expect(await runFindings(mode, "resolve F1")).toBe("F1 is already resolved.");
				expect(await runFindings(mode, "resolve F9")).toBe("No advisor finding F9.");
				expect(await runFindings(mode, "open")).not.toContain("F1 ");
				expect(await runFindings(mode, "all")).toContain("F1 [resolved]");
				expect(await runFindings(mode, "reopen F1")).toBe("Reopened F1.");
				expect(await runFindings(mode, "reopen F1")).toBe("F1 is already open.");
				expect(await runFindings(mode, "resolve")).toStartWith("Usage: /advisor findings");
			});
		}

		it("does not reopen a finding whose category and anchor an open finding holds", async () => {
			const tools = enable();
			await advise(tools.get("Security"), report("security", "Token compared with ==."));
			expect(await runFindings("text", "resolve F1")).toBe("Resolved F1.");
			await advise(tools.get("Security"), report("security", "Token compared with == again."));
			session.agent.clearSteeringQueue();
			expect(await runFindings("text", "reopen F1")).toBe(
				"F1 not reopened: an open finding already covers its category and anchor.",
			);
		});

		it("persists resolve and reopen across resume", async () => {
			const tools = enable();
			await advise(tools.get("Security"), report("security", "Token compared with ==."));
			await advise(tools.get("Correctness"), report("logic", "Wrong branch on null token."));
			session.agent.clearSteeringQueue();
			await runFindings("text", "resolve F1");
			await runFindings("text", "resolve F2");
			await runFindings("text", "reopen F2");
			const resumed = createSession(sessionManager);
			try {
				expect(resumed.getAdvisorFindings().map(finding => [finding.id, finding.status])).toEqual([
					["F1", "resolved"],
					["F2", "open"],
				]);
			} finally {
				await resumed.dispose();
			}
		});
	});
});
