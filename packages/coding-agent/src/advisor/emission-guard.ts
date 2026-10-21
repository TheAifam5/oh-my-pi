/**
 * Per-session policy gate for advisor `advise()` calls.
 *
 * The advisor system prompt tells the watcher model a per-update advice budget
 * (default 4 non-blockers, `blocker` exempt):
 *
 * > max N non-blockers/update (`blocker` exempt)
 * > NEVER repeat advice you already gave, and NEVER send the same advice twice
 *
 * Real advisor models violate this. Issue #3520 captured a session where
 * `__advisor.jsonl` recorded 309 `advise` calls covering 92 unique notes —
 * 114× `Stop.`, 52× `No issue; continue.`, 41× `Done.` — flooding the primary
 * transcript with `<advisory severity="blocker">Stop.</advisory>` after the
 * task was already complete. The fix is to make the rules load-bearing in code
 * instead of prose: drop duplicates, content-free self-talk, and over-budget
 * calls at the `AdviseTool` admission boundary so the primary stays clean even when
 * the advisor misbehaves.
 *
 * The guard is the single admission authority: every decision carries a
 * truthful {@link AdvisorSuppressionReason} that `AdviseTool` surfaces
 * verbatim in its acknowledgment — a rejected note is never described as
 * recorded, and a rate-limited note is never mislabeled a duplicate.
 */

/**
 * Case-insensitive, punctuation-folded normalization. Collapses every run of
 * non-letter / non-digit characters into a single space and trims, so
 * `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`, while
 * `"No issue; continue."` keys to `no issue continue`.
 *
 * Exported for tests.
 */
export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Dedupe key for one finding: the trimmed `where.ref` anchor plus the
 * {@link normalizeAdvisorNote normalized} defect; the normalized defect alone
 * without a ref. Empty when the defect normalizes to nothing.
 */
export function advisorDedupeKey(defect: string, ref?: string): string {
	const normalized = normalizeAdvisorNote(defect);
	if (!normalized) return "";
	const anchor = ref?.trim();
	return anchor ? `${anchor}\n${normalized}` : normalized;
}

/**
 * Normalized phrases the advisor occasionally emits that carry no concrete
 * actionable content. Each must be the output of {@link normalizeAdvisorNote}
 * so a single membership check covers every punctuation/casing variant
 * (`"Stop."`, `"stop"`, `"STOP!"`).
 *
 * The list is conservative — only short, content-free filler the reporter
 * observed driving primary-transcript pollution. A genuine `blocker` like
 * `"Stop: 'await' missing on writeStream.end() will lose buffered writes."`
 * does not match.
 */
const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
	// Self-stop noise — telling the agent to "stop" without a reason is useless.
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,
	// Completion self-talk — the agent already finished the task.
	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,
	// "Nothing to flag" — silence is the correct expression of "no concerns".
	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,
	// Endorsements — equivalent to silence.
	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

/** Longest note (trimmed characters) {@link isNoFindingNote} may classify as filler. */
const NO_FINDING_MAX_LENGTH = 200;

/**
 * Raw-text markers of concrete content: code spans, digits (line numbers,
 * counts, SHAs), `file.ext`, paths, CLI flags, camelCase / snake_case
 * identifiers, calls, `#refs`, assignments, arrows. Any match keeps the note.
 */
const CONTENT_TOKEN = /`|\d|\w\.[A-Za-z]{1,6}\b|(?:^|\s)[~.]?\/\w|(?:^|\s)--?\w|\b[a-z]+[A-Z]\w*|\w_\w|\(\)|#\w|=|->/;

/** Normalized-text cues of a finding or directive. Any match keeps the note. */
const FINDING_CUE =
	/\b(?:but|however|though|although|instead|except|unless|should|must|never|missing|wrong|broken|fails?|failed|failing|failure|errors?|bugs?|leaks?|race|deadlock|crash\w*|regress\w*|unsafe|incorrect|invalid|stale|caution|warning|careful|make sure|before|after|if you|please|don t|do not)\b/;

/** Parenthesized list right after an ownership word, e.g. `domain (CI/release)`. */
const OWNERSHIP_PARENTHETICAL = /\b(lane|domain|scope|area)\s*\([^()`]{0,80}\)/gi;

/** Clause boundaries: sentence punctuation, dashes, and `so` / `, and` joins (not `so far`). */
const CLAUSE_SPLIT = /[.;:!?\n—–]+|,\s*(?:so|and)\s+|\s+so\s+(?!far\b)/i;

