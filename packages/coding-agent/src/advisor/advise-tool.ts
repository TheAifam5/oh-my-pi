import { type } from "@oh-my-pi/omptype";
import { type AdvisorKind, type AdvisorNote, type AdvisorSeverity } from "@oh-my-pi/pi-tui/chat/messages";
export {
	type AdvisorKind,
	type AdvisorMessageDetails,
	type AdvisorNote,
	type AdvisorSeverity,
} from "@oh-my-pi/pi-tui/chat/messages";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText, logger } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };
import { AdvisorEmissionGuard, type AdvisorSuppressionReason, advisorDedupeKey } from "./emission-guard";

const adviseSchema = type({
	kind: type("'defect' | 'concern' | 'unverified' | 'suggestion'").describe(
		"defect: wrong now; concern: likely wrong; unverified: a claim or result nobody checked; suggestion: a better approach.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
	where: type({
		type: type("'file' | 'command' | 'tool-call' | 'instruction' | 'claim' | 'approach'").describe(
			"What the finding is anchored to; `approach` anchors a plan, strategy, or verification approach.",
		),
		ref: type("string").describe(
			"The concrete anchor: path[:line], command, tool call, quoted instruction or claim, or the plan step.",
		),
	}).describe("Where the finding is."),
	defect: type("string").describe("What is wrong, in one line. For `suggestion`, the advice itself."),
	"impact?": type("string").describe(
		"What breaks if left as is. Required for defect/concern/unverified at severity concern or blocker.",
	),
	"fix?": type("string").describe(
		"The concrete correction. Required for defect/concern/unverified at severity concern or blocker.",
	),
});

export type AdviseParams = typeof adviseSchema.infer;

/** Anchor of a structured advisor finding. */
export type AdviseWhere = AdviseParams["where"];

export interface AdviseDetails {
	/** Rendered note body (see {@link formatAdviseNote}); the only field in transcripts written before structured advice. */
	note: string;
	severity?: AdvisorSeverity;
	kind?: AdvisorKind;
	where?: AdviseWhere;
	defect?: string;
	impact?: string;
	fix?: string;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/**
 * Render the note body of a structured finding:
 * `<where.ref> — <defect>`, then ` → <impact>` and ` → <fix>` when present.
 * Fields are trimmed; the result is plain text (escape before embedding in XML).
 */
export function formatAdviseNote(advice: {
	where: { ref: string };
	defect: string;
	impact?: string;
	fix?: string;
}): string {
	let note = `${advice.where.ref.trim()} — ${advice.defect.trim()}`;
	const impact = advice.impact?.trim();
	if (impact) note += ` → ${impact}`;
	const fix = advice.fix?.trim();
	if (fix) note += ` → ${fix}`;
	return note;
}

/**
 * Free-text strings of an `advise` tool call's raw arguments — `where.ref`,
 * `defect`, `impact`, `fix`, and the legacy `note` — for content screening
 * and summaries. Non-string values are skipped.
 */
export function adviseArgumentTexts(args: Record<string, unknown>): string[] {
	const texts: string[] = [];
	const where = args.where;
	if (where && typeof where === "object" && "ref" in where && typeof where.ref === "string") texts.push(where.ref);
	for (const field of ["defect", "impact", "fix", "note"] as const) {
		const value = args[field];
		if (typeof value === "string") texts.push(value);
	}
	return texts;
}

const ADVISE_SILENCE_RULE = "A review with nothing to report ends without calling `advise`.";

/**
 * Validate raw `advise` arguments: the schema shape and enums, non-empty
 * `where.ref` and `defect`, and non-empty `impact`/`fix` for a
 * defect/concern/unverified finding at severity concern or blocker. Returns
 * the parsed params, or the rejection text naming every failing field.
 */
export function validateAdviseArgs(raw: unknown): AdviseParams | string {
	const parsed = adviseSchema(raw);
	if (parsed instanceof type.errors) return `Rejected: ${parsed.summary}\n${ADVISE_SILENCE_RULE}`;
	const missing: string[] = [];
	if (!parsed.where.ref.trim()) missing.push("where.ref");
	if (!parsed.defect.trim()) missing.push("defect");
	if (parsed.kind !== "suggestion" && (parsed.severity === "concern" || parsed.severity === "blocker")) {
		if (!parsed.impact?.trim()) missing.push("impact");
		if (!parsed.fix?.trim()) missing.push("fix");
	}
	if (missing.length === 0) return parsed;
	return `Rejected: missing or empty ${missing.join(", ")}. \`impact\` and \`fix\` are required for kind defect, concern, or unverified at severity concern or blocker.\n${ADVISE_SILENCE_RULE}`;
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as a
 * tag attribute (rather than a prose header) so the rendered agent-facing output
 * stays a clean `<advisory>` block. The primary agent's system prompt never
 * mentions advisories, so this is its only cue for how to treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity and kind as attributes, the
 * XML-escaped note body as text. Shared by the non-interrupting YieldQueue
 * dispatcher and the interrupting steer path so both build byte-identical
 * content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[], opts?: { currentTurn?: number }): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${escapeXmlAttribute(n.severity)}"` : "";
			const kind = n.kind ? ` kind="${escapeXmlAttribute(n.kind)}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			const age =
				opts?.currentTurn !== undefined && n.turn !== undefined && opts.currentTurn > n.turn
					? ` turns_ago="${opts.currentTurn - n.turn}"`
					: "";
			return `<advisory${who}${severity}${kind}${age} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

/**
 * Whether advice at this severity should interrupt the running agent (delivered
 * via the steering channel, aborting in-flight tools) rather than ride the
 * non-interrupting aside queue that lands at the next step boundary. `concern`
 * and `blocker` interrupt; a plain `nit` queues.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/** Whether `severity` is at least `minimum` (an omitted severity is a plain `nit`). */
export function meetsAdvisorSeverity(severity: AdvisorSeverity | undefined, minimum: AdvisorSeverity): boolean {
	return advisorSeverityRank(severity) >= advisorSeverityRank(minimum);
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";
/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A `preserveOnly` caller records every note that arrives while the primary
 *   is idle as a visible card and never starts a new primary turn.
 * - A non-interrupting `nit` rides the non-interrupting aside queue while
 *   streaming, or is preserved as a visible card when idle after a terminal answer.
 * - An interrupting `concern`/`blocker` is normally steered into the agent: into
 *   the live turn while one is streaming, or (when idle) a triggered turn so the
 *   advice is acted on immediately.
 * - If the primary is idle on a terminal text answer with no queued work, a note
 *   below `continueSeverity` (`advisor.continueSeverity`) is preserved as a
 *   visible card instead of waking the primary to restate completion (#4840).
 *   A note at or above it — any severity, a `nit` included — triggers a
 *   continuation so the primary acknowledges it before the run is considered
 *   done (#5628), subject to the stop/abort and cooldown gates below; a gated
 *   note is preserved rather than parked as an aside the idle primary would
 *   never see.
 * - After a deliberate user interrupt (`autoResumeSuppressed`) the advisor must
 *   not auto-resume the stopped run. While the agent is idle — or still tearing
 *   the interrupted turn down (`aborting`) — the note is preserved as a visible
 *   card instead of restarting the run. But once a turn is actively streaming
 *   again (a resume the user already drove), steering the note in does NOT
 *   auto-resume anything, so it is delivered live. Parking it during an active
 *   run instead strands it (it never reaches the running agent) and the withheld
 *   notes dump as one burst at the next user prompt — the bug this guards.
 * - During the post-interrupt immune-turn window, further non-blocker notes are
 *   downgraded to asides (preserved when idle on a terminal answer). A `blocker`
 *   is exempt: it means the agent handed off broken or unexercised work, so it
 *   still steers a triggered turn even right after a prior interrupt (#5628).
 */
export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	/** Lowest severity that may wake a primary idle on a terminal answer. */
	continueSeverity: AdvisorSeverity;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	interruptImmuneTurnActive?: boolean;
	preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
	if (opts.preserveOnly && !opts.streaming) return "preserve";
	const terminalIdle = opts.terminalAnswerNoQueuedWork === true && !opts.streaming && !opts.aborting;
	if (terminalIdle) {
		if (!meetsAdvisorSeverity(opts.severity, opts.continueSeverity)) return "preserve";
	} else if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (opts.interruptImmuneTurnActive && opts.severity !== "blocker") return terminalIdle ? "preserve" : "aside";
	return "steer";
}

/**
 * Derive the advisor loop's telemetry from the primary session's config so the
 * advisor model's GenAI spans and usage/cost hooks (onChatUsage, onCostDelta,
 * costEstimator) fire under the same pipeline as every other model call —
 * stamped with the advisor's own agent identity. `conversationId` is cleared so
 * the advisor loop falls back to its own `-advisor` session id for
 * `gen_ai.conversation.id` instead of inheriting the primary's conversation.
 *
 * Returns undefined when the primary has no telemetry (instrumentation off), so
 * the advisor `Agent` stays a zero-overhead no-op as well.
 */
export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

/**
 * The tools an advisor receives by default when its config omits `tools` — the
 * read-only investigative set. The full available pool is every built tool the
 * session has (the advisor is a full agent); a config's `tools` selects from it.
 * The runtime build additionally admits `recall` into the default set when the
 * active memory backend built it (hindsight/mnemopi).
 */
export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob"]);

/** Rank advisor severities so the dedupe state can detect a real escalation
 *  (nit → concern → blocker) versus a verbatim repeat. `undefined` defers to
 *  `nit` because the schema treats an omitted severity as a plain nit. */
const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

/**
 * Merged-batch ordering: most recent turn first, then severity (blocker →
 * concern → nit) within a turn. The newest notes describe the latest state of
 * the work, so they read first; severity breaks ties so a blocker never hides
 * below a same-turn nit.
 */
export function compareAdvisorNotes(a: AdvisorNote, b: AdvisorNote): number {
	const turnDelta = (b.turn ?? 0) - (a.turn ?? 0);
	if (turnDelta !== 0) return turnDelta;
	return advisorSeverityRank(b.severity) - advisorSeverityRank(a.severity);
}

/** Admission acks: one line each — the advisor needs the verdict, not a policy essay. */
const ADVISOR_ACK_SENT = "Delivered.";
/** Held behind the in-progress primary turn; flushed when it completes. */
const ADVISOR_ACK_DEFERRED = "Queued for the end of the turn. Do not re-raise.";
/** A suppressed note is never described as recorded or queued. */
const ADVISOR_ACK_SUPPRESSED: Record<AdvisorSuppressionReason, string> = {
	empty: "Dropped: empty note.",
	noise: "Dropped: nothing actionable.",
	duplicate: "Dropped: already raised.",
	"rate-limit": "Dropped: this update's advice budget is spent.",
};
/** A malformed call after this update's single retry was spent. */
const ADVISOR_ACK_INVALID_DROPPED = "Dropped: invalid call; this update's retry is spent.";

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	/** Consults an advisor model over the network. */
	readonly replay = "unsafe" as const;
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;
	/** Malformed calls reach {@link execute}, which owns rejection and the per-update retry limit. */
	readonly lenientArgValidation = true;
	/**
	 * Single admission authority for every emission. The tool owns no parallel
	 * dedupe/budget state: the guard's {@link AdvisorAdmission} decides whether
	 * a note routes, holds pending, or is suppressed — and names any displaced
	 * pending note.
	 */
	readonly #guard: AdvisorEmissionGuard;
	#inProgressUpdate = false;
	/** Primary-turn count the in-flight update reviews (stamped on emitted notes
	 *  so merged batches can report how stale each review was at delivery). */
	#coveredTurn: number | undefined;
	/** Notes admitted but withheld while the primary was mid-turn, in arrival
	 *  order. Flushed deterministically at the completed-update transition or an
	 *  explicit {@link flushDeferredNotes}, so delivery does not depend on the
	 *  advisor model choosing to re-raise (it may not — the deferred
	 *  acknowledgment tells it the note is queued). Only these still-pending
	 *  notes can be displaced by the guard; routed notes are never retracted. */
	#deferredNotes: {
		key: string;
		defect: string;
		ref: string;
		note: string;
		severity?: AdviseDetails["severity"];
		kind: AdvisorKind;
		turn?: number;
	}[] = [];

	/**
	 * @param onAdvice Route an admitted note to the primary (channel selection +
	 *   delivery). Never re-filters — the note already cleared the guard.
	 * @param guard The admission authority: noise/empty/dedupe filter, rank-aware
	 *   escalation, and the per-update non-blocker budget, decided the moment a
	 *   note is emitted (live or deferred). Defaults to a stock
	 *   {@link AdvisorEmissionGuard} (default budget
	 *   {@link ADVISOR_DEFAULT_BUDGET_PER_UPDATE}).
	 */
	constructor(
		private readonly onAdvice: (
			note: string,
			severity: AdviseDetails["severity"] | undefined,
			turn: number | undefined,
			kind: AdvisorKind,
		) => void,
		guard?: AdvisorEmissionGuard,
	) {
		this.#guard = guard ?? new AdvisorEmissionGuard();
	}

	/**
	 * Start one advisor update: resets the guard's per-update budget and marks
	 * whether the update reviews an in-progress primary turn. Non-blockers
	 * emitted while in progress are withheld so partial work does not interrupt
	 * the primary before it can finish its planned steps. Transitioning to a
	 * completed update flushes the withheld backlog, oldest first — each note
	 * was admitted when emitted, so the flush routes without re-admission and a
	 * backlog of one note per originating update reaches the primary intact.
	 */
	beginUpdate(inProgress: boolean, coveredTurn?: number): void {
		const wasInProgress = this.#inProgressUpdate;
		this.#inProgressUpdate = inProgress;
		this.#coveredTurn = coveredTurn;
		this.#guard.beginUpdate();
		if (wasInProgress && !inProgress) this.#flushDeferred();
	}

	/**
	 * Mark the primary no longer mid-turn and flush the withheld backlog
	 * WITHOUT starting a new advisor update or resetting the guard's budget.
	 * Called at the primary's terminal boundary (final yield), where no advisor
	 * review follows but reserved notes must still reach the primary. Flushed
	 * notes stay charged to their originating update as routed deliveries.
	 */
	flushDeferredNotes(): void {
		this.#inProgressUpdate = false;
		this.#flushDeferred();
	}

	/** Clear all note state when the advisor starts a fresh conversation: the
	 *  guard's dedupe/budget memory and this tool's pending backlog reset
	 *  together, so a re-primed advisor can re-raise old issues. */
	resetDeliveredNotes(): void {
		this.#guard.reset();
		this.#inProgressUpdate = false;
		this.#deferredNotes = [];
	}

	async execute(
		_toolCallId: string,
		rawArgs: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		const args = validateAdviseArgs(rawArgs);
		if (typeof args === "string") return this.#rejected(args);
		const note = formatAdviseNote(args);
		const rank = advisorSeverityRank(args.severity);
		const key = advisorDedupeKey(args.defect, args.where.ref);
		if (this.#inProgressUpdate && args.severity !== "blocker") {
			// Withheld, not delivered: reserve for the deterministic flush at the
			// completed-update transition / terminal boundary.
			const pending = this.#deferredNotes.find(item => item.key === key);
			if (pending) {
				// Re-raise of a still-queued note is not a new admission: escalate
				// severity in place (never a second slot) and keep the dedupe rank
				// coherent so equal/lower repeats of the finding stay suppressed.
				if (rank > advisorSeverityRank(pending.severity)) {
					pending.severity = args.severity;
					this.#guard.escalatePending(args.defect, rank, args.where.ref);
				}
				return this.#result(ADVISOR_ACK_DEFERRED, args, note);
			}
			const decision = this.#guard.admit(args.defect, {
				rank,
				pending: true,
				ref: args.where.ref,
			});
			if (!decision.accepted) return this.#suppressed(args, note, decision.reason);
			// The guard centrally names the still-pending note displaced by this
			// strictly-higher-severity admission; only same-update pending notes
			// can be displaced, so the backlog lookup is a drop, not a policy.
			if (decision.displacedKey !== undefined) {
				const displacedIndex = this.#deferredNotes.findIndex(item => item.key === decision.displacedKey);
				if (displacedIndex !== -1) this.#deferredNotes.splice(displacedIndex, 1);
			}
			this.#deferredNotes.push({
				key,
				defect: args.defect,
				ref: args.where.ref,
				note,
				severity: args.severity,
				kind: args.kind,
				turn: this.#coveredTurn,
			});
			return this.#result(ADVISOR_ACK_DEFERRED, args, note);
		}
		// Live path (completed update, or a blocker that must interrupt now). A
		// blocker re-raise of a still-queued note pulls the reservation first:
		// the guard admits it as a rank escalation (nit/concern → blocker), so
		// it interrupts at blocker severity now instead of arriving late at the
		// lower deferred severity.
		const reservedIndex = this.#deferredNotes.findIndex(item => item.key === key);
		if (reservedIndex !== -1) this.#deferredNotes.splice(reservedIndex, 1);
		const decision = this.#guard.admit(args.defect, {
			rank,
			pending: false,
			ref: args.where.ref,
		});
		if (!decision.accepted) return this.#suppressed(args, note, decision.reason);
		this.onAdvice(note, args.severity, this.#coveredTurn, args.kind);
		return this.#result(ADVISOR_ACK_SENT, args, note);
	}

	/** Route every withheld note, oldest first, without re-admission — each was
	 *  admitted when emitted. Routed notes are marked so their originating
	 *  update's slots stay charged and can no longer be displaced. */
	#flushDeferred(): void {
		if (this.#deferredNotes.length === 0) return;
		const pending = this.#deferredNotes;
		this.#deferredNotes = [];
		for (const { defect, ref, note, severity, kind, turn } of pending) {
			this.#guard.markRouted(defect, ref);
			this.onAdvice(note, severity, turn ?? this.#coveredTurn, kind);
		}
	}

	/** Malformed call: the first rejection this update is a tool error the
	 *  advisor may correct once; later ones are dropped without delivery. */
	#rejected(problem: string): AgentToolResult<AdviseDetails> {
		if (this.#guard.recordInvalidCall()) {
			return { content: [{ type: "text", text: problem }], details: { note: "" }, isError: true };
		}
		logger.debug("advisor advice dropped after a spent retry");
		return {
			content: [{ type: "text", text: ADVISOR_ACK_INVALID_DROPPED }],
			details: { note: "" },
			useless: true,
		};
	}

	/** Truthful suppression acknowledgment keyed by the guard's reason: a
	 *  rejected note is never described as recorded, queued, or delivered. */
	#suppressed(
		args: AdviseParams,
		note: string,
		reason: AdvisorSuppressionReason | undefined,
	): AgentToolResult<AdviseDetails> {
		logger.debug("advisor advice suppressed by emission guard", { reason, severity: args.severity });
		return this.#result(ADVISOR_ACK_SUPPRESSED[reason ?? "duplicate"], args, note);
	}

	#result(text: string, args: AdviseParams, note: string): AgentToolResult<AdviseDetails> {
		return {
			content: [{ type: "text", text }],
			details: {
				note,
				severity: args.severity,
				kind: args.kind,
				where: args.where,
				defect: args.defect,
				impact: args.impact,
				fix: args.fix,
			},
			useless: true,
		};
	}
}
