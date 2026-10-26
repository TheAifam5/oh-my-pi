import { type Type, type } from "@oh-my-pi/omptype";
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
import { escapeXmlAttribute, escapeXmlText, logger, prompt } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };
import {
	type AdviseWhere,
	adviseWhereSchema,
	emptyAnchorFields,
	formatAnchorDisplay,
	isApproachIdentity,
	resolveAnchorIdentity,
} from "./anchor-identity";
import { AdvisorEmissionGuard, type AdvisorSuppressionReason, advisorDedupeKey } from "./emission-guard";
import {
	ADVISOR_RELATIONS,
	type AdvisorFinding,
	AdvisorFindingsLedger,
	type AdvisorRelation,
	type AdvisorReport,
	type AdvisorReportInput,
} from "./findings-ledger";

const adviseShape = {
	kind: type("'defect' | 'concern' | 'unverified' | 'suggestion'").describe(
		"defect: wrong now; concern: likely wrong; unverified: a claim or result nobody checked; suggestion: a better approach.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
	where: adviseWhereSchema,
	defect: type("string").describe("What is wrong, in one line. For `suggestion`, the advice itself."),
	"impact?": type("string").describe(
		"What breaks if left as is. Required for defect/concern/unverified at severity concern or blocker.",
	),
	"fix?": type("string").describe(
		"The concrete correction. Required for defect/concern/unverified at severity concern or blocker.",
	),
	"relatesTo?": type(/^F\d+$/).describe("Id of an open finding from the digest this report relates to."),
	"relation?": type
		.enumerated(...ADVISOR_RELATIONS)
		.describe(
			"How the report relates to `relatesTo`: duplicate (same anchor; any topic between two approach anchors), adds, escalates (higher severity), disputes, resolved (owner only).",
		),
};

/** `advise` parameters without a category taxonomy. */
const uncategorizedAdviseSchema = type(adviseShape);

export type AdviseParams = typeof uncategorizedAdviseSchema.infer & {
	/** Active-taxonomy category id; present when the session has a taxonomy. */
	category?: string;
};

/** One category of the active taxonomy as offered to one advisor. */
export interface AdviseCategory {
	id: string;
	description: string;
	/** Whether the reporting advisor owns this category. */
	owned?: boolean;
}

/**
 * The `advise` parameter schema for a taxonomy: without categories, no
 * `category` field; otherwise `category` is required and enumerates the ids.
 */
export function buildAdviseSchema(categories: readonly AdviseCategory[]): Type<AdviseParams> {
	if (categories.length === 0) return uncategorizedAdviseSchema;
	return type({
		...adviseShape,
		category: type
			.enumerated(...categories.map(category => category.id))
			.describe("The finding's category; ids and meanings are listed in the tool description."),
	});
}

export interface AdviseDetails {
	/** Rendered note body (see {@link formatAdviseNote}); the only field in transcripts written before structured advice. */
	note: string;
	severity?: AdvisorSeverity;
	kind?: AdvisorKind;
	category?: string;
	where?: AdviseWhere;
	defect?: string;
	impact?: string;
	fix?: string;
	relatesTo?: string;
	relation?: AdvisorRelation;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** One admitted finding as routed to the primary. */
export interface AdvisorAdvice {
	/** Rendered note body (see {@link formatAdviseNote}). */
	note: string;
	severity: AdvisorSeverity | undefined;
	kind: AdvisorKind;
	/** Primary-turn count the emitting review covered. */
	turn: number | undefined;
	/** Active-taxonomy category id; undefined without a taxonomy. */
	category: string | undefined;
	where: AdviseWhere;
	/** Display string of `where` (see {@link formatAnchorDisplay}). */
	anchor: string;
	/** Host-side anchor identity (see {@link resolveAnchorIdentity}); never shown to models. */
	anchorIdentity: string;
	defect: string;
	impact: string | undefined;
	fix: string | undefined;
	/** Ledger finding the report belongs to. */
	finding?: string;
	/** Whether the report raised its finding's severity. */
	escalated?: boolean;
	/** How the report relates to its finding, when it named one. */
	relation?: AdvisorRelation;
	/** Whether the report must not interrupt the primary. */
	aside?: boolean;
}

/**
 * Render the note body of a structured finding:
 * `<anchor display> — <defect>`, then ` → <impact>` and ` → <fix>` when present.
 * Fields are trimmed; the result is plain text (escape before embedding in XML).
 */
export function formatAdviseNote(advice: {
	where: AdviseWhere;
	defect: string;
	impact?: string;
	fix?: string;
}): string {
	let note = `${formatAnchorDisplay(advice.where)} — ${advice.defect.trim()}`;
	const impact = advice.impact?.trim();
	if (impact) note += ` → ${impact}`;
	const fix = advice.fix?.trim();
	if (fix) note += ` → ${fix}`;
	return note;
}

/** Free-text `where` fields, in display order. */
const WHERE_TEXT_FIELDS = ["path", "symbol", "text", "id", "quote", "topic", "ref"] as const;

/**
 * Free-text strings of an `advise` tool call's raw arguments — the `where`
 * anchor (its display string when it is a valid anchor, else its string
 * fields), `defect`, `impact`, `fix`, and the legacy `note` — for content
 * screening and summaries. Non-string values are skipped.
 */
export function adviseArgumentTexts(args: Record<string, unknown>): string[] {
	const texts: string[] = [];
	const where = args.where;
	const anchor = adviseWhereSchema(where);
	if (!(anchor instanceof type.errors)) {
		texts.push(formatAnchorDisplay(anchor));
	} else if (where && typeof where === "object") {
		for (const field of WHERE_TEXT_FIELDS) {
			const value = (where as Record<string, unknown>)[field];
			if (typeof value === "string") texts.push(value);
		}
	}
	for (const field of ["defect", "impact", "fix", "note"] as const) {
		const value = args[field];
		if (typeof value === "string") texts.push(value);
	}
	return texts;
}

const ADVISE_SILENCE_RULE = "A review with nothing to report ends without calling `advise`.";

/**
 * Validate raw `advise` arguments against `schema` (default: no taxonomy):
 * the shape and enums, non-empty anchor text and `defect`, non-empty
 * `impact`/`fix` for a defect/concern/unverified finding at severity concern
 * or blocker, and `relatesTo` and `relation` given together. Returns the
 * parsed params, or the rejection text naming every failing field.
 */
export function validateAdviseArgs(
	raw: unknown,
	schema: Type<AdviseParams> = uncategorizedAdviseSchema,
): AdviseParams | string {
	const parsed = schema(raw);
	if (parsed instanceof type.errors) return `Rejected: ${parsed.summary}\n${ADVISE_SILENCE_RULE}`;
	if ((parsed.relatesTo === undefined) !== (parsed.relation === undefined)) {
		return `Rejected: \`relatesTo\` and \`relation\` go together; give both or neither.\n${ADVISE_SILENCE_RULE}`;
	}
	const missing = emptyAnchorFields(parsed.where);
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
 * `<advisory>` element per note, the XML-escaped note body as text. A ledger
 * note leads with `finding`, `category`, and `owner`, then severity and kind,
 * then `reporters` and `relation`; a note without a finding keeps the pre-ledger attribute
 * order. Shared by the non-interrupting YieldQueue dispatcher and the
 * interrupting steer path so both build byte-identical content.
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
			let attributes = `${who}${severity}${kind}`;
			if (n.finding) {
				const category = n.category ? ` category="${escapeXmlAttribute(n.category)}"` : "";
				const owner = n.owner ? ` owner="${escapeXmlAttribute(n.owner)}"` : "";
				const reporters = n.reporters?.length ? ` reporters="${escapeXmlAttribute(n.reporters.join(","))}"` : "";
				const relation = n.relation ? ` relation="${escapeXmlAttribute(n.relation)}"` : "";
				attributes = ` finding="${escapeXmlAttribute(n.finding)}"${category}${owner}${severity}${kind}${reporters}${relation}${who}`;
			}
			return `<advisory${attributes}${age} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
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
/** Rank of a severity: nit (or none) 1, concern 2, blocker 3. */
export function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
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
	"rate-limit": "Dropped: this update's advice budget is spent.",
};
/** An exact repeat of a report already on the finding: recorded, not delivered again. */
const ADVISOR_ACK_DUPLICATE = "Already raised; recorded, not delivered again.";
/** A malformed call after this update's single retry was spent. */
const ADVISOR_ACK_INVALID_DROPPED = "Dropped: invalid call; this update's retry is spent.";

/** Host wiring of one advisor's `advise` tool beyond routing and admission. */
export interface AdviseToolOptions {
	/** Active taxonomy as offered to this advisor; empty or omitted means no `category` field. */
	categories?: readonly AdviseCategory[];
	/**
	 * Host-side anchor identity; defaults to {@link resolveAnchorIdentity}
	 * without a workspace context (no file is read).
	 */
	resolveAnchorIdentity?: (where: AdviseWhere) => Promise<string>;
	/** Session findings ledger; defaults to a ledger private to this tool. */
	ledger?: AdvisorFindingsLedger;
	/** Reporter name recorded in the ledger; defaults to `default`. */
	advisor?: string;
}

/** A report withheld behind an in-progress primary turn. */
interface DeferredReport {
	/** {@link advisorDedupeKey} of the defect and finding key: matches re-raises. */
	key: string;
	/** Category plus anchor identity: the guard's budget slot key. */
	findingKey: string;
	advice: AdvisorAdvice;
	finding: AdvisorFinding;
	report: AdvisorReport;
}

export class AdviseTool implements AgentTool<Type<AdviseParams>, AdviseDetails> {
	readonly name = "advise";
	/** Consults an advisor model over the network. */
	readonly replay = "unsafe" as const;
	readonly label = "Advise";
	readonly description: string;
	readonly parameters: Type<AdviseParams>;
	readonly intent = "omit" as const;
	/** Malformed calls reach {@link execute}, which owns rejection and the per-update retry limit. */
	readonly lenientArgValidation = true;
	readonly #onAdvice: (advice: AdvisorAdvice) => void;
	readonly #resolveAnchorIdentity: (where: AdviseWhere) => Promise<string>;
	/** Per-call backstop and rate limit; the ledger decides what is a new finding. */
	readonly #guard: AdvisorEmissionGuard;
	/** Dedupe owner: classifies each report as a new finding, an attachment, or a duplicate. */
	readonly #ledger: AdvisorFindingsLedger;
	/** Whether {@link #ledger} is private to this tool (cleared on reset). */
	readonly #ownsLedger: boolean;
	readonly #advisor: string;
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
	#deferredNotes: DeferredReport[] = [];
	/** Settles after the latest call's admission; admissions run in call order. */
	#admissionChain: Promise<unknown> = Promise.resolve();

	/**
	 * @param onAdvice Route an admitted report to the primary (channel
	 *   selection + delivery). Never re-filters — the report already cleared admission.
	 * @param guard Per-call noise/empty backstop, invalid-call retry, and the
	 *   per-update budget of new findings. Defaults to a stock
	 *   {@link AdvisorEmissionGuard} (default budget
	 *   {@link ADVISOR_DEFAULT_BUDGET_PER_UPDATE}).
	 * @param options Category taxonomy, anchor identity resolution, and the findings ledger.
	 */
	constructor(
		onAdvice: (advice: AdvisorAdvice) => void,
		guard?: AdvisorEmissionGuard,
		options: AdviseToolOptions = {},
	) {
		this.#onAdvice = onAdvice;
		this.#guard = guard ?? new AdvisorEmissionGuard();
		this.#ownsLedger = options.ledger === undefined;
		this.#ledger = options.ledger ?? new AdvisorFindingsLedger();
		this.#advisor = options.advisor ?? "default";
		const categories = options.categories ?? [];
		this.parameters = buildAdviseSchema(categories);
		this.description = prompt.render(adviseDescription, { categories });
		this.#resolveAnchorIdentity = options.resolveAnchorIdentity ?? (where => resolveAnchorIdentity(where));
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

	/** Clear per-advisor note state when the advisor starts a fresh
	 *  conversation: the guard's budget and this tool's pending backlog, plus
	 *  a tool-private ledger, so a re-primed advisor can re-raise old issues. */
	resetDeliveredNotes(): void {
		this.#guard.reset();
		this.#inProgressUpdate = false;
		this.#deferredNotes = [];
		if (this.#ownsLedger) this.#ledger.clear();
	}

	async execute(
		_toolCallId: string,
		rawArgs: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		const args = validateAdviseArgs(rawArgs, this.parameters);
		if (typeof args === "string") return this.#rejected(args);
		const identity = this.#resolveAnchorIdentity(args.where).catch(err => {
			logger.debug("advisor anchor identity fell back to the unread form", { error: String(err) });
			return resolveAnchorIdentity(args.where);
		});
		// Identities resolve concurrently; admission stays in call order.
		const admitted = this.#admissionChain.then(async () => this.#admit(args, await identity));
		this.#admissionChain = admitted.catch(() => undefined);
		return admitted;
	}

	#admit(args: AdviseParams, anchorIdentity: string): AgentToolResult<AdviseDetails> {
		if (args.relatesTo !== undefined && args.relation !== undefined) {
			const target = this.#ledger.get(args.relatesTo);
			if (!target) {
				return this.#rejected(
					`Rejected: finding ${args.relatesTo} is unknown in this session. Use an existing finding ID, or omit both relation fields for a new finding.`,
				);
			}
			if (target.status === "resolved" && args.relation === "resolved") {
				return this.#result(
					`Already resolved: ${target.id}. No new report or delivery.`,
					args,
					formatAdviseNote(args),
				);
			}
			if (target.status !== "open") {
				return this.#rejected(
					`Rejected: finding ${target.id} is ${target.status}. Ask the main agent to reopen it for a regression, or omit both relation fields for a new finding.`,
				);
			}
		}
		const note = formatAdviseNote(args);
		const advice: AdvisorAdvice = {
			note,
			severity: args.severity,
			kind: args.kind,
			turn: this.#coveredTurn,
			category: args.category,
			where: args.where,
			anchor: formatAnchorDisplay(args.where),
			anchorIdentity,
			defect: args.defect,
			impact: args.impact,
			fix: args.fix,
		};
		const rank = advisorSeverityRank(args.severity);
		const related = this.#relatedFinding(args, anchorIdentity);
		const findingKey = related ? related.finding.id : `${args.category ?? ""}\n${anchorIdentity}`;
		const key = advisorDedupeKey(args.defect, findingKey);
		const pending = this.#inProgressUpdate && args.severity !== "blocker";
		const reservedIndex = this.#deferredNotes.findIndex(item => item.key === key);
		if (pending && reservedIndex !== -1) {
			// Re-raise of a still-queued note is not a new report: escalate
			// severity in place (never a second slot or report).
			const reserved = this.#deferredNotes[reservedIndex]!;
			if (rank > advisorSeverityRank(reserved.advice.severity)) {
				reserved.advice.severity = args.severity;
				this.#ledger.raiseReport(reserved.finding, reserved.report, args.severity);
				this.#guard.escalatePending(findingKey, rank);
			}
			return this.#result(ADVISOR_ACK_DEFERRED, args, note);
		}
		if (reservedIndex !== -1) {
			// A blocker re-raise of a still-queued note replaces the reservation
			// so it interrupts at blocker severity now.
			const [reserved] = this.#deferredNotes.splice(reservedIndex, 1);
			this.#ledger.withdraw(reserved!.finding, reserved!.report);
		}
		if (related) return this.#admitRelated(args, advice, related, { rank, pending, key, findingKey });
		const existing = this.#ledger.findOpen(args.category, anchorIdentity);
		const decision = this.#guard.admit(args.defect, { rank, pending, key: findingKey, newFinding: !existing });
		if (!decision.accepted) return this.#suppressed(args, note, decision.reason);
		if (decision.displacedKey !== undefined) {
			// Only same-update pending reports can be displaced; they were never delivered.
			for (const item of this.#deferredNotes.filter(item => item.findingKey === decision.displacedKey)) {
				this.#deferredNotes.splice(this.#deferredNotes.indexOf(item), 1);
				this.#ledger.withdraw(item.finding, item.report);
			}
		}
		const outcome = this.#ledger.record(this.#reportInput(args, advice));
		if (outcome.type === "duplicate") {
			logger.debug("advisor advice recorded as a duplicate report", { finding: outcome.finding.id });
			return this.#result(ADVISOR_ACK_DUPLICATE, args, note);
		}
		advice.finding = outcome.finding.id;
		if (outcome.type === "attached") {
			if (outcome.escalated) advice.escalated = true;
			else if (!this.#guard.admitAttachedAside()) return this.#asideCapped(args, note, outcome.finding);
		}
		return this.#route(args, advice, { key, findingKey, finding: outcome.finding, report: outcome.report, pending });
	}

	/**
	 * The open finding a report names through `relatesTo`, with the relation
	 * it takes effect as: `duplicate` only when the report's anchor identity
	 * matches the finding's or both anchors are `approach` anchors (whose
	 * topics are free text), `resolved` only from the finding's owner (else
	 * `disputes`). Undefined without a relation or for an unmatched duplicate:
	 * the report then counts as unrelated. Unknown and closed IDs are handled before admission.
	 */
	#relatedFinding(
		args: AdviseParams,
		anchorIdentity: string,
	): { finding: AdvisorFinding; relation: AdvisorRelation } | undefined {
		if (args.relatesTo === undefined || args.relation === undefined) return undefined;
		const finding = this.#ledger.get(args.relatesTo);
		if (!finding || finding.status !== "open") return undefined;
		if (
			args.relation === "duplicate" &&
			finding.identity !== anchorIdentity &&
			!(isApproachIdentity(finding.identity) && isApproachIdentity(anchorIdentity))
		) {
			return undefined;
		}
		if (args.relation === "resolved" && !this.#ledger.isOwner(finding, this.#advisor)) {
			return { finding, relation: "disputes" };
		}
		return { finding, relation: args.relation };
	}

	/**
	 * Admit a report on a finding it names. It joins the finding; `resolved`
	 * closes it. Only `escalates` raising the finding's severity may
	 * interrupt; every other relation is an aside charged against
	 * {@link AdvisorEmissionGuard.admitAttachedAside}. A `duplicate` repeating
	 * the lead report is recorded without delivery.
	 */
	#admitRelated(
		args: AdviseParams,
		advice: AdvisorAdvice,
		related: { finding: AdvisorFinding; relation: AdvisorRelation },
		opts: { rank: number; pending: boolean; key: string; findingKey: string },
	): AgentToolResult<AdviseDetails> {
		const { finding, relation } = related;
		const decision = this.#guard.admit(args.defect, {
			rank: opts.rank,
			pending: opts.pending,
			key: opts.findingKey,
			newFinding: false,
		});
		if (!decision.accepted) return this.#suppressed(args, advice.note, decision.reason);
		const outcome = this.#ledger.recordRelated(finding, { ...this.#reportInput(args, advice), relation });
		if (relation === "resolved") this.#ledger.resolve(finding.id, this.#advisor, args.defect);
		if (outcome.type !== "attached") return this.#result(ADVISOR_ACK_DUPLICATE, args, advice.note);
		advice.finding = finding.id;
		advice.relation = relation;
		if (relation === "escalates" && outcome.escalated) {
			advice.escalated = true;
		} else {
			advice.aside = true;
			if (!this.#guard.admitAttachedAside()) return this.#asideCapped(args, advice.note, finding);
		}
		return this.#route(args, advice, { ...opts, finding, report: outcome.report });
	}

	#reportInput(args: AdviseParams, advice: AdvisorAdvice): AdvisorReportInput {
		return {
			advisor: this.#advisor,
			category: args.category,
			identity: advice.anchorIdentity,
			anchor: advice.anchor,
			where: args.where,
			kind: args.kind,
			severity: args.severity,
			defect: args.defect,
			impact: args.impact,
			fix: args.fix,
		};
	}

	/** Deliver an admitted report now, or withhold it behind the in-progress primary turn. */
	#route(
		args: AdviseParams,
		advice: AdvisorAdvice,
		reserved: Omit<DeferredReport, "advice"> & { pending: boolean },
	): AgentToolResult<AdviseDetails> {
		if (reserved.pending) {
			const { key, findingKey, finding, report } = reserved;
			this.#deferredNotes.push({ key, findingKey, advice, finding, report });
			return this.#result(ADVISOR_ACK_DEFERRED, args, advice.note);
		}
		this.#onAdvice(advice);
		return this.#result(ADVISOR_ACK_SENT, args, advice.note);
	}

	/** An aside on an existing finding past this update's aside budget: recorded, not delivered. */
	#asideCapped(args: AdviseParams, note: string, finding: AdvisorFinding): AgentToolResult<AdviseDetails> {
		logger.debug("advisor aside recorded without delivery", { finding: finding.id });
		return this.#result(
			`Recorded under ${finding.id}; this update's aside budget is spent, not delivered.`,
			args,
			note,
		);
	}

	/** Route every withheld note, oldest first, without re-admission — each was
	 *  admitted when emitted. Routed notes are marked so their originating
	 *  update's slots stay charged and can no longer be displaced. */
	#flushDeferred(): void {
		if (this.#deferredNotes.length === 0) return;
		const pending = this.#deferredNotes;
		this.#deferredNotes = [];
		for (const { advice, findingKey } of pending) {
			this.#guard.markRouted(findingKey);
			this.#onAdvice({ ...advice, turn: advice.turn ?? this.#coveredTurn });
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
		return this.#result(ADVISOR_ACK_SUPPRESSED[reason ?? "noise"], args, note);
	}

	#result(text: string, args: AdviseParams, note: string): AgentToolResult<AdviseDetails> {
		return {
			content: [{ type: "text", text }],
			details: {
				note,
				severity: args.severity,
				kind: args.kind,
				category: args.category,
				where: args.where,
				defect: args.defect,
				impact: args.impact,
				fix: args.fix,
				relatesTo: args.relatesTo,
				relation: args.relation,
			},
			useless: true,
		};
	}
}
