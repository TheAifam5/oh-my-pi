import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type BillingSource, knownBilling, type Model, type Usage } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	notePoolPickApplied,
	PoolSelection,
	type RolePoolDeps,
	type RolePoolPick,
	RolePoolUnavailableError,
	resolveRolePool,
	rolePoolPolicyBlocked,
} from "@oh-my-pi/pi-coding-agent/session/pool-selection";
import { trackInFlightRequest } from "@oh-my-pi/pi-coding-agent/session/in-flight-requests";
import { LEDGER_HIT_RATE_TTL_MS, PromptCacheAffinity } from "@oh-my-pi/pi-coding-agent/session/prompt-cache-affinity";
import { resetRetryFallbackRoundRobinPositions } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { retryFallbackBillingRegistry } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-groups";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function bundled(provider: "openai" | "google" | "anthropic", id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const OPENAI = bundled("openai", "gpt-4o-mini");
const GOOGLE = bundled("google", "gemini-2.5-flash");
const ANTHROPIC = bundled("anthropic", "claude-sonnet-4-5");

function selectorOf(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/** An inline pool whose members are aliased m1, m2, … in the given order. */
function pool(strategy: string, models: Model[], routing?: Record<string, unknown>): Record<string, unknown> {
	const aliases = models.map((_, index) => `m${index + 1}`);
	return {
		strategy,
		...(strategy === "priority" || strategy === "round-robin" ? { strategyOptions: { order: aliases } } : {}),
		...(strategy === "quota" ? { strategyOptions: { objective: "balance", capacityMetric: "fraction" } } : {}),
		models: Object.fromEntries(models.map((model, index) => [aliases[index], { model: selectorOf(model) }])),
		...(routing ? { routing } : {}),
	};
}

describe("model role pools", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const unregisterBilling: Array<() => void> = [];
	const notices: string[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-role-pools-");
		await initTheme();
		authStorage = createInMemoryAuthStorage();
		for (const provider of ["openai", "google", "anthropic"]) {
			authStorage.keys.setRuntime(provider, `${provider}-test-key`);
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
		resetRetryFallbackRoundRobinPositions();
		notices.length = 0;
	});

	afterEach(() => {
		for (const unregister of unregisterBilling.splice(0)) unregister();
		vi.restoreAllMocks();
	});

	/** Reports one billing source per provider through registered readers and a stubbed usage fetch. */
	function stubBilling(sources: Record<string, BillingSource>): void {
		for (const [provider, source] of Object.entries(sources)) {
			unregisterBilling.push(
				retryFallbackBillingRegistry.register({
					id: provider,
					readBilling: report => knownBilling(report, [source]),
				}),
			);
		}
		vi.spyOn(modelRegistry.authStorage.usage, "reports").mockResolvedValue(
			Object.keys(sources).map(provider => ({ provider, fetchedAt: Date.now(), limits: [] })),
		);
	}

	function deps(settings: Settings, extra: Partial<RolePoolDeps> = {}): RolePoolDeps {
		return {
			settings,
			modelRegistry,
			sessionId: () => "role-pool-test",
			emitNotice: async message => {
				notices.push(message);
			},
			availableModels: () => modelRegistry.getAvailable(),
			...extra,
		};
	}

	describe("funding", () => {
		it("picks the funded included member past an exhausted one, naming the skip in a notice", async () => {
			const settings = Settings.isolated({
				modelRoles: {
					engineer: pool("priority", [OPENAI, GOOGLE], {
						funding: { order: ["included", "metered"] },
						spending: { policy: "provider-managed" },
					}),
				},
			});
			stubBilling({
				openai: { mode: "subscription-included", state: "exhausted" },
				google: { mode: "subscription-included", state: "available" },
			});

			const resolution = await resolveRolePool("engineer", deps(settings));

			expect(resolution?.kind).toBe("picked");
			if (resolution?.kind !== "picked") return;
			expect(selectorOf(resolution.pick.model)).toBe(selectorOf(GOOGLE));
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain(selectorOf(OPENAI));
		});

		it("ranks a member without billing evidence after a funded one and still excludes an exhausted one", async () => {
			const settings = Settings.isolated({
				modelRoles: {
					engineer: pool("priority", [ANTHROPIC, OPENAI, GOOGLE], { funding: { order: ["included", "free"] } }),
				},
			});
			// anthropic has no usage report, so its billing evidence is unknown.
			stubBilling({
				openai: { mode: "subscription-included", state: "exhausted" },
				google: { mode: "free", state: "available" },
			});

			const resolution = await resolveRolePool("engineer", deps(settings));

			expect(resolution?.kind).toBe("picked");
			if (resolution?.kind !== "picked") return;
			expect(selectorOf(resolution.pick.model)).toBe(selectorOf(GOOGLE));
			expect(resolution.pick.rest.map(member => member.raw)).toEqual([selectorOf(ANTHROPIC)]);
			expect(notices).toEqual([expect.stringContaining(`${selectorOf(OPENAI)} (funding exhausted)`)]);
			expect(notices[0]).not.toContain(selectorOf(ANTHROPIC));
		});

		it("refuses a pool whose only member is metered under a spent local budget", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "spent-budget.db"));
			try {
				const settings = Settings.isolated(
					{
						modelRoles: {
							engineer: pool("priority", [OPENAI], {
								funding: { order: ["metered"] },
								spending: {
									policy: "local-hard-budget",
									budget: {
										id: "team",
										currency: "USD",
										perRequestMax: "0.25",
										window: { type: "rolling", durationMs: 86_400_000, maxSpend: "1" },
									},
								},
							}),
						},
					},
					{ storage },
				);
				stubBilling({ openai: { mode: "metered", state: "available" } });
				storage.spendLedger.record({
					atMs: Date.now(),
					budgetId: "team",
					owner: "engineer",
					member: selectorOf(OPENAI),
					provider: OPENAI.provider,
					model: OPENAI.id,
					costNanos: 900_000_000,
				});

				const resolution = await resolveRolePool("engineer", deps(settings));

				expect(resolution?.kind).toBe("none");
				if (resolution?.kind !== "none") return;
				expect(resolution.skipped.map(entry => [entry.selector, entry.reason.kind])).toEqual([
					[selectorOf(OPENAI), "budget-exhausted"],
				]);
				expect(rolePoolPolicyBlocked(resolution.skipped)).toBe(true);
			} finally {
				AgentStorage.close();
			}
		});
	});

	describe("local limits", () => {
		it("passes over a member whose model limit is reached and picks the next one", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "limits.db"));
			try {
				const settings = Settings.isolated(
					{
						modelRoles: { engineer: pool("priority", [OPENAI, GOOGLE]) },
						limits: {
							[selectorOf(OPENAI)]: [
								{ metric: "requests", max: 1, window: { type: "calendar", period: "day" } },
							],
						},
					},
					{ storage },
				);
				storage.usageLedger.record({
					atMs: Date.now(),
					provider: OPENAI.provider,
					model: OPENAI.id,
					costNanos: 0,
					inputTokens: 10,
					outputTokens: 5,
				});

				const resolution = await resolveRolePool("engineer", deps(settings));

				expect(resolution?.kind).toBe("picked");
				if (resolution?.kind !== "picked") return;
				expect(selectorOf(resolution.pick.model)).toBe(selectorOf(GOOGLE));
			} finally {
				AgentStorage.close();
			}
		});
		it("counts a pool limit only against calls made through that pool", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "pool-limits.db"));
			try {
				const limits = [{ metric: "requests", max: 1, window: { type: "calendar", period: "day" } }];
				const settings = Settings.isolated(
					{
						modelRoles: {
							engineer: pool("priority", [OPENAI, GOOGLE], { limits }),
							reviewer: pool("priority", [OPENAI, GOOGLE]),
						},
					},
					{ storage },
				);
				const call = (poolId: string) =>
					storage.usageLedger.record({
						atMs: Date.now(),
						provider: OPENAI.provider,
						model: OPENAI.id,
						pool: poolId,
						costNanos: 0,
						inputTokens: 1,
						outputTokens: 1,
					});
				call("role:reviewer");
				expect((await resolveRolePool("engineer", deps(settings)))?.kind).toBe("picked");

				call("role:engineer");
				const resolution = await resolveRolePool("engineer", deps(settings));
				expect(resolution?.kind).toBe("none");
				if (resolution?.kind !== "none") return;
				expect(resolution.skipped.map(entry => entry.reason.kind)).toEqual(["limit-reached", "limit-reached"]);
			} finally {
				AgentStorage.close();
			}
		});

		it("passes over a member whose skip limit cannot be read and ignores an unreadable warn limit", async () => {
			const day = { type: "calendar", period: "day" };
			const settings = Settings.isolated({
				modelRoles: { engineer: pool("priority", [OPENAI, GOOGLE]) },
				limits: {
					[selectorOf(OPENAI)]: [{ metric: "requests", max: 100, window: day }],
					[GOOGLE.provider]: [{ metric: "requests", max: 1, window: day, onLimit: "warn" }],
				},
			});

			const resolution = await resolveRolePool("engineer", deps(settings));

			expect(resolution?.kind).toBe("picked");
			if (resolution?.kind !== "picked") return;
			expect(selectorOf(resolution.pick.model)).toBe(selectorOf(GOOGLE));
		});

		it("lets a randomized strategy choose only among members no limit refuses", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "random-limits.db"));
			const pending = Promise.withResolvers<void>();
			trackInFlightRequest(GOOGLE.provider, GOOGLE.id, pending.promise);
			try {
				const limits = {
					[selectorOf(OPENAI)]: [{ metric: "requests", max: 1, window: { type: "calendar", period: "day" } }],
				};
				storage.usageLedger.record({
					atMs: Date.now(),
					provider: OPENAI.provider,
					model: OPENAI.id,
					costNanos: 0,
					inputTokens: 1,
					outputTokens: 1,
				});
				const members = [OPENAI, GOOGLE, ANTHROPIC];

				// Over all three members these draws would pick the limited OPENAI; over the other two
				// they draw GOOGLE and ANTHROPIC, and ANTHROPIC has fewer requests in flight.
				const draws = [0, 0.9];
				const p2c = Settings.isolated({ modelRoles: { engineer: pool("p2c", members) }, limits }, { storage });
				const p2cPick = await resolveRolePool("engineer", deps(p2c, { random: () => draws.shift() ?? 0 }));
				if (p2cPick?.kind !== "picked") throw new Error("expected a pick");
				expect([p2cPick.pick.selector, ...p2cPick.pick.rest].map(selector => selector.raw)).toEqual(
					[ANTHROPIC, GOOGLE].map(selectorOf),
				);

				// A bag left holding only the limited member refills, so the cycle never stalls on it.
				const bag = Settings.isolated(
					{ modelRoles: { engineer: pool("shuffle-bag", members) }, limits },
					{ storage },
				);
				const counts = new Map<string, number>();
				for (let i = 0; i < 4; i++) {
					const resolution = await resolveRolePool("engineer", deps(bag, { random: () => 0.5 }));
					if (resolution?.kind !== "picked") throw new Error("expected a pick");
					counts.set(resolution.pick.selector.raw, (counts.get(resolution.pick.selector.raw) ?? 0) + 1);
					notePoolPickApplied(resolution.pick);
				}
				expect(Object.fromEntries(counts)).toEqual({ [selectorOf(GOOGLE)]: 2, [selectorOf(ANTHROPIC)]: 2 });
			} finally {
				pending.resolve();
				await pending.promise;
				AgentStorage.close();
			}
		});

		it("reports every limited and cooling-down member of a randomized pool in member order", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "all-limited.db"));
			try {
				const settings = Settings.isolated(
					{
						modelRoles: { engineer: pool("shuffle-bag", [OPENAI, GOOGLE, ANTHROPIC]) },
						limits: {
							[OPENAI.provider]: [{ metric: "requests", max: 1, window: { type: "calendar", period: "day" } }],
							[GOOGLE.provider]: [{ metric: "requests", max: 1, window: { type: "calendar", period: "day" } }],
						},
					},
					{ storage },
				);
				for (const model of [OPENAI, GOOGLE]) {
					storage.usageLedger.record({
						atMs: Date.now(),
						provider: model.provider,
						model: model.id,
						costNanos: 0,
						inputTokens: 1,
						outputTokens: 1,
					});
				}
				modelRegistry.suppressSelector(selectorOf(ANTHROPIC), Date.now() + 60_000);

				const resolution = await resolveRolePool("engineer", deps(settings, { random: () => 0 }));

				expect(resolution?.kind).toBe("none");
				if (resolution?.kind !== "none") return;
				expect(resolution.skipped.map(entry => [entry.selector, entry.reason.kind])).toEqual([
					[selectorOf(OPENAI), "limit-reached"],
					[selectorOf(GOOGLE), "limit-reached"],
					[selectorOf(ANTHROPIC), "cooldown"],
				]);
				expect(rolePoolPolicyBlocked(resolution.skipped)).toBe(true);
			} finally {
				AgentStorage.close();
			}
		});
		/** Records one call on each of `models` today in `storage`'s usage ledger. */
		function recordCalls(storage: AgentStorage, models: Model[]): void {
			for (const model of models) {
				storage.usageLedger.record({
					atMs: Date.now(),
					provider: model.provider,
					model: model.id,
					costNanos: 0,
					inputTokens: 1,
					outputTokens: 1,
				});
			}
		}

		const ONCE_A_DAY = [{ metric: "requests", max: 1, window: { type: "calendar", period: "day" } }];

		it("reports a member that is both limited and cooling down as limited", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "limited-cooling.db"));
			try {
				const settings = Settings.isolated(
					{
						modelRoles: { engineer: pool("random", [OPENAI, GOOGLE]) },
						limits: { [selectorOf(OPENAI)]: ONCE_A_DAY },
					},
					{ storage },
				);
				recordCalls(storage, [OPENAI]);
				modelRegistry.suppressSelector(selectorOf(OPENAI), Date.now() + 60_000);
				modelRegistry.suppressSelector(selectorOf(GOOGLE), Date.now() + 60_000);

				const resolution = await resolveRolePool("engineer", deps(settings, { random: () => 0 }));

				expect(resolution?.kind).toBe("none");
				if (resolution?.kind !== "none") return;
				expect(resolution.skipped.map(entry => [entry.selector, entry.reason.kind])).toEqual([
					[selectorOf(OPENAI), "limit-reached"],
					[selectorOf(GOOGLE), "cooldown"],
				]);
			} finally {
				AgentStorage.close();
			}
		});

		it("rotates a round-robin pool over the members no limit refuses", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "round-robin-limits.db"));
			try {
				const settings = Settings.isolated(
					{
						modelRoles: { engineer: pool("round-robin", [OPENAI, GOOGLE, ANTHROPIC]) },
						limits: { [selectorOf(OPENAI)]: ONCE_A_DAY },
					},
					{ storage },
				);
				recordCalls(storage, [OPENAI]);
				const used: string[][] = [];
				for (let i = 0; i < 3; i++) {
					const resolution = await resolveRolePool("engineer", deps(settings));
					if (resolution?.kind !== "picked") throw new Error("expected a pick");
					used.push([resolution.pick.selector, ...resolution.pick.rest].map(selector => selector.raw));
					notePoolPickApplied(resolution.pick);
				}
				expect(used).toEqual([
					[selectorOf(GOOGLE), selectorOf(ANTHROPIC)],
					[selectorOf(ANTHROPIC), selectorOf(GOOGLE)],
					[selectorOf(GOOGLE), selectorOf(ANTHROPIC)],
				]);
			} finally {
				AgentStorage.close();
			}
		});
	});

	describe("selection order", () => {
		it("lists availability and credential skips in member order before policy skips", async () => {
			const settings = Settings.isolated({
				modelRoles: {
					engineer: {
						strategy: "priority",
						strategyOptions: { order: ["m1", "m2", "m3"] },
						models: {
							m1: { model: selectorOf(OPENAI) },
							m2: { model: selectorOf(GOOGLE) },
							m3: { model: "openai/no-such-model" },
						},
						routing: { funding: { order: ["included"] } },
					},
				},
			});
			stubBilling({ openai: { mode: "subscription-included", state: "exhausted" } });

			const resolution = await resolveRolePool(
				"engineer",
				deps(settings, { hasUsableAuth: model => model.provider !== "google" }),
			);

			expect(resolution?.kind).toBe("none");
			if (resolution?.kind !== "none") return;
			expect(resolution.skipped.map(entry => [entry.selector, entry.reason.kind])).toEqual([
				[selectorOf(GOOGLE), "no-auth"],
				["openai/no-such-model", "unavailable"],
				[selectorOf(OPENAI), "exhausted"],
			]);
			expect(rolePoolPolicyBlocked(resolution.skipped)).toBe(true);
		});

		it("advances a round-robin pool only when its pick is recorded as used", async () => {
			const settings = Settings.isolated({ modelRoles: { engineer: pool("round-robin", [OPENAI, GOOGLE]) } });
			const pickedModel = async () => {
				const resolution = await resolveRolePool("engineer", deps(settings));
				if (resolution?.kind !== "picked") throw new Error("expected a pick");
				return resolution.pick;
			};

			const first = await pickedModel();
			expect(selectorOf(first.model)).toBe(selectorOf(OPENAI));
			expect(selectorOf((await pickedModel()).model)).toBe(selectorOf(OPENAI));
			notePoolPickApplied(first);
			expect(selectorOf((await pickedModel()).model)).toBe(selectorOf(GOOGLE));
		});
	});

	describe("strategies", () => {
		/** Selectors of the pick and the members after it, in the order the strategy put them. */
		async function picked(settings: Settings, extra: Partial<RolePoolDeps> = {}): Promise<string[]> {
			const resolution = await resolveRolePool("engineer", deps(settings, extra));
			if (resolution?.kind !== "picked") throw new Error("expected a pick");
			return [resolution.pick.selector, ...resolution.pick.rest].map(selector => selector.raw);
		}

		it("cheapest tries the lowest input plus output price first", async () => {
			const settings = Settings.isolated({
				modelRoles: { engineer: pool("cheapest", [ANTHROPIC, GOOGLE, OPENAI]) },
			});
			expect(await picked(settings)).toEqual([OPENAI, GOOGLE, ANTHROPIC].map(selectorOf));
		});

		it("least-used tries the model with the fewest requests in its window, and keeps member order without a ledger", async () => {
			const windowed = pool("least-used", [OPENAI, GOOGLE, ANTHROPIC]);
			windowed.strategyOptions = { window: { type: "rolling", durationMs: 3_600_000 } };
			expect(await picked(Settings.isolated({ modelRoles: { engineer: windowed } }))).toEqual(
				[OPENAI, GOOGLE, ANTHROPIC].map(selectorOf),
			);
			const storage = await AgentStorage.open(path.join(tempDir.path(), "least-used.db"));
			try {
				const settings = Settings.isolated({ modelRoles: { engineer: windowed } }, { storage });
				const call = (model: Model, atMs: number) =>
					storage.usageLedger.record({
						atMs,
						provider: model.provider,
						model: model.id,
						costNanos: 0,
						inputTokens: 1,
						outputTokens: 1,
					});
				call(OPENAI, Date.now());
				call(OPENAI, Date.now());
				call(GOOGLE, Date.now());
				// Older than the one-hour window, so it does not count.
				call(ANTHROPIC, Date.now() - 2 * 3_600_000);
				expect(await picked(settings)).toEqual([ANTHROPIC, GOOGLE, OPENAI].map(selectorOf));
			} finally {
				AgentStorage.close();
			}
		});

		it("least-loaded and p2c prefer the member with fewer requests in flight", async () => {
			const pending = Promise.withResolvers<void>();
			trackInFlightRequest(OPENAI.provider, OPENAI.id, pending.promise);
			try {
				const loaded = Settings.isolated({
					modelRoles: { engineer: pool("least-loaded", [OPENAI, GOOGLE, ANTHROPIC]) },
				});
				expect(await picked(loaded)).toEqual([GOOGLE, ANTHROPIC, OPENAI].map(selectorOf));
				// The two draws are OPENAI (index 0) and ANTHROPIC (0.9 skips index 0 and lands on index 2).
				const draws = [0, 0.9];
				const p2c = Settings.isolated({ modelRoles: { engineer: pool("p2c", [OPENAI, GOOGLE, ANTHROPIC]) } });
				expect(await picked(p2c, { random: () => draws.shift() ?? 0 })).toEqual(
					[ANTHROPIC, OPENAI, GOOGLE].map(selectorOf),
				);
			} finally {
				pending.resolve();
				await pending.promise;
			}
			const idle = Settings.isolated({ modelRoles: { engineer: pool("least-loaded", [OPENAI, GOOGLE]) } });
			expect(await picked(idle)).toEqual([OPENAI, GOOGLE].map(selectorOf));
		});

		it("shuffle-bag picks every member once before repeating, advancing only on recorded use", async () => {
			const settings = Settings.isolated({
				modelRoles: { engineer: pool("shuffle-bag", [OPENAI, GOOGLE, ANTHROPIC]) },
			});
			const random = () => 0.5;
			const used: string[] = [];
			for (let i = 0; i < 3; i++) {
				const resolution = await resolveRolePool("engineer", deps(settings, { random }));
				if (resolution?.kind !== "picked") throw new Error("expected a pick");
				expect((await picked(settings, { random }))[0]).toBe(resolution.pick.selector.raw);
				used.push(resolution.pick.selector.raw);
				notePoolPickApplied(resolution.pick);
			}
			expect(used.sort()).toEqual([OPENAI, GOOGLE, ANTHROPIC].map(selectorOf).sort());
		});

		it("shuffle-bag stays fair when a member cannot be picked", async () => {
			const settings = Settings.isolated({
				modelRoles: { engineer: pool("shuffle-bag", [OPENAI, GOOGLE, ANTHROPIC]) },
			});
			const extra: Partial<RolePoolDeps> = {
				random: () => 0.5,
				hasUsableAuth: model => model.provider !== "google",
			};
			const counts = new Map<string, number>();
			for (let i = 0; i < 6; i++) {
				const resolution = await resolveRolePool("engineer", deps(settings, extra));
				if (resolution?.kind !== "picked") throw new Error("expected a pick");
				counts.set(resolution.pick.selector.raw, (counts.get(resolution.pick.selector.raw) ?? 0) + 1);
				notePoolPickApplied(resolution.pick);
			}
			expect(Object.fromEntries(counts)).toEqual({ [selectorOf(OPENAI)]: 3, [selectorOf(ANTHROPIC)]: 3 });
		});

		it("least-loaded ranks a member whose model does not resolve after a busy one", async () => {
			const selection = new PoolSelection({
				settings: Settings.isolated(),
				modelRegistry,
				sessionId: () => undefined,
				emitNotice: async () => {},
			});
			const unresolved = { raw: "nowhere/model", provider: "nowhere", id: "model", thinkingLevel: undefined };
			const busy = { raw: selectorOf(OPENAI), provider: OPENAI.provider, id: OPENAI.id, thinkingLevel: undefined };
			const pending = Promise.withResolvers<void>();
			trackInFlightRequest(OPENAI.provider, OPENAI.id, pending.promise);
			try {
				const ordered = await selection.order("engineer", [unresolved, busy], "least-loaded", undefined, {
					purpose: "retry-fallback",
					resolveCandidate: candidate => (candidate === busy ? OPENAI : undefined),
					chain: () => [unresolved, busy],
					walkActive: false,
				});
				expect(ordered.candidates).toEqual([busy, unresolved]);
			} finally {
				pending.resolve();
				await pending.promise;
			}
		});

		it("shuffle-bag keeps the given order while a walk is under way", async () => {
			const selection = new PoolSelection({
				settings: Settings.isolated(),
				modelRegistry,
				sessionId: () => undefined,
				emitNotice: async () => {},
				// Reverses the members on refill, so a fresh bag would reorder them.
				random: () => 0,
			});
			const chain = [OPENAI, GOOGLE, ANTHROPIC].map(model => ({
				raw: selectorOf(model),
				provider: model.provider,
				id: model.id,
				thinkingLevel: undefined,
			}));
			const ordered = (walkActive: boolean) =>
				selection.order("engineer", [...chain], "shuffle-bag", undefined, {
					purpose: "retry-fallback",
					resolveCandidate: () => undefined,
					chain: () => chain,
					walkActive,
				});
			expect((await ordered(true)).candidates).toEqual(chain);
			expect((await ordered(false)).candidates).not.toEqual(chain);
		});
	});

	describe("cache affinity", () => {
		// Wall-clock based so the funding filter reads freshly stubbed billing reports as current.
		const T0 = Date.now();

		/** A response of `model` whose request started at `atMs`. */
		function response(
			model: Model,
			atMs: number,
			usage: Partial<Usage> = {},
			stopReason: AssistantMessage["stopReason"] = "stop",
		): AssistantMessage {
			return {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					...usage,
				},
				stopReason,
				timestamp: atMs,
			};
		}

		/** The pick the pool makes at `nowMs` with `affinity`'s record, or with `affinity` as the warm check. */
		async function pickAt(
			settings: Settings,
			affinity: PromptCacheAffinity | ((model: Model) => boolean),
			nowMs: number,
			extra: Partial<RolePoolDeps> = {},
		): Promise<RolePoolPick> {
			const promptCacheWarm =
				affinity instanceof PromptCacheAffinity
					? (model: Model, at: number) => affinity.isWarm(model, at)
					: affinity;
			const resolution = await resolveRolePool(
				"engineer",
				deps(settings, { now: () => nowMs, promptCacheWarm, ...extra }),
			);
			if (resolution?.kind !== "picked") throw new Error("expected a pick");
			return resolution.pick;
		}

		async function pickedAt(...args: Parameters<typeof pickAt>): Promise<string> {
			return selectorOf((await pickAt(...args)).model);
		}

		const affinityPool = (strategy: string, models: Model[], routing: Record<string, unknown> = {}) =>
			Settings.isolated({
				modelRoles: { engineer: pool(strategy, models, { cache: { affinity: true }, ...routing }) },
			});

		it("prefers a warm member over a better-ranked cold one for the declared lifetime from the request start", async () => {
			const settings = affinityPool("priority", [OPENAI, ANTHROPIC]);
			const affinity = new PromptCacheAffinity();
			// A read without a per-tier breakdown keeps the shortest declared lifetime (300 s), from the request start.
			affinity.observe(response(ANTHROPIC, T0, { cacheRead: 5000 }), ANTHROPIC, T0 + 60_000);
			expect(await pickedAt(settings, affinity, T0 + 299_000)).toBe(selectorOf(ANTHROPIC));
			expect(await pickedAt(settings, affinity, T0 + 300_000)).toBe(selectorOf(OPENAI));

			// A one-hour write is remembered, so a later read without a breakdown stays on the long tier.
			affinity.observe(response(ANTHROPIC, T0, { cacheWrite: 5000, cttl: { ephemeral1h: 5000 } }), ANTHROPIC, T0);
			affinity.observe(response(ANTHROPIC, T0 + 600_000, { cacheRead: 5000 }), ANTHROPIC, T0 + 600_000);
			expect(await pickedAt(settings, affinity, T0 + 600_000 + 3_599_000)).toBe(selectorOf(ANTHROPIC));

			// A later five-minute write shortens the window.
			affinity.observe(
				response(ANTHROPIC, T0 + 700_000, { cacheWrite: 5000, cttl: { ephemeral5m: 5000 } }),
				ANTHROPIC,
				T0 + 700_000,
			);
			expect(await pickedAt(settings, affinity, T0 + 1_000_000)).toBe(selectorOf(OPENAI));

			// A reported tier without a declared lifetime falls back to the shortest declared one.
			const shortOnly = { ...ANTHROPIC, promptCache: { short: 300 } };
			affinity.observe(
				response(ANTHROPIC, T0 + 2_000_000, { cacheWrite: 5000, cttl: { ephemeral1h: 5000 } }),
				shortOnly,
				T0 + 2_000_000,
			);
			expect(await pickedAt(settings, affinity, T0 + 2_299_000)).toBe(selectorOf(ANTHROPIC));
			expect(await pickedAt(settings, affinity, T0 + 2_300_000)).toBe(selectorOf(OPENAI));
		});

		it("returns to strategy order once a completed response neither reads nor writes the cache", async () => {
			const settings = affinityPool("priority", [OPENAI, ANTHROPIC]);
			const affinity = new PromptCacheAffinity();
			affinity.observe(response(ANTHROPIC, T0, { cacheWrite: 5000 }), ANTHROPIC, T0);
			// An errored response with no cache usage says nothing about the cache.
			affinity.observe(response(ANTHROPIC, T0 + 1000, {}, "error"), ANTHROPIC, T0 + 1000);
			expect(await pickedAt(settings, affinity, T0 + 2000)).toBe(selectorOf(ANTHROPIC));
			// An aborted or errored response that read the cache extends the window.
			affinity.observe(response(ANTHROPIC, T0 + 200_000, { cacheRead: 5000 }, "aborted"), ANTHROPIC, T0 + 200_000);
			expect(await pickedAt(settings, affinity, T0 + 450_000)).toBe(selectorOf(ANTHROPIC));
			affinity.observe(response(ANTHROPIC, T0 + 400_000, { cacheRead: 5000 }, "error"), ANTHROPIC, T0 + 400_000);
			expect(await pickedAt(settings, affinity, T0 + 650_000)).toBe(selectorOf(ANTHROPIC));

			affinity.observe(response(ANTHROPIC, T0 + 660_000), ANTHROPIC, T0 + 660_000);
			expect(await pickedAt(settings, affinity, T0 + 661_000)).toBe(selectorOf(OPENAI));
		});

		it("keeps warmth apart for the same model on another base URL", async () => {
			const affinity = new PromptCacheAffinity();
			const elsewhere = { ...ANTHROPIC, baseUrl: "https://anthropic-proxy.example.com" };
			affinity.observe(response(ANTHROPIC, T0, { cacheRead: 5000 }), elsewhere, T0);
			expect(await pickedAt(affinityPool("priority", [OPENAI, ANTHROPIC]), affinity, T0 + 1000)).toBe(
				selectorOf(OPENAI),
			);
		});

		it("moves a round-robin position to the promoted member and keeps a shuffle-bag's other members", async () => {
			const affinity = new PromptCacheAffinity();
			const robin = affinityPool("round-robin", [OPENAI, GOOGLE, ANTHROPIC]);
			const applied = async (settings: Settings, nowMs: number, extra: Partial<RolePoolDeps> = {}) => {
				const pick = await pickAt(settings, affinity, nowMs, extra);
				notePoolPickApplied(pick);
				return selectorOf(pick.model);
			};
			expect(await applied(robin, T0)).toBe(selectorOf(OPENAI));
			affinity.observe(response(ANTHROPIC, T0, { cacheRead: 5000 }), ANTHROPIC, T0);
			expect(await applied(robin, T0 + 1000)).toBe(selectorOf(ANTHROPIC));
			// After expiry the rotation continues after the promoted member, so GOOGLE waits a turn.
			expect(await applied(robin, T0 + 300_000)).toBe(selectorOf(OPENAI));
			expect(await applied(robin, T0 + 300_000)).toBe(selectorOf(GOOGLE));

			const bag = affinityPool("shuffle-bag", [OPENAI, GOOGLE, ANTHROPIC]);
			const random = () => 0.5;
			expect(await applied(bag, T0 + 1000, { random })).toBe(selectorOf(ANTHROPIC));
			const rest = [await applied(bag, T0 + 300_000, { random }), await applied(bag, T0 + 300_000, { random })];
			expect(rest.sort()).toEqual([OPENAI, GOOGLE].map(selectorOf).sort());
		});

		it("keeps strategy order without affinity or for a model that declares no cache lifetime", async () => {
			const affinity = new PromptCacheAffinity();
			affinity.observe(response(ANTHROPIC, T0, { cacheRead: 5000 }), ANTHROPIC, T0);
			affinity.observe(response(GOOGLE, T0, { cacheRead: 5000 }), GOOGLE, T0);
			const off = Settings.isolated({ modelRoles: { engineer: pool("priority", [OPENAI, ANTHROPIC]) } });
			expect(await pickedAt(off, affinity, T0 + 1000)).toBe(selectorOf(OPENAI));
			expect(await pickedAt(affinityPool("priority", [OPENAI, GOOGLE]), affinity, T0 + 1000)).toBe(
				selectorOf(OPENAI),
			);
		});

		it("never promotes a warm member that is cooling down, limited, or funded only by a later stage", async () => {
			const affinity = new PromptCacheAffinity();
			affinity.observe(response(ANTHROPIC, T0, { cacheRead: 5000 }), ANTHROPIC, T0);

			modelRegistry.suppressSelector(selectorOf(ANTHROPIC), Date.now() + 60_000);
			expect(await pickedAt(affinityPool("priority", [OPENAI, ANTHROPIC]), affinity, T0 + 1000)).toBe(
				selectorOf(OPENAI),
			);
			modelRegistry.clearSuppressedSelectors();

			stubBilling({
				openai: { mode: "subscription-included", state: "available" },
				google: { mode: "metered", state: "available" },
			});
			const staged = affinityPool("priority", [GOOGLE, OPENAI], {
				funding: { order: ["included", "metered"] },
				spending: { policy: "provider-managed" },
			});
			expect(await pickedAt(staged, model => model.provider === "google", T0 + 1000)).toBe(selectorOf(OPENAI));

			const storage = await AgentStorage.open(path.join(tempDir.path(), "affinity-limits.db"));
			try {
				const limited = Settings.isolated(
					{
						modelRoles: { engineer: pool("priority", [OPENAI, ANTHROPIC], { cache: { affinity: true } }) },
						limits: {
							[selectorOf(ANTHROPIC)]: [
								{ metric: "requests", max: 1, window: { type: "calendar", period: "day" } },
							],
						},
					},
					{ storage },
				);
				storage.usageLedger.record({
					atMs: Date.now(),
					provider: ANTHROPIC.provider,
					model: ANTHROPIC.id,
					costNanos: 0,
					inputTokens: 1,
					outputTokens: 1,
				});
				expect(await pickedAt(limited, affinity, T0 + 1000)).toBe(selectorOf(OPENAI));
			} finally {
				AgentStorage.close();
			}
		});
	});

	describe("cache pricing", () => {
		// Full price: CHEAP 2 < CACHED 3.5. At a 0.9 hit rate CACHED's input is 0.9 * 0.3 + 0.1 * 3 = 0.57, so 1.07.
		const CHEAP: Model = { ...OPENAI, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } };
		const CACHED: Model = { ...GOOGLE, cost: { input: 3, output: 0.5, cacheRead: 0.3, cacheWrite: 3 } };
		const UNPRICED: Model = {
			...ANTHROPIC,
			cost: { input: Number.POSITIVE_INFINITY, output: 1, cacheRead: 0, cacheWrite: 0 },
		};
		const pricingPool = (pricing: boolean) =>
			Settings.isolated({
				modelRoles: { engineer: pool("cheapest", [UNPRICED, CHEAP, CACHED], { cache: { pricing } }) },
			});

		async function order(
			settings: Settings,
			cacheHitRate: RolePoolDeps["cacheHitRate"],
			models: Model[] = [UNPRICED, CHEAP, CACHED],
		): Promise<string[]> {
			const resolution = await resolveRolePool(
				"engineer",
				deps(settings, { availableModels: () => models, cacheHitRate }),
			);
			if (resolution?.kind !== "picked") throw new Error("expected a pick");
			return [resolution.pick.selector, ...resolution.pick.rest].map(selector => selector.raw);
		}

		function promptTokens(model: Model, input: number, cacheRead: number): AssistantMessage {
			return {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input,
					output: 10,
					cacheRead,
					cacheWrite: 0,
					totalTokens: input + cacheRead + 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		}

		it("prices cached input at the ledger's hit rate only when pricing is on, keeping unpriced members last", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "cache-pricing-ledger.db"));
			try {
				const record = (model: Model, inputTokens: number, cacheReadTokens: number) =>
					storage.cacheLedger.record({
						atMs: Date.now() - 1000,
						provider: model.provider,
						model: model.id,
						baseUrl: model.baseUrl,
						inputTokens,
						cacheReadTokens,
						cacheWriteTokens: 0,
					});
				record(CACHED, 100, 900);
				record(UNPRICED, 0, 1000);
				const affinity = new PromptCacheAffinity();
				const hitRate = (model: Model, nowMs: number) => affinity.cacheHitRate(model, nowMs, storage.cacheLedger);
				expect(await order(pricingPool(true), hitRate)).toEqual([CACHED, CHEAP, UNPRICED].map(selectorOf));
				expect(await order(pricingPool(false), hitRate)).toEqual([CHEAP, CACHED, UNPRICED].map(selectorOf));
				// Without any recorded or observed calls a member keeps its full price.
				expect(
					await order(pricingPool(true), (model, nowMs) => affinity.cacheHitRate(model, nowMs, undefined)),
				).toEqual([CHEAP, CACHED, UNPRICED].map(selectorOf));
			} finally {
				AgentStorage.close();
			}
		});

		it("prefers the ledger's rate, which already holds this session's turns, over one cold session sample", async () => {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "cache-pricing-session.db"));
			try {
				storage.cacheLedger.record({
					atMs: Date.now() - 1000,
					provider: CACHED.provider,
					model: CACHED.id,
					baseUrl: CACHED.baseUrl,
					inputTokens: 100,
					cacheReadTokens: 900,
					cacheWriteTokens: 0,
				});
				const affinity = new PromptCacheAffinity();
				affinity.observe(promptTokens(CACHED, 1000, 0), CACHED, Date.now());
				expect(
					await order(pricingPool(true), (model, nowMs) =>
						affinity.cacheHitRate(model, nowMs, storage.cacheLedger),
					),
				).toEqual([CACHED, CHEAP, UNPRICED].map(selectorOf));
			} finally {
				AgentStorage.close();
			}
		});

		it("falls back to the session's own turns without ledger data, leaving cache-warming replays out", async () => {
			const affinity = new PromptCacheAffinity();
			const hitRate = (model: Model, nowMs: number) => affinity.cacheHitRate(model, nowMs, undefined);
			// A cache-warming replay keeps the cache warm but is not a sample of the hit rate.
			const warmable: Model = { ...CACHED, promptCache: { short: 300 } };
			affinity.observe(promptTokens(CACHED, 0, 1000), warmable, Date.now(), true);
			expect(affinity.isWarm(warmable, Date.now())).toBe(true);
			expect(await order(pricingPool(true), hitRate)).toEqual([CHEAP, CACHED, UNPRICED].map(selectorOf));
			affinity.observe(promptTokens(CACHED, 50, 450), CACHED, Date.now());
			affinity.observe(promptTokens(CACHED, 50, 450), CACHED, Date.now());
			expect(await order(pricingPool(true), hitRate)).toEqual([CACHED, CHEAP, UNPRICED].map(selectorOf));
			affinity.clear();
			expect(await order(pricingPool(true), hitRate)).toEqual([CHEAP, CACHED, UNPRICED].map(selectorOf));
		});

		it("reads the ledger once per member per 30 seconds, and again after the record is cleared", async () => {
			let reads = 0;
			const ledger = {
				cacheHitRate: () => {
					reads++;
					return { rate: 0.9, samples: 1 };
				},
			};
			const affinity = new PromptCacheAffinity();
			const hitRate = (model: Model, nowMs: number) => affinity.cacheHitRate(model, nowMs, ledger);
			const at = async (nowMs: number) =>
				(
					await resolveRolePool(
						"engineer",
						deps(pricingPool(true), {
							availableModels: () => [UNPRICED, CHEAP, CACHED],
							cacheHitRate: hitRate,
							now: () => nowMs,
						}),
					)
				)?.kind;
			const T = 1_000_000;
			// Every member has a cache-read price, so each is read once.
			await at(T);
			expect(reads).toBe(3);
			await at(T + LEDGER_HIT_RATE_TTL_MS - 1);
			expect(reads).toBe(3);
			await at(T + LEDGER_HIT_RATE_TTL_MS);
			expect(reads).toBe(6);
			affinity.clear();
			await at(T + LEDGER_HIT_RATE_TTL_MS);
			expect(reads).toBe(9);
		});

		// CHEAP 2 < RIVAL 2.05; each rate would flip the two if it were used for the member it is given to.
		const RIVAL: Model = { ...GOOGLE, cost: { input: 1.05, output: 1, cacheRead: 0.05, cacheWrite: 1 } };
		it.each([
			[Number.NaN, CHEAP],
			[-0.1, CHEAP],
			[1.5, RIVAL],
		])("keeps full price for an out-of-range hit rate %p", async (rate, target) => {
			const settings = Settings.isolated({
				modelRoles: { engineer: pool("cheapest", [RIVAL, CHEAP], { cache: { pricing: true } }) },
			});
			const hitRate = (model: Model) => (model.provider === target.provider ? rate : undefined);
			expect(await order(settings, hitRate, [RIVAL, CHEAP])).toEqual([CHEAP, RIVAL].map(selectorOf));
		});

		it("keeps full price for a member without a cache-read price and never picks a cheaper member that is cooling down", async () => {
			const noCacheRead: Model = { ...CACHED, cost: { ...CACHED.cost, cacheRead: Number.NaN } };
			expect(await order(pricingPool(true), () => 0.9, [UNPRICED, CHEAP, noCacheRead])).toEqual(
				[CHEAP, CACHED, UNPRICED].map(selectorOf),
			);

			modelRegistry.suppressSelector(selectorOf(CACHED), Date.now() + 60_000);
			const resolution = await resolveRolePool(
				"engineer",
				deps(pricingPool(true), { availableModels: () => [UNPRICED, CHEAP, CACHED], cacheHitRate: () => 0.9 }),
			);
			if (resolution?.kind !== "picked") throw new Error("expected a pick");
			expect(resolution.pick.selector.raw).toBe(selectorOf(CHEAP));
		});
	});

	describe("legacy roles", () => {
		it("returns nothing for legacy role values so the existing resolver keeps them", async () => {
			const settings = Settings.isolated({
				modelRoles: { selector: selectorOf(OPENAI), pattern: "gpt-4o", list: `missing/x,${selectorOf(GOOGLE)}` },
			});

			for (const role of ["selector", "pattern", "list"]) {
				expect(await resolveRolePool(role, deps(settings))).toBeUndefined();
			}
		});
	});

	describe("subagent spawn", () => {
		/** Registry double: every catalog model is available; `apiKey` decides each provider's key. */
		function fakeSpawnRegistry(
			apiKey: (provider: string) => string | undefined = () => "test-key",
			suppressed: readonly string[] = [],
		) {
			const available = [OPENAI, GOOGLE, ANTHROPIC];
			return {
				refresh: async () => {},
				awaitBackgroundRefresh: async () => {},
				getAvailable: () => available,
				getApiKey: async (model: Model) => apiKey(model.provider),
				// Configured credentials exist even when the key itself is expired or blocked.
				hasConfiguredAuth: () => true,
				isSelectorSuppressed: (selector: string) => suppressed.includes(selector),
				find: (provider: string, id: string) => available.find(m => m.provider === provider && m.id === id),
				authStorage: modelRegistry.authStorage,
			};
		}

		async function spawn(
			settings: Settings,
			id: string,
			options: {
				modelOverride?: string;
				apiKey?: (provider: string) => string | undefined;
				suppressed?: readonly string[];
				parentActiveModelPattern?: string;
				prewalk?: string;
			} = {},
		): Promise<{ spawned: string | undefined; error: string | undefined; prewalk: string | undefined }> {
			let spawned: string | undefined;
			let prewalk: string | undefined;
			vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async sessionOptions => {
				spawned = sessionOptions?.model ? selectorOf(sessionOptions.model) : undefined;
				prewalk = sessionOptions?.prewalk ? selectorOf(sessionOptions.prewalk.target) : undefined;
				throw new Error("stop after model resolution");
			});
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: {
					name: "task",
					description: "test",
					systemPrompt: "test",
					source: "bundled",
					...(options.prewalk ? { prewalk: options.prewalk } : {}),
				},
				task: "work",
				index: 0,
				id,
				modelOverride: options.modelOverride ?? "@engineer",
				settings,
				modelRegistry: fakeSpawnRegistry(options.apiKey, options.suppressed) as never,
				parentActiveModelPattern: options.parentActiveModelPattern,
				enableLsp: false,
			});
			return { spawned, error: result.error, prewalk };
		}

		it("keeps the parent-model fallback when no member has a usable key and funding excluded none", async () => {
			const settings = Settings.isolated({ modelRoles: { engineer: pool("priority", [OPENAI, GOOGLE]) } });

			const { spawned, error } = await spawn(settings, "no-credentials", {
				apiKey: provider => (provider === "anthropic" ? "test-key" : undefined),
				parentActiveModelPattern: selectorOf(ANTHROPIC),
			});

			expect(error).not.toContain("model role pool");
			expect(spawned).toBe(selectorOf(ANTHROPIC));
		});

		it("fails the spawn without starting a session when funding excluded every credentialed member", async () => {
			const settings = Settings.isolated({
				modelRoles: { engineer: pool("priority", [OPENAI, GOOGLE], { funding: { order: ["included"] } }) },
			});
			stubBilling({
				openai: { mode: "subscription-included", state: "exhausted" },
				google: { mode: "subscription-included", state: "exhausted" },
			});

			const { spawned, error } = await spawn(settings, "unfunded", {
				parentActiveModelPattern: selectorOf(ANTHROPIC),
			});

			expect(spawned).toBeUndefined();
			expect(error).toContain('model role pool "engineer"');
		});
	});

	describe("startup", () => {
		function startupOptions(settings: Settings) {
			return {
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			};
		}

		it("fails with the role and skip reasons when every default pool member is unfunded", async () => {
			const settings = Settings.isolated({
				modelRoles: { default: pool("priority", [OPENAI, GOOGLE], { funding: { order: ["included"] } }) },
			});
			stubBilling({
				openai: { mode: "subscription-included", state: "exhausted" },
				google: { mode: "subscription-included", state: "disabled" },
			});

			const error = await createAgentSession(startupOptions(settings)).then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(error).toBeInstanceOf(RolePoolUnavailableError);
			if (!(error instanceof RolePoolUnavailableError)) return;
			expect(error.role).toBe("default");
			expect(error.skipped.map(entry => [entry.selector, entry.reason.kind])).toEqual([
				[selectorOf(OPENAI), "exhausted"],
				[selectorOf(GOOGLE), "disabled"],
			]);
		});

		it("starts on the first default pool member when no member has billing evidence", async () => {
			const settings = Settings.isolated({
				modelRoles: { default: pool("priority", [OPENAI, GOOGLE], { funding: { order: ["included"] } }) },
			});
			// Neither provider has a registered billing reader or a usage report in this test.
			vi.spyOn(modelRegistry.authStorage.usage, "reports").mockResolvedValue([]);

			const { session } = await createAgentSession(startupOptions(settings));
			try {
				expect(session.model && selectorOf(session.model)).toBe(selectorOf(OPENAI));
			} finally {
				await session.dispose();
			}
		});

		it("starts on the funded default pool member", async () => {
			const settings = Settings.isolated({
				modelRoles: { default: pool("priority", [OPENAI, GOOGLE], { funding: { order: ["included"] } }) },
			});
			stubBilling({
				openai: { mode: "subscription-included", state: "exhausted" },
				google: { mode: "subscription-included", state: "available" },
			});

			const { session } = await createAgentSession(startupOptions(settings));
			try {
				expect(session.model && selectorOf(session.model)).toBe(selectorOf(GOOGLE));
			} finally {
				await session.dispose();
			}
		});

		/** Session options as main builds them for a `--models` or `enabledModels` scope, over the test startup options. */
		async function scopedStartupOptions(
			roles: Record<string, unknown>,
			scope: Model[],
			source: "--models" | "enabledModels",
			patterns = scope.map(selectorOf),
			extra: Record<string, unknown> = {},
		) {
			const settings = Settings.isolated({
				modelRoles: roles,
				...(source === "enabledModels" ? { enabledModels: patterns } : {}),
				...extra,
			});
			const scoped = await resolveModelScope(patterns, modelRegistry, undefined, settings);
			const built = await buildSessionOptions(
				parseArgs(source === "--models" ? ["--models", patterns.join(",")] : []),
				scoped,
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			return { ...startupOptions(settings), ...built, cwd: tempDir.path() };
		}

		it.each(["--models", "enabledModels"] as const)(
			"starts on the funded default pool member within a %s scope",
			async source => {
				const roles = {
					default: pool("priority", [ANTHROPIC, OPENAI, GOOGLE], { funding: { order: ["included"] } }),
				};
				stubBilling({
					openai: { mode: "subscription-included", state: "exhausted" },
					google: { mode: "subscription-included", state: "available" },
				});

				const { session } = await createAgentSession(await scopedStartupOptions(roles, [OPENAI, GOOGLE], source));
				try {
					expect(session.model && selectorOf(session.model)).toBe(selectorOf(GOOGLE));
				} finally {
					await session.dispose();
				}
			},
		);

		it("starts on the first scoped model with a warning when no default pool member is in a --models scope", async () => {
			const { session, modelFallbackMessage } = await createAgentSession(
				await scopedStartupOptions({ default: pool("priority", [ANTHROPIC]) }, [GOOGLE, OPENAI], "--models"),
			);
			try {
				expect(session.model && selectorOf(session.model)).toBe(selectorOf(GOOGLE));
				expect(modelFallbackMessage).toContain('model role pool "default"');
			} finally {
				await session.dispose();
			}
		});

		it("starts the --models scope fallback at the model's default effort before the settings default", async () => {
			const settings = Settings.isolated({
				modelRoles: { default: pool("priority", [ANTHROPIC]) },
				defaultThinkingLevel: "high",
			});
			const google: Model = {
				...GOOGLE,
				thinking: {
					mode: "budget",
					efforts: [Effort.Low, Effort.Medium, Effort.High],
					defaultLevel: Effort.Medium,
				},
			};
			const built = await buildSessionOptions(
				parseArgs(["--models", selectorOf(GOOGLE)]),
				[{ model: google, explicitThinkingLevel: false }],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			const { session } = await createAgentSession({ ...startupOptions(settings), ...built, cwd: tempDir.path() });
			try {
				expect(session.model && selectorOf(session.model)).toBe(selectorOf(GOOGLE));
				expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
			} finally {
				await session.dispose();
			}
		});

		it("starts a default pool member at the effort of its matching --models entry", async () => {
			const roles = {
				default: {
					strategy: "priority",
					strategyOptions: { order: ["m1"] },
					models: { m1: { model: selectorOf(GOOGLE), defaultEffort: "low" } },
				},
			};
			const { session } = await createAgentSession(
				await scopedStartupOptions(roles, [GOOGLE], "--models", [`${selectorOf(GOOGLE)}:high`], {
					defaultThinkingLevel: "minimal",
				}),
			);
			try {
				expect(session.model && selectorOf(session.model)).toBe(selectorOf(GOOGLE));
				expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			} finally {
				await session.dispose();
			}
		});
	});
});
