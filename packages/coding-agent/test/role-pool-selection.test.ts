import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type BillingSource, knownBilling, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	notePoolPickApplied,
	type RolePoolDeps,
	RolePoolUnavailableError,
	resolveRolePool,
	rolePoolPolicyBlocked,
} from "@oh-my-pi/pi-coding-agent/session/pool-selection";
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
function pool(
	strategy: "priority" | "round-robin" | "random" | "quota",
	models: Model[],
	routing?: Record<string, unknown>,
): Record<string, unknown> {
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
	});
});
