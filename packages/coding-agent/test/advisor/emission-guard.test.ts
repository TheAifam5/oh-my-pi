import { describe, expect, it } from "bun:test";
import {
	AdvisorEmissionGuard,
	advisorDedupeKey,
	isNoFindingNote,
	normalizeAdvisorNote,
} from "../../src/advisor/emission-guard";

describe("normalizeAdvisorNote", () => {
	it("collapses punctuation, casing, and surrounding whitespace into one canonical key", () => {
		// The reporter's three top duplicates all key to the same canonical form
		// regardless of trailing punctuation or casing — that's what makes the
		// dedupe + suppression checks single-membership.
		expect(normalizeAdvisorNote("Stop.")).toBe("stop");
		expect(normalizeAdvisorNote("  STOP!  ")).toBe("stop");
		expect(normalizeAdvisorNote("*Stop*")).toBe("stop");
		expect(normalizeAdvisorNote("Done.")).toBe("done");
		expect(normalizeAdvisorNote("No issue; continue.")).toBe("no issue continue");
	});

	it("returns empty string for whitespace-only input so callers can short-circuit", () => {
		expect(normalizeAdvisorNote("")).toBe("");
		expect(normalizeAdvisorNote("   ")).toBe("");
		expect(normalizeAdvisorNote("...")).toBe("");
	});

	it("preserves internal letters/digits but folds non-alphanumeric runs to one space", () => {
		expect(normalizeAdvisorNote("Refactor `auth-flow.ts`: drop legacy branch.")).toBe(
			"refactor auth flow ts drop legacy branch",
		);
	});
});

