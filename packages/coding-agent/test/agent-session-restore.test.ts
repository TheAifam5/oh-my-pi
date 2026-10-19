import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type ToolReplay } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	CRASHED_TURN_ERROR,
	planInterruptedTurnRepair,
	repairInterruptedTurn,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { localReadReplay } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(model: Model, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

const probeSchema = type({ value: "string" });

/** A tool (`probe` by default) recording each run's `value` in `executed`, with the given replay declaration. */
function probeTool(executed: string[], replay: ToolReplay | undefined, name = "probe"): AgentTool {
	const tool: AgentTool<typeof probeSchema, { value: string }> = {
		name,
		label: "Probe",
		description: "Probe tool",
		parameters: probeSchema,
		replay,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	return tool as AgentTool;
}

/**
 * A session holding `user` and then `turn`, with a start marker after the turn for each
 * call in `started`, as the write-before-execute hook leaves them when the process dies.
 */
function crashedMidTurn(user: string, turn: AssistantMessage, started: readonly string[]): SessionManager {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
	const assistantEntryId = manager.appendMessage(turn);
	for (const block of turn.content) {
		if (block.type !== "toolCall" || !started.includes(block.id)) continue;
		manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: block.id,
			toolName: block.name,
			startedAt: "2026-10-01T10:00:00.000Z",
			replay: "unsafe",
			assistantEntryId,
		});
	}
	return manager;
}

/** Warning notices `session` emits from now on. */
function collectNotices(session: AgentSession): string[] {
	const notices: string[] = [];
	session.subscribe(event => {
		if (event.type === "notice") notices.push(event.message);
	});
	return notices;
}

/** `persisted` with the records resume-time exit recovery (sdk.ts) closes its cut-off turn with. */
function closedByExitRecovery(persisted: Message[]): Message[] {
	const manager = SessionManager.inMemory();
	for (const message of persisted) manager.appendMessage(message);
	const repair = planInterruptedTurnRepair(manager.getBranch(), undefined, { assumeExit: true });
	if (!repair?.abort) throw new Error("Expected an unfinished turn to close");
	return [...persisted, ...repair.toolResults, repair.abort];
}

