import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { type AuthAccountPolicies, AuthStorage } from "@oh-my-pi/pi-ai";
import { apiKeyFingerprint } from "@oh-my-pi/pi-ai/auth/policy";
import { createAuthGatewayRouter, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { LocalLimit } from "@oh-my-pi/pi-ai/usage/limits";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { encodeGatewayJobId } from "@oh-my-pi/pi-ai/providers/video-server";
import {
	installGatewayAccountLimits,
	openGatewayLedger,
	openGatewayLedgerDatabase,
} from "../../src/cli/auth-gateway-limits";
import { installStdioAccountLimits } from "../../src/cli/auth-gateway-stdio";
import { Settings } from "../../src/config/settings";
import { AgentStorage } from "../../src/session/agent-storage";

const KEY = "sk-gateway-limit-test";
const DAY = { type: "calendar", period: "day" } as const;

function model(spec: Pick<ModelSpec<Api>, "id" | "api" | "provider" | "baseUrl" | "kind">): Model<Api> {
	return buildModel({
		name: spec.id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: null,
		supportsTools: false,
		...spec,
	} satisfies ModelSpec<Api>);
}

const embedding = model({
	id: "text-embedding-3-small",
	api: "openai-embeddings",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	kind: "embedding",
});
const image = model({
	id: "router-image-test",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://openrouter.example/v1",
	kind: "image",
});
const video = model({
	id: "google/veo-3.1",
	api: "openrouter-video",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	kind: "video",
});
const otherVideo = model({
	id: "google/veo-3.1-fast",
	api: "openrouter-video",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	kind: "video",
});

/** Upstream answers: embeddings report tokens; images and videos report only a cost. */
function upstream(gate?: Promise<void>, reached?: () => void): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		reached?.();
		await gate;
		if (url.endsWith("/embeddings")) {
			return Response.json({
				object: "list",
				data: [{ object: "embedding", index: 0, embedding: [0.125, -0.25] }],
				model: embedding.id,
				usage: { prompt_tokens: 5, total_tokens: 5 },
			});
		}
		if (url.includes("/images")) {
			return Response.json({ created: 1, data: [{ b64_json: "aW1hZ2U=" }], usage: { cost: 0.42 } });
		}
		if (url.endsWith("/videos") && init?.method === "POST") {
			return Response.json({ id: "job-1", status: "pending" }, { status: 202 });
		}
		if (url.endsWith("/videos/job-1")) {
			return Response.json({ id: "job-1", status: "completed", usage: { cost: 0.4, is_byok: false } });
		}
		if (url.includes("/videos/job-1/content")) {
			return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "Content-Type": "video/mp4" } });
		}
		return Response.json({ error: { message: "unexpected upstream request" } }, { status: 500 });
	};
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function policy(provider: string, limits?: LocalLimit[]): AuthAccountPolicies[number] {
	return { provider, account: { keyFingerprint: apiKeyFingerprint(KEY) }, name: "work", ...(limits && { limits }) };
}