describe("AdvisorEmissionGuard", () => {
	it("drops the exact content-free filler the reporter observed flooding the chat", () => {
		// Issue #3520: 114× "Stop.", 52× "No issue; continue.", 41× "Done." —
		// none of these carry a concrete reason and they cannot be acted on, so
		// the guard suppresses them regardless of severity.
		const guard = new AdvisorEmissionGuard();
		for (const note of ["Stop.", "Done.", "No issue; continue.", "LGTM", "No further watcher input needed."]) {
			expect(guard.admit(note, { rank: 1, pending: false })).toEqual({ accepted: false, reason: "noise" });
		}
	});

	it("dedupes by normalized text across the session, ignoring casing and trailing punctuation", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.admit("Move retries into the queue, not the request path.", { rank: 1, pending: false })).toEqual({
			accepted: true,
		});
		// Same advice with different casing and trailing punctuation must NOT
		// land twice in the primary transcript.
		expect(guard.admit("move retries into the queue, not the request path", { rank: 1, pending: false })).toEqual({
			accepted: false,
			reason: "duplicate",
		});
		expect(guard.admit("Move retries into the queue, not the request path!", { rank: 1, pending: false })).toEqual({
			accepted: false,
			reason: "duplicate",
		});
	});

	it("limits each update to four non-blockers by default", () => {
		// #3520's anti-flood clamp lives beside the upstream default: four
		// distinct notes from one advisor cycle are fine; the fifth is the flood.
		const guard = new AdvisorEmissionGuard();
		for (let i = 1; i <= 4; i++) {
			expect(guard.admit(`Distinct concern ${i}.`, { rank: 2, pending: false }).accepted).toBe(true);
		}
		expect(guard.admit("Distinct concern 5.", { rank: 2, pending: false })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
		guard.beginUpdate();
		// New cycle: budget reset.
		expect(guard.admit("Distinct concern 5.", { rank: 2, pending: false }).accepted).toBe(true);
	});

	it("rate-limits a second distinct non-blocker per update under an explicit budget of 1", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("First concern: missing await in #handleRetry.", { rank: 2, pending: false })).toEqual({
			accepted: true,
		});
		expect(guard.admit("Second concern: wrong env var name.", { rank: 2, pending: false })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("does not let a suppressed call consume the per-update budget", () => {
		// A noise call like "Stop." must never displace a real concern that
		// follows in the same advisor model cycle.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Stop.", { rank: 2, pending: false })).toEqual({ accepted: false, reason: "noise" });
		expect(guard.admit("Concrete: read race in #handleRetry.", { rank: 2, pending: false }).accepted).toBe(true);
	});

	it("does not let a deduped call consume the per-update budget", () => {
		// A repeat of a prior session note is dropped, but the model can still
		// follow it with a fresh concrete concern in the same cycle.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Concrete: read race in #handleRetry.", { rank: 2, pending: false }).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("Concrete: read race in #handleRetry.", { rank: 2, pending: false })).toEqual({
			accepted: false,
			reason: "duplicate",
		});
		expect(guard.admit("New concern: cache eviction never fires.", { rank: 2, pending: false }).accepted).toBe(true);
	});

	it("lets any number of blockers through while non-blockers share the budget", () => {
		// The per-update budget exists to stop nit/concern floods (#3520). A
		// blocker reports broken handoff — losing it because a concern was emitted
		// first in the same cycle loses the one note that must always land.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Concern: only one of three reads done.", { rank: 2, pending: false })).toEqual({
			accepted: true,
		});
		expect(guard.admit("Blocker: the run stopped before the third read.", { rank: 3, pending: false })).toEqual({
			accepted: true,
		});
		expect(guard.admit("Blocker: the diff was never exercised end to end.", { rank: 3, pending: false })).toEqual({
			accepted: true,
		});
		// The budget is still spent for non-blockers.
		expect(guard.admit("Nit: consider a shorter loop.", { rank: 1, pending: false })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
		// Noise and dedupe still apply to blockers.
		expect(guard.admit("Blocker: the run stopped before the third read.", { rank: 3, pending: false })).toEqual({
			accepted: false,
			reason: "duplicate",
		});
	});

	it("lets a higher-severity note displace a still-pending nit and names the displaced note", () => {
		// Escalation within one cycle is not a flood: the concern takes the
		// pending nit's slot, and the decision identifies the displaced note so
		// the caller can drop it from its backlog without inferring policy.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Nit: rename the helper for clarity.", { rank: 1, pending: true })).toEqual({
			accepted: true,
		});
		expect(guard.admit("Concern: the helper drops the lock early.", { rank: 2, pending: true })).toEqual({
			accepted: true,
			displacedKey: "nit rename the helper for clarity",
		});
		// Equal or lower rank after the concern stays dropped.
		expect(guard.admit("Nit: also fix the comment.", { rank: 1, pending: true })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
		expect(guard.admit("Concern: second concern.", { rank: 2, pending: true })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("never displaces a routed note to free budget — delivery cannot be retracted", () => {
		// A note already routed to the primary keeps its slot: a later concern
		// in the same update must not create an over-budget second delivery by
		// "evicting" a delivery that already happened.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Nit: rename the helper.", { rank: 1, pending: false })).toEqual({ accepted: true });
		expect(guard.admit("Concern: the helper drops the lock early.", { rank: 2, pending: false })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("stops displacing a pending note once markRouted reports it delivered", () => {
		// A deferred flush routes the note without a new update boundary; its
		// slot stays charged but becomes non-displaceable.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Nit: rename the helper.", { rank: 1, pending: true })).toEqual({ accepted: true });
		guard.markRouted("Nit: rename the helper.");
		expect(guard.admit("Concern: the helper drops the lock early.", { rank: 2, pending: true })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("admits a same-text blocker escalation of an already-routed note without reopening budget", () => {
		// The production failure: a delivered nit re-raised as a blocker must
		// still interrupt — dedupe is rank-aware, not a hard text wall. The
		// routed slot stays charged (no retraction), the blocker is exempt, and
		// equal/lower retags afterwards stay suppressed.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		const note = "The migration drops the users table without a backup.";
		expect(guard.admit(note, { rank: 1, pending: false })).toEqual({ accepted: true });
		expect(guard.admit("THE MIGRATION DROPS THE USERS TABLE WITHOUT A BACKUP!", { rank: 3, pending: false })).toEqual(
			{ accepted: true },
		);
		expect(guard.admit(note, { rank: 2, pending: false })).toEqual({ accepted: false, reason: "duplicate" });
		expect(guard.admit(note, { rank: 1, pending: false })).toEqual({ accepted: false, reason: "duplicate" });
	});

	it("releases the budget slot when a still-pending note escalates to blocker", () => {
		// The reservation will never flush — the note routes live as a blocker —
		// so its pending slot is freed for the rest of the update.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		const note = "The migration drops the users table without a backup.";
		expect(guard.admit(note, { rank: 2, pending: true })).toEqual({ accepted: true });
		expect(guard.admit(note, { rank: 3, pending: false })).toEqual({ accepted: true });
		expect(guard.admit("Concern: the rollback path is untested.", { rank: 2, pending: true })).toEqual({
			accepted: true,
		});
	});

	it("tracks in-place pending escalation so eviction compares the real rank", () => {
		// A queued nit re-raised as a concern is escalated in place (no new
		// admission). escalatePending keeps the slot rank coherent: an equal-rank
		// newcomer afterwards is rate-limited, not waved through as an eviction.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		const note = "Issue A.";
		expect(guard.admit(note, { rank: 1, pending: true })).toEqual({ accepted: true });
		guard.escalatePending(note, 2);
		expect(guard.admit("Issue B.", { rank: 2, pending: true })).toEqual({ accepted: false, reason: "rate-limit" });
		// The escalated text is now recorded at concern rank: equal/lower retags
		// dedupe, a blocker still routes.
		expect(guard.admit(note, { rank: 2, pending: true })).toEqual({ accepted: false, reason: "duplicate" });
		expect(guard.admit(note, { rank: 3, pending: false })).toEqual({ accepted: true });
	});

	it("treats a same-update severity re-raise of a routed note as one charged slot", () => {
		// The same text at higher severity is the same note reclassified, not a
		// second note: the slot upgrades in place instead of double-charging.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 2 });
		const note = "The helper drops the lock early.";
		expect(guard.admit(note, { rank: 1, pending: false })).toEqual({ accepted: true });
		expect(guard.admit(note, { rank: 2, pending: false })).toEqual({ accepted: true });
		// Only one of the two budget slots was spent.
		expect(guard.admit("Distinct nit: naming.", { rank: 1, pending: false })).toEqual({ accepted: true });
		expect(guard.admit("Distinct nit: formatting.", { rank: 1, pending: false })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("reset clears dedupe and the per-update gate so a re-primed advisor can re-raise old issues", () => {
		// Compaction / session-switch rewrites the primary transcript. The
		// advisor is re-primed from scratch and may legitimately re-raise the
		// same concerns — they're new context for a freshly-primed reviewer.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Race in #handleRetry.", { rank: 2, pending: false }).accepted).toBe(true);
		expect(guard.admit("Race in #handleRetry.", { rank: 2, pending: false }).accepted).toBe(false);
		guard.reset();
		expect(guard.admit("Race in #handleRetry.", { rank: 2, pending: false }).accepted).toBe(true);
	});

	it("keeps dedupe history bounded when a pending escalation re-tracks an evicted key", () => {
		// escalatePending must share admit's FIFO-bounded recording: a key that
		// aged out of the history and is re-tracked by an in-place escalation
		// would otherwise bypass the eviction queue and become a permanent,
		// unevictable entry.
		const guard = new AdvisorEmissionGuard({ capacity: 1 });
		expect(guard.admit("Issue A.", { rank: 1, pending: true }).accepted).toBe(true);
		guard.beginUpdate();
		// Admitting B evicts A from the capacity-1 history.
		expect(guard.admit("Issue B.", { rank: 1, pending: true }).accepted).toBe(true);
		// A is re-tracked via in-place escalation while still pending; it
		// re-enters the eviction queue as the oldest entry.
		guard.escalatePending("Issue A.", 2);
		guard.beginUpdate();
		// Admitting C evicts A again (oldest tracked). With the leak, A would
		// stay tracked forever and the final re-raise would be a false duplicate.
		expect(guard.admit("Issue C.", { rank: 1, pending: true }).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("Issue A.", { rank: 2, pending: true }).accepted).toBe(true);
	});

	it("evicts oldest entries when dedupe history exceeds capacity", () => {
		// Bounded so very long sessions cannot grow the dedupe state without
		// bound. Pre-eviction unique notes are remembered; post-eviction the
		// oldest one is forgotten and can resurface.
		const guard = new AdvisorEmissionGuard({ capacity: 3 });
		expect(guard.admit("first", { rank: 1, pending: false }).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("second", { rank: 1, pending: false }).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("third", { rank: 1, pending: false }).accepted).toBe(true);
		guard.beginUpdate();
		// "first" still in history.
		expect(guard.admit("first", { rank: 1, pending: false }).accepted).toBe(false);
		guard.beginUpdate();
		// Fourth unique entry evicts "first".
		expect(guard.admit("fourth", { rank: 1, pending: false }).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("first", { rank: 1, pending: false }).accepted).toBe(true);
	});

	it("rejects empty / whitespace-only notes without consuming the budget", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("", { rank: 1, pending: false })).toEqual({ accepted: false, reason: "empty" });
		expect(guard.admit("   ", { rank: 1, pending: false })).toEqual({ accepted: false, reason: "empty" });
		expect(guard.admit("Concrete advice.", { rank: 1, pending: false }).accepted).toBe(true);
	});

	it("end-to-end: the reporter's 309-call spam log yields a single unique note", () => {
		// Mimic the issue's distribution: 114× "Stop.", 52× "No issue; continue.",
		// 41× "Done.", plus 102 copies of one concrete-but-repeated nit. Spread
		// the calls across 50 advisor update cycles. Noise phrases never pass;
		// identical-text repeats never escape the session dedupe. After all
		// calls, exactly the concrete nit has been admitted — and only once.
		const guard = new AdvisorEmissionGuard();
		const accepted: string[] = [];
		const stream: string[] = [
			...Array(114).fill("Stop."),
			...Array(52).fill("No issue; continue."),
			...Array(41).fill("Done."),
			...Array(102).fill("Concrete-but-repeated nit: x"),
		];
		// Interleave across 50 update cycles.
		const cycles = 50;
		const perCycle = Math.ceil(stream.length / cycles);
		for (let c = 0; c < cycles; c++) {
			guard.beginUpdate();
			for (let i = 0; i < perCycle; i++) {
				const note = stream[c * perCycle + i];
				if (note === undefined) break;
				if (guard.admit(note, { rank: 1, pending: false }).accepted) accepted.push(note);
			}
		}
		expect(accepted).toEqual(["Concrete-but-repeated nit: x"]);
	});

	it("keys dedupe on the trimmed ref plus the normalized defect", () => {
		expect(advisorDedupeKey("Budget never decrements!", " src/retry.ts:42 ")).toBe(
			"src/retry.ts:42\nbudget never decrements",
		);
		expect(advisorDedupeKey("...", "src/retry.ts")).toBe("");
		const guard = new AdvisorEmissionGuard();
		const defect = "Budget never decrements.";
		expect(guard.admit(defect, { rank: 1, pending: false, ref: "src/retry.ts:42" }).accepted).toBe(true);
		expect(guard.admit("budget never decrements", { rank: 1, pending: false, ref: "src/retry.ts:42" })).toEqual({
			accepted: false,
			reason: "duplicate",
		});
		expect(guard.admit(defect, { rank: 1, pending: false, ref: "src/queue.ts:7" }).accepted).toBe(true);
		expect(guard.admit(defect, { rank: 2, pending: false, ref: "src/retry.ts:42" }).accepted).toBe(true);
		expect(guard.admit("Done.", { rank: 1, pending: false, ref: "src/retry.ts:42" })).toEqual({
			accepted: false,
			reason: "noise",
		});
	});

	it("allows one invalid-call retry per update and resets it with the update and on reset", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.recordInvalidCall()).toBe(true);
		expect(guard.recordInvalidCall()).toBe(false);
		expect(guard.recordInvalidCall()).toBe(false);
		guard.beginUpdate();
		expect(guard.recordInvalidCall()).toBe(true);
		guard.reset();
		expect(guard.recordInvalidCall()).toBe(true);
	});
});

describe("isNoFindingNote", () => {
	// Real advise() notes from watchdog advisor transcripts that reached the
	// primary as `<advisory>` cards while carrying no finding.
	const realFiller = [
		"Nothing in verification scope; no advice.",
		"Silent: agent is mid-investigation and on track.",
		"No finding from me: this update is a UI/billing-text proposal, outside my domain (dependencies, build, CI, release, packaging).",
		"Out of my lane (dependency/CI/release); no owned finding in this transcript segment. Silent.",
		"Mid-turn; no UI-domain concern here. Silent.",
		"nit",
		"Silence.",
		"Silent.",
		"Outside my domain (delivery/dependency/CI/release config). No finding to report.",
		"Nothing to flag in my lane.",
		"Silent: no owned style finding in the transcript so far.",
		"Rebase mid-flight is fine; nothing to flag yet.",
		"Nothing to flag: no code changed this turn, so there is no layout issue to report.",
		"Nothing new to flag. The agent has already corrected its overclaim about evidence, so no further advice is needed.",
		"Docs check: no finding. Rebasing is in progress; I'm silent.",
		"No owned install/upgrade/persisted-state finding in this update.",
		"Nothing from the concurrency/resource domain to flag on this update.",
		"No concurrency or resource issue here; the proposal is a display-only change.",
		"Nothing verification-owned; the agent has made a proposal and is awaiting the user's choices.",
		"Nothing in verification scope; the answer is correctly caveated as docs/code-read, not tested.",
		"Nothing to add on the new tasks yet. This is mid-investigation, so I withhold critique.",
		"Nothing for me to flag in this update, so I'm staying silent.",
	];

	// Real advise() notes from the same transcripts that carry a finding,
	// including ones that open with a no-finding phrase.
	const realFindings = [
		"Nothing in verification scope; continue reading resolveCliModel at model-resolver.ts:2188.",
		"Nothing in the transcript's changed lines needs a style note yet. When you edit model-browser.ts:730 and the billing summary, run `oxfmt` on the changed files and keep one statement per line.",
		"No verification issue; keep tracing resolveCliModel for @role-with-pool, then state the answer with its read-only basis.",
		"Nothing in verification scope; wait for the build/smoke-test result before claiming the rebuild.",
		"Nothing in my domain. The pin-persistence question (session-file credential_pin) is a design choice with no concrete before/after migration or recovery transition yet.",
		"Silent on concurrency: the agent is reading how `auth.accountPolicies` is structured, which is the natural home for a per-account reset policy. It has not written any code yet.",
		"Don't edit global WATCHDOG.md or WATCHDOG.yml to fix silence.",
		"The isolated rerun exited 1 with no output, so it gave no evidence either way.",
		"`cargo metadata failed` is most likely caused by the isolated HOME. cargo and rustup resolve ~/.cargo and ~/.rustup from HOME.",
		"You killed StatsAccountsPage mid-run. Run `git status` in the maxxed worktree now.",
	];

	it("classifies real content-free advisor notes as no-finding", () => {
		expect(realFiller.filter(note => !isNoFindingNote(note))).toEqual([]);
	});

	it("keeps real findings, including ones that open with a no-finding phrase", () => {
		expect(realFindings.filter(note => isNoFindingNote(note))).toEqual([]);
	});

	it("classifies stay/remain/keep and future-tense silence statements as no-finding", () => {
		for (const note of [
			"I will stay silent.",
			"I'll keep silent here.",
			"Remaining silent for now.",
			"Keeping silent this turn.",
			"Staying silent on this update.",
		]) {
			expect(isNoFindingNote(note)).toBe(true);
		}
	});

	it("keeps short findings phrased with no-finding words", () => {
		for (const note of [
			"No lock around the cache write; two writers can interleave.",
			"No tests for the new path; nothing else to flag.",
			"No issue with the parser, the retry loop spins forever.",
			"Nothing handles the empty queue case.",
			"No owned finding, but the lease push needs the old tip.",
			"No concern on style; see emission-guard.ts:282.",
			"Nothing in the lock protects the cache write.",
			"No input in the request body.",
			"Outside my domain (token exposed at auth.ts:42). No finding to report.",
			"Silent failure: the catch block swallows the write error.",
		]) {
			expect(isNoFindingNote(note)).toBe(false);
		}
	});

	it("keeps progress-only notes that state no explicit absence of findings", () => {
		for (const note of ["Agent is still reading the old schema and deleting live rows.", "looks fine"]) {
			expect(isNoFindingNote(note)).toBe(false);
		}
	});

	it("keeps notes beyond the length bound", () => {
		expect(isNoFindingNote(`Nothing to flag ${"in this update ".repeat(20)}`)).toBe(false);
	});

	it("bounds matching time on adversarial clause repetition", () => {
		let note = "nothing";
		while (note.length < 180) note += " in my lane";
		const started = performance.now();
		expect(isNoFindingNote(`${note} b c d e f`)).toBe(false);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("drops a no-finding defect as noise without spending the budget, whatever the anchor", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		for (const ref of ["review", "src/retry.ts:42", "`bun test`", undefined]) {
			for (const defect of realFiller) {
				expect(guard.admit(defect, { rank: 2, pending: false, ref })).toEqual({
					accepted: false,
					reason: "noise",
				});
			}
		}
		expect(guard.admit(realFindings[0]!, { rank: 2, pending: false, ref: "review" })).toEqual({ accepted: true });
	});
});