/** Longest clause (normalized words) tested against {@link NO_FINDING_MARKER_CLAUSES}. */
const NO_FINDING_MAX_CLAUSE_WORDS = 16;

const OWNERSHIP = String.raw`(?:\w+ ){0,3}(?:lane|domain|scope|side|area)`;
const SCOPE_NOUN = String.raw`(?:update|updates|step|steps|turn|transcript|segment|diff|change|changes|exploration|investigation|session|review|spawn|task|tasks|proposal|stage|point)`;
const SCOPE_TAIL = String.raw`(?: (?:yet|here|now|so far|for now|from me|for me|at this (?:stage|point)|this (?:turn|update|step)|to (?:add|flag|report|advise|raise|review)(?: for \w+)?|(?:in|within|from|outside|out of|beyond) (?:my |the |this )?${OWNERSHIP}|(?:in|on|for|from|at|during|with|about) (?:\w+ )?(?:this|the|my|that|these|its|your)(?: \w+){0,3} ${SCOPE_NOUN})){0,3}`;
const FINDING_NOUN = String.raw`(?:finding|findings|advice|issue|issues|concern|concerns|problem|problems|defect|defects|risk|risks|note|notes|critique|objection|objections|comment|comments)`;

/**
 * Whole-clause shapes (over {@link normalizeAdvisorNote} output) stating no
 * finding, silence, or the advisor's own lane. A no-finding note needs at
 * least one such clause.
 */
const NO_FINDING_MARKER_CLAUSES: readonly RegExp[] = [
	String.raw`(?:nit|concern|blocker|none|n a|lgtm|ok|okay|on track|carry on|continue|looks good|all good)`,
	String.raw`(?:(?:so )?i(?: m| am| will| ll) )?(?:staying |remaining |stay |remain |keep(?:ing)? )?(?:silent|silence)(?: (?:on|about) \w+(?: \w+)?)?${SCOPE_TAIL}`,
	String.raw`(?:so )?i(?: m| am)? (?:withhold|withholding|holding|hold)(?: my| further)? critique${SCOPE_TAIL}`,
	String.raw`(?:i have |still )?nothing(?: new| further| more| else)?(?: (?:\w+ ){0,3}(?:owned|related))?(?: (?:to|for me to) (?:add|flag|report|advise|raise|say|note))?${SCOPE_TAIL}`,
	String.raw`(?:\w+ check )?(?:there is |there are |i have |i see )?no (?:\w+ ){0,6}${FINDING_NOUN}${SCOPE_TAIL}`,
	String.raw`no further (?:\w+ ){0,2}(?:is |are )?(?:needed|required)${SCOPE_TAIL}`,
	String.raw`(?:out of|outside|not in|beyond) (?:my|the) ${OWNERSHIP}`,
].map(source => new RegExp(`^${source}$`));

/**
 * Whole-clause shapes describing the watched agent's progress or the review
 * context. Accepted only alongside a {@link NO_FINDING_MARKER_CLAUSES} clause.
 */
const NO_FINDING_CONTEXT_CLAUSES: readonly RegExp[] = [
	String.raw`(?:(?:\w+ )?(?:investigation|exploration|scouting|reading) only )?no (?:changed )?(?:lines|code|changes)(?: changed)?(?: (?:to review|under review))?(?: for \w+)?${SCOPE_TAIL}`,
	String.raw`(?:just )?(?:the |this )?(?:main )?(?:agent|user|scout|engineer)(?: is| s| has)? (?:has (?:made|asked|sent) (?:a |an |the )?\w+ and is )?(?:still |now |already |just )?(?:mid turn|mid investigation|mid flight|on track|in progress|(?:waiting|awaiting)(?: on| for)?(?: \w+){0,4}|(?:reading|locating|investigating|exploring|scouting|researching|doing read only)(?: \w+){0,8})(?: and (?:on track|mid turn))?`,
	String.raw`(?:the )?agent (?:has )?already (?:corrected|acted on|addressed|caught|handled)(?: \w+){0,6}`,
	String.raw`(?:\w+ ){0,2}(?:mid turn|mid investigation|mid flight|in progress)(?: and on track)?`,
	String.raw`(?:\w+ ){0,3}(?:is|are|looks) fine`,
	String.raw`(?:just )?(?:a |the )?read only (?:\w+ ){0,3}(?:task|scout|agent|spawn|lookup|exploration)(?: (?:has been|was|is) (?:spawned|started|launched|running))?`,
	String.raw`(?:the |this )?(?:proposal|update|step|change|task) (?:is|was) (?:a |an |just |only ){0,2}(?:\w+ ){0,4}(?:proposal|change|question|exploration|investigation|scouting|research|reading|mapping|task)(?: (?:outside|out of|beyond) (?:my|the) ${OWNERSHIP})?`,
	String.raw`(?:the )?answer is (?:\w+ )?(?:caveated|hedged|scoped)(?: \w+){0,6}`,
	String.raw`wait(?:ing)? (?:for|on) (?:the |a )?(?:\w+ ){0,2}(?:answer|answers|reply|result|results|user|engineer|scout|choices?)`,
	String.raw`\w+ check`,
].map(source => new RegExp(`^${source}$`));

