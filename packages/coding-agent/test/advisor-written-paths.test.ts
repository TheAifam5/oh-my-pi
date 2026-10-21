import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ReadTool, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type AdviseParams, AdviseTool, type AdvisorCategory } from "../src/advisor";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const CATEGORIES: AdvisorCategory[] = [{ id: "logic", description: "Correctness.", owner: "Correctness" }];
const ROSTER: AdvisorConfig[] = [{ name: "Correctness" }];
const editParams = type({ path: "string" });

describe("advisor relative anchors after primary writes", () => {
	let authStorage: AuthStorage;
	let tempDir: TempDir;
	let repo: string;
	let worktree: string;
	let session: AgentSession;
	let primaryResponses: MockResponse[];
	let editInWorktree: MockResponse;
	let defects = 0;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-written-paths-");
		repo = path.join(tempDir.path(), "repo");
		worktree = path.join(tempDir.path(), "worktree");
		await Bun.write(path.join(repo, "a", "b.ts"), "one\ntwo\nmain line\n");
		const git = (...args: string[]) =>
			Bun.$`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`.cwd(repo).quiet();
		await git("init", "-q");
		await git("add", ".");
		await git("commit", "-qm", "init");
		await git("worktree", "add", "-q", worktree);
		await Bun.write(path.join(worktree, "a", "b.ts"), "one\ntwo\nworktree line\n");
		editInWorktree = {
			content: [{ type: "toolCall", name: "edit", arguments: { path: path.join(worktree, "a", "b.ts") } }],
		};

		primaryResponses = [];
		const primaryMock = createMockModel({
			provider: "anthropic",
			handler: () => primaryResponses.shift() ?? { content: ["done"] },
		});
		const advisorMock = createMockModel({ provider: "anthropic", handler: { content: ["Reviewed."] } });
		const editTool: AgentTool<typeof editParams> = {
			name: "edit",
			label: "Edit",
			description: "Mock edit tool",
			parameters: editParams,
			execute: async (_id, params) => ({
				content: [{ type: "text", text: "edited" }],
				details: { path: params.path },
			}),
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "off",
			"advisor.immuneTurns": 0,
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			"todo.enabled": false,
			"tools.approvalMode": "yolo",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const sessionManager = SessionManager.inMemory(repo);
		const toolSession: ToolSession = {
			cwd: repo,
			hasUI: false,
			settings,
			sessionManager,
			getSessionId: () => sessionManager.getSessionId(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const readTool: Tool = new ReadTool(toolSession);
		const toolContext = { settings } as unknown as AgentToolContext;
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [editTool] },
				streamFn: primaryMock.stream,
			}),
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [readTool],
			advisorGetToolContext: () => toolContext,
			advisorStreamFn: advisorMock.stream,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		session.applyAdvisorConfigs(ROSTER, undefined, undefined, CATEGORIES);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		await tempDir?.remove().catch(() => {});
	});

	/** Host anchor identity the session records for a `logic` finding anchored at `anchorPath`. */
	async function identityOf(anchorPath: string): Promise<string> {
		const tool = session.getAdvisorAgents()[0]?.state.tools?.find(candidate => candidate.name === "advise");
		if (!(tool instanceof AdviseTool)) throw new Error("Expected advise tool");
		const defect = `Defect ${++defects}.`;
		const params: AdviseParams = {
			kind: "defect",
			category: "logic",
			where: { type: "file", path: anchorPath },
			defect,
			severity: "nit",
		};
		session.agent.state.isStreaming = true;
		try {
			await tool.execute("call", params);
		} finally {
			session.agent.clearSteeringQueue();
			session.yieldQueue.drainLazy();
			session.agent.state.isStreaming = false;
		}
		const finding = session.getAdvisorFindings().find(f => f.reports.some(report => report.defect === defect));
		if (!finding) throw new Error(`Expected a finding for ${defect}`);
		return finding.identity;
	}

	async function primaryTurn(prompt: string, responses: MockResponse[] = []): Promise<void> {
		primaryResponses.push(...responses);
		await session.prompt(prompt);
		await session.waitForAdvisorCatchup(2_000);
	}

	async function anchorIdentities(): Promise<{ worktree: string; cwd: string }> {
		const identities = {
			worktree: await identityOf(`${path.join(worktree, "a", "b.ts")}:3`),
			cwd: await identityOf(`${path.join(repo, "a", "b.ts")}:3`),
		};
		expect(identities.worktree).not.toBe(identities.cwd);
		return identities;
	}

	it("resolves a relative anchor into the worktree the primary edited, also after compaction", async () => {
		await primaryTurn("edit b.ts in the worktree", [editInWorktree]);
		const expected = await anchorIdentities();
		expect(await identityOf("a/b.ts:3")).toBe(expected.worktree);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: "compacted",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: {},
		}));
		await primaryTurn("second request");
		await session.compact();
		expect(compactSpy).toHaveBeenCalled();
		expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);

		expect(await identityOf("a/b.ts:3")).toBe(expected.worktree);
	});

	it("resolves a relative anchor against cwd after the session id changes", async () => {
		await primaryTurn("edit b.ts in the worktree", [editInWorktree]);
		const expected = await anchorIdentities();
		expect(await identityOf("a/b.ts:3")).toBe(expected.worktree);

		const previousSessionId = session.sessionManager.getSessionId();
		expect(await session.newSession()).toBe(true);
		expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
		expect(await identityOf("a/b.ts:3")).toBe(expected.cwd);

		await primaryTurn("first request in the new session");
		expect(await identityOf("a/b.ts:3")).toBe(expected.cwd);
	});
});
