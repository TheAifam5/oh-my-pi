import type { AgentMessage, ToolReplayClass } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

export const TOOL_EXECUTION_START_CUSTOM_TYPE = "tool_execution_start";
export const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

/**
 * Custom entry types core crash recovery reads as evidence. Extensions must
 * not write them: a forged marker or exit record would change what resume
 * reports about an interrupted turn.
 */
const RESERVED_RECOVERY_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	SESSION_EXIT_CUSTOM_TYPE,
]);

/** Throws when an extension tries to append a custom entry type reserved for crash recovery. */
export function assertExtensionCustomEntryType(customType: string): void {
	if (RESERVED_RECOVERY_CUSTOM_TYPES.has(customType)) {
		throw new Error(`Custom entry type "${customType}" is reserved for session crash recovery.`);
	}
}

/**
 * Compact projection of tool-call arguments persisted with the start marker.
 * The assistant message already carries the full arguments; this exists only
 * so `appendArgumentSummary` can name the command/path in resume warnings
 * without duplicating whole argument payloads into the session JSONL.
 */
export interface ToolArgumentSummary {
	command?: string;
	path?: string;
}

/**
 * Persisted marker written before a tool implementation starts running.
 *
 * When `assistantEntryId` is present, the marker was appended after that
 * assistant entry and before the tool started. Markers without it come from
 * writers that did not order the two, or from speculative execution, which
 * starts before the assistant entry exists and so precedes it on the branch.
 */
export interface ToolExecutionStartData {
	toolCallId: string;
	toolName: string;
	args?: ToolArgumentSummary;
	intent?: string;
	startedAt: string;
	/** Replay class resolved from the tool when the call started. */
	replay?: ToolReplayClass;
	/** Session entry id of the assistant message that requested the call. */
	assistantEntryId?: string;
	/** Written when speculative execution started the call while the model was still streaming. */
	speculative?: true;
	/**
	 * Set when the journal could not prove write-before-execute for this run:
	 * `"degraded"` after a wait gave up or a journal step failed, `"deferred"`
	 * on storage that confirms appends later, `"failed"` for a tombstone
	 * written after journaling threw. Any such marker in a turn makes its
	 * unmarked calls `"unknown"` instead of `"not_started"`.
	 */
	journal?: ToolJournalCondition;
}

/** Why a start marker cannot vouch for the write-before-execute order of its run. */
export type ToolJournalCondition = "degraded" | "deferred" | "failed";

/** Session entry ids are short random hex or Snowflake ids; anything else in a marker is ignored. */
const ENTRY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** ISO form of a persisted time string, or `undefined` when it does not parse. */
function normalizeIsoTime(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 64) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** Tool call left without a matching toolResult at the end of a branch. */
export interface PendingToolCallDiagnostic {
	toolCallId?: string;
	toolName: string;
	args?: unknown;
	intent?: string;
	assistantTimestamp?: number;
	startedAt?: string;
	replay?: ToolReplayClass;
}

/** Details carried by a tool result written on resume for a call the previous process never finished. */
export interface InterruptedToolResultDetails {
	__interrupted: true;
	/**
	 * `"started"` when a start marker exists for the call. `"not_started"` only
	 * when the turn was journaled before execution (another call of the same
	 * turn has a marker naming the assistant entry), which proves an unmarked
	 * call never ran. `"unknown"` otherwise: sessions written before start
	 * journaling, or an exit before the turn's first marker.
	 */
	execution: "started" | "not_started" | "unknown";
	resumed: true;
	startedAt?: string;
	args?: ToolArgumentSummary;
	replay?: ToolReplayClass;
}

/** Records a resume must append to close an interrupted turn, in append order. */
export interface InterruptedTurnRepair {
	/** One result per call of the interrupted assistant turn that has no result yet. */
	toolResults: ToolResultMessage<InterruptedToolResultDetails>[];
	/** Terminal aborted assistant record; absent when the turn is already closed or no model metadata exists. */
	abort?: AssistantMessage;
}

/** Session shutdown marker written during normal and fatal process teardown. */
export interface SessionExitData {
	reason: string;
	kind: "normal" | "signal" | "fatal" | "process_exit";
	recordedAt: string;
	pendingToolCalls?: PendingToolCallDiagnostic[];
}

interface PendingToolCallRecord extends PendingToolCallDiagnostic {
	key: string;
}

interface ToolCallContent {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: unknown;
}

