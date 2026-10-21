import { describe, expect, it } from "bun:test";
import { type Judge, type JudgmentRequest, type Model, tokenUsage } from "@oh-my-pi/pi-ai";
import {
	type AdvisorCategory,
	type AdvisorFinding,
	AdvisorFindingsLedger,
	type AdvisorReportInput,
	type FindingsJudgeCandidates,
	type FindingsJudgeSettings,
	judgeFindingGroups,
} from "../../src/advisor";

const CATEGORIES: AdvisorCategory[] = [
	{ id: "security", description: "Trust boundaries.", owner: "Security", precedence: 1 },
	{ id: "logic", description: "Correctness.", owner: "Correctness" },
];

const OWNERS: Record<string, string> = { security: "Security", logic: "Correctness" };

const SETTINGS: FindingsJudgeSettings = {
	enabled: true,
	model: "@judge",
	timeoutMs: 10_000,
	allowCrossProvider: false,
};

function input(overrides: Partial<AdvisorReportInput> = {}): AdvisorReportInput {
	return {
		advisor: "Correctness",
		category: "logic",
		identity: "file:server.ts:1043",
		anchor: "server.ts:1043",
		kind: "defect",
		severity: "concern",
		defect: "Token compared with ==.",
		impact: "Timing leak.",
		fix: "Use timingSafeEqual.",
		...overrides,
	};
}

/** A logic finding by Correctness and a security finding by Security on one anchor. */
function ledgerWithPair(): { ledger: AdvisorFindingsLedger; findings: AdvisorFinding[] } {
	const ledger = new AdvisorFindingsLedger({ ownerOf: category => OWNERS[category] });
	ledger.record(input());
	ledger.record(
		input({
			advisor: "Security",
			category: "security",
			defect: "Non-constant-time token check.",
			severity: "blocker",
		}),
	);
	return { ledger, findings: [...ledger.list()] };
}

interface Candidate {
	provider: string;
	/** Verdict per question; omitted answers `same`. */
	verdict?: string;
	fail?: boolean;
	hang?: boolean;
}

/** Judge candidates tried in order like the judge role chain: a failure falls through, an abort ends the chain. */
function chain(candidates: Candidate[]): { judge: FindingsJudgeCandidates; requests: string[]; questions: string[][] } {
	const requests: string[] = [];
	const questions: string[][] = [];
	const judge: FindingsJudgeCandidates = {
		async withCandidate(run, options) {
			let lastError: unknown;
			for (const candidate of candidates) {
				const model = { provider: candidate.provider, id: `${candidate.provider}-judge` } as Model;
				const candidateJudge: Judge = {
					label: candidate.provider,
					async judge(request: JudgmentRequest, judgeOptions) {
						requests.push(candidate.provider);
						questions.push(Object.keys(request.questions));
						if (candidate.fail) throw new Error(`${candidate.provider} unavailable`);
						if (candidate.hang) {
							const { promise, reject } = Promise.withResolvers<never>();
							judgeOptions?.signal?.addEventListener("abort", () => reject(judgeOptions.signal?.reason));
							return promise;
						}
						const answers: Record<string, unknown> = {};
						for (const id in request.questions) {
							answers[id] = {
								type: "choice",
								choice: candidate.verdict ?? "same",
								probabilities: {},
								confidence: 1,
							};
						}
						return {
							api: "test",
							provider: candidate.provider,
							model: model.id,
							answers: answers as never,
							usage: tokenUsage(0, 0),
						};
					},
				};
				try {
					return await run(candidateJudge, "online", model);
				} catch (error) {
					if (options?.signal?.aborted) throw error;
					lastError = error;
				}
			}
			throw lastError ?? new Error("no judge");
		},
	};
	return { judge, requests, questions };
}

const sameProvider = () => "anthropic";

