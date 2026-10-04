import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	type InterruptedToolResultDetails,
	planInterruptedTurnRepair,
	repairInterruptedTurn,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL = { api: "anthropic-messages", provider: "anthropic", model: "mock" } as const;

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", content, ...MODEL, usage: USAGE, stopReason, timestamp: Date.now() };
}

const twoCalls = assistant(
	[
		{ type: "toolCall", id: "call_started", name: "bash", arguments: { command: "make deploy" } },
		{ type: "toolCall", id: "call_queued", name: "write", arguments: { path: "notes.md", content: "x" } },
	],
	"toolUse",
);

function result(toolCallId: string, toolName: string, details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

/** Start marker as the write-before-execute hook writes it; omit `assistantEntryId` for a pre-journaling writer. */
function startMarker(manager: SessionManager, toolCallId: string, toolName: string, assistantEntryId?: string): void {
	manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
		toolCallId,
		toolName,
		startedAt: "2026-10-01T10:00:00.000Z",
		args: { command: "make deploy" },
		replay: "unsafe",
		...(assistantEntryId ? { assistantEntryId } : {}),
	});
}

function messages(entries: readonly SessionEntry[]) {
	return entries.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

function resultsFor(entries: readonly SessionEntry[], toolCallId: string): ToolResultMessage[] {
	return messages(entries).filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
}

function text(message: ToolResultMessage): string {
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

describe("interrupted turn repair", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("closes a crashed tool turn with started and not-started results, then stays idempotent", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		startMarker(manager, "call_started", "bash", manager.appendMessage(twoCalls));

		const repair = repairInterruptedTurn(manager);
		expect(repair?.toolResults.map(message => message.toolCallId)).toEqual(["call_started", "call_queued"]);

		const branch = manager.getBranch();
		const [started] = resultsFor(branch, "call_started");
		const [queued] = resultsFor(branch, "call_queued");
		expect(started?.isError).toBe(true);
		expect(started?.details).toMatchObject({
			__interrupted: true,
			execution: "started",
			resumed: true,
			startedAt: "2026-10-01T10:00:00.000Z",
			args: { command: "make deploy" },
			replay: "unsafe",
		} satisfies InterruptedToolResultDetails);
		expect(text(started!)).toContain("after this tool started (2026-10-01T10:00:00.000Z)");
		expect(text(started!)).toContain("outcome is unknown");
		expect(text(started!)).toContain("make deploy");
		expect(queued?.details).toMatchObject({ __interrupted: true, execution: "not_started", resumed: true });
		expect(text(queued!)).toContain("before this tool started; it was not executed");

		const tail = messages(branch).at(-1);
		expect(tail).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] });
		expect((tail as AssistantMessage).errorMessage).toContain("without a shutdown record");

		expect(repairInterruptedTurn(manager)).toBeUndefined();
		expect(resultsFor(manager.getBranch(), "call_started")).toHaveLength(1);
		expect(resultsFor(manager.getBranch(), "call_queued")).toHaveLength(1);
	});

	it("reports an unmarked call as unknown when the turn has no journaled marker", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		manager.appendMessage(twoCalls);
		// A pre-journaling writer appended the marker after the tool had already started.
		startMarker(manager, "call_started", "bash");

		const repair = planInterruptedTurnRepair(manager.getBranch());
		expect(repair?.toolResults.map(message => message.details?.execution)).toEqual(["started", "unknown"]);
		expect(text(repair!.toolResults[1]!)).toContain("whether it started is unknown");
	});

	it("pairs a speculative start journaled before its assistant entry with the call", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "call_queued",
			toolName: "write",
			startedAt: "2026-10-01T09:59:59.000Z",
			replay: "unsafe",
			speculative: true,
		});
		startMarker(manager, "call_started", "bash", manager.appendMessage(twoCalls));

		const repair = planInterruptedTurnRepair(manager.getBranch());
		expect(repair?.toolResults.map(message => [message.toolCallId, message.details?.execution])).toEqual([
			["call_started", "started"],
			["call_queued", "started"],
		]);
		expect(repair?.toolResults[1]?.details?.startedAt).toBe("2026-10-01T09:59:59.000Z");
	});

	it("does not let a marker for a call outside the turn vouch for the turn's unmarked calls", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		startMarker(manager, "call_foreign", "bash", manager.appendMessage(twoCalls));

		const repair = planInterruptedTurnRepair(manager.getBranch());
		expect(repair?.toolResults.map(message => message.details?.execution)).toEqual(["unknown", "unknown"]);
	});

	it("never reports not_started once the run's journal stalled", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		const assistantEntryId = manager.appendMessage(
			assistant(
				[
					{ type: "toolCall", id: "call_a", name: "bash", arguments: { command: "a" } },
					{ type: "toolCall", id: "call_b", name: "bash", arguments: { command: "b" } },
					{ type: "toolCall", id: "call_c", name: "bash", arguments: { command: "c" } },
				],
				"toolUse",
			),
		);
		startMarker(manager, "call_a", "bash", assistantEntryId);
		// The journal stalled after A: B's marker says so, and C never ran.
		manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "call_b",
			toolName: "bash",
			startedAt: "2026-10-01T10:00:03.000Z",
			assistantEntryId,
			journal: "degraded",
		});

		const repair = planInterruptedTurnRepair(manager.getBranch());
		expect(repair?.toolResults.map(message => [message.toolCallId, message.details?.execution])).toEqual([
			["call_a", "started"],
			["call_b", "started"],
			["call_c", "unknown"],
		]);
	});

	it("bounds a marker time to an ISO string, ignoring unparsable or oversized input", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		const assistantEntryId = manager.appendMessage(twoCalls);
		manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "call_started",
			toolName: "bash",
			startedAt: `2026-10-01T10:00:00.000Z${"x".repeat(1_000_000)}`,
			assistantEntryId: "../../not-an-id",
			replay: "maybe",
		});

		const [started] = planInterruptedTurnRepair(manager.getBranch())?.toolResults ?? [];
		const startedAt = started?.details?.startedAt ?? "";
		expect(startedAt).toBe(new Date(Date.parse(startedAt)).toISOString());
		expect(text(started!).length).toBeLessThan(500);
		expect(started?.details?.replay).toBeUndefined();
		// The rejected entry id cannot vouch, so the unmarked call stays unknown.
		expect(assistantEntryId).toMatch(/^[a-f0-9-]+$/);
		expect(planInterruptedTurnRepair(manager.getBranch())?.toolResults[1]?.details?.execution).toBe("unknown");
	});

	it("plans nothing for a tail with malformed content instead of throwing", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		manager.appendMessage({ ...twoCalls, content: "x" as unknown as AssistantMessage["content"] });

		expect(planInterruptedTurnRepair(manager.getBranch(), MODEL)).toBeUndefined();
	});

	it("pairs only the calls still missing a result", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		startMarker(manager, "call_started", "bash", manager.appendMessage(twoCalls));
		manager.appendMessage(result("call_started", "bash"));

		const repair = planInterruptedTurnRepair(manager.getBranch());
		expect(repair?.toolResults.map(message => message.toolCallId)).toEqual(["call_queued"]);
		expect(repair?.abort).toMatchObject({ stopReason: "aborted" });
	});

	it("aborts a fully paired tool-result tail without adding results", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		manager.appendMessage(twoCalls);
		manager.appendMessage(result("call_started", "bash"));
		manager.appendMessage(result("call_queued", "write"));

		const repair = planInterruptedTurnRepair(manager.getBranch());
		expect(repair?.toolResults).toEqual([]);
		expect(repair?.abort).toMatchObject({ stopReason: "aborted" });
	});

	it("aborts a user tail only once model metadata is available", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });

		expect(planInterruptedTurnRepair(manager.getBranch())).toBeUndefined();
		expect(planInterruptedTurnRepair(manager.getBranch(), MODEL)?.abort).toMatchObject({
			...MODEL,
			stopReason: "aborted",
		});
	});

	it("uses session_exit as a hint: a graceful exit plans nothing, an abnormal one keeps its wording", () => {
		const graceful = SessionManager.inMemory();
		graceful.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		graceful.appendMessage(twoCalls);
		graceful.appendMessage(result("call_started", "bash"));
		graceful.appendMessage(result("call_queued", "write"));
		graceful.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: "2026-10-01T10:00:01.000Z",
		});
		expect(planInterruptedTurnRepair(graceful.getBranch())).toBeUndefined();

		const signalled = SessionManager.inMemory();
		signalled.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		signalled.appendMessage(twoCalls);
		signalled.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "SIGTERM",
			kind: "signal",
			recordedAt: "2026-10-01T10:00:01.000Z",
		});
		const repair = planInterruptedTurnRepair(signalled.getBranch());
		// No marker names the turn, so an unmarked call may have started under a pre-journaling writer.
		expect(repair?.toolResults.map(message => message.details?.execution)).toEqual(["unknown", "unknown"]);
		expect(repair?.abort?.errorMessage).toBe("Previous OMP process exited before completing the turn.");
		expect(repair?.abort?.timestamp).toBe(Date.parse("2026-10-01T10:00:01.000Z"));
	});

	it("leaves settled tails alone", () => {
		const yieldTail = SessionManager.inMemory();
		yieldTail.appendMessage({ role: "user", content: "summarize", timestamp: Date.now() });
		yieldTail.appendMessage(assistant([{ type: "toolCall", id: "y1", name: "yield", arguments: {} }], "toolUse"));
		yieldTail.appendMessage(result("y1", "yield", { status: "success" }));

		const forkedTail = SessionManager.inMemory();
		forkedTail.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		forkedTail.appendMessage(assistant([twoCalls.content[0]!], "toolUse"));
		forkedTail.appendMessage(
			result("call_started", "bash", { __synthetic: true, source: "assistant_stop_aborted", executed: false }),
		);

		const failedTurn = SessionManager.inMemory();
		failedTurn.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		failedTurn.appendMessage({ ...twoCalls, stopReason: "aborted" });
		failedTurn.appendMessage(result("call_started", "bash"));
		failedTurn.appendMessage(result("call_queued", "write"));

		const bashTail = SessionManager.inMemory();
		bashTail.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		bashTail.appendMessage(assistant([{ type: "text", text: "done" }], "stop"));
		bashTail.appendMessage({
			role: "bashExecution",
			command: "ls",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});

		for (const manager of [yieldTail, forkedTail, failedTurn, bashTail]) {
			expect(planInterruptedTurnRepair(manager.getBranch(), MODEL)).toBeUndefined();
		}
	});

	it("pairs the dangling calls of a failed assistant turn without appending another abort", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		manager.appendMessage({ ...twoCalls, stopReason: "error", errorMessage: "stream reset" });

		const repair = planInterruptedTurnRepair(manager.getBranch(), MODEL);
		expect(repair?.toolResults.map(message => message.toolCallId)).toEqual(["call_started", "call_queued"]);
		expect(repair?.abort).toBeUndefined();
	});

	it("finishes a torn repair: results already written, abort missing", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		manager.appendMessage(twoCalls);
		const firstPass = planInterruptedTurnRepair(manager.getBranch());
		for (const message of firstPass?.toolResults ?? []) manager.appendMessage(message);

		const secondPass = repairInterruptedTurn(manager);
		expect(secondPass?.toolResults).toEqual([]);
		expect(secondPass?.abort).toMatchObject({ stopReason: "aborted" });
		expect(resultsFor(manager.getBranch(), "call_queued")).toHaveLength(1);
	});

	it("closes a copy separated from a session another live process owns, leaving the original untouched", async () => {
		tempDir = TempDir.createSync("@pi-interrupted-turn-owned-");
		const writer = SessionManager.create(tempDir.path(), tempDir.path());
		writer.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		startMarker(writer, "call_started", "bash", writer.appendMessage(twoCalls));
		writer.flushSync();
		const sessionFile = writer.getSessionFile()!;
		await writer.close();
		const originalBytes = fs.readFileSync(sessionFile, "utf8");

		/** File storage whose ownership lease is always held by another process. */
		class ClaimedElsewhereStorage extends FileSessionStorage {
			override claimSession(_sessionId: string, _sessionPath: string): (() => void) | null {
				return null;
			}
		}
		const observer = await SessionManager.open(sessionFile, tempDir.path(), new ClaimedElsewhereStorage());
		try {
			const repair = repairInterruptedTurn(observer);
			// The live session may still start or finish these calls, so nothing here claims either.
			expect(repair?.toolResults.map(message => message.details?.execution)).toEqual(["unknown", "unknown"]);
			expect(text(repair!.toolResults[0]!)).toContain("separated from a live OMP session");
			expect(repair?.abort?.errorMessage).toContain("the turn continues there");
			await observer.flush();
			const copy = observer.getSessionFile();
			expect(copy).not.toBe(sessionFile);
			const copied = fs.readFileSync(copy!, "utf8");
			expect(copied).toContain("separated from a live OMP session");
		} finally {
			await observer.close();
		}
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(originalBytes);
	});

	it("appends nothing while another session manager in this process holds the session", async () => {
		tempDir = TempDir.createSync("@pi-interrupted-turn-in-process-");
		const live = SessionManager.create(tempDir.path(), tempDir.path());
		live.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		live.appendMessage(twoCalls);
		live.flushSync();
		const sessionFile = live.getSessionFile()!;
		const resumed = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const before = resumed.getEntries().length;
			expect(repairInterruptedTurn(resumed)).toBeUndefined();
			expect(resumed.getEntries()).toHaveLength(before);
		} finally {
			await resumed.close();
			await live.close();
		}
	});

	it("repairs a session file whose last line was torn by the crash", async () => {
		tempDir = TempDir.createSync("@pi-interrupted-turn-");
		const writer = SessionManager.create(tempDir.path(), tempDir.path());
		writer.appendMessage({ role: "user", content: "deploy", timestamp: Date.now() });
		startMarker(writer, "call_started", "bash", writer.appendMessage(twoCalls));
		writer.flushSync();
		const sessionFile = writer.getSessionFile()!;
		await writer.close();
		fs.appendFileSync(sessionFile, '{"type":"message","id":"torn","parentId":');

		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const repair = repairInterruptedTurn(reopened);
			expect(repair?.toolResults.map(message => message.details?.execution)).toEqual(["started", "not_started"]);
			await reopened.flush();
		} finally {
			await reopened.close();
		}
		const verified = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const branch = verified.getBranch();
			expect(resultsFor(branch, "call_started")).toHaveLength(1);
			expect(resultsFor(branch, "call_queued")).toHaveLength(1);
			expect(messages(branch).at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
			expect(planInterruptedTurnRepair(branch)).toBeUndefined();
		} finally {
			await verified.close();
		}
	});
});