/**
 * Whether a note carries no finding: at most {@link NO_FINDING_MAX_LENGTH}
 * characters, no {@link CONTENT_TOKEN} or {@link FINDING_CUE}, every clause
 * matching a marker or context shape, and at least one marker clause
 * ("Nothing in verification scope; no advice.", "Out of my lane (CI/release);
 * no owned finding. Silent.", a bare "nit"). A note citing a location,
 * identifier, or number never matches.
 *
 * Exported for tests.
 */
export function isNoFindingNote(note: string): boolean {
	const text = note.trim();
	if (!text || text.length > NO_FINDING_MAX_LENGTH) return false;
	if (CONTENT_TOKEN.test(text)) return false;
	if (FINDING_CUE.test(normalizeAdvisorNote(text))) return false;
	let marked = false;
	for (const part of text.replace(OWNERSHIP_PARENTHETICAL, "$1").split(CLAUSE_SPLIT)) {
		const clause = normalizeAdvisorNote(part);
		if (!clause) continue;
		if (clause.split(" ").length > NO_FINDING_MAX_CLAUSE_WORDS) return false;
		if (NO_FINDING_MARKER_CLAUSES.some(shape => shape.test(clause))) marked = true;
		else if (!NO_FINDING_CONTEXT_CLAUSES.some(shape => shape.test(clause))) return false;
	}
	return marked;
}

/**
 * Bounds the dedupe history. Sessions with very long advisor activity could
 * otherwise grow the set without bound. The reporter's pathological session
 * had 92 unique notes; 4096 leaves headroom while staying tiny (≤ ~256 KB of
 * normalized strings even at long max).
 */
const DEFAULT_HISTORY_CAPACITY = 4096;

/** Maximum non-blocker advise notes allowed per update cycle across all configurations. */
export const ADVISOR_MAX_BUDGET_PER_UPDATE = 32;

/** Default non-blocker advise notes allowed per update cycle when unspecified. */
export const ADVISOR_DEFAULT_BUDGET_PER_UPDATE = 4;

/** Why the guard suppressed a note. Surfaced verbatim in the tool acknowledgment. */
export type AdvisorSuppressionReason = "empty" | "noise" | "duplicate" | "rate-limit";

/**
 * The guard's admission decision for one `advise()` call — the single source
 * of truth `AdviseTool` acts on; the tool never re-infers eviction or
 * suppression policy from its own state.
 */
export interface AdvisorAdmission {
	/** Whether the note may reach the primary (routed now or held for a deferred flush). */
	accepted: boolean;
	/** Why a suppressed note was rejected. Set only when `accepted` is false. */
	reason?: AdvisorSuppressionReason;
	/**
	 * Normalized key of a still-pending note from the SAME update that this
	 * admission displaced (budget full, strictly higher severity). The caller
	 * MUST drop it from its pending backlog. Only pending notes are ever
	 * displaced — a note already routed to the primary keeps its budget slot,
	 * because a delivery cannot be retracted.
	 */
	displacedKey?: string;
}

/**
 * Decides whether an advisor `advise()` call should reach the primary agent.
 *
 * Enforces — in this order — the noise filter, session-scoped rank-aware
 * dedupe (FIFO-evicted at {@link DEFAULT_HISTORY_CAPACITY}), and a per-update
 * budget of admitted non-blocker notes. Suppressed calls never consume the
 * budget — a noise call doesn't burn the slot for a real concern that follows
 * in the same update. A `blocker` is exempt from the budget: it must always
 * interrupt, so a lower-severity note emitted earlier in the same update can
 * never rate-limit it out.
 *
 * Dedupe is rank-aware: re-raising the same text at a strictly higher
 * severity is a real escalation (nit → concern → blocker), not a repeat, and
 * is admitted — an already-delivered nit re-raised as a blocker still
 * interrupts. Equal or lower severity re-raises stay suppressed, so an
 * advisor cannot bypass dedupe by retagging the same text sideways.
 *
 * The budget is rank-aware within a single update: when it is full, a
 * strictly-higher-severity note displaces the lowest-rank STILL-PENDING slot
 * (a queued concern kicks out a queued nit) and the decision names the
 * displaced note via {@link AdvisorAdmission.displacedKey}. Routed notes
 * remain charged and cannot be displaced — delivery cannot be retracted to
 * free a slot. With a budget of 1 this collapses to one non-blocker per
 * update with concern-evicts-pending-nit; with the default budget 4, up to 4
 * non-blockers are admitted before displacement applies.
 *
 * Reset on advisor reset (compaction, session switch, `/new`) via
 * {@link reset}. Per-update budget is cleared at the start of every advisor
 * `agent.prompt()` cycle via {@link beginUpdate} (driven by
 * `AdviseTool.beginUpdate`).
 */