export interface AssistantModelMetadata {
	api: AssistantMessage["api"];
	provider: string;
	model: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object") return false;
	return value !== null;
}
function isPendingToolCallDiagnostic(value: unknown): value is PendingToolCallDiagnostic {
	if (!isObject(value) || typeof value.toolName !== "string") return false;
	if ("toolCallId" in value && typeof value.toolCallId !== "string") return false;
	if ("intent" in value && typeof value.intent !== "string") return false;
	if ("assistantTimestamp" in value && typeof value.assistantTimestamp !== "number") return false;
	if ("startedAt" in value && typeof value.startedAt !== "string") return false;
	if ("replay" in value && value.replay !== "safe" && value.replay !== "unsafe") return false;
	return true;
}

function readPendingToolCalls(value: unknown): PendingToolCallDiagnostic[] | undefined {
	if (!Array.isArray(value) || !value.every(isPendingToolCallDiagnostic)) return undefined;
	return value;
}

function readSessionExit(entry: SessionEntry): SessionExitData | undefined {
	if (entry.type !== "custom" || entry.customType !== SESSION_EXIT_CUSTOM_TYPE || !isObject(entry.data)) {
		return undefined;
	}
	const { reason, kind, recordedAt } = entry.data;
	if (
		typeof reason !== "string" ||
		(kind !== "normal" && kind !== "signal" && kind !== "fatal" && kind !== "process_exit") ||
		typeof recordedAt !== "string"
	) {
		return undefined;
	}
	return {
		reason,
		kind,
		recordedAt,
		pendingToolCalls: readPendingToolCalls(entry.data.pendingToolCalls),
	};
}

const INTERRUPTED_TURN_ERROR = "Previous OMP process exited before completing the turn.";
const CRASHED_TURN_ERROR = "Previous OMP process exited without a shutdown record before completing the turn.";
const SEPARATED_TURN_ERROR =
	"This session copy was separated from a live OMP session that still owns the original file; the turn continues there.";

/** Options for {@link planInterruptedTurnRepair}. */
export interface InterruptedTurnRepairOptions {
	/**
	 * The branch is a copy split off a session another live process still
	 * writes: its turn is not interrupted, only unreachable from here.
	 */
	separatedFromLiveSession?: boolean;
}

function isClosedByFailure(message: AssistantMessage | undefined): boolean {
	return message?.stopReason === "error" || message?.stopReason === "aborted";
}

/** True when a yield result ends its run: the loop stops without another model call. */
export function isTerminalYieldResult(toolName: string, isError: boolean | undefined, details: unknown): boolean {
	if (toolName !== "yield" || isError) return false;
	if (!isObject(details)) return true;
	return !(
		details.status === "success" &&
		Array.isArray(details.type) &&
		details.type.length > 0 &&
		details.type.every(item => typeof item === "string")
	);
}

/** A tool-result tail that ends its turn without a following assistant record. */
function isSettledToolResultTail(message: ToolResultMessage): boolean {
	if (isTerminalYieldResult(message.toolName, message.isError, message.details)) return true;
	// Fork repair closes a live parent's in-flight calls with aborted synthetic results.
	const details = message.details;
	return isObject(details) && details.__synthetic === true && details.source === "assistant_stop_aborted";
}

function interruptedToolResult(
	call: { id: string; name: string },
	pending: PendingToolCallDiagnostic,
	turnJournaled: boolean,
	separated: boolean,
	timestamp: number,
): ToolResultMessage<InterruptedToolResultDetails> {
	const args = summarizeToolArguments(pending.args);
	// A separated copy's calls may still start or finish in the live session.
	const execution: InterruptedToolResultDetails["execution"] = separated
		? "unknown"
		: pending.startedAt
			? "started"
			: turnJournaled
				? "not_started"
				: "unknown";
	const details: InterruptedToolResultDetails = { __interrupted: true, execution, resumed: true };
	if (pending.startedAt) details.startedAt = pending.startedAt;
	if (args) details.args = args;
	if (pending.replay) details.replay = pending.replay;
	const callParts = [call.name];
	appendArgumentSummary(callParts, args);
	const callLabel = callParts.join(" ");
	const text = separated
		? `This session copy was separated from a live OMP session that still owns the original file; this call may still be running there, and its outcome is unknown here. It was not re-run. Call: ${callLabel}.`
		: execution === "started"
			? `Previous OMP process exited after this tool started (${pending.startedAt}) and before it returned; its outcome is unknown. It was not re-run. Call: ${callLabel}.`
			: execution === "not_started"
				? `Previous OMP process exited before this tool started; it was not executed. Call: ${callLabel}.`
				: `Previous OMP process exited before this tool returned; whether it started is unknown. It was not re-run. Call: ${callLabel}.`;
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		details,
		isError: true,
		timestamp,
	};
}

