import { afterEach, describe, expect, it } from "bun:test";
import { createApiKeyResolver } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-daybreak-blue-latest";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function codexCredential(accountId: string, email: string) {
	return {
		type: "oauth" as const,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email,
	};
}

describe("api key resolver entitlement", () => {
	let authStorage: AuthStorage | undefined;

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
	});

	it("routes free-variant requests away from exhausted keys and keeps explicit paid suffixes eligible", async () => {
		const usageFetch: FetchImpl = async (_input, init) => {
			const healthy = new Headers(init?.headers).get("authorization") === "Bearer healthy";
			return new Response(
				JSON.stringify({
					data: {
						limit: 100,
						limit_remaining: healthy ? 20 : 90,
						limit_reset: "monthly",
						free_model_daily_requests: { used: healthy ? 0 : 50, limit: 50, remaining: healthy ? 50 : 0 },
					},
				}),
			);
		};
		authStorage = await AuthStorage.create(":memory:", { usageFetch: usageFetch as typeof globalThis.fetch });
		await authStorage.credentials.set("openrouter", [
			{ type: "api_key", key: "spent" },
			{ type: "api_key", key: "healthy" },
		]);
		const store = authStorage;
		const keys: string[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			keys.push(new Headers(init?.headers).get("authorization") ?? "");
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		for (const id of [
			"meta-llama/llama-3.3-70b-instruct",
			"meta-llama/llama-3.3-70b-instruct:free",
			"meta-llama/llama-3.3-70b-instruct:nitro",
		]) {
			for (const direct of [false, true]) {
				const model = buildModel({
					id,
					name: id,
					provider: "openrouter",
					api: "openai-completions",
					baseUrl: "https://openrouter.ai/api/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 1024,
				});
				const resolver = createApiKeyResolver(
					{
						getApiKeyWithCredentialForProvider: (provider, session, options) =>
							store.keys.getWithCredential(provider, session, options),
						authStorage: store,
					},
					"openrouter",
					{ modelId: id },
				);
				const result = await streamSimple(
					model,
					{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
					{
						apiKey: direct ? store.keys.resolver("openrouter", { modelId: id }) : resolver,
						openrouterVariant: "free",
						fetch,
					},
				).result();
				expect(result.stopReason).toBe("stop");
			}
		}
		expect(keys).toEqual([
			"Bearer healthy",
			"Bearer healthy",
			"Bearer healthy",
			"Bearer healthy",
			"Bearer spent",
			"Bearer spent",
		]);
	});

	for (const direct of [false, true]) {
		it(`keeps a free-variant usage error from blocking paid requests through ${direct ? "storage" : "registry"} resolution`, async () => {
			const usageFetch: FetchImpl = async () =>
				new Response(
					JSON.stringify({
						data: {
							limit: 100,
							limit_remaining: 90,
							free_model_daily_requests: { used: 0, limit: 50, remaining: 50 },
						},
					}),
				);
			authStorage = await AuthStorage.create(":memory:", { usageFetch: usageFetch as typeof globalThis.fetch });
			await authStorage.credentials.set("openrouter", [
				{ type: "api_key", key: "limited-free" },
				{ type: "api_key", key: "healthy" },
			]);
			const store = authStorage;
			const id = "meta-llama/llama-3.3-70b-instruct";
			const model = buildModel({
				id,
				name: id,
				provider: "openrouter",
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 1024,
			});
			const resolver = createApiKeyResolver(
				{
					getApiKeyWithCredentialForProvider: (provider, session, options) =>
						store.keys.getWithCredential(provider, session, options),
					authStorage: store,
				},
				"openrouter",
				{ modelId: id },
			);
			const keys: string[] = [];
			const fetch: FetchImpl = async (_input, init) => {
				const key = new Headers(init?.headers).get("authorization") ?? "";
				keys.push(key);
				if (key === "Bearer limited-free") {
					return new Response(JSON.stringify({ error: { message: "free-model usage limit reached" } }), {
						status: 429,
					});
				}
				return new Response(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
						"data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: direct ? store.keys.resolver("openrouter", { modelId: id }) : resolver,
					openrouterVariant: "free",
					fetch,
					maxHttpAttempts: 1,
				},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(keys).toEqual(["Bearer limited-free", "Bearer healthy"]);
			expect(await store.keys.get("openrouter", undefined, { modelId: id })).toBe("limited-free");
		});
	}

	it("does not rotate a fresh store's usage-limited session onto an account the model does not list", async () => {
		authStorage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		await authStorage.credentials.set(PROVIDER, [
			codexCredential("account-entitled", "entitled@example.com"),
			codexCredential("account-other", "other@example.com"),
		]);
		const entitled = authStorage.sessions
			.accounts(PROVIDER)
			.find(account => account.accountId === "account-entitled");
		if (!entitled) throw new Error("expected the entitled Codex account");
		const sessionId = "entitlement-fresh-store";
		expect(authStorage.sessions.pin(PROVIDER, sessionId, entitled.credentialId, { restoredAtMs: Date.now() })).toBe(
			true,
		);
		const store = authStorage;
		const resolver = createApiKeyResolver(
			{
				getApiKeyWithCredentialForProvider: (provider, session, options) =>
					store.keys.getWithCredential(provider, session, options),
				authStorage: store,
			},
			PROVIDER,
			{ sessionId, modelId: MODEL_ID, accountIds: ["account-entitled"] },
		);

		const resolved = await resolver({
			lastChance: true,
			error: new Error("usage_limit_reached: The usage limit has been reached"),
		});

		expect(resolved).toBeUndefined();
	});
});