async function gateway(
	accountPolicies: AuthAccountPolicies,
	fetchImpl: FetchImpl = upstream(),
	onUsage?: (model: Model<Api>) => Promise<void>,
) {
	const tempDir = TempDir.createSync("@omp-auth-gateway-limits-");
	cleanups.push(() => tempDir.removeSync());
	const dbPath = tempDir.join("agent.db");
	const storage = await AuthStorage.create(":memory:", { accountPolicies, defaultReservePct: 10 });
	cleanups.push(() => storage.close());
	for (const provider of new Set(accountPolicies.map(entry => entry.provider))) {
		await storage.credentials.set(provider, [{ type: "api_key", key: KEY }]);
	}
	let opened = 0;
	const limits = await installGatewayAccountLimits(storage, accountPolicies, () => {
		opened++;
		return openGatewayLedger(dbPath);
	});
	if (limits) cleanups.push(() => limits.close());
	const models = [embedding, image, video, otherVideo];
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => models.find(entry => id === entry.id || id === `${entry.provider}/${entry.id}`),
		version: "test",
		fetch: fetchImpl,
		onUsage: onUsage ?? limits?.onUsage,
	});
	cleanups.push(() => handle.close());
	const post = (pathName: string, body: unknown) =>
		fetch(`${handle.url}${pathName}`, {
			method: "POST",
			headers: { Authorization: "Bearer gw-token", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const get = (pathName: string) =>
		fetch(`${handle.url}${pathName}`, { headers: { Authorization: "Bearer gw-token" } });
	const rows = () => {
		using db = new Database(dbPath, { readonly: true });
		return db.query<{ account: string | null }, []>("SELECT account FROM usage_ledger").all();
	};
	return { post, get, rows, limits, handle, storage, opened: () => opened };
}

const embed = { model: embedding.id, input: "hello" };

describe("auth-gateway account limits", () => {
	test("records each call under its account and refuses the call past a requests limit", async () => {
		const gw = await gateway([policy("openai", [{ metric: "requests", max: 1, window: DAY, onLimit: "skip" }])]);

		expect((await gw.post("/v1/embeddings", embed)).status).toBe(200);
		expect(gw.rows()).toEqual([{ account: `key:${apiKeyFingerprint(KEY)}` }]);

		const refused = await gw.post("/v1/embeddings", embed);
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("local limit");
		expect(gw.rows()).toHaveLength(1);
	});

	test("counts a call that reports only a cost against a usd limit", async () => {
		const gw = await gateway([policy("openrouter", [{ metric: "usd", max: "0.40", window: DAY, onLimit: "skip" }])]);
		const generate = () =>
			gw.post("/v1/images", { model: image.id, prompt: "a forest", response_format: "b64_json" });

		expect((await generate()).status).toBe(200);
		expect((await generate()).status).toBe(429);
	});

	test("counts a completed video job once against a usd limit, refusing new submits but not its polls or download", async () => {
		const gw = await gateway([policy("openrouter", [{ metric: "usd", max: "0.30", window: DAY, onLimit: "skip" }])]);
		const observe = vi.spyOn(gw.storage.usage, "observe");
		const submit = () => gw.post("/v1/videos", { model: `openrouter/${video.id}`, prompt: "a lighthouse" });

		const submitted = await submit();
		expect(submitted.status).toBe(202);
		const { id } = (await submitted.json()) as { id: string };
		const poll = () => gw.get(`/v1/videos/${encodeURIComponent(id)}`);
		expect((await poll()).status).toBe(200);
		expect(gw.rows()).toHaveLength(1);
		expect((await submit()).status).toBe(429);

		expect((await poll()).status).toBe(200);
		expect((await gw.get(`/v1/videos/${encodeURIComponent(id)}/content`)).status).toBe(200);
		expect(gw.rows()).toHaveLength(1);
		expect(observe).toHaveBeenCalledTimes(1);
	});

	test("records a video job fetched without polling, once, whatever model its job id names", async () => {
		const gw = await gateway([policy("openrouter", [{ metric: "usd", max: "5", window: DAY, onLimit: "skip" }])]);
		const submitted = await gw.post("/v1/videos", { model: `openrouter/${video.id}`, prompt: "a lighthouse" });
		const { id } = (await submitted.json()) as { id: string };
		const renamed = encodeGatewayJobId({ provider: "openrouter", modelId: otherVideo.id, upstreamId: "job-1" });

		expect((await gw.get(`/v1/videos/${encodeURIComponent(id)}/content`)).status).toBe(200);
		expect(gw.rows()).toHaveLength(1);
		expect((await gw.get(`/v1/videos/${encodeURIComponent(renamed)}`)).status).toBe(200);
		expect((await gw.get(`/v1/videos/${encodeURIComponent(renamed)}/content`)).status).toBe(200);
		expect(gw.rows()).toHaveLength(1);
	});

	test("retries a failed ledger record of a video job without observing it again", async () => {
		let attempts = 0;
		const gw = await gateway(
			[policy("openrouter", [{ metric: "usd", max: "5", window: DAY, onLimit: "skip" }])],
			upstream(),
			async () => {
				attempts++;
				throw new Error("ledger unavailable");
			},
		);
		const observe = vi.spyOn(gw.storage.usage, "observe");
		const submitted = await gw.post("/v1/videos", { model: `openrouter/${video.id}`, prompt: "a lighthouse" });
		const { id } = (await submitted.json()) as { id: string };

		for (let poll = 0; poll < 3; poll++) {
			expect((await gw.get(`/v1/videos/${encodeURIComponent(id)}`)).status).toBe(200);
		}
		expect(attempts).toBe(3);
		expect(observe).toHaveBeenCalledTimes(1);
	});

	test("records a request still in flight when the gateway closes", async () => {
		const release = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const gw = await gateway(
			[policy("openai", [{ metric: "requests", max: 5, window: DAY, onLimit: "skip" }])],
			upstream(release.promise, reached.resolve),
		);

		const inFlight = gw.post("/v1/embeddings", embed).catch(() => undefined);
		await reached.promise;
		const closed = gw.handle.close();
		release.resolve();
		await closed;
		expect(gw.rows()).toHaveLength(1);
		await inFlight;
	});

	test("opens no ledger and records nothing without a limit counted from it", async () => {
		const gw = await gateway([policy("openai")]);

		expect(gw.limits).toBeUndefined();
		expect((await gw.post("/v1/embeddings", embed)).status).toBe(200);
		expect((await gw.post("/v1/embeddings", embed)).status).toBe(200);
		expect(gw.opened()).toBe(0);
	});

	test("creates the ledger database owner-only and leaves a corrupt one in place", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-ledger-");
		const fresh = tempDir.join("data", "agent.db");
		const db = await openGatewayLedgerDatabase(fresh);
		db.run("CREATE TABLE probe (x)");
		if (process.platform !== "win32") {
			for (const file of [fresh, `${fresh}-wal`, `${fresh}-shm`]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		}
		db.close();

		const corrupt = tempDir.join("corrupt.db");
		const garbage = "not a sqlite database ".repeat(256);
		fs.writeFileSync(corrupt, garbage);
		await expect(openGatewayLedgerDatabase(corrupt)).rejects.toThrow();
		expect(fs.readFileSync(corrupt, "utf8")).toBe(garbage);
		expect(fs.readdirSync(tempDir.path()).filter(name => name.startsWith("corrupt.db.corrupt"))).toEqual([]);
	});
});

describe("auth-gateway stdio account limits", () => {
	test("counts calls in the agent storage's ledger, refuses past a limit, and leaves that ledger open", async () => {
		const tempDir = TempDir.createSync("@omp-auth-gateway-stdio-limits-");
		cleanups.push(() => tempDir.removeSync());
		const agentStorage = await AgentStorage.open(tempDir.join("agent.db"));
		cleanups.push(() => AgentStorage.close());
		const accountPolicies = [policy("openai", [{ metric: "requests", max: 1, window: DAY, onLimit: "skip" }])];
		const storage = await AuthStorage.create(":memory:", { accountPolicies, defaultReservePct: 10 });
		cleanups.push(() => storage.close());
		await storage.credentials.set("openai", [{ type: "api_key", key: KEY }]);

		const limits = await installStdioAccountLimits(
			storage,
			accountPolicies,
			Settings.isolated({}, { storage: agentStorage }),
		);
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: id => (id === embedding.id ? embedding : undefined),
			fetch: upstream(),
			onUsage: limits?.onUsage,
		});
		cleanups.push(() => router.close());
		const embedCall = () =>
			router.route(
				new Request("http://stdio/v1/embeddings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(embed),
				}),
				"stdio",
			);

		expect((await embedCall()).status).toBe(200);
		expect((await embedCall()).status).toBe(429);
		await router.settled();
		await limits?.close();
		expect(agentStorage.usageLedger.totals([{ provider: "openai" }], 0).requests).toBe(1n);
	});
});