/**
 * Plans the records that close an interrupted turn at the end of the active
 * branch. Detection reads the branch itself: an assistant turn with tool calls
 * lacking results, a tool-result tail, or a user tail, with no settled
 * assistant after it. A later `session_exit` only refines the outcome: a
 * normal exit without pending calls marks a graceful stop and nothing is
 * planned; any other exit, or none at all (crash, SIGKILL, power loss), plans
 * a repair. Planning on an already repaired branch returns `undefined`.
 */
export function planInterruptedTurnRepair(
	entries: readonly SessionEntry[],
	fallbackModel?: AssistantModelMetadata,
	options?: InterruptedTurnRepairOptions,
): InterruptedTurnRepair | undefined {
	const separated = options?.separatedFromLiveSession === true;
	let tailIndex = -1;
	let tail: AgentMessage | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		tailIndex = index;
		tail = entry.message;
		break;
	}
	if (!isObject(tail)) return undefined;

	let exit: SessionExitData | undefined;
	for (let index = entries.length - 1; index > tailIndex; index--) {
		exit = readSessionExit(entries[index]!);
		if (exit) break;
	}
	if (exit?.kind === "normal" && !exit.pendingToolCalls?.length) return undefined;

	let previousAssistant: AssistantMessage | undefined;
	let previousAssistantIndex = -1;
	for (let index = tailIndex; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "assistant") continue;
		previousAssistant = entry.message;
		previousAssistantIndex = index;
		break;
	}

	let needsAbort: boolean;
	let owner: AssistantMessage | undefined;
	if (tail.role === "assistant") {
		// Malformed persisted content means there is nothing reliable to close.
		if (!Array.isArray(tail.content) || !tail.content.some(isToolCallContent)) return undefined;
		owner = tail;
		needsAbort = !isClosedByFailure(tail);
	} else if (tail.role === "toolResult") {
		owner = previousAssistant;
		needsAbort = !isClosedByFailure(owner) && !isSettledToolResultTail(tail);
	} else if (tail.role === "user" || tail.role === "fileMention") {
		needsAbort = true;
	} else {
		return undefined;
	}

	const repairedAt = Date.now();
	const toolResults: ToolResultMessage<InterruptedToolResultDetails>[] = [];
	if (owner) {
		const pending = new Map<string, PendingToolCallDiagnostic>();
		for (const call of collectPendingToolCalls(entries)) {
			if (call.toolCallId) pending.set(call.toolCallId, call);
		}
		const ownerContent: unknown[] = Array.isArray(owner.content) ? owner.content : [];
		const calls: { id: string; name: string }[] = [];
		for (const part of ownerContent) {
			if (isToolCallContent(part) && typeof part.id === "string" && typeof part.name === "string") {
				calls.push({ id: part.id, name: part.name });
			}
		}
		const turnJournaled = isTurnJournaled(entries, previousAssistantIndex, new Set(calls.map(call => call.id)));
		for (const call of calls) {
			const record = pending.get(call.id);
			if (record) toolResults.push(interruptedToolResult(call, record, turnJournaled, separated, repairedAt));
		}
	}

	let abort: AssistantMessage | undefined;
	const model = previousAssistant ?? fallbackModel;
	if (needsAbort && model) {
		const recordedAt = exit ? Date.parse(exit.recordedAt) : Number.NaN;
		abort = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: separated ? SEPARATED_TURN_ERROR : exit ? INTERRUPTED_TURN_ERROR : CRASHED_TURN_ERROR,
			timestamp: Number.isFinite(recordedAt) ? recordedAt : repairedAt,
		};
	}
	if (toolResults.length === 0 && !abort) return undefined;
	return abort ? { toolResults, abort } : { toolResults };
}

/**
 * True when the turn's markers prove write-before-execute held: at least one
 * marker for a call of this turn names the assistant entry, and no marker for
 * a call of this turn reports a degraded journal.
 */
function isTurnJournaled(
	entries: readonly SessionEntry[],
	assistantIndex: number,
	callIds: ReadonlySet<string>,
): boolean {
	const assistantEntryId = entries[assistantIndex]?.id;
	if (assistantEntryId === undefined) return false;
	let vouched = false;
	for (let index = assistantIndex + 1; index < entries.length; index++) {
		const marker = readToolExecutionStart(entries[index]!);
		if (!marker || !callIds.has(marker.toolCallId)) continue;
		if (marker.journal !== undefined) return false;
		if (marker.assistantEntryId === assistantEntryId) vouched = true;
	}
	return vouched;
}

