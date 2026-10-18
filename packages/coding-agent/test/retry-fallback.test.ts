import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ModelKind } from "@oh-my-pi/pi-catalog/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	getRetryFallbackShuffleBag,
	orderRetryFallbackCandidates,
	recordRetryFallbackUse,
	resetRetryFallbackRoundRobinPositions,
	type RetryFallbackOrderOptions,
	type RetryFallbackQuotaEvidence,
	type RetryFallbackResolutionContext,
	type RetryFallbackStrategy,
	resolveRetryFallbackChainKey,
	retryFallbackQuotaEvidence,
	validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("google", "gemini-3.5-flash"),
		getBundledModel("google-vertex", "gemini-3.5-flash"),
		getBundledModel("openrouter", "google/gemini-3.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
		getBundledModel("xai-oauth", "grok-4.7"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "openrouter/google/gemini-3.5-flash";
		const exactContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-3.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
				[selector]: ["google/gemini-3.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-3.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe("openrouter/google/*");

		const roleContext = createContext(
			{ default: ["openai/gpt-4o-mini"], task: ["google/gemini-3.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		const defaultContext = createContext({ default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBe("default");
	});

	it("does not let a later shared-assignment role steal the default chain", () => {
		const selector = "openrouter/google/gemini-3.5-flash";
		const context = createContext(
			{
				vision: ["openai/gpt-4o-mini"],
				default: ["google/gemini-3.5-flash"],
			},
			{ default: selector, vision: selector },
		);
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "default")).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "vision")).toBe("vision");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["google/gemini-3.5-flash", "openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "google/gemini-3.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "openrouter/google/gemini-3.5-flash";
		const context = createContext({ "openrouter/google/*": ["google-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "openrouter/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "google-vertex/gemini-3.5-flash",
				provider: "google-vertex",
				id: "gemini-3.5-flash",
				thinkingLevel: undefined,
				wildcard: true,
			},
		]);
	});

	it("carries per-entry thinking levels while bare entries inherit", () => {
		const context = createContext({ default: ["openai/gpt-4o-mini:low", "google/gemini-3.5-flash"] });
		const candidates = findRetryFallbackCandidates(context, "default", "openai/gpt-4o-mini");
		expect(candidates.map(candidate => candidate.raw)).toEqual(["openai/gpt-4o-mini:low", "google/gemini-3.5-flash"]);
		expect(candidates[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// Bare entries carry no level so the failing turn's effort applies at switch time.
		expect(candidates[1]?.thinkingLevel).toBeUndefined();
	});

	it("inherits the default chain only for chat roles and preserves explicit empty kind chains", () => {
		const defaultChain = ["openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains(
			{ default: defaultChain, slow: ["google/gemini-3.5-flash"], judge: [] },
			["default", "task", "slow", "judge", "image", "web"],
		);
		expect(expanded.task).toBe(defaultChain);
		expect(expanded.slow).toEqual(["google/gemini-3.5-flash"]);
		expect(expanded.judge).toEqual([]);
		expect(expanded.image).toBeUndefined();
		expect(expanded.web).toBeUndefined();
	});

	it("prefers an exact model+effort key over a different-effort key regardless of object order", () => {
		const model = getBundledModel("google", "gemini-3.5-flash");
		const low = "google/gemini-3.5-flash:low";
		const max = "google/gemini-3.5-flash:max";

		const maxFirst = createContext({ [max]: ["openai/gpt-4o-mini:max"], [low]: ["openai/gpt-4o-mini:low"] });
		expect(resolveRetryFallbackChainKey(maxFirst, low, model)).toBe(low);
		expect(findRetryFallbackCandidates(maxFirst, low, low, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini:low",
		]);

		const lowFirst = createContext({ [low]: ["openai/gpt-4o-mini:low"], [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(lowFirst, low, model)).toBe(low);
	});

	it("lets a suffixless key match any effort but an exact effort key still wins", () => {
		const model = getBundledModel("google", "gemini-3.5-flash");
		const low = "google/gemini-3.5-flash:low";
		const suffixless = "google/gemini-3.5-flash";

		const baseOnly = createContext({ [suffixless]: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(baseOnly, low, model)).toBe(suffixless);

		const suffixlessFirst = createContext({
			[suffixless]: ["openai/gpt-4o-mini"],
			[low]: ["openai/gpt-4o-mini:low"],
		});
		expect(resolveRetryFallbackChainKey(suffixlessFirst, low, model)).toBe(low);
	});

	it("never escalates to a different-effort chain when no matching effort is configured", () => {
		const model = getBundledModel("google", "gemini-3.5-flash");
		const low = "google/gemini-3.5-flash:low";
		const max = "google/gemini-3.5-flash:max";

		const maxOnly = createContext({ [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, low, model)).toBeUndefined();

		const maxWithDefault = createContext({ [max]: ["openai/gpt-4o-mini:max"], default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(maxWithDefault, low, model)).toBe("default");

		const maxWithHint = createContext({ [max]: ["openai/gpt-4o-mini:max"], smol: ["openai/gpt-4o-mini:medium"] });
		expect(resolveRetryFallbackChainKey(maxWithHint, low, model, "smol")).toBe("smol");
	});

	it("treats effort aliases as equivalent to their canonical form when matching keys", () => {
		const model = getBundledModel("google", "gemini-3.5-flash");
		const canonicalHigh = "google/gemini-3.5-flash:high";
		const aliasKey = "google/gemini-3.5-flash:hi";

		const context = createContext({ [aliasKey]: ["openai/gpt-4o-mini:high"] });
		expect(resolveRetryFallbackChainKey(context, canonicalHigh, model)).toBe(aliasKey);
		expect(
			findRetryFallbackCandidates(context, aliasKey, canonicalHigh, model).map(candidate => candidate.raw),
		).toEqual(["openai/gpt-4o-mini:high"]);
	});

	it("matches a requested effort key to the active model's clamped effort", () => {
		const model = getBundledModel("google", "gemini-3.5-flash");
		const high = "google/gemini-3.5-flash:high";
		const max = "google/gemini-3.5-flash:max";

		const maxOnly = createContext({ [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, high, model)).toBe(max);
		expect(findRetryFallbackCandidates(maxOnly, max, high, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini:max",
		]);

		const exactHigh = createContext({
			[max]: ["openai/gpt-4o-mini:max"],
			[high]: ["openai/gpt-4o-mini:high"],
		});
		expect(resolveRetryFallbackChainKey(exactHigh, high, model)).toBe(high);
	});

	it("uses the default chain when the live model matches no role primary (#12421)", () => {
		const live = "openrouter/google/gemini-3.5-flash";
		const context = createContext(
			{
				default: ["openai/gpt-4o-mini", "google/gemini-3.5-flash"],
				slow: ["openai/gpt-4o-mini"],
			},
			{ default: "google/gemini-3.5-flash", slow: "openai/gpt-4o-mini" },
		);
		expect(resolveRetryFallbackChainKey(context, live)).toBe("default");
		// The effective chain leads with `default`'s primary, then the configured entries.
		expect(findRetryFallbackCandidates(context, "default", live).map(candidate => candidate.raw)).toEqual([
			"google/gemini-3.5-flash",
			"openai/gpt-4o-mini",
		]);
	});

	it("keeps a role's chain when the live effort differs from the role's explicit effort (#13789)", () => {
		const model = getBundledModel("xai-oauth", "grok-4.7");
		const high = "xai-oauth/grok-4.7:high";
		const xhigh = "xai-oauth/grok-4.7:xhigh";

		// A spawn `effort` or `/thinking` moved the session off the role's effort.
		const roleOnly = createContext({ task: ["openai/gpt-4o-mini"] }, { task: high });
		expect(resolveRetryFallbackChainKey(roleOnly, xhigh, model)).toBe("task");
		expect(findRetryFallbackCandidates(roleOnly, "task", xhigh, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini",
		]);

		// A role assigned the live effort still outranks one assigned another effort.
		const exactRole = createContext(
			{ task: ["openai/gpt-4o-mini"], slow: ["openai/gpt-4o-mini:high"] },
			{ task: high, slow: xhigh },
		);
		expect(resolveRetryFallbackChainKey(exactRole, xhigh, model)).toBe("slow");

		// Model-selector keys stay effort-exact.
		const modelKey = createContext({ [high]: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(modelKey, xhigh, model)).toBeUndefined();
	});
});

describe("retry fallback kind-role validation", () => {
	const chatModel = getBundledModel("openai", "gpt-4o-mini");
	if (!chatModel) throw new Error("Expected bundled OpenAI test model");
	const judgeModel: Model = { ...chatModel, id: "test-judge", name: "Test Judge", kind: "judge" };
	const imageModel: Model = { ...chatModel, id: "test-image", name: "Test Image", kind: "image" };
	const models = [chatModel, judgeModel, imageModel];
	const registry = {
		getAll: (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? models : models.filter(model => (model.kind ?? "chat") === kind),
		getAvailable: (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? models : models.filter(model => (model.kind ?? "chat") === kind),
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
		hasProvider: (provider: string) => models.some(model => model.provider === provider),
		getProviderModels: (provider: string) => models.filter(model => model.provider === provider),
	};

	it("accepts aliases and fuzzy patterns that resolve to the role's model kind", () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${judgeModel.provider}/${judgeModel.id}` },
			"retry.fallbackChains": { judge: ["@judge", "test-judge"] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));

		expect(warnings).toEqual([]);
	});

	it("validates compatibility without requiring provider credentials or availability", () => {
		const settings = Settings.isolated({
			modelRoles: { image: `${imageModel.provider}/${imageModel.id}` },
			"retry.fallbackChains": { image: ["@image", "test-image"] },
		});
		const warnings: string[] = [];

		const unavailableRegistry = { ...registry, getAvailable: () => [] };
		validateRetryFallbackChains(settings, unavailableRegistry, warning => warnings.push(warning));

		expect(warnings).toEqual([]);
	});

	it("warns when kind-role entries resolve to the wrong kind or no model", () => {
		const wrongKindSelector = `${imageModel.provider}/${imageModel.id}`;
		const missingSelector = `${chatModel.provider}/missing-judge`;
		const settings = Settings.isolated({
			"retry.fallbackChains": { judge: [wrongKindSelector, missingSelector] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));

		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain(wrongKindSelector);
		expect(warnings[1]).toContain(missingSelector);
	});

	it("validates provider-qualified kind-role entries without composing the full catalog", () => {
		let fullCatalogReads = 0;
		const countingRegistry = {
			...registry,
			getAll: (kind: ModelKind | "all" = "chat") => {
				fullCatalogReads++;
				return registry.getAll(kind);
			},
		};
		const warnings: string[] = [];

		validateRetryFallbackChains(
			Settings.isolated({ "retry.fallbackChains": { judge: [`${judgeModel.provider}/${judgeModel.id}`] } }),
			countingRegistry,
			warning => warnings.push(warning),
		);
		expect(warnings).toEqual([]);
		expect(fullCatalogReads).toBe(0);

		// A provider-less pattern has no provider slice to check; it must still resolve.
		validateRetryFallbackChains(
			Settings.isolated({ "retry.fallbackChains": { judge: ["test-judge"] } }),
			countingRegistry,
			warning => warnings.push(warning),
		);
		expect(warnings).toEqual([]);
		expect(fullCatalogReads).toBe(1);
	});

	it("keeps pending-discovery suppression for unresolved kind-role entries", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": { judge: ["litellm/pending-judge"] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning), {
			isDiscoveryPending: provider => provider === "litellm",
		});

		expect(warnings).toEqual([]);
	});
});

describe("retry fallback strategies", () => {
	const NOW = 1_000_000;
	const MAX_AGE = 60_000;
	const order = (
		candidates: string[],
		strategy: "priority" | "quota" | "round-robin",
		evidence: Record<string, RetryFallbackQuotaEvidence> = {},
	) =>
		orderRetryFallbackCandidates(candidates, strategy, {
			evidence: candidate => evidence[candidate],
			nowMs: NOW,
			maxAgeMs: MAX_AGE,
		});
	// Full chain: primary "p", then entries "a", "b", "c".
	const CHAIN = ["p", "a", "b", "c"];
	const roundRobin = (candidates: string[], lastAppliedPosition: number | undefined) =>
		orderRetryFallbackCandidates(candidates, "round-robin", {
			nowMs: NOW,
			maxAgeMs: MAX_AGE,
			chainPosition: candidate => {
				const position = CHAIN.indexOf(candidate);
				return position < 0 ? undefined : position;
			},
			chainLength: CHAIN.length,
			lastAppliedPosition,
		});

	it("keeps configured order under priority even when quota evidence disagrees", () => {
		expect(order(["a", "b"], "priority", { b: { state: "healthy", remainingFraction: 1, observedAt: NOW } })).toEqual(
			["a", "b"],
		);
	});

	it("orders cheapest, least-used, and least-loaded by rank, unranked last, ties in given order", () => {
		const rank: Record<string, number> = { a: 2, c: 0, d: 2 };
		for (const strategy of ["cheapest", "least-used", "least-loaded"] as const) {
			expect(
				orderRetryFallbackCandidates(["a", "b", "c", "d"], strategy, {
					nowMs: NOW,
					maxAgeMs: MAX_AGE,
					rank: candidate => rank[candidate],
				}),
			).toEqual(["c", "a", "d", "b"]);
		}
	});

	it("puts the less loaded of two distinct random candidates first under p2c, the rest in given order", () => {
		const p2c = (draws: number[], rank: Record<string, number>) =>
			orderRetryFallbackCandidates(["a", "b", "c"], "p2c", {
				nowMs: NOW,
				maxAgeMs: MAX_AGE,
				random: () => draws.shift() ?? 0,
				rank: candidate => rank[candidate],
			});
		// Draws pick a (index 0) and c (the second draw skips index 0, so 0.9 lands on index 2).
		expect(p2c([0, 0.9], { a: 2, b: 0, c: 1 })).toEqual(["c", "a", "b"]);
		// Identical draws still yield two distinct candidates.
		expect(p2c([0, 0], { a: 1, b: 0, c: 0 })).toEqual(["b", "a", "c"]);
		// A tie keeps the first drawn, so all-tied members each come first for some draw.
		const tied = { a: 0, b: 0, c: 0 };
		expect([p2c([0, 0.9], tied)[0], p2c([0.5, 0], tied)[0], p2c([0.9, 0], tied)[0]]).toEqual(["a", "b", "c"]);
	});

	it("uses every shuffle-bag member once per cycle before reshuffling", () => {
		resetRetryFallbackRoundRobinPositions();
		const chain = ["p", "a", "b"].map(raw => ({ raw, provider: "x", id: raw, thinkingLevel: undefined }));
		const draws = [0, 0, 0.99, 0.99];
		const random = () => draws.shift() ?? 0;
		const used: string[] = [];
		for (let i = 0; i < 6; i++) {
			const bag = getRetryFallbackShuffleBag(chain, ["p", "a", "b"], random);
			const [next] = orderRetryFallbackCandidates(["p", "a", "b"], "shuffle-bag", {
				nowMs: NOW,
				maxAgeMs: MAX_AGE,
				bagPosition: candidate => (bag.includes(candidate) ? bag.indexOf(candidate) : undefined),
			});
			used.push(next!);
			recordRetryFallbackUse(
				"shuffle-bag",
				chain,
				chain.find(entry => entry.raw === next)!,
			);
		}
		expect(used.slice(0, 3).sort()).toEqual(["a", "b", "p"]);
		expect(used.slice(3).sort()).toEqual(["a", "b", "p"]);
		// The second cycle draws a fresh shuffle instead of repeating the first.
		expect(used.slice(3)).not.toEqual(used.slice(0, 3));
		// With no member pickable right now (all cooling down), the bag keeps its progress.
		const [first] = getRetryFallbackShuffleBag(chain, ["p", "a", "b"], random);
		recordRetryFallbackUse(
			"shuffle-bag",
			chain,
			chain.find(entry => entry.raw === first)!,
		);
		expect(getRetryFallbackShuffleBag(chain, [], random)).toHaveLength(2);
		resetRetryFallbackRoundRobinPositions();
	});

	it("starts round-robin after the last applied chain entry and wraps past the end", () => {
		expect(roundRobin(["a", "b", "c"], undefined)).toEqual(["a", "b", "c"]);
		expect(roundRobin(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
		expect(roundRobin(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
	});

	it("tries more remaining quota first, then reserve, unknown, and depleted entries", () => {
		const evidence: Record<string, RetryFallbackQuotaEvidence> = {
			depleted: { state: "depleted", observedAt: NOW },
			unknown: { state: "unknown", observedAt: NOW },
			reserve: { state: "reserve", remainingFraction: 0.05, observedAt: NOW },
			lowHealthy: { state: "healthy", remainingFraction: 0.3, observedAt: NOW },
			highHealthy: { state: "healthy", remainingFraction: 0.9, observedAt: NOW },
		};
		expect(
			order(["depleted", "missing", "unknown", "reserve", "lowHealthy", "highHealthy"], "quota", evidence),
		).toEqual(["highHealthy", "lowHealthy", "reserve", "missing", "unknown", "depleted"]);
	});

	it("ranks stale or undated healthy evidence as unknown, below fresh reserve", () => {
		const evidence: Record<string, RetryFallbackQuotaEvidence> = {
			stale: { state: "healthy", remainingFraction: 1, observedAt: NOW - MAX_AGE - 1 },
			undated: { state: "healthy", remainingFraction: 1 },
			reserve: { state: "reserve", remainingFraction: 0.05, observedAt: NOW - MAX_AGE },
		};
		expect(order(["stale", "undated", "reserve"], "quota", evidence)).toEqual(["reserve", "stale", "undated"]);
	});

	it("summarizes usage health by the best usable account and the newest report", () => {
		expect(
			retryFallbackQuotaEvidence(
				{
					state: "healthy",
					accounts: [
						{ credentialId: 1, credentialType: "oauth", state: "healthy", remainingFraction: 0.4, fetchedAt: 10 },
						{ credentialId: 2, credentialType: "oauth", state: "healthy", remainingFraction: 0.7, fetchedAt: 30 },
						{ credentialId: 3, credentialType: "oauth", state: "depleted", fetchedAt: 20 },
					],
				},
				NOW,
			),
		).toEqual({ state: "healthy", remainingFraction: 0.7, observedAt: 30 });
	});
});

describe("retry fallback strategy lists", () => {
	const NOW = 1_000_000;
	const fresh = (state: RetryFallbackQuotaEvidence["state"], remainingFraction?: number) => ({
		state,
		remainingFraction,
		observedAt: NOW,
	});
	const order = (
		candidates: string[],
		strategies: readonly RetryFallbackStrategy[],
		evidence: Record<string, RetryFallbackQuotaEvidence>,
		ranks: Partial<Record<RetryFallbackStrategy, Record<string, number>>>,
		extra: Partial<RetryFallbackOrderOptions<string>> = {},
	) =>
		orderRetryFallbackCandidates(candidates, strategies, {
			evidence: candidate => evidence[candidate],
			nowMs: NOW,
			maxAgeMs: 60_000,
			rank: (candidate, strategy) => ranks[strategy]?.[candidate],
			...extra,
		});

	it("ties quota fractions within the tolerance and breaks the tie by the next key", () => {
		const evidence = { a: fresh("healthy", 0.82), b: fresh("healthy", 0.88), c: fresh("healthy", 0.65) };
		const ranks = { cheapest: { a: 1, b: 5, c: 0 } };
		// a and b share the 0.8 bucket, so the cheaper a goes first; c's lower bucket keeps it last despite its price.
		expect(order(["b", "c", "a"], ["quota", "cheapest"], evidence, ranks, { quotaTolerance: 0.1 })).toEqual([
			"a",
			"b",
			"c",
		]);
		// Without a tolerance the exact fractions decide.
		expect(order(["b", "c", "a"], ["quota", "cheapest"], evidence, ranks)).toEqual(["b", "a", "c"]);
		// A fraction that is a whole multiple of the tolerance opens its own bucket despite float error.
		const edge = { low: fresh("healthy", 0.29), high: fresh("healthy", 0.3) };
		expect(
			order(
				["low", "high"],
				["quota", "cheapest"],
				edge,
				{ cheapest: { low: 0, high: 1 } },
				{ quotaTolerance: 0.1 },
			),
		).toEqual(["high", "low"]);
	});

	it("applies three keys in list order and keeps unknown and depleted members last", () => {
		const evidence = {
			a: fresh("healthy", 0.9),
			b: fresh("healthy", 0.8),
			c: fresh("healthy", 0.76),
			d: fresh("depleted"),
		};
		const ranks = {
			cheapest: { a: 2, b: 2, c: 1, d: 0, e: 0 },
			"least-loaded": { a: 5, b: 1, c: 9, d: 0, e: 0 },
		};
		const strategies = ["quota", "cheapest", "least-loaded"] as const;
		expect(order(["a", "b", "c", "d", "e"], strategies, evidence, ranks, { quotaTolerance: 0.25 })).toEqual([
			"c",
			"b",
			"a",
			"e",
			"d",
		]);
		expect(
			order(["a", "b", "c", "d", "e"], strategies, evidence, ranks, { quotaTolerance: 0.25, excludeUnknown: true }),
		).toEqual(["c", "b", "a", "d"]);
	});

	it("breaks the remaining ties by a last random entry, drawing once per candidate", () => {
		const draws = [0.1, 0.9, 0.5, 0.7];
		let drawn = 0;
		const random = () => {
			drawn++;
			return draws.shift() ?? 0;
		};
		// The draws rank b, d, c, a; c is cheapest, and the tied rest follow the draw.
		expect(
			order(["a", "b", "c", "d"], ["cheapest", "random"], {}, { cheapest: { a: 1, b: 1, c: 0, d: 1 } }, { random }),
		).toEqual(["c", "b", "d", "a"]);
		expect(drawn).toBe(4);
	});

	it("breaks the remaining ties by a last round-robin entry, starting after the last applied member", () => {
		const chain = ["p", "a", "b", "c"];
		expect(
			order(
				["p", "a", "b", "c"],
				["least-loaded", "round-robin"],
				{},
				{ "least-loaded": { p: 1, a: 0, b: 0, c: 0 } },
				{ chainPosition: candidate => chain.indexOf(candidate), chainLength: chain.length, lastAppliedPosition: 1 },
			),
		).toEqual(["b", "c", "a", "p"]);
	});

	it("orders by one strategy name exactly as before and as a one-entry list", () => {
		const candidates = ["a", "b", "c", "d", "e"];
		const evidence: Record<string, RetryFallbackQuotaEvidence> = {
			a: fresh("reserve", 0.2),
			b: fresh("healthy", 0.5),
			c: fresh("healthy"),
			d: fresh("unknown"),
			e: fresh("healthy", 0.9),
		};
		const rank: Record<string, number> = { a: 3, b: 1, d: 1, e: 0 };
		const options = (): RetryFallbackOrderOptions<string> => {
			const draws = [0.3, 0.8, 0.1, 0.6, 0.4];
			return {
				evidence: candidate => evidence[candidate],
				nowMs: NOW,
				maxAgeMs: 60_000,
				random: () => draws.shift() ?? 0,
				weight: candidate => (candidate === "c" ? 4 : undefined),
				rank: candidate => rank[candidate],
				bagPosition: candidate => ({ c: 0, a: 1, e: 2 })[candidate],
				chainPosition: candidate => candidates.indexOf(candidate),
				chainLength: candidates.length,
				lastAppliedPosition: 2,
			};
		};
		// `least-used` and `least-loaded` take the same rank path as `cheapest`.
		const expected: Partial<Record<RetryFallbackStrategy, string[]>> = {
			priority: ["a", "b", "c", "d", "e"],
			"round-robin": ["d", "e", "a", "b", "c"],
			"weighted-random": ["b", "d", "c", "e", "a"],
			random: ["b", "d", "e", "a", "c"],
			quota: ["e", "b", "c", "a", "d"],
			cheapest: ["e", "b", "d", "a", "c"],
			p2c: ["e", "a", "b", "c", "d"],
			"shuffle-bag": ["c", "a", "e", "b", "d"],
		};
		for (const [strategy, ordered] of Object.entries(expected) as [RetryFallbackStrategy, string[]][]) {
			expect(orderRetryFallbackCandidates(candidates, strategy, options())).toEqual(ordered);
			expect(orderRetryFallbackCandidates(candidates, [strategy], options())).toEqual(ordered);
		}
	});
});