describe("judgeFindingGroups", () => {
	it("merges a same pair into the highest-precedence category without dropping report text", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "anthropic" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		expect(outcome).toEqual({ judged: 1, merged: 1, blocked: 0, failed: 0 });
		expect(requests).toEqual(["anthropic"]);
		const [lead] = ledger.list();
		expect(ledger.list()).toHaveLength(1);
		expect(lead).toMatchObject({ id: "F2", category: "security", severity: "blocker", merged: [{ id: "F1" }] });
		expect(lead?.reports.map(report => report.defect)).toEqual([
			"Non-constant-time token check.",
			"Token compared with ==.",
		]);
		expect(ledger.leadReport(lead!).advisor).toBe("Security");
		expect(ledger.get("F1")).toBe(lead);
		// A later report in the merged category attaches to the lead.
		expect(ledger.record(input({ defect: "Still compared with ==." })).finding).toBe(lead!);
	});

	it("keeps a distinct pair apart", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge } = chain([{ provider: "anthropic", verdict: "distinct" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		expect(outcome).toEqual({ judged: 1, merged: 0, blocked: 0, failed: 0 });
		expect(ledger.list().map(finding => finding.id)).toEqual(["F1", "F2"]);
	});

	it("does not send a group to a judge on another provider than its advisors", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "openai" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 1, failed: 0 });
		expect(requests).toEqual([]);
		expect(ledger.list()).toHaveLength(2);
	});

	it("blocks a group whose advisors use different providers", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "anthropic" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: advisor => (advisor === "Security" ? "openai" : "anthropic"),
		});
		expect(outcome.blocked).toBe(1);
		expect(requests).toEqual([]);
	});

	it("sends cross-provider only with allowCrossProvider", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "openai" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: { ...SETTINGS, allowCrossProvider: true },
			judge,
			providerOf: sameProvider,
		});
		expect(outcome.merged).toBe(1);
		expect(requests).toEqual(["openai"]);
	});

	it("re-checks the provider per call when the fallback chain switches provider", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "anthropic", fail: true }, { provider: "openai" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		expect(requests).toEqual(["anthropic"]);
		expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 1, failed: 0 });
		expect(ledger.list()).toHaveLength(2);
	});

	it("leaves the grouping unchanged when the judge times out", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "anthropic", hang: true }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: { ...SETTINGS, timeoutMs: 20 },
			judge,
			providerOf: sameProvider,
		});
		expect(requests).toEqual(["anthropic"]);
		expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 0, failed: 1 });
		expect(ledger.list().map(finding => finding.id)).toEqual(["F1", "F2"]);
	});

	it("rejects an answer that is neither same nor distinct", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge } = chain([{ provider: "anthropic", verdict: "maybe" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		expect(outcome.failed).toBe(1);
		expect(ledger.list()).toHaveLength(2);
	});

	it("skips the pass when the setting is disabled", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "anthropic" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: { ...SETTINGS, enabled: false },
			judge,
			providerOf: sameProvider,
		});
		expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 0, failed: 0 });
		expect(requests).toEqual([]);
	});

	it("judges only groups with a touched finding in two or more categories", async () => {
		const { ledger, findings } = ledgerWithPair();
		ledger.record(input({ identity: "file:other.ts:1", anchor: "other.ts:1" }));
		const { judge, requests } = chain([{ provider: "anthropic" }]);
		const lone = ledger.list().at(-1)!;
		expect(
			await judgeFindingGroups({
				ledger,
				touched: [lone],
				categories: CATEGORIES,
				settings: SETTINGS,
				judge,
				providerOf: sameProvider,
			}),
		).toEqual({ judged: 0, merged: 0, blocked: 0, failed: 0 });
		expect(
			await judgeFindingGroups({
				ledger,
				touched: [],
				categories: CATEGORIES,
				settings: SETTINGS,
				judge,
				providerOf: sameProvider,
			}),
		).toEqual({ judged: 0, merged: 0, blocked: 0, failed: 0 });
		expect(requests).toEqual([]);
		expect(findings).toHaveLength(2);
	});

	it("asks only pairs that include a finding touched by the update", async () => {
		const { ledger } = ledgerWithPair();
		const outcome = ledger.record(
			input({ advisor: "Performance", category: "concurrency", defect: "Racy token cache." }),
		);
		const { judge, questions } = chain([{ provider: "anthropic", verdict: "distinct" }]);
		await judgeFindingGroups({
			ledger,
			touched: [outcome.finding],
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		expect(questions).toEqual([["F1_F3", "F2_F3"]]);
	});

	it("keeps merged-in reports when the lead's own reports pass the cap", async () => {
		const { ledger, findings } = ledgerWithPair();
		for (let i = 0; i < 10; i++) ledger.record(input({ advisor: `Logic${i}`, defect: `Logic report ${i}.` }));
		const { judge } = chain([{ provider: "anthropic" }]);
		await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		const [lead] = ledger.list();
		const merged = lead!.reports.filter(report => report.category === "logic").map(report => report.defect);
		for (let i = 0; i < 20; i++) {
			ledger.record(input({ advisor: `Sec${i}`, category: "security", defect: `Security report ${i}.` }));
		}
		expect(lead!.reports.filter(report => report.category === "logic").map(report => report.defect)).toEqual(merged);
		expect(lead!.reports.filter(report => report.category === undefined)).toHaveLength(16);
	});

	it("persists a merge: a restored ledger resolves the merged id and category to the lead", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge } = chain([{ provider: "anthropic" }]);
		await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			providerOf: sameProvider,
		});
		const restored = new AdvisorFindingsLedger({ ownerOf: category => OWNERS[category] });
		restored.load(structuredClone(ledger.toEntry()));
		expect(restored.get("F1")?.id).toBe("F2");
		expect(restored.findOpen("logic", "file:server.ts:1043")?.id).toBe("F2");
		expect(
			restored.record(input({ category: "logic", identity: "file:new.ts:1", anchor: "new.ts:1" })).finding.id,
		).toBe("F3");
	});
});

describe("AdvisorFindingsLedger.reopen", () => {
	it("reopens a resolved finding unless an open finding holds its key", () => {
		const ledger = new AdvisorFindingsLedger();
		ledger.record(input());
		expect(ledger.reopen("F1")).toBe("open");
		expect(ledger.resolve("F1")).toBe(true);
		expect(ledger.reopen("F1")).toBe("reopened");
		expect(ledger.findOpen("logic", "file:server.ts:1043")?.id).toBe("F1");
		ledger.resolve("F1");
		ledger.record(input({ defect: "Again." }));
		expect(ledger.reopen("F1")).toBe("superseded");
		expect(ledger.reopen("F7")).toBe("missing");
	});
});