/** Session files whose skipped repair was already logged, so each is reported once per process. */
const heldRepairSkipsLogged = new Set<string>();

/**
 * Closes an interrupted turn on the session's active branch: appends one
 * interrupted result per unpaired call, then the terminal aborted assistant
 * record. Planning and appending run in one synchronous block, so no other
 * append in this process can interleave; a repeat call finds the repaired
 * tail and appends nothing. Returns what was appended.
 *
 * Another live session in this process may be mid-turn on the same file, so
 * nothing is appended then. When another process owns the file, the first
 * append moves this session to a sibling copy; that copy is closed with
 * wording that says the turn continues in the live session, so the copy never
 * replays an unpaired tool call to a provider.
 */
export function repairInterruptedTurn(
	sessionManager: SessionManager,
	fallbackModel?: AssistantModelMetadata,
): InterruptedTurnRepair | undefined {
	const branch = sessionManager.getBranch();
	if (!planInterruptedTurnRepair(branch, fallbackModel)) return undefined;
	if (sessionManager.isSessionHeldByAnotherManager()) {
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile !== undefined && !heldRepairSkipsLogged.has(sessionFile)) {
			heldRepairSkipsLogged.add(sessionFile);
			logger.warn("Interrupted turn left unrepaired: another session manager in this process holds the session", {
				sessionId: sessionManager.getSessionId(),
				reason: "undisposed session manager",
			});
		}
		return undefined;
	}
	const separatedFromLiveSession = sessionManager.isSessionOwnedElsewhere();
	const repair = planInterruptedTurnRepair(branch, fallbackModel, { separatedFromLiveSession });
	if (!repair) return undefined;
	for (const result of repair.toolResults) sessionManager.appendMessage(result);
	if (repair.abort) sessionManager.appendMessage(repair.abort);
	return repair;
}

function isToolCallContent(value: unknown): value is ToolCallContent {
	if (!isObject(value)) return false;
	return value.type === "toolCall" && (typeof value.name === "string" || typeof value.id === "string");
}

/** Character cap for each summarized argument field. */
const ARGUMENT_SUMMARY_MAX_CHARS = 200;

function truncateSummaryField(value: string): string {
	return value.length > ARGUMENT_SUMMARY_MAX_CHARS ? `${value.slice(0, ARGUMENT_SUMMARY_MAX_CHARS)}…` : value;
}

/**
 * Project full tool-call arguments down to the fields the pending-tool-call
 * resume warning actually renders (`command`/`path`), truncated. Returns
 * `undefined` when the arguments carry neither, so callers can omit `args`
 * entirely instead of persisting an empty object.
 */
export function summarizeToolArguments(args: unknown): ToolArgumentSummary | undefined {
	if (!isObject(args)) return undefined;
	const summary: ToolArgumentSummary = {};
	if (typeof args.command === "string" && args.command.length > 0) {
		summary.command = truncateSummaryField(args.command);
	}
	if (typeof args.path === "string" && args.path.length > 0) {
		summary.path = truncateSummaryField(args.path);
	}
	return summary.command !== undefined || summary.path !== undefined ? summary : undefined;
}

function readToolExecutionStart(entry: SessionEntry): ToolExecutionStartData | undefined {
	if (entry.type !== "custom" || entry.customType !== TOOL_EXECUTION_START_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (!isObject(data)) return undefined;
	if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string") return undefined;
	// Marker text reaches the model on resume: accept only times that parse, re-emitted as ISO.
	const startedAt = normalizeIsoTime(data.startedAt) ?? normalizeIsoTime(entry.timestamp) ?? "unknown time";
	const result: ToolExecutionStartData = {
		toolCallId: data.toolCallId,
		toolName: data.toolName,
		startedAt,
	};
	// Legacy sessions persisted full argument objects; project them down.
	if ("args" in data) {
		const args = summarizeToolArguments(data.args);
		if (args) result.args = args;
	}
	if (typeof data.intent === "string") result.intent = data.intent;
	if (data.replay === "safe" || data.replay === "unsafe") result.replay = data.replay;
	if (typeof data.assistantEntryId === "string" && ENTRY_ID_PATTERN.test(data.assistantEntryId)) {
		result.assistantEntryId = data.assistantEntryId;
	}
	if (data.speculative === true) result.speculative = true;
	if (data.journal === "degraded" || data.journal === "deferred" || data.journal === "failed") {
		result.journal = data.journal;
	}
	return result;
}

function appendAssistantToolCalls(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role !== "assistant") return;
	const content = Array.isArray(message.content) ? message.content : [];
	const toolCalls: PendingToolCallRecord[] = [];
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (!isToolCallContent(part)) continue;
		const toolName = part.name ?? "unknown";
		const key = part.id ?? `assistant:${message.timestamp ?? "unknown"}:${index}:${toolName}`;
		const record: PendingToolCallRecord = {
			key,
			toolName,
		};
		if (typeof message.timestamp === "number") record.assistantTimestamp = message.timestamp;
		if (part.id) record.toolCallId = part.id;
		if ("arguments" in part) record.args = part.arguments;
		toolCalls.push(record);
	}
	pending.clear();
	for (const toolCall of toolCalls) pending.set(toolCall.key, toolCall);
}