export class AdvisorEmissionGuard {
	/** Normalized key → highest admitted severity rank this session. A new call
	 *  passes only when its rank strictly exceeds the recorded one (a real
	 *  escalation), so equal/lower retags of the same text stay suppressed. */
	#seen = new Map<string, number>();
	/** Insertion-order log to drive FIFO eviction without a second Map. Keys are
	 *  pushed on first admission only; escalations update the rank in place. */
	#seenOrder: string[] = [];
	/** Budget slots charged this update, in admission order. Length ≤
	 *  #budgetPerUpdate. `pending` marks notes withheld behind an in-progress
	 *  primary turn: only those may be displaced by a strictly-higher-rank
	 *  admission; routed notes stay charged. */
	#slots: { key: string; rank: number; pending: boolean }[] = [];
	/** Malformed `advise` calls rejected this update. */
	#invalidCalls = 0;
	readonly #capacity: number;
	readonly #budgetPerUpdate: number;

	constructor(opts: { capacity?: number; budgetPerUpdate?: number } = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
		const budget = opts.budgetPerUpdate;
		this.#budgetPerUpdate =
			typeof budget === "number" && Number.isFinite(budget)
				? Math.min(ADVISOR_MAX_BUDGET_PER_UPDATE, Math.max(1, Math.trunc(budget)))
				: ADVISOR_DEFAULT_BUDGET_PER_UPDATE;
	}

	/**
	 * Drop all dedupe and per-update state. Called when the advisor runtime is
	 * reset — same boundary as `yieldQueue.clear("advisor")`, so a re-primed
	 * advisor can re-raise old issues (the primary transcript was rewritten).
	 * Driven by `AdviseTool.resetDeliveredNotes()`.
	 */
	reset(): void {
		this.#seen.clear();
		this.#seenOrder.length = 0;
		this.#slots = [];
		this.#invalidCalls = 0;
	}

	/**
	 * Clear the per-update budget. Called at the start of every advisor
	 * `agent.prompt()` cycle (via `AdviseTool.beginUpdate`) so the next advisor
	 * model cycle starts with a fresh budget. Notes still pending from earlier
	 * updates keep their reservations — they hold no slot here and cannot be
	 * displaced by the new update's admissions.
	 */
	beginUpdate(): void {
		this.#slots = [];
		this.#invalidCalls = 0;
	}

	/**
	 * Count one malformed `advise` call against this update. Returns `true` for
	 * the first rejection (the advisor may retry once) and `false` once the
	 * update's single retry is spent (the call is dropped).
	 */
	recordInvalidCall(): boolean {
		this.#invalidCalls++;
		return this.#invalidCalls === 1;
	}

	/**
	 * Record that a still-pending note was re-raised at a strictly higher
	 * severity and is being escalated in place — no new admission, no extra
	 * budget. Keeps the dedupe rank and any current-update slot coherent, so a
	 * later equal/lower repeat of the finding stays suppressed and displacement
	 * compares the note's real rank. The finding is identified by `defect` and
	 * `ref` as in {@link admit}. No-op when `rank` does not exceed the recorded
	 * rank.
	 */
	escalatePending(defect: string, rank: number, ref?: string): void {
		const key = advisorDedupeKey(defect, ref);
		if (!key) return;
		const seenRank = this.#seen.get(key) ?? 0;
		if (rank <= seenRank) return;
		// Shares admit's bounded recording: a key that aged out of the FIFO
		// history and is re-tracked here MUST re-enter the eviction queue,
		// otherwise it becomes a permanent, unevictable entry.
		this.#recordRank(key, rank);
		const slot = this.#slots.find(s => s.key === key);
		if (slot && slot.rank < rank) slot.rank = rank;
	}

