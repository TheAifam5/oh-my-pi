import { describe, expect, it } from "bun:test";
import {
	AdvisorEmissionGuard,
	advisorDedupeKey,
	isNoFindingNote,
	normalizeAdvisorNote,
} from "../../src/advisor/emission-guard";

/** Admission options for a report keyed by its own text. */
function finding(key: string, rank: number, pending = false, newFinding = true) {
	return { rank, pending, key, newFinding };
}

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
		// none of these carry a concrete reason, so the guard suppresses them
		// regardless of severity or ledger state.
		const guard = new AdvisorEmissionGuard();
		for (const note of ["Stop.", "Done.", "No issue; continue.", "LGTM", "No further watcher input needed."]) {
			expect(guard.admit(note, finding(note, 1))).toEqual({ accepted: false, reason: "noise" });
			expect(guard.admit(note, finding(note, 1, false, false))).toEqual({ accepted: false, reason: "noise" });
		}
	});

	it("holds no cross-update dedupe: the same report is admitted again in a later update", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		const note = "Move retries into the queue, not the request path.";
		expect(guard.admit(note, finding("a", 1))).toEqual({ accepted: true });
		guard.beginUpdate();
		expect(guard.admit(note, finding("a", 1))).toEqual({ accepted: true });
	});

	it("limits each update to four new non-blocker findings by default", () => {
		const guard = new AdvisorEmissionGuard();
		for (let i = 1; i <= 4; i++) {
			expect(guard.admit(`Distinct concern ${i}.`, finding(`k${i}`, 2)).accepted).toBe(true);
		}
		expect(guard.admit("Distinct concern 5.", finding("k5", 2))).toEqual({ accepted: false, reason: "rate-limit" });
		guard.beginUpdate();
		expect(guard.admit("Distinct concern 5.", finding("k5", 2)).accepted).toBe(true);
	});

	it("never charges a report attached to an existing finding", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("First concern: missing await in #handleRetry.", finding("a", 2)).accepted).toBe(true);
		for (let i = 0; i < 5; i++) {
			expect(guard.admit(`Corroboration ${i}: same await.`, finding("a", 2, false, false))).toEqual({
				accepted: true,
			});
		}
		expect(guard.admit("Second concern: wrong env var name.", finding("b", 2))).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("does not let a suppressed call consume the per-update budget", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Stop.", finding("a", 2))).toEqual({ accepted: false, reason: "noise" });
		expect(guard.admit("Concrete: read race in #handleRetry.", finding("b", 2)).accepted).toBe(true);
	});

	it("lets any number of blockers through while non-blockers share the budget", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Concern: only one of three reads done.", finding("a", 2))).toEqual({ accepted: true });
		expect(guard.admit("Blocker: the run stopped before the third read.", finding("b", 3))).toEqual({
			accepted: true,
		});
		expect(guard.admit("Blocker: the diff was never exercised end to end.", finding("c", 3))).toEqual({
			accepted: true,
		});
		expect(guard.admit("Nit: consider a shorter loop.", finding("d", 1))).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("lets a higher-severity finding displace a still-pending nit and names the displaced key", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Nit: rename the helper for clarity.", finding("nit", 1, true))).toEqual({ accepted: true });
		expect(guard.admit("Concern: the helper drops the lock early.", finding("concern", 2, true))).toEqual({
			accepted: true,
			displacedKey: "nit",
		});
		expect(guard.admit("Nit: also fix the comment.", finding("nit2", 1, true))).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
		expect(guard.admit("Concern: second concern.", finding("concern2", 2, true))).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("never displaces a routed note to free budget — delivery cannot be retracted", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Nit: rename the helper.", finding("a", 1))).toEqual({ accepted: true });
		expect(guard.admit("Concern: the helper drops the lock early.", finding("b", 2))).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("stops displacing a pending note once markRouted reports it delivered", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Nit: rename the helper.", finding("a", 1, true))).toEqual({ accepted: true });
		guard.markRouted("a");
		expect(guard.admit("Concern: the helper drops the lock early.", finding("b", 2, true))).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("releases the budget slot when a still-pending finding escalates to blocker", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		const note = "The migration drops the users table without a backup.";
		expect(guard.admit(note, finding("a", 2, true))).toEqual({ accepted: true });
		expect(guard.admit(note, finding("a", 3))).toEqual({ accepted: true });
		expect(guard.admit("Concern: the rollback path is untested.", finding("b", 2, true))).toEqual({
			accepted: true,
		});
	});

	it("tracks in-place pending escalation so displacement compares the real rank", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Issue A.", finding("a", 1, true))).toEqual({ accepted: true });
		guard.escalatePending("a", 2);
		expect(guard.admit("Issue B.", finding("b", 2, true))).toEqual({ accepted: false, reason: "rate-limit" });
	});

	it("treats a same-update re-admission of one finding key as one charged slot", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 2 });
		const note = "The helper drops the lock early.";
		expect(guard.admit(note, finding("a", 1))).toEqual({ accepted: true });
		expect(guard.admit(note, finding("a", 2))).toEqual({ accepted: true });
		expect(guard.admit("Distinct nit: naming.", finding("b", 1))).toEqual({ accepted: true });
		expect(guard.admit("Distinct nit: formatting.", finding("c", 1))).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("reset clears the per-update gate", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Race in #handleRetry.", finding("a", 2)).accepted).toBe(true);
		expect(guard.admit("Leak in #close.", finding("b", 2)).accepted).toBe(false);
		guard.reset();
		expect(guard.admit("Leak in #close.", finding("b", 2)).accepted).toBe(true);
	});

	it("rejects empty / whitespace-only notes without consuming the budget", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("", finding("a", 1))).toEqual({ accepted: false, reason: "empty" });
		expect(guard.admit("   ", finding("a", 1))).toEqual({ accepted: false, reason: "empty" });
		expect(guard.admit("Concrete advice.", finding("a", 1)).accepted).toBe(true);
	});

	it("keys a report on the trimmed anchor plus the normalized defect", () => {
		expect(advisorDedupeKey("Budget never decrements!", " src/retry.ts:42 ")).toBe(
			"src/retry.ts:42\nbudget never decrements",
		);
		expect(advisorDedupeKey("...", "src/retry.ts")).toBe("");
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
		for (const key of ["review", "src/retry.ts:42", "`bun test`", ""]) {
			for (const defect of realFiller) {
				expect(guard.admit(defect, finding(key, 2))).toEqual({
					accepted: false,
					reason: "noise",
				});
			}
		}
		expect(guard.admit(realFindings[0]!, finding("review", 2))).toEqual({ accepted: true });
	});
});
