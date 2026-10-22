import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { logger } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "model-not-found-rotation-test";
const API = "model-not-found-rotation-test" as Api;
const ANTHROPIC = "anthropic";
const MYTHOS = "claude-mythos-5-1";
const SONNET = "claude-sonnet-5-5";
const HOUR_MS = 60 * 60_000;

function notFound(modelId: string): string {
	return `404 ${JSON.stringify({
		type: "error",
		error: { type: "not_found_error", message: `model: ${modelId}` },
		request_id: "req_test",
	})}`;
}

function model(id: string): Model<Api> {
	return { id, name: id, api: API, provider: ANTHROPIC, contextWindow: 1000, maxTokens: 100 } as Model<Api>;
}

function message(modelId: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: API,
		provider: ANTHROPIC,
		model: modelId,
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };

describe("Anthropic model-not-found account rotation", () => {
	let tempDir = "";
	let dbPath = "";
	const stores: SqliteAuthCredentialStore[] = [];
	/** Bearers each provider request was sent with, in order. */
	let requests: string[] = [];
	/** Bearer → model id the account answers with a 404 naming it. */
	let refusals = new Map<string, string>();

	async function open(): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		stores.push(store);
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.credentials.reload();
		return storage;
	}

	async function seed(): Promise<{ storage: AuthStorage; idA: number; idB: number }> {
		const storage = await open();
		const expires = Date.now() + 30 * 24 * HOUR_MS;
		await storage.credentials.set(ANTHROPIC, [
			{ type: "oauth", access: "access-a", refresh: "r1", expires, email: "a@example.com" },
			{ type: "oauth", access: "access-b", refresh: "r2", expires, email: "b@example.com" },
		]);
		const idOf = (access: string): number => {
			const row = storage.credentials
				.list(ANTHROPIC)
				.find(entry => entry.credential.type === "oauth" && entry.credential.access === access);
			if (!row) throw new Error(`expected ${access}`);
			return row.id;
		};
		return { storage, idA: idOf("access-a"), idB: idOf("access-b") };
	}

	/** Stream one request for `modelId` through the storage's rotating resolver. */
	async function request(storage: AuthStorage, sessionId: string, modelId: string): Promise<AssistantMessage> {
		return streamSimple(model(modelId), context, {
			apiKey: storage.keys.resolver(ANTHROPIC, { sessionId, modelId }),
		}).result();
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-not-found-"));
		dbPath = path.join(tempDir, "agent.db");
		requests = [];
		refusals = new Map();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider] as OAuthCredentials | undefined;
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});
		registerCustomApi(
			API,
			(requested: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				const bearer = String(options?.apiKey);
				requests.push(bearer);
				const stream = new AssistantMessageEventStream();
				const refused = refusals.get(bearer);
				queueMicrotask(() => {
					if (refused === undefined) {
						const done = message(requested.id);
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
						return;
					}
					const failure = message(requested.id, {
						content: [],
						stopReason: "error",
						errorMessage: notFound(refused),
						errorStatus: 404,
					});
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			SOURCE_ID,
		);
	});

	afterEach(async () => {
		unregisterCustomApis(SOURCE_ID);
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("a 404 on one account is served by a sibling, which records a denial for the refusing account only", async () => {
		const { storage, idA } = await seed();
		refusals.set("access-a", MYTHOS);
		storage.sessions.pin(ANTHROPIC, "first", idA, { restoredAtMs: Date.now() });

		const served = await request(storage, "first", MYTHOS);
		expect(served.stopReason).toBe("stop");
		expect(requests).toEqual(["access-a", "access-b"]);

		// The next request for the model skips the refusing account outright.
		requests = [];
		storage.sessions.pin(ANTHROPIC, "second", idA, { restoredAtMs: Date.now() });
		expect((await request(storage, "second", MYTHOS)).stopReason).toBe("stop");
		expect(requests).toEqual(["access-b"]);

		// The denial is persisted for that model and that account only.
		const restarted = await open();
		restarted.sessions.pin(ANTHROPIC, "restarted", idA, { restoredAtMs: Date.now() });
		expect(await restarted.keys.get(ANTHROPIC, "restarted", { modelId: MYTHOS })).toBe("access-b");
		restarted.sessions.pin(ANTHROPIC, "other-model", idA, { restoredAtMs: Date.now() });
		expect(await restarted.keys.get(ANTHROPIC, "other-model", { modelId: SONNET })).toBe("access-a");
	});

	test("a 404 on every account records no denial, and a repeat sends one request before surfacing the 404", async () => {
		const { storage, idA } = await seed();
		refusals.set("access-a", MYTHOS);
		refusals.set("access-b", MYTHOS);
		storage.sessions.pin(ANTHROPIC, "first", idA, { restoredAtMs: Date.now() });

		const failed = await request(storage, "first", MYTHOS);
		expect(failed.stopReason).toBe("error");
		expect(AIError.isAnthropicModelNotFoundError(failed, ANTHROPIC, MYTHOS)).toBe(true);
		expect(requests).toEqual(["access-a", "access-b"]);
		// The caller's own rotation finds nothing left to try, so it goes to model fallback.
		expect(
			(await storage.limits.rotate(ANTHROPIC, "first", { error: failed, modelId: MYTHOS, apiKey: "access-b" }))
				.switched,
		).toBe(false);

		requests = [];
		storage.sessions.pin(ANTHROPIC, "second", idA, { restoredAtMs: Date.now() });
		expect((await request(storage, "second", MYTHOS)).stopReason).toBe("error");
		expect(requests).toEqual(["access-a"]);

		const restarted = await open();
		restarted.sessions.pin(ANTHROPIC, "restarted", idA, { restoredAtMs: Date.now() });
		expect(await restarted.keys.get(ANTHROPIC, "restarted", { modelId: MYTHOS })).toBe("access-a");
	});

	test("an unconfirmed 404 is held in memory only", async () => {
		const { storage, idA } = await seed();
		storage.sessions.pin(ANTHROPIC, "held", idA, { restoredAtMs: Date.now() });
		const rotation = await storage.limits.rotate(ANTHROPIC, "held", {
			error: notFound(MYTHOS),
			modelId: MYTHOS,
			apiKey: "access-a",
		});
		expect(rotation.switched).toBe(true);
		expect(await storage.keys.get(ANTHROPIC, "held", { modelId: MYTHOS })).toBe("access-b");

		const restarted = await open();
		restarted.sessions.pin(ANTHROPIC, "restarted", idA, { restoredAtMs: Date.now() });
		expect(await restarted.keys.get(ANTHROPIC, "restarted", { modelId: MYTHOS })).toBe("access-a");
	});

	test("a 404 naming another model, status, or provider is not an account-specific refusal", async () => {
		const { storage, idA } = await seed();
		refusals.set("access-a", "claude-other-5");
		storage.sessions.pin(ANTHROPIC, "other", idA, { restoredAtMs: Date.now() });

		const failed = await request(storage, "other", MYTHOS);
		expect(failed.stopReason).toBe("error");
		expect(requests).toEqual(["access-a"]);

		const named = message(MYTHOS, { stopReason: "error", errorMessage: notFound(MYTHOS), errorStatus: 404 });
		expect(AIError.isModelNotFoundId(AIError.classifyMessage({ ...named }))).toBe(true);
		expect(AIError.isModelNotFoundId(AIError.classifyMessage({ ...named, errorMessage: notFound("x-1") }))).toBe(
			false,
		);
		expect(AIError.isModelNotFoundId(AIError.classifyMessage({ ...named, provider: "openai" }))).toBe(false);
		expect(AIError.isModelNotFoundId(AIError.classifyMessage({ ...named, errorStatus: 400 }))).toBe(false);
		expect(AIError.isAnthropicModelNotFoundError(notFound(MYTHOS), ANTHROPIC, `anthropic/${MYTHOS}`)).toBe(true);
	});

	test("a model whose only entitled account is blocked sends no request and fails as a usage limit", async () => {
		const { storage, idA } = await seed();
		storage.setModelAccountAccess(ANTHROPIC, MYTHOS, ["a@example.com"]);
		const blockedUntilMs = (
			await storage.limits.markReached(ANTHROPIC, undefined, {
				credentialId: idA,
				modelId: MYTHOS,
				retryAfterMs: HOUR_MS,
			})
		).blockedUntilMs;
		if (blockedUntilMs === undefined) throw new Error("expected a block");
		const warn = vi.spyOn(logger, "warn");

		const error = await request(storage, "restricted", MYTHOS).catch((caught: unknown) => caught);
		expect(requests).toEqual([]);
		expect(AIError.isUsageLimit(error)).toBe(true);
		expect(AIError.isUsageLimit(String((error as Error).message))).toBe(true);
		expect(String((error as Error).message)).toMatch(/retry-after-ms=\d{4,}/);
		expect(warn).toHaveBeenCalledWith(
			"Every account entitled to the model is blocked; not sending the request",
			expect.objectContaining({
				provider: ANTHROPIC,
				modelId: MYTHOS,
				accounts: [{ account: `#${idA} ***@example.com`, blockedUntil: new Date(blockedUntilMs).toISOString() }],
			}),
		);

		// Without an entitlement restriction a blocked account still serves as the last resort.
		await storage.limits.markReached(ANTHROPIC, undefined, {
			apiKey: "access-b",
			modelId: SONNET,
			retryAfterMs: HOUR_MS,
		});
		await storage.limits.markReached(ANTHROPIC, undefined, {
			apiKey: "access-a",
			modelId: SONNET,
			retryAfterMs: HOUR_MS,
		});
		expect((await request(storage, "unrestricted", SONNET)).stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
	});
});
