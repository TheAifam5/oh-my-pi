import type { ChoiceQuestion, Judge, JudgeOptions, JsonValue, Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { JudgeKind } from "../judgment";
import findingsJudgeTemplate from "../prompts/advisor/findings-judge.md" with { type: "text" };
import type { AdvisorCategory } from "./config";
import type { AdvisorFinding, AdvisorFindingsLedger } from "./findings-ledger";

/** `advisor.aggregation.judge` settings. */
export interface FindingsJudgeSettings {
	enabled: boolean;
	/** Model selector; `@judge` is the `judge` model role. */
	model: string;
	timeoutMs: number;
	/** Whether report text may reach a judge on another provider than its advisors'. */
	allowCrossProvider: boolean;
}

/** Judge candidates tried in chain order; `model` is the candidate a call is about to reach. */
export interface FindingsJudgeCandidates {
	withCandidate<T>(
		run: (judge: Judge, kind: JudgeKind, model: Model) => Promise<T>,
		options?: JudgeOptions,
	): Promise<T>;
}

/** One judge pass over the findings an advisor update touched. */
export interface FindingsJudgePass {
	ledger: AdvisorFindingsLedger;
	/** Findings that received a report during the update. */
	touched: Iterable<AdvisorFinding>;
	categories: readonly AdvisorCategory[];
	settings: FindingsJudgeSettings;
	judge: FindingsJudgeCandidates;
	/** Provider of the advisor named `advisor`'s model; undefined when unknown. */
	providerOf: (advisor: string) => string | undefined;
}

/** What one judge pass did, counted per anchor group. */
export interface FindingsJudgeOutcome {
	/** Groups the judge answered. */
	judged: number;
	/** Findings merged into another one. */
	merged: number;
	/** Groups skipped because a candidate's provider differs from a source advisor's. */
	blocked: number;
	/** Groups whose judgment failed, timed out, or returned an unusable answer. */
	failed: number;
}

const VERDICTS = ["same", "distinct"] as const;
type Verdict = (typeof VERDICTS)[number];

const BLOCKED = Symbol("findings-judge.blocked");

function findingState(finding: AdvisorFinding): JsonValue {
	return {
		id: finding.id,
		category: finding.category,
		anchor: finding.anchor,
		reports: finding.reports.map(report => {
			const entry: Record<string, string> = { kind: report.kind, defect: report.defect };
			if (report.severity) entry.severity = report.severity;
			if (report.impact) entry.impact = report.impact;
			if (report.fix) entry.fix = report.fix;
			return entry;
		}),
	};
}

/**
 * Ask the judge whether findings sharing an anchor are the same defect. Only
 * anchor groups holding open findings in at least two categories, one of them
 * touched, are judged, one request per group with one `same`/`distinct`
 * question per pair that includes a touched finding. Findings judged `same`
 * merge into the one whose category has the highest precedence (the oldest on
 * a tie). Before each candidate call, the candidate's provider must equal the
 * provider of every advisor that reported a judged finding unless
 * `allowCrossProvider` is set; otherwise the group is not judged. A failed,
 * timed-out, or malformed judgment leaves the group unchanged.
 */
export async function judgeFindingGroups(pass: FindingsJudgePass): Promise<FindingsJudgeOutcome> {
	const outcome: FindingsJudgeOutcome = { judged: 0, merged: 0, blocked: 0, failed: 0 };
	if (!pass.settings.enabled) return outcome;
	const touched = new Set([...pass.touched].filter(finding => finding.status === "open"));
	const identities = new Set([...touched].map(finding => finding.identity));
	for (const identity of identities) {
		const group = pass.ledger.openAt(identity);
		const pairs: [AdvisorFinding, AdvisorFinding][] = [];
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i]!;
				const b = group[j]!;
				if (a.category !== b.category && (touched.has(a) || touched.has(b))) pairs.push([a, b]);
			}
		}
		if (pairs.length === 0) continue;
		const verdicts = await judgePairs(pass, pairs);
		if (verdicts === BLOCKED) {
			outcome.blocked++;
			continue;
		}
		if (verdicts === undefined) {
			outcome.failed++;
			continue;
		}
		outcome.judged++;
		outcome.merged += mergeSame(pass, pairs, verdicts);
	}
	return outcome;
}

async function judgePairs(
	pass: FindingsJudgePass,
	pairs: readonly [AdvisorFinding, AdvisorFinding][],
): Promise<Verdict[] | typeof BLOCKED | undefined> {
	const findings = [...new Set(pairs.flat())];
	const sources = new Set(findings.flatMap(finding => finding.reports.map(report => report.advisor)));
	const providers = [...sources].map(advisor => pass.providerOf(advisor));
	const questions: Record<string, ChoiceQuestion<Verdict>> = {};
	const ids = pairs.map(([a, b]) => `${a.id}_${b.id}`);
	pairs.forEach(([a, b], index) => {
		questions[ids[index]!] = {
			type: "choice",
			instructions: prompt.render(findingsJudgeTemplate, { a: a.id, b: b.id }),
			criteria: { same: null, distinct: null },
		};
	});
	const state = { findings: findings.map(findingState) };
	const signal = AbortSignal.timeout(pass.settings.timeoutMs);
	try {
		const result = await pass.judge.withCandidate(
			async (judge, _kind, model) => {
				if (!pass.settings.allowCrossProvider && !providers.every(provider => provider === model.provider)) {
					return BLOCKED;
				}
				return judge.judge({ state, questions }, { signal });
			},
			{ signal },
		);
		if (result === BLOCKED) return BLOCKED;
		const verdicts: Verdict[] = [];
		for (const id of ids) {
			const answer = result.answers[id];
			if (answer?.type !== "choice" || !VERDICTS.includes(answer.choice)) {
				logger.debug("advisor findings judge returned an unusable answer", { question: id });
				return undefined;
			}
			verdicts.push(answer.choice);
		}
		return verdicts;
	} catch (error) {
		logger.debug("advisor findings judge failed", { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
}

/** Merge every connected set of `same` pairs into its lead finding; returns the number of findings merged away. */
function mergeSame(
	pass: FindingsJudgePass,
	pairs: readonly [AdvisorFinding, AdvisorFinding][],
	verdicts: readonly Verdict[],
): number {
	const parent = new Map<AdvisorFinding, AdvisorFinding>();
	const root = (finding: AdvisorFinding): AdvisorFinding => {
		let current = finding;
		while (parent.has(current)) current = parent.get(current)!;
		return current;
	};
	pairs.forEach(([a, b], index) => {
		if (verdicts[index] !== "same") return;
		const ra = root(a);
		const rb = root(b);
		if (ra !== rb) parent.set(rb, ra);
	});
	const sets = new Map<AdvisorFinding, AdvisorFinding[]>();
	for (const finding of new Set(pairs.flat())) {
		const key = root(finding);
		const set = sets.get(key);
		if (set) set.push(finding);
		else sets.set(key, [finding]);
	}
	const precedence = (finding: AdvisorFinding): number =>
		pass.categories.find(category => category.id === finding.category)?.precedence ?? 0;
	const order = pass.ledger.list();
	let merged = 0;
	for (const set of sets.values()) {
		if (set.length < 2) continue;
		set.sort((a, b) => precedence(b) - precedence(a) || order.indexOf(a) - order.indexOf(b));
		const [lead, ...rest] = set;
		for (const finding of rest) if (pass.ledger.merge(lead!, finding)) merged++;
	}
	return merged;
}