	/**
	 * Record the highest admitted rank for a key, FIFO-bounding the history:
	 * first-seen keys enter the eviction queue and the oldest entry is dropped
	 * beyond {@link #capacity}. The single recording path shared by {@link
	 * admit} and {@link escalatePending}.
	 */
	#recordRank(key: string, rank: number): void {
		const isNew = !this.#seen.has(key);
		this.#seen.set(key, rank);
		if (!isNew) return;
		this.#seenOrder.push(key);
		if (this.#seenOrder.length > this.#capacity) {
			const stale = this.#seenOrder.shift();
			if (stale !== undefined) this.#seen.delete(stale);
		}
	}

	/**
	 * Mark a previously admitted pending finding (`defect` and `ref` as in
	 * {@link admit}) as routed to the primary (a deferred flush delivered it).
	 * Its budget slot — when still within the originating update — becomes
	 * non-displaceable: a routed note cannot be retracted to free budget. No-op
	 * once the update boundary has cleared the slot.
	 */
	markRouted(defect: string, ref?: string): void {
		const key = advisorDedupeKey(defect, ref);
		const slot = this.#slots.find(s => s.key === key);
		if (slot) slot.pending = false;
	}

	/**
	 * Decide whether the proposed finding may reach the primary. The decision
	 * is the single admission authority: on `accepted` the guard has recorded
	 * the note (consumed budget where due, updated the dedupe rank) and names
	 * any displaced pending note; on rejection the `reason` is the truthful
	 * classification for the advisor-facing acknowledgment.
	 *
	 * `defect` is filtered against the content-free phrase list and
	 * {@link isNoFindingNote}, independent of the anchor. Dedupe keys on
	 * {@link advisorDedupeKey}(`defect`, `ref`). `pending` declares the caller's
	 * routing intent: withheld behind an in-progress primary turn (displaceable
	 * by a later strictly-higher-rank admission this update) versus routed
	 * immediately (charged, never displaceable). A note that fails the
	 * noise/empty/dedupe filter never consumes the budget, so a suppressed
	 * phrase cannot burn the update's slot ahead of a substantive concern.
	 */
	admit(defect: string, opts: { rank: number; pending: boolean; ref?: string }): AdvisorAdmission {
		const normalized = normalizeAdvisorNote(defect);
		if (!normalized) return { accepted: false, reason: "empty" };
		if (SUPPRESSED_NORMALIZED_PHRASES[normalized] || isNoFindingNote(defect)) {
			return { accepted: false, reason: "noise" };
		}
		const key = advisorDedupeKey(defect, opts.ref);
		const rank = opts.rank;
		const seenRank = this.#seen.get(key) ?? 0;
		if (rank <= seenRank) return { accepted: false, reason: "duplicate" };
		// Admitted: a fresh note, or a strictly-higher-rank re-raise of an
		// already-admitted note (a real escalation).
		let displacedKey: string | undefined;
		const ownSlot = this.#slots.find(s => s.key === key);
		if (rank >= 3) {
			// Blockers: unlimited per update — never dropped to the budget. A
			// blocker escalation of a still-pending note releases its slot: the
			// note now routes live, so the reservation will never flush. A
			// routed slot stays charged — delivery cannot be retracted.
			if (ownSlot?.pending) this.#slots.splice(this.#slots.indexOf(ownSlot), 1);
		} else if (ownSlot) {
			// Same-update severity escalation of an already-admitted note (e.g. a
			// routed nit re-raised as a concern): upgrade the slot's rank instead
			// of charging a second slot for the same text.
			ownSlot.rank = rank;
		} else if (this.#slots.length < this.#budgetPerUpdate) {
			this.#slots.push({ key, rank, pending: opts.pending });
		} else {
			// Budget full: a strictly-higher-rank note displaces the lowest-rank
			// still-pending slot (concern kicks out a queued nit). Same or lower
			// rank — or a budget spent entirely on routed notes — is rate-limited.
			let minIndex = -1;
			for (let i = 0; i < this.#slots.length; i++) {
				const slot = this.#slots[i]!;
				if (!slot.pending) continue;
				if (minIndex === -1 || slot.rank < this.#slots[minIndex]!.rank) minIndex = i;
			}
			if (minIndex !== -1 && rank > this.#slots[minIndex]!.rank) {
				displacedKey = this.#slots[minIndex]!.key;
				this.#slots[minIndex] = { key, rank, pending: opts.pending };
			} else {
				return { accepted: false, reason: "rate-limit" };
			}
		}
		this.#recordRank(key, rank);
		return displacedKey === undefined ? { accepted: true } : { accepted: true, displacedKey };
	}
}
