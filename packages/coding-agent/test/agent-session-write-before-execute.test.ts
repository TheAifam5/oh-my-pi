import { afterEach, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type } from "@oh-my-pi/omptype";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	planInterruptedTurnRepair,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Deferred-publish storage whose writes stay unconfirmed until the test releases them. */
class GatedPublishStorage extends MemorySessionStorage {
	readonly defersSyncPublish = true;
	readonly #gate = Promise.withResolvers<void>();
	released = false;

	release(): void {
		this.released = true;
		this.#gate.resolve();
	}

	async confirmWrites(_path: string): Promise<void> {
		await this.#gate.promise;
	}

	override async drain(): Promise<void> {
		await this.#gate.promise;
	}
}

let session: AgentSession | undefined;
let storage: GatedPublishStorage | undefined;
let tempDir: TempDir | undefined;

afterEach(async () => {
	storage?.release();
	await session?.dispose();
	session = undefined;
	storage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
	vi.restoreAllMocks();
});

/** A tool stub; read-tier stubs declare `replay: "safe"`, since replay safety is never inferred from the tier. */
function probeTool(
	name: string,
	approval: AgentTool["approval"],
	onExecute: (toolCallId: string) => void,
	concurrency?: AgentTool["concurrency"],
): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		approval,
		replay: approval === "read" ? "safe" : undefined,
		concurrency,
		execute: async toolCallId => {
			onExecute(toolCallId);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

function createSession(
	sessionManager: SessionManager,
	tools: AgentTool[],
	settings: Record<string, unknown>,
): AgentSession {
	const responses: MockResponse[] = [
		{
			content: tools.map(tool => ({
				type: "toolCall" as const,
				id: `call_${tool.name}`,
				name: tool.name,
				arguments: {},
			})),
			stopReason: "toolUse",
		},
	];
	const mock = createMockModel({ handler: () => responses.shift() ?? { content: ["done"], stopReason: "stop" } });
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	return new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, ...settings }),
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
}

it("starts a tool only after its assistant entry and start marker are confirmed by session storage", async () => {
	storage = new GatedPublishStorage();
	const gated = storage;
	const sessionManager = SessionManager.create("/project", "/sessions", gated);
	const startedWhileUnconfirmed: string[] = [];
	const executed: string[] = [];
	const onExecute = (toolCallId: string) => {
		if (!gated.released) startedWhileUnconfirmed.push(toolCallId);
		executed.push(toolCallId);
	};
	session = createSession(
		sessionManager,
		[probeTool("probe_exec", undefined, onExecute), probeTool("probe_read", "read", onExecute)],
		{},
	);

	const run = session.prompt("go");
	// Give the loop ample time to reach dispatch while storage withholds confirmation.
	for (let tick = 0; tick < 20 && executed.length === 0; tick++) await Bun.sleep(10);
	expect(executed).toEqual([]);
	gated.release();
	await run;

	expect(executed.sort()).toEqual(["call_probe_exec", "call_probe_read"]);
	expect(startedWhileUnconfirmed).toEqual([]);

	const entries = sessionManager.getEntries();
	const assistantEntry = entries.find(
		entry =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			(entry.message as AssistantMessage).content.some(part => part.type === "toolCall"),
	);
	if (!assistantEntry) throw new Error("Expected the tool-call assistant entry");
	const markers = entries.flatMap(entry =>
		entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE
			? [{ index: entries.indexOf(entry), data: entry.data as ToolExecutionStartData }]
			: [],
	);
	expect(markers.map(marker => [marker.data.toolCallId, marker.data.replay]).sort()).toEqual([
		["call_probe_exec", "unsafe"],
		["call_probe_read", "safe"],
	]);
	for (const marker of markers) {
		expect(marker.data.assistantEntryId).toBe(assistantEntry.id);
		expect(marker.index).toBeGreaterThan(entries.indexOf(assistantEntry));
	}
});

it("with session.fsyncUnsafeTools, fsyncs the session file before an unsafe tool and not before a replay-safe one", async () => {
	tempDir = TempDir.createSync("@pi-fsync-unsafe-");
	const fileStorage = new FileSessionStorage();
	const fsyncSpy = vi.spyOn(fileStorage, "fsyncSync");
	const fsyncsAtExecute = new Map<string, number>();
	const onExecute = (toolCallId: string) => fsyncsAtExecute.set(toolCallId, fsyncSpy.mock.calls.length);
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path(), fileStorage);
	session = createSession(
		sessionManager,
		[probeTool("probe_exec", undefined, onExecute), probeTool("probe_read", "read", onExecute)],
		{ "session.fsyncUnsafeTools": true },
	);

	await session.prompt("go");

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	expect(fsyncSpy.mock.calls).toEqual([[sessionFile]]);
	expect(fsyncsAtExecute.get("call_probe_exec")).toBe(1);
});

