import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { AdvisorRuntime, type AdvisorAgent } from "@oh-my-pi/pi-coding-agent/advisor/runtime";

const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
const fallback = getBundledModel("google", "gemini-2.5-flash");
if (!primary || !fallback) throw new Error("Missing bundled models");
const primarySelector = `${primary.provider}/${primary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;
let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	vi.restoreAllMocks();
});

async function setup(options: {
	reservePct?: number;
	whenReserved?: "fallback" | "skip";
	budget?: AdvisorConfig["budget"];
	explicitFallback?: boolean;
	name?: string;
	advisorFailure?: string;
}) {
	if (!primary || !fallback) throw new Error("Missing bundled models");
	const controls = { remaining: 10 };
	const usageProvider: UsageProvider = {
		id: "anthropic",
		async fetchUsage() {
			return {
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: ["5h", "7d"].map(windowId => ({
					id: `anthropic:${windowId}`,
					label: windowId,
					scope: { provider: "anthropic", windowId, shared: true },
					window: { id: windowId, label: windowId, resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: 1 - controls.remaining / 100 },
					status: "ok",
				})),
			};
		},
	};
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
	});
	authStorage = auth;
	await auth.credentials.set("anthropic", [
		{
			type: "oauth",
			access: "advisor-key",
			refresh: "refresh-key",
			expires: Date.now() + 86_400_000,
			accountId: "reserved-account",
			email: "reserved@example.com",
		},
	]);
	auth.keys.setRuntime("google", "fallback-key");
	const registry = new ModelRegistry(auth);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "strict",
		"advisor.budget.reservePct": options.reservePct,
		"advisor.budget.whenReserved": options.whenReserved ?? "fallback",
		"retry.fallbackChains": { security: [fallbackSelector], deep: [fallbackSelector] },
	});
	settings.setModelRole("security", primarySelector);
	settings.setModelRole("deep", primarySelector);
	const mock = createMockModel({ handler: { content: ["Complete"] } });
	const requested: string[] = [];
	const notices: string[] = [];
	session = new AgentSession({
		agent: new Agent({
			initialState: { model: primary, systemPrompt: ["Test"], tools: [] },
			getApiKey: () => "main-key",
			streamFn: mock.stream,
		}),
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(),
		settings,
		advisorTools: [],
		advisorConfigs: [
			{
				name: options.name ?? "Security",
				model: "@security",
				budget: options.budget,
				fallback: options.explicitFallback ? "deep" : undefined,
			},
		],
		advisorStreamFn: (model, context, streamOptions) => {
			requested.push(model.id);
			if (options.advisorFailure) mock.push({ throw: options.advisorFailure });
			return mock.stream(model, context, streamOptions);
		},
	});
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "advisor") notices.push(event.message);
	});
	session.setAdvisorEnabled(true);
	const active = session;
	const review = async () => {
		await auth.usage.invalidate("anthropic");
		await active.prompt("Review this update");
		await active.waitForIdle();
		expect(await active.waitForAdvisorCatchup(5000)).toBe(true);
	};
	return { requested, notices, review, controls, registry };
}

describe("advisor quota reserve", () => {
	for (const explicitFallback of [false, true]) {
		it(`uses the ${explicitFallback ? "explicit" : "role-derived"} chain without requesting the reserved model`, async () => {
			const { requested, notices, review, controls } = await setup({ reservePct: 20, explicitFallback });
			await review();
			await review();
			expect(requested).toEqual([fallback?.id, fallback?.id]);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("10.0%");
			controls.remaining = 80;
			await review();
			expect(requested.at(-1)).toBe(primary?.id);
		});
	}

	it("rechecks the reserve on real request resolution after a successful preflight", async () => {
		const { registry, controls } = await setup({ reservePct: 20 });
		controls.remaining = 80;
		expect(await registry.getApiKey(primary, "request-reserve", { minRemainingPct: 20 })).toBe("advisor-key");
		controls.remaining = 10;
		await authStorage?.usage.invalidate("anthropic");
		const notices: number[] = [];
		const resolver = registry.resolver("anthropic", {
			sessionId: "request-reserve",
			modelId: primary.id,
			minRemainingPct: 20,
			onReservedAccount: (_account, remaining) => notices.push(remaining),
		});
		expect(await resolver({ lastChance: false, error: undefined })).toBeUndefined();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toBeCloseTo(10);
	});

	it("skips reserved reviews without requests or repeated notices", async () => {
		const { requested, notices, review } = await setup({ reservePct: 20, whenReserved: "skip" });
		await review();
		await review();
		expect(requested).toEqual([]);
		expect(notices).toHaveLength(1);
	});

	it("inherits each budget field separately and honors the advisor override", async () => {
		const { requested, review } = await setup({ reservePct: 50, whenReserved: "skip", budget: { reservePct: 5 } });
		await review();
		expect(requested).toEqual([primary?.id]);
	});

	it("uses a per-advisor skip override over the global fallback action", async () => {
		const { requested, review } = await setup({ reservePct: 50, budget: { whenReserved: "skip" } });
		await review();
		expect(requested).toEqual([]);
	});

	it("sanitizes project-controlled advisor names in reserve notices", async () => {
		const { notices, review } = await setup({
			reservePct: 20,
			whenReserved: "skip",
			name: "Review\n\x1b[31mSpoof\u202e",
		});
		await review();
		expect(notices).toHaveLength(1);
		expect(notices[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
	});

	it("keeps missing credentials on the normal error path rather than treating them as reserved", async () => {
		const { registry, requested, notices, review } = await setup({
			reservePct: 20,
			whenReserved: "skip",
			advisorFailure: "No API key found for anthropic",
		});
		const originalGet = registry.getApiKey.bind(registry);
		vi.spyOn(registry, "getApiKey").mockImplementation((model, sessionId, options) =>
			options?.minRemainingPct === undefined ? originalGet(model, sessionId, options) : Promise.resolve(undefined),
		);
		vi.spyOn(registry, "getApiKeyWithCredentialForProvider").mockResolvedValue(undefined);
		await review();
		expect(requested).toEqual([primary?.id]);
		expect(notices.some(notice => notice.includes("unavailable"))).toBe(true);
		expect(notices.some(notice => notice.includes("quota reserve"))).toBe(false);
	});

	it("supplies a fresh prompt signal after an aborted review resumes", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const firstFinished = Promise.withResolvers<void>();
		const signals: Array<AbortSignal | undefined> = [];
		const agent: AdvisorAgent = {
			prompt: async (_input, options) => {
				signals.push(options?.signal);
				if (signals.length === 1) {
					firstStarted.resolve();
					await firstFinished.promise;
				} else {
					options?.signal?.throwIfAborted();
					secondStarted.resolve();
				}
			},
			abort: () => firstFinished.resolve(),
			reset: () => {},
			state: { messages: [] },
		};
		const messages: AgentMessage[] = [{ role: "user", content: "Review", timestamp: 1 }];
		const runtime = new AdvisorRuntime(agent, { snapshotMessages: () => messages }, 0);
		try {
			runtime.onTurnEnd(messages);
			await firstStarted.promise;
			await runtime.pauseForSessionTransition();
			expect(signals[0]?.aborted).toBe(true);
			runtime.resumeAfterSessionTransition();
			messages.push({ role: "user", content: "Review after abort", timestamp: 2 });
			runtime.onTurnEnd(messages);
			await secondStarted.promise;
			expect(signals[1]?.aborted).toBe(false);
			expect(signals[1]).not.toBe(signals[0]);
			await runtime.waitForCatchup(5000, 1);
		} finally {
			runtime.dispose();
		}
	});

	it("does not filter when reservePct is unset", async () => {
		const { requested, notices, review } = await setup({});
		await review();
		expect(requested).toEqual([primary?.id]);
		expect(notices).toEqual([]);
	});
});
