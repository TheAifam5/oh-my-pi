import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type BillingSource, knownBilling, type Model } from "@oh-my-pi/pi-ai";
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
	RolePoolUnavailableError,
	resolveRolePool,
	rolePoolPolicyBlocked,
} from "@oh-my-pi/pi-coding-agent/session/pool-selection";
import { trackInFlightRequest } from "@oh-my-pi/pi-coding-agent/session/in-flight-requests";
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

		it("never picks a member whose billing is unknown, not even the first", async () => {
			const settings = Settings.isolated({
				modelRoles: { engineer: pool("priority", [OPENAI], { funding: { order: ["included"] } }) },
			});
			// No reader and no report for openai: billing evidence is unknown.
			vi.spyOn(modelRegistry.authStorage.usage, "reports").mockResolvedValue([]);

			const resolution = await resolveRolePool("engineer", deps(settings));

			expect(resolution?.kind).toBe("none");
			if (resolution?.kind !== "none") return;
			expect(resolution.skipped.map(entry => [entry.selector, entry.reason.kind])).toEqual([
				[selectorOf(OPENAI), "unknown-evidence"],
			]);
			expect(notices).toHaveLength(1);
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

		it("names the --model workaround when billing evidence for the default pool is missing", async () => {
			const settings = Settings.isolated({
				modelRoles: { default: pool("priority", [OPENAI], { funding: { order: ["included"] } }) },
			});
			vi.spyOn(modelRegistry.authStorage.usage, "reports").mockResolvedValue([]);

			const error = await createAgentSession(startupOptions(settings)).then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(error).toBeInstanceOf(RolePoolUnavailableError);
			const message = error instanceof Error ? error.message : "";
			// openai has no registered billing reader in this test, so the hint names the provider.
			expect(message).toContain("No billing reader exists for openai");
			expect(message).toContain("--model");
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
		) {
			const patterns = scope.map(selectorOf);
			const settings = Settings.isolated({
				modelRoles: roles,
				...(source === "enabledModels" ? { enabledModels: patterns } : {}),
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
	});
});