it("stops waiting on a stalled journal after one budget for the rest of the run", async () => {
	storage = new GatedPublishStorage();
	const sessionManager = SessionManager.create("/project", "/sessions", storage);
	const warn = vi.spyOn(logger, "warn");
	const executed: string[] = [];
	const onExecute = (toolCallId: string) => executed.push(toolCallId);
	session = createSession(
		sessionManager,
		["one", "two", "three"].map(name => probeTool(`probe_${name}`, undefined, onExecute, "exclusive")),
		{},
	);

	const startedAt = Date.now();
	await session.prompt("go");
	const elapsed = Date.now() - startedAt;

	expect(executed).toEqual(["call_probe_one", "call_probe_two", "call_probe_three"]);
	// One 2 s budget for the whole run, not one per exclusive call.
	expect(elapsed).toBeLessThan(3_500);
	expect(warn.mock.calls.filter(([message]) => String(message).startsWith("Session journal stalled"))).toHaveLength(1);
	// Markers still land after the assistant entry even though confirmation never came.
	const entries = sessionManager.getEntries();
	const assistantIndex = entries.findIndex(
		entry =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			(entry.message as AssistantMessage).content.some(part => part.type === "toolCall"),
	);
	const markerIndexes = entries.flatMap((entry, index) =>
		entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE ? [index] : [],
	);
	expect(markerIndexes).toHaveLength(3);
	for (const index of markerIndexes) expect(index).toBeGreaterThan(assistantIndex);
});

it("an abort while waiting on the journal keeps the tool from starting", async () => {
	storage = new GatedPublishStorage();
	const sessionManager = SessionManager.create("/project", "/sessions", storage);
	const executed: string[] = [];
	const current = createSession(
		sessionManager,
		[probeTool("probe_exec", undefined, toolCallId => executed.push(toolCallId))],
		{},
	);
	session = current;

	const run = current.prompt("go");
	const deadline = Date.now() + 1_500;
	while (
		!sessionManager
			.getEntries()
			.some(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE)
	) {
		if (Date.now() > deadline) throw new Error("tool never reached its journal wait");
		await Bun.sleep(5);
	}
	const abortedAt = Date.now();
	await current.abort();
	await run.catch(() => {});

	expect(executed).toEqual([]);
	expect(Date.now() - abortedAt).toBeLessThan(1_500);
});

/** Memory storage whose incremental appends fail, as on a full disk; full rewrites still succeed. */
class FailingAppendStorage extends MemorySessionStorage {
	override openWriter(): SessionStorageWriter {
		let error: Error | undefined;
		let open = true;
		const fail = (): never => {
			error ??= new Error("ENOSPC: no space left on device");
			throw error;
		};
		return {
			appendSync: () => fail(),
			append: async () => fail(),
			flush: async () => {
				if (error) throw error;
			},
			flushSync: () => {
				if (error) throw error;
			},
			isOpen: () => open,
			close: async () => {
				open = false;
			},
			getError: () => error,
		};
	}
}

/** Memory storage that rejects every write, as in a read-only session directory, so the failure stays latched. */
class UnwritableStorage extends FailingAppendStorage {
	override writeTextSync(): void {
		throw new Error("EROFS: read-only file system");
	}
}

it("by default runs an unsafe tool on a failing journal, and resume never reports a later call as not started", async () => {
	const sessionManager = SessionManager.create("/project", "/sessions", new FailingAppendStorage());
	const executed: string[] = [];
	let branchWhileRunning: SessionEntry[] = [];
	const onExecute = (toolCallId: string) => {
		executed.push(toolCallId);
		// The branch a crash during the first call would leave behind.
		if (toolCallId === "call_probe_first") branchWhileRunning = [...sessionManager.getBranch()];
	};
	session = createSession(
		sessionManager,
		[
			probeTool("probe_first", undefined, onExecute, "exclusive"),
			probeTool("probe_second", undefined, onExecute, "exclusive"),
		],
		{},
	);

	await session.prompt("go");

	expect(executed).toEqual(["call_probe_first", "call_probe_second"]);
	const repair = planInterruptedTurnRepair(branchWhileRunning);
	const executionById = new Map(repair?.toolResults.map(result => [result.toolCallId, result.details?.execution]));
	expect(executionById.get("call_probe_first")).toBe("started");
	expect(executionById.get("call_probe_second")).toBe("unknown");
	// The failing storage can also reject disposal's final flush, which is not this contract.
	const current = session;
	session = undefined;
	await current.dispose().catch(() => {});
});

it("with session.refuseUnsafeToolsWithoutJournal, refuses an unsafe tool on a failing journal but runs replay-safe tools, yield, and ask", async () => {
	const sessionManager = SessionManager.create("/project", "/sessions", new UnwritableStorage());
	const executed: string[] = [];
	const onExecute = (toolCallId: string) => executed.push(toolCallId);
	session = createSession(
		sessionManager,
		[
			probeTool("probe_unsafe", undefined, onExecute, "exclusive"),
			probeTool("probe_safe", "read", onExecute, "exclusive"),
			probeTool("ask", undefined, onExecute, "exclusive"),
			probeTool("yield", undefined, onExecute, "exclusive"),
		],
		{ "session.refuseUnsafeToolsWithoutJournal": true },
	);

	await session.prompt("go");

	expect(executed).toEqual(["call_probe_safe", "call_ask", "call_yield"]);
	const refused = sessionManager
		.getEntries()
		.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []))
		.find(message => message.toolCallId === "call_probe_unsafe");
	expect(refused?.isError).toBe(true);
	const refusalText = JSON.stringify(refused?.content);
	expect(refusalText).toContain("refusing to start probe_unsafe");
	// The storage error stays in the log; it may name local paths.
	expect(refusalText).not.toContain("EROFS");
	// The failing storage also rejects disposal's final flush, which is not this contract.
	const current = session;
	session = undefined;
	await current.dispose().catch(() => {});
});
