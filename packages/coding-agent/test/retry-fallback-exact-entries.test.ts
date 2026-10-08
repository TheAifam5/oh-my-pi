import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model, ModelKind } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { formatModelStringWithRouting, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	parseRetryFallbackSelector,
	validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { collectOnlineTinyCandidates } from "@oh-my-pi/pi-coding-agent/tiny/online-candidates";
import { logger } from "@oh-my-pi/pi-utils";

const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const glm = getBundledModel("openrouter", "z-ai/glm-4.7")!;
const models = [sonnet, mini, glm];

const registry = {
	getAvailable: () => models,
	getAll: (kind: ModelKind | "all" = "chat") =>
		kind === "all" ? models : models.filter(model => (model.kind ?? "chat") === kind),
	find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
	hasProvider: (provider: string) => models.some(model => model.provider === provider),
	getProviderModels: (provider: string) => models.filter(model => model.provider === provider),
	isProviderDiscoveryPending: () => false,
};

function createRecovery(settings: Settings): TurnRecovery {
	const host = {
		settings,
		modelRegistry: registry,
		configWarnings: [],
		sessionManager: { getSessionId: () => "exact-entries", getLastModelChangeRole: () => undefined },
		sessionId: () => "exact-entries",
		model: () => sonnet,
		emitSessionEvent: async () => {},
	} as unknown as TurnRecoveryHost;
	return new TurnRecovery(host, { deferFallbackChainValidation: true });
}

function resolveEntry(recovery: TurnRecovery, role: string, raw: string): Model<Api> | undefined {
	const selector = parseRetryFallbackSelector(raw, registry);
	if (!selector) throw new Error(`Unparseable selector ${raw}`);
	return recovery.resolveRetryFallbackCandidate(role, selector);
}

function unmatchedEntryWarnings(warn: { mock: { calls: unknown[][] } }): unknown[] {
	return warn.mock.calls
		.filter(call => typeof call[0] === "string" && call[0].includes("matches no model exactly"))
		.map(call => call[1]);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("retry fallback chain entries resolve exactly", () => {
	it("yields no candidate for a partial id that pattern matching would map to a neighbor, warning once", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated({ "retry.fallbackChains": { default: ["anthropic/claude-sonnet-4"] } });
		const recovery = createRecovery(settings);

		expect(resolveEntry(recovery, "default", "anthropic/claude-sonnet-4")).toBeUndefined();
		expect(resolveEntry(recovery, "default", "anthropic/claude-sonnet-4")).toBeUndefined();

		expect(unmatchedEntryWarnings(warn)).toEqual([
			{ entry: "anthropic/claude-sonnet-4", nearest: "anthropic/claude-sonnet-4-5" },
		]);
	});

	it("still resolves an exact id, a thinking suffix, and an @upstream routing suffix", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated();
		const recovery = createRecovery(settings);

		expect(resolveEntry(recovery, "default", "anthropic/claude-sonnet-4-5")).toBe(sonnet);
		expect(resolveEntry(recovery, "default", "anthropic/claude-sonnet-4-5:high")?.id).toBe(sonnet.id);
		const routed = resolveEntry(recovery, "default", "openrouter/z-ai/glm-4.7@chutes");
		expect(routed && formatModelStringWithRouting(routed)).toBe("openrouter/z-ai/glm-4.7@chutes");
		expect(unmatchedEntryWarnings(warn)).toEqual([]);
	});

	it("keeps pattern matching for a role's own assignment and for a role-alias entry", () => {
		const settings = Settings.isolated();
		settings.setModelRole("slow", "anthropic/sonnet");
		const recovery = createRecovery(settings);

		expect(resolveEntry(recovery, "slow", "anthropic/sonnet")).toBe(sonnet);
		expect(resolveEntry(recovery, "default", "pi/slow")).toBe(sonnet);
		// The same partial selector as a plain chain entry of another key names no model.
		expect(resolveEntry(recovery, "default", "anthropic/sonnet")).toBeUndefined();
	});

	it("leaves model-group members exact", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: {
					strategy: "priority",
					strategyOptions: { order: ["m1"] },
					models: { m1: { model: "anthropic/claude-sonnet-4" } },
				},
			},
		});
		const recovery = createRecovery(settings);

		expect(resolveEntry(recovery, "default", "anthropic/claude-sonnet-4")).toBeUndefined();
		expect(resolveEntry(recovery, "default", "anthropic/claude-sonnet-4-5")).toBe(sonnet);
	});
});

describe("other fallback chain consumers resolve entries exactly", () => {
	it("resolveRoleChain skips a partial configured entry but pattern-matches the role's own selector", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated({
			"retry.fallbackChains": { slow: ["openai/gpt-4o", "openrouter/z-ai/glm-4.7"] },
		});
		settings.setModelRole("slow", "anthropic/sonnet");

		expect(resolveRoleChain("slow", settings, models).map(candidate => candidate.model)).toEqual([sonnet, glm]);
	});

	it("online tiny candidates skip a partial chain entry but not the role's own partial assignment", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated({
			"retry.fallbackChains": { tiny: ["openai/gpt-4o", "openrouter/z-ai/glm-4.7"] },
		});
		settings.setModelRole("tiny", "anthropic/sonnet");

		expect(collectOnlineTinyCandidates(["tiny"], settings, models).map(candidate => candidate.model)).toEqual([
			sonnet,
			glm,
		]);
		expect(unmatchedEntryWarnings(warn)).toEqual([{ entry: "openai/gpt-4o", nearest: "openai/gpt-4o-mini" }]);
	});

	it("startup validation rejects a kind-role entry that only pattern matching resolves", () => {
		const judge: Model<Api> = { ...mini, id: "test-judge", name: "Test Judge", kind: "judge" };
		const judgeModels = [mini, judge];
		const judgeRegistry = {
			getAll: (kind: ModelKind | "all" = "chat") =>
				kind === "all" ? judgeModels : judgeModels.filter(model => (model.kind ?? "chat") === kind),
			find: (provider: string, id: string) =>
				judgeModels.find(model => model.provider === provider && model.id === id),
			hasProvider: (provider: string) => judgeModels.some(model => model.provider === provider),
			getProviderModels: (provider: string) => judgeModels.filter(model => model.provider === provider),
		};
		const settings = Settings.isolated({
			"retry.fallbackChains": { judge: ["openai/test-jud", "openai/test-judge"] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, judgeRegistry, warning => warnings.push(warning));

		expect(warnings).toEqual([
			"Fallback chain for role 'judge' does not resolve to a compatible model: openai/test-jud",
		]);
	});
});
