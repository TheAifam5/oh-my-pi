import { describe, expect, it } from "bun:test";
import { type Judge, type JudgmentRequest, type Model, tokenUsage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorAggregationJudgeEnabled } from "../../src/advisor/settings";
import { all } from "../../src/config/registry";
import { Settings } from "../../src/config/settings";
import {
	type AdvisorCategory,
	type AdvisorFinding,
	AdvisorFindingsLedger,
	type AdvisorReportInput,
	type DisclosureDomain,
	type FindingsJudgeCandidates,
	type FindingsJudgeSettings,
	judgeFindingGroups,
	modelDisclosureDomain,
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
	allowCrossDomain: false,
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
	baseUrl?: string;
	account?: string;
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
				const model = {
					...getBundledModel("anthropic", "claude-sonnet-4-5")!,
					provider: candidate.provider,
					id: `${candidate.provider}-judge`,
					baseUrl: candidate.baseUrl ?? "https://api.example.test/v1",
					headers: { account: candidate.account ?? "account-1" },
				} satisfies Model;
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

const sameDomain = (): DisclosureDomain => ({
	provider: "anthropic",
	origin: "https://api.example.test",
	auth: "account-1",
	local: false,
});

function candidateDomain(model: Model): DisclosureDomain | undefined {
	return modelDisclosureDomain(model, model.baseUrl, model.headers?.account);
}

describe("judgeFindingGroups", () => {
	for (const host of ["interactive", "rpc", "acp"] as const) {
		it(`does not disclose reports to the judge by default in ${host} sessions`, async () => {
			const settings = Settings.isolated();
			if (host !== "interactive") {
				for (const setting of all()) {
					if (setting.definition.protocolDefault?.includes(host)) setting.pinDefault(settings);
				}
			}
			const { ledger, findings } = ledgerWithPair();
			const { judge, requests } = chain([{ provider: "anthropic" }]);
			const outcome = await judgeFindingGroups({
				ledger,
				touched: findings,
				categories: CATEGORIES,
				settings: { ...SETTINGS, enabled: cfgAdvisorAggregationJudgeEnabled.get(settings) },
				judge,
				advisorDomain: sameDomain,
				judgeDomain: candidateDomain,
			});
			expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 0, failed: 0 });
			expect(requests).toEqual([]);
			expect(ledger.list()).toHaveLength(2);
		});
	}

	it("merges a same pair into the highest-precedence category without dropping report text", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "anthropic" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: advisor => ({ ...sameDomain(), provider: advisor === "Security" ? "openai" : "anthropic" }),
			judgeDomain: candidateDomain,
		});
		expect(outcome.blocked).toBe(1);
		expect(requests).toEqual([]);
	});

	it("sends cross-domain only with allowCrossDomain", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "openai" }]);
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: { ...SETTINGS, allowCrossDomain: true },
			judge,
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
		});
		expect(requests).toEqual(["anthropic"]);
		expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 1, failed: 0 });
		expect(ledger.list()).toHaveLength(2);
	});

	for (const candidate of [{ baseUrl: "https://other.example.test/v1" }, { account: "account-2" }]) {
		it(`blocks same-provider reports with a different ${candidate.baseUrl ? "base URL origin" : "account"}`, async () => {
			const { ledger, findings } = ledgerWithPair();
			const { judge, requests } = chain([{ provider: "anthropic", ...candidate }]);
			const outcome = await judgeFindingGroups({
				ledger,
				touched: findings,
				categories: CATEGORIES,
				settings: SETTINGS,
				judge,
				advisorDomain: sameDomain,
				judgeDomain: candidateDomain,
			});
			expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 1, failed: 0 });
			expect(requests).toEqual([]);
			expect(ledger.list()).toHaveLength(2);
		});
	}

	for (const [advisorAuth, judgeAuth] of [
		[undefined, undefined],
		[undefined, "account-1"],
		["account-1", undefined],
	] as const) {
		it(`blocks unknown authentication identities (${advisorAuth ?? "unknown"} advisor, ${judgeAuth ?? "unknown"} judge)`, async () => {
			const { ledger, findings } = ledgerWithPair();
			const { judge, requests } = chain([{ provider: "anthropic" }]);
			const outcome = await judgeFindingGroups({
				ledger,
				touched: findings,
				categories: CATEGORIES,
				settings: SETTINGS,
				judge,
				advisorDomain: () => ({ ...sameDomain(), auth: advisorAuth }),
				judgeDomain: () => ({ ...sameDomain(), auth: judgeAuth }),
			});
			expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 1, failed: 0 });
			expect(requests).toEqual([]);
			expect(ledger.list()).toHaveLength(2);
		});
	}

	it("judges matching explicitly keyless local endpoints without an auth identity", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([{ provider: "anthropic" }]);
		const localModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			advisorDomain: () => modelDisclosureDomain(localModel, "http://localhost:1234/v1", undefined, true),
			judgeDomain: () => modelDisclosureDomain(localModel, "http://localhost:1234/v1", undefined, true),
		});
		expect(outcome).toEqual({ judged: 1, merged: 1, blocked: 0, failed: 0 });
		expect(requests).toEqual(["anthropic"]);
		expect(ledger.list()).toHaveLength(1);
	});

	for (const [baseUrl, explicitlyKeyless] of [
		["http://localhost:1234/v1", false],
		["https://api.example.test/v1", true],
		["http://localhost:1234/other", true],
	] as const) {
		it(`blocks an unauthenticated endpoint without a matching explicit keyless local domain (${baseUrl}, keyless=${explicitlyKeyless})`, async () => {
			const { ledger, findings } = ledgerWithPair();
			const { judge, requests } = chain([{ provider: "anthropic" }]);
			const localModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const outcome = await judgeFindingGroups({
				ledger,
				touched: findings,
				categories: CATEGORIES,
				settings: SETTINGS,
				judge,
				advisorDomain: () => modelDisclosureDomain(localModel, "http://localhost:1234/v1", undefined, true),
				judgeDomain: () => modelDisclosureDomain(localModel, baseUrl, undefined, explicitlyKeyless),
			});
			expect(outcome).toEqual({ judged: 0, merged: 0, blocked: 1, failed: 0 });
			expect(requests).toEqual([]);
			expect(ledger.list()).toHaveLength(2);
		});
	}

	it("blocks a fallback member with the same provider but a different disclosure domain", async () => {
		const { ledger, findings } = ledgerWithPair();
		const { judge, requests } = chain([
			{ provider: "anthropic", fail: true },
			{ provider: "anthropic", baseUrl: "https://other.example.test/v1" },
		]);
		let resolutions = 0;
		const outcome = await judgeFindingGroups({
			ledger,
			touched: findings,
			categories: CATEGORIES,
			settings: SETTINGS,
			judge,
			advisorDomain: () => {
				resolutions++;
				return sameDomain();
			},
			judgeDomain: candidateDomain,
		});
		expect(resolutions).toBeGreaterThan(2);
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
				advisorDomain: sameDomain,
				judgeDomain: candidateDomain,
			}),
		).toEqual({ judged: 0, merged: 0, blocked: 0, failed: 0 });
		expect(
			await judgeFindingGroups({
				ledger,
				touched: [],
				categories: CATEGORIES,
				settings: SETTINGS,
				judge,
				advisorDomain: sameDomain,
				judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
			advisorDomain: sameDomain,
			judgeDomain: candidateDomain,
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
