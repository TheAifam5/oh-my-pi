import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { maskedAccountLabel } from "@oh-my-pi/pi-ai/auth/types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

type FallbackApplied = Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>;

const CAPACITY_ERROR = "Codex is at capacity right now. Please try again later. code=turn_rate_limit_exceeded";
const QUOTA_ERROR =
	"Devin stream error failed_precondition: Your daily usage quota has been exhausted. Your quota will reset after 1s.";

function notFound(modelId: string): string {
	return `404 ${JSON.stringify({
		type: "error",
		error: { type: "not_found_error", message: `model: ${modelId}` },
		request_id: "req_test",
	})}`;
}

function bundled(provider: Parameters<typeof getBundledModel>[0], id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const selectorOf = (model: Model): string => `${model.provider}/${model.id}`;

describe("advisor and capacity routing", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-advisor-routing-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		for (const provider of ["anthropic", "openai", "google"]) {
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
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	const mainModel = bundled("openai", "gpt-4o-mini");
	const advisorPrimary = bundled("anthropic", "claude-sonnet-4-5");
	const advisorChainModel = bundled("google", "gemini-2.5-flash");
	const securityChainModel = bundled("openai", "gpt-4o");
	const overrideModel = bundled("anthropic", "claude-opus-4-1");

	/**
	 * Start a session whose advisors fail on `advisorPrimary` with `failure` (every request,
	 * or the first `failures`), answer on every other model, and resolve once `expectedAnswers`
	 * advisor reviews have answered.
	 */
	function startAdvisorSession(options: {
		configs: AdvisorConfig[];
		settings: Record<string, unknown>;
		roles?: Record<string, string>;
		failure: string;
		failures?: number;
		expectedAnswers?: number;
		onRequest?: (model: Model) => Promise<void> | void;
	}): { requested: string[]; fallbacks: FallbackApplied[]; answered: Promise<void> } {
		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const requested: string[] = [];
		const fallbacks: FallbackApplied[] = [];
		const answered = Promise.withResolvers<void>();
		let primaryFailures = 0;
		let answers = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: mainModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, ...options.settings });
		for (const [role, selector] of Object.entries(options.roles ?? {})) settings.setModelRole(role, selector);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: options.configs,
			advisorStreamFn: async (model, context, streamOptions) => {
				requested.push(selectorOf(model));
				await options.onRequest?.(model);
				const failing =
					selectorOf(model) === selectorOf(advisorPrimary) &&
					(options.failures === undefined || primaryFailures++ < options.failures);
				if (failing) {
					advisorMock.push({ throw: options.failure });
				} else {
					advisorMock.push({ content: ["Advisor reviewed"] });
					if (++answers >= (options.expectedAnswers ?? 1)) answered.resolve();
				}
				return advisorMock.stream(model, context, streamOptions);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event);
		});
		session.setAdvisorEnabled(true);
		return { requested, fallbacks, answered: answered.promise };
	}

	it("falls back along the @role's chain instead of the advisor chain", async () => {
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const { requested, fallbacks, answered } = startAdvisorSession({
			configs: [{ name: "Security", model: "@security" }],
			settings: {
				"retry.fallbackChains": {
					advisor: [selectorOf(advisorChainModel)],
					security: [selectorOf(securityChainModel)],
				},
			},
			roles: { security: `${selectorOf(advisorPrimary)}:high`, advisor: selectorOf(mainModel) },
			failure: QUOTA_ERROR,
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toEqual([selectorOf(advisorPrimary), selectorOf(securityChainModel)]);
		expect(fallbacks).toMatchObject([{ role: "security", to: selectorOf(securityChainModel) }]);
	});

	it("walks an advisor's explicit fallback chain before its @role's chain", async () => {
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const { requested, fallbacks, answered } = startAdvisorSession({
			configs: [{ name: "Security", model: "@security", fallback: "deep" }],
			settings: {
				"retry.fallbackChains": {
					security: [selectorOf(securityChainModel)],
					deep: [selectorOf(advisorChainModel)],
				},
			},
			roles: { security: `${selectorOf(advisorPrimary)}:high`, deep: selectorOf(overrideModel) },
			failure: QUOTA_ERROR,
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toEqual([selectorOf(advisorPrimary), selectorOf(overrideModel)]);
		expect(fallbacks).toMatchObject([{ role: "deep", to: selectorOf(overrideModel) }]);
	});

	it("backs off and retries an advisor's model on a capacity error, then tries another account, then falls back", async () => {
		const markReached = vi
			.spyOn(modelRegistry.authStorage.limits, "markReached")
			.mockResolvedValue({ switched: false });
		const waits = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { requested, fallbacks, answered } = startAdvisorSession({
			configs: [{ name: "Capacity", model: `${selectorOf(advisorPrimary)}:high` }],
			settings: {
				"retry.capacityRetries": 1,
				"retry.capacityBaseDelayMs": 150,
				"retry.fallbackChains": { advisor: [selectorOf(advisorChainModel)] },
			},
			roles: { advisor: `${selectorOf(advisorPrimary)}:high` },
			failure: CAPACITY_ERROR,
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toEqual([
			selectorOf(advisorPrimary),
			selectorOf(advisorPrimary),
			selectorOf(advisorChainModel),
		]);
		expect(waits).toHaveBeenCalledWith(150, expect.anything());
		expect(markReached).toHaveBeenCalledTimes(1);
		expect(markReached).toHaveBeenCalledWith(
			advisorPrimary.provider,
			expect.any(String),
			expect.objectContaining({ reason: "MODEL_CAPACITY_EXHAUSTED", modelId: advisorPrimary.id }),
		);
		expect(fallbacks).toMatchObject([{ role: "advisor", to: selectorOf(advisorChainModel) }]);
	});

	it("retries an advisor on its model after a capacity error moves it to another account", async () => {
		const markReached = vi
			.spyOn(modelRegistry.authStorage.limits, "markReached")
			.mockResolvedValue({ switched: true });
		const { requested, fallbacks, answered } = startAdvisorSession({
			configs: [{ name: "Capacity", model: `${selectorOf(advisorPrimary)}:high` }],
			settings: {
				"retry.capacityRetries": 0,
				"retry.fallbackChains": { advisor: [selectorOf(advisorChainModel)] },
			},
			roles: { advisor: `${selectorOf(advisorPrimary)}:high` },
			failure: CAPACITY_ERROR,
			failures: 1,
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toEqual([selectorOf(advisorPrimary), selectorOf(advisorPrimary)]);
		expect(markReached).toHaveBeenCalledTimes(1);
		expect(fallbacks).toEqual([]);
	});

	it("queues advisor requests beyond advisor.maxConcurrentRequests", async () => {
		let inFlight = 0;
		let peak = 0;
		const { requested, answered } = startAdvisorSession({
			configs: [
				{ name: "One", model: selectorOf(advisorChainModel) },
				{ name: "Two", model: selectorOf(advisorChainModel) },
				{ name: "Three", model: selectorOf(advisorChainModel) },
			],
			settings: { "advisor.maxConcurrentRequests": 2 },
			failure: CAPACITY_ERROR,
			expectedAnswers: 3,
			onRequest: async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				// Advisors start independently and expose no signal before their slot is
				// granted, so overlapping requests need a real hold to be observable.
				await Bun.sleep(30);
				inFlight--;
			},
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toHaveLength(3);
		expect(peak).toBe(2);
	});

	it("names the masked account in the advisor failure log", async () => {
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		vi.spyOn(modelRegistry.authStorage.sessions, "accounts").mockReturnValue([
			{ credentialId: 3, type: "oauth", email: "someone@other.example", active: false, pinned: false },
			{ credentialId: 14, type: "oauth", email: "work.user@example.com", active: true, pinned: false },
		]);
		const warn = vi.spyOn(logger, "warn");
		const { answered } = startAdvisorSession({
			configs: [{ name: "Logged", model: `${selectorOf(advisorPrimary)}:high` }],
			settings: { "retry.fallbackChains": { advisor: [selectorOf(advisorChainModel)] } },
			roles: { advisor: `${selectorOf(advisorPrimary)}:high` },
			failure: QUOTA_ERROR,
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(warn).toHaveBeenCalledWith(
			"advisor turn failed",
			expect.objectContaining({ advisor: "Logged", account: "#14 ***@example.com" }),
		);
		expect(warn).toHaveBeenCalledWith(
			"advisor retry fallback applied",
			expect.objectContaining({ account: "#14 ***@example.com", to: selectorOf(advisorChainModel) }),
		);
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).not.toContain("work.user");
	});

	it("masks API keys to their fingerprint and accounts without email to their id", () => {
		expect(maskedAccountLabel({ credentialId: 5, type: "api_key", keyFingerprint: "ab12" })).toBe("#5 key ab12");
		expect(maskedAccountLabel({ credentialId: 6, type: "oauth" })).toBe("#6");
	});

	it("moves an advisor to another account on a 404 naming its model, bounded by the account count, then falls back", async () => {
		const rotate = vi.spyOn(modelRegistry.authStorage.limits, "rotate").mockResolvedValue({ switched: true });
		const { requested, fallbacks, answered } = startAdvisorSession({
			configs: [{ name: "Security", model: `${selectorOf(advisorPrimary)}:high` }],
			settings: { "retry.fallbackChains": { advisor: [selectorOf(advisorChainModel)] } },
			roles: { advisor: `${selectorOf(advisorPrimary)}:high` },
			failure: notFound(advisorPrimary.id),
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toEqual([
			selectorOf(advisorPrimary),
			selectorOf(advisorPrimary),
			selectorOf(advisorChainModel),
		]);
		expect(rotate).toHaveBeenCalledWith(
			advisorPrimary.provider,
			expect.any(String),
			expect.objectContaining({ modelId: advisorPrimary.id }),
		);
		expect(fallbacks).toMatchObject([{ role: "advisor", to: selectorOf(advisorChainModel) }]);
	});

	it("falls an advisor back without rotating on a 404 naming another model", async () => {
		const rotate = vi.spyOn(modelRegistry.authStorage.limits, "rotate").mockResolvedValue({ switched: true });
		const { requested, fallbacks, answered } = startAdvisorSession({
			configs: [{ name: "Security", model: `${selectorOf(advisorPrimary)}:high` }],
			settings: { "retry.fallbackChains": { advisor: [selectorOf(advisorChainModel)] } },
			roles: { advisor: `${selectorOf(advisorPrimary)}:high` },
			failure: notFound("claude-other-5"),
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toEqual([selectorOf(advisorPrimary), selectorOf(advisorChainModel)]);
		expect(rotate).not.toHaveBeenCalled();
		expect(fallbacks).toMatchObject([{ role: "advisor", to: selectorOf(advisorChainModel) }]);
	});

	it("falls an advisor back at once when every account entitled to its model is blocked", async () => {
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const waits = vi.spyOn(scheduler, "wait");
		const refusal = new AIError.EntitledAccountsBlockedError(
			advisorPrimary.provider,
			advisorPrimary.id,
			Date.now() + 3 * 24 * 60 * 60_000,
		);
		const { requested, fallbacks, answered } = startAdvisorSession({
			configs: [{ name: "Security", model: `${selectorOf(advisorPrimary)}:high` }],
			settings: {
				"retry.fallbackOn": "usage-limit",
				"retry.fallbackChains": { advisor: [selectorOf(advisorChainModel)] },
			},
			roles: { advisor: `${selectorOf(advisorPrimary)}:high` },
			failure: `Failed to resolve API key for provider ${advisorPrimary.provider}: ${refusal.message}`,
		});
		await session!.prompt("Complete one primary turn");
		await answered;

		expect(requested).toEqual([selectorOf(advisorPrimary), selectorOf(advisorChainModel)]);
		expect(fallbacks).toMatchObject([{ role: "advisor", to: selectorOf(advisorChainModel) }]);
		// Other suites' timers may share the spy; no wait for this block's remaining time (days) occurs.
		expect(waits.mock.calls.filter(([delayMs]) => typeof delayMs === "number" && delayMs >= 60_000)).toEqual([]);
	});

	it("retries a main turn on another account after a 404 naming its model, then falls back", async () => {
		const primary = advisorPrimary;
		const fallback = securityChainModel;
		const rotate = vi
			.spyOn(modelRegistry.authStorage.limits, "rotate")
			.mockResolvedValueOnce({ switched: true })
			.mockResolvedValue({ switched: false });
		const requested: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(selectorOf(model));
				if (selectorOf(model) === selectorOf(primary)) mock.push({ throw: notFound(primary.id) });
				else mock.push({ content: ["Recovered"] });
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { default: [selectorOf(fallback)] },
		});
		settings.setModelRole("default", selectorOf(primary));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Recover from a model 404");
		await session.waitForIdle();

		expect(requested).toEqual([selectorOf(primary), selectorOf(primary), selectorOf(fallback)]);
		expect(rotate).toHaveBeenCalledTimes(2);
		expect(rotate).toHaveBeenCalledWith(
			primary.provider,
			expect.any(String),
			expect.objectContaining({ modelId: primary.id }),
		);
		expect(session.model?.id).toBe(fallback.id);
	});

	it("retries a main turn's model after a capacity error before falling back", async () => {
		const primary = advisorPrimary;
		const fallback = securityChainModel;
		const markReached = vi
			.spyOn(modelRegistry.authStorage.limits, "markReached")
			.mockResolvedValue({ switched: false });
		const requested: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(selectorOf(model));
				if (selectorOf(model) === selectorOf(primary)) mock.push({ throw: CAPACITY_ERROR });
				else mock.push({ content: ["Recovered"] });
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.capacityRetries": 2,
			"retry.capacityBaseDelayMs": 1,
			"retry.fallbackChains": { default: [selectorOf(fallback)] },
		});
		settings.setModelRole("default", selectorOf(primary));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Recover from capacity");
		await session.waitForIdle();

		expect(requested).toEqual([selectorOf(primary), selectorOf(primary), selectorOf(primary), selectorOf(fallback)]);
		expect(markReached).toHaveBeenCalledWith(
			primary.provider,
			expect.any(String),
			expect.objectContaining({ reason: "MODEL_CAPACITY_EXHAUSTED", modelId: primary.id }),
		);
		expect(session.model?.id).toBe(fallback.id);
	});
});