function applyToolExecutionStart(pending: Map<string, PendingToolCallRecord>, marker: ToolExecutionStartData): void {
	const existing = pending.get(marker.toolCallId);
	if (existing) {
		// A speculative start precedes the dispatch marker; keep the earliest.
		existing.startedAt ??= marker.startedAt;
		// The assistant message carries the full arguments; the marker only has
		// the command/path projection. Keep the richer copy when present.
		existing.args ??= marker.args;
		if (marker.intent) existing.intent = marker.intent;
		if (marker.replay) existing.replay = marker.replay;
		return;
	}
	const record: PendingToolCallRecord = {
		key: marker.toolCallId,
		toolCallId: marker.toolCallId,
		toolName: marker.toolName,
		args: marker.args,
		startedAt: marker.startedAt,
	};
	if (marker.intent) record.intent = marker.intent;
	if (marker.replay) record.replay = marker.replay;
	pending.set(marker.toolCallId, record);
}

function applyMessageEntry(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role === "toolResult") {
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		if (toolCallId) pending.delete(toolCallId);
		return;
	}
	appendAssistantToolCalls(pending, message);
}

/** Finds tool calls left pending at the end of a session branch. */
export function collectPendingToolCalls(entries: readonly SessionEntry[]): PendingToolCallDiagnostic[] {
	const pending = new Map<string, PendingToolCallRecord>();
	// Markers for calls no assistant entry has named yet: speculative execution
	// journals its start while the model is still streaming the call.
	const early = new Map<string, ToolExecutionStartData>();
	for (const entry of entries) {
		if (entry.type === "message") {
			if (!isObject(entry.message)) continue;
			applyMessageEntry(pending, entry.message);
			if (entry.message.role === "assistant") {
				for (const [toolCallId, marker] of early) {
					if (pending.has(toolCallId)) applyToolExecutionStart(pending, marker);
				}
				early.clear();
			} else if (entry.message.role === "toolResult") {
				early.delete(entry.message.toolCallId);
			}
			continue;
		}
		const marker = readToolExecutionStart(entry);
		if (!marker) continue;
		if (!pending.has(marker.toolCallId)) early.set(marker.toolCallId, marker);
		applyToolExecutionStart(pending, marker);
	}
	return [...pending.values()].map(({ key: _key, ...toolCall }) => toolCall);
}

function appendArgumentSummary(parts: string[], args: unknown): void {
	if (!isObject(args)) return;
	const command = args.command;
	if (typeof command === "string" && command.length > 0) {
		parts.push(`command \`${command}\``);
		return;
	}
	const path = args.path;
	if (typeof path === "string" && path.length > 0) parts.push(`path \`${path}\``);
}

function formatPendingToolCall(call: PendingToolCallDiagnostic): string {
	const parts = [call.toolName];
	if (call.toolCallId) parts.push(call.toolCallId);
	appendArgumentSummary(parts, call.args);
	return parts.join(" ");
}

/** Builds the resume warning shown when a prior branch ended mid-tool-call. */
export function describePendingToolCalls(entries: readonly SessionEntry[]): string | undefined {
	const pending = collectPendingToolCalls(entries);
	if (pending.length === 0) return undefined;
	const formatted = pending.map(formatPendingToolCall).join(", ");
	const noun = pending.length === 1 ? "tool call" : "tool calls";
	return `Previous session ended while ${pending.length} ${noun} remained pending: ${formatted}. The prior OMP process exited before recording tool result(s).`;
}