describe("AgentSession.restoreInterruptedTurn (omp --restore)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-restore-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** A session reopened from `persisted` as `--resume` builds it, its model answering from `responses`. */
	function reopen(
		model: Model,
		persisted: Message[] | SessionManager,
		tools: AgentTool[],
		responses: MockResponse[],
		evalToolSession?: ToolSession,
	) {
		let sessionManager: SessionManager;
		if (persisted instanceof SessionManager) sessionManager = persisted;
		else {
			sessionManager = SessionManager.inMemory();
			for (const message of persisted) sessionManager.appendMessage(message);
		}
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			evalToolSession,
		});
		session.subscribe(() => {});
		return { session, mock };
	}

	it("goes on with a turn a crash cut off mid tool call, running the cut-off replay-safe call again", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		// The process died while `probe` ran: no tool result, no session_exit record.
		const { session, mock } = reopen(
			model,
			[
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			],
			[probeTool(executed, "safe")],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "done after restore" });
	});

	it("goes on with a crash-cut turn that startup repair already closed without an exit record", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const { session, mock } = reopen(
			model,
			[
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			],
			[probeTool(executed, "safe")],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);
		// A resume without --restore (or a revived subagent) closes the crash tail at startup.
		const startup = repairInterruptedTurn(session.sessionManager);
		expect(startup?.abort?.errorMessage).toBe(CRASHED_TURN_ERROR);
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const entriesBeforeRestore = session.sessionManager.getEntries().length;

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		// The restore appended no second repair before retrying.
		const repairedEntries = session.sessionManager
			.getEntries()
			.slice(entriesBeforeRestore)
			.filter(
				entry =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
			);
		expect(repairedEntries).toEqual([]);
	});

	it("goes on with a turn exit recovery closed when the eval state snapshot follows it (#16195)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const evalToolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalSessionId: () => "restore-eval-state",
		};
		// Eval history makes the reopened session persist an eval state snapshot right
		// after the turn the previous process's exit cut off and resume recovery closed.
		const { session, mock } = reopen(
			model,
			closedByExitRecovery([
				{ role: "user", content: "eval something", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_eval", name: "eval", arguments: { code: "1" } }],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_eval",
					toolName: "eval",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: Date.now(),
				},
				assistant(model, { content: [{ type: "text", text: "evaluated" }] }),
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			]),
			[probeTool(executed, "safe")],
			[{ content: ["done after restore"], stopReason: "stop" }],
			evalToolSession,
		);
		const tail = session.sessionManager.getBranch().at(-1);
		expect(tail?.type === "custom_message" && tail.customType).toBe("eval-state-context");
		// The idle "F5 to Retry" row sees the closed turn through the snapshot too.
		expect(session.hasAbortedToolCallTail).toBe(true);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "done after restore" });
	});

	it("replays a crash-cut call when --restore skipped startup repair and the eval state snapshot already follows the tail", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const evalToolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalSessionId: () => "restore-eval-state-unrepaired",
		};
		const { session, mock } = reopen(
			model,
			[
				{ role: "user", content: "eval something", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_eval", name: "eval", arguments: { code: "1" } }],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_eval",
					toolName: "eval",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: Date.now(),
				},
				assistant(model, { content: [{ type: "text", text: "evaluated" }] }),
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			],
			[probeTool(executed, "safe")],
			[{ content: ["done after restore"], stopReason: "stop" }],
			evalToolSession,
		);
		const tail = session.sessionManager.getBranch().at(-1);
		expect(tail?.type === "custom_message" && tail.customType).toBe("eval-state-context");

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
	});

	it("does not replay a partly completed batch when an eval state snapshot sits inside it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const evalToolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalSessionId: () => "restore-eval-state-partial",
		};
		const { session, mock } = reopen(
			model,
			[
				{ role: "user", content: "eval something", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_eval", name: "eval", arguments: { code: "1" } }],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_eval",
					toolName: "eval",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: Date.now(),
				},
				assistant(model, { content: [{ type: "text", text: "evaluated" }] }),
				{ role: "user", content: "run both probes", timestamp: Date.now() },
				assistant(model, {
					content: [
						{ type: "toolCall", id: "call_done", name: "probe", arguments: { value: "done" } },
						{ type: "toolCall", id: "call_cut", name: "probe", arguments: { value: "cut" } },
					],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_done",
					toolName: "probe",
					content: [{ type: "text", text: "ok:done" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			[probeTool(executed, "safe")],
			[{ content: ["answered from the transcript"], stopReason: "stop" }],
			evalToolSession,
		);
		const tail = session.sessionManager.getBranch().at(-1);
		expect(tail?.type === "custom_message" && tail.customType).toBe("eval-state-context");

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		// Re-running the batch would repeat the completed call; the model answers instead.
		expect(executed).toEqual([]);
		expect(mock.calls.length).toBe(1);
	});

	it("does not re-run an unsafe call that started before the crash: the model sees its interrupted result and a notice names it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const { session, mock } = reopen(
			model,
			crashedMidTurn(
				"deploy",
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { value: "kubectl apply" } }],
					stopReason: "toolUse",
				}),
				["call_1"],
			),
			[probeTool(executed, "unsafe", "bash")],
			[{ content: ["answered after restore"], stopReason: "stop" }],
		);
		const notices = collectNotices(session);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual([]);
		expect(mock.calls.length).toBe(1);
		const sent = mock.calls[0]!.context.messages.at(-1);
		if (sent?.role !== "toolResult") throw new Error("Expected the interrupted result to end the request");
		expect(sent.toolCallId).toBe("call_1");
		expect(sent.content).toContainEqual({ type: "text", text: expect.stringContaining("It was not re-run") });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("bash (started)");
	});

	it("re-runs a crash-cut batch of local reads that started before the crash", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const { session, mock } = reopen(
			model,
			crashedMidTurn(
				"read the notes",
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { value: "notes.md" } }],
					stopReason: "toolUse",
				}),
				["call_1"],
			),
			[probeTool(executed, localReadReplay, "read")],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);
		const notices = collectNotices(session);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["notes.md"]);
		expect(mock.calls.length).toBe(1);
		expect(notices).toEqual([]);
	});

	it("re-runs an unsafe call the journal proves never started", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		// The read's marker names the turn, so the unmarked bash call reads as not started.
		const { session, mock } = reopen(
			model,
			crashedMidTurn(
				"read, then deploy",
				assistant(model, {
					content: [
						{ type: "toolCall", id: "call_read", name: "read", arguments: { value: "notes.md" } },
						{ type: "toolCall", id: "call_bash", name: "bash", arguments: { value: "kubectl apply" } },
					],
					stopReason: "toolUse",
				}),
				["call_read"],
			),
			[probeTool(executed, localReadReplay, "read"), probeTool(executed, "unsafe", "bash")],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect([...executed].sort()).toEqual(["kubectl apply", "notes.md"]);
		expect(mock.calls.length).toBe(1);
	});

	it("re-runs none of a batch on /retry when one of its calls is unsafe and started", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const { session, mock } = reopen(
			model,
			crashedMidTurn(
				"read, then deploy",
				assistant(model, {
					content: [
						{ type: "toolCall", id: "call_read", name: "read", arguments: { value: "notes.md" } },
						{ type: "toolCall", id: "call_bash", name: "bash", arguments: { value: "kubectl apply" } },
					],
					stopReason: "toolUse",
				}),
				["call_read", "call_bash"],
			),
			[probeTool(executed, localReadReplay, "read"), probeTool(executed, "unsafe", "bash")],
			[{ content: ["answered after retry"], stopReason: "stop" }],
		);
		// A plain resume closes the crash tail at startup; the user then runs /retry.
		repairInterruptedTurn(session.sessionManager);
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const notices = collectNotices(session);

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual([]);
		expect(mock.calls.length).toBe(1);
		const sentResults = mock.calls[0]!.context.messages.flatMap(message =>
			message.role === "toolResult" ? [message.toolCallId] : [],
		);
		expect(sentResults).toEqual(["call_read", "call_bash"]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("bash (started)");
		expect(notices[0]).not.toContain("read");
	});

	it("does not re-run a crash-cut call whose tool is no longer registered", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const { session, mock } = reopen(
			model,
			crashedMidTurn(
				"run the removed tool",
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "gone", arguments: { value: "x" } }],
					stopReason: "toolUse",
				}),
				[],
			),
			[probeTool(executed, "safe")],
			[{ content: ["answered after restore"], stopReason: "stop" }],
		);
		const notices = collectNotices(session);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(1);
		const sent = mock.calls[0]!.context.messages.at(-1);
		if (sent?.role !== "toolResult") throw new Error("Expected the interrupted result to end the request");
		expect(sent.content).toContainEqual({ type: "text", text: expect.stringContaining("It was not re-run") });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("gone (tool unavailable)");
	});

	it("shortens an oversized model-chosen tool name in the refusal notice to one bounded line", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const toolName = `${"x".repeat(10)}\n${"y".repeat(5_000)}`;
		const { session } = reopen(
			model,
			crashedMidTurn(
				"run the removed tool",
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: toolName, arguments: { value: "x" } }],
					stopReason: "toolUse",
				}),
				[],
			),
			[probeTool([], "safe")],
			[{ content: ["answered after restore"], stopReason: "stop" }],
		);
		const notices = collectNotices(session);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(`${"x".repeat(10)} ${"y".repeat(52)}… (tool unavailable)`);
		expect(notices[0]).not.toContain("y".repeat(53));
		expect(notices[0]!.length).toBeLessThan(256);
		expect(notices[0]).not.toMatch(/[\r\n]/);
	});

	it("leaves a turn the user interrupted, and one that finished, as they are", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const interrupted: Message[] = [
			{ role: "user", content: "run the probe", timestamp: Date.now() },
			assistant(model, {
				content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "x" } }],
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "probe",
				content: [{ type: "text", text: "Execution interrupted" }],
				isError: true,
				timestamp: Date.now(),
			},
			assistant(model, { stopReason: "aborted", errorMessage: "Interrupted by user" }),
		];
		const finished: Message[] = [
			{ role: "user", content: "say hi", timestamp: Date.now() },
			assistant(model, { content: [{ type: "text", text: "hi" }] }),
		];
		for (const persisted of [interrupted, finished]) {
			const { session, mock } = reopen(model, persisted, [], []);
			await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			expect(mock.calls.length).toBe(0);
			await session.dispose();
		}
		session = undefined;
	});
});
