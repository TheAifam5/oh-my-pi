import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { decodeGatewayJobId, encodeGatewayJobId } from "@oh-my-pi/pi-ai/providers/video-server";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { CredentialRankingStrategy, UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const VIDEO_BYTES = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

interface UpstreamRequest {
	url: string;
	method: string;
	authorization: string | null;
	body?: unknown;
}

interface Harness {
	url: string;
	storage: AuthStorage;
	upstream: UpstreamRequest[];
	handle: AuthGatewayServerHandle;
	dir: string;
}

function model(id: string, api: Api = "openrouter-video", kind: "video" | undefined = "video"): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...(kind !== undefined && { kind }),
	} satisfies ModelSpec<Api>);
}

async function boot(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-video-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "openrouter-secret");
	const video = model("google/veo-3.1");
	const wrongApi = model("openrouter/auto", "openrouter", undefined);
	const upstream: UpstreamRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		upstream.push({
			url,
			method,
			authorization: new Headers(init?.headers).get("authorization"),
			...(body !== undefined && { body }),
		});
		if (url.endsWith("/videos") && method === "POST") {
			return Response.json(
				{
					id: "job-upstream-123",
					polling_url: "https://openrouter.ai/api/v1/videos/job-upstream-123",
					status: "pending",
				},
				{ status: 202 },
			);
		}
		if (url.endsWith("/videos/job-upstream-123") && method === "GET") {
			return Response.json({
				id: "job-upstream-123",
				generation_id: "generation-456",
				polling_url: "https://openrouter.ai/api/v1/videos/job-upstream-123",
				status: "completed",
				unsigned_urls: ["https://openrouter.ai/api/v1/videos/job-upstream-123/content?index=0"],
				usage: { cost: 0.4, is_byok: false },
			});
		}
		if (url.endsWith("/videos/job-upstream-123/content") && method === "GET") {
			return new Response(VIDEO_BYTES, {
				headers: { "Content-Type": "video/mp4", "Content-Length": String(VIDEO_BYTES.byteLength) },
			});
		}
		return Response.json({ error: { message: "unexpected upstream request" } }, { status: 500 });
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => {
			if (id === video.id || id === `openrouter/${video.id}`) return video;
			if (id === wrongApi.id || id === `openrouter/${wrongApi.id}`) return wrongApi;
			return undefined;
		},
		version: "test",
		fetch: fetchImpl,
	});
	return { url: handle.url, storage, upstream, handle, dir };
}

async function close(harness: Harness | undefined): Promise<void> {
	if (!harness) return;
	await harness.handle.close();
	harness.storage.close();
	await fs.rm(harness.dir, { recursive: true, force: true });
}

function gatewayHeaders(): Record<string, string> {
	return { Authorization: "Bearer gw-token", "Content-Type": "application/json" };
}

async function submit(harness: Harness): Promise<{ response: Response; body: Record<string, unknown> }> {
	const response = await fetch(`${harness.url}/v1/videos`, {
		method: "POST",
		headers: gatewayHeaders(),
		body: JSON.stringify({
			model: "openrouter/google/veo-3.1",
			prompt: "A lighthouse in a storm",
			duration: 8,
			resolution: "1080p",
			aspect_ratio: "16:9",
			frame_images: [
				{
					type: "image_url",
					image_url: { url: "https://example.com/first.png" },
					frame_type: "first_frame",
				},
			],
			generate_audio: true,
			seed: 42,
		}),
	});
	return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("auth-gateway asynchronous video generation", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await close(harness);
		harness = undefined;
	});

	it("submits with the broker credential and returns a stateless gateway job id", async () => {
		harness = await boot();
		const { response, body } = await submit(harness);
		expect(response.status).toBe(202);
		const gatewayId = body.id;
		expect(typeof gatewayId).toBe("string");
		expect(decodeGatewayJobId(gatewayId as string)).toEqual({
			provider: "openrouter",
			modelId: "google/veo-3.1",
			upstreamId: "job-upstream-123",
		});
		expect(body).toMatchObject({
			status: "pending",
			polling_url: `${harness.url}/v1/videos/${gatewayId}`,
		});
		expect(harness.upstream).toEqual([
			{
				url: "https://openrouter.ai/api/v1/videos",
				method: "POST",
				authorization: "Bearer openrouter-secret",
				body: {
					model: "google/veo-3.1",
					prompt: "A lighthouse in a storm",
					duration: 8,
					resolution: "1080p",
					aspect_ratio: "16:9",
					frame_images: [
						{
							type: "image_url",
							image_url: { url: "https://example.com/first.png" },
							frame_type: "first_frame",
						},
					],
					generate_audio: true,
					seed: 42,
				},
			},
		]);
	});

	it("polls upstream, rewrites content URLs, and records reported completion cost", async () => {
		harness = await boot();
		const observed: Array<{ provider: string; model: string; costUsd?: number }> = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => observed.push(entry));
		const submitted = await submit(harness);
		const gatewayId = submitted.body.id as string;
		const response = await fetch(`${harness.url}/v1/videos/${gatewayId}`, {
			headers: { Authorization: "Bearer gw-token", "x-omp-app": "video-client" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: gatewayId,
			status: "completed",
			polling_url: `${harness.url}/v1/videos/${gatewayId}`,
			generation_id: "generation-456",
			unsigned_urls: [`${harness.url}/v1/videos/${gatewayId}/content`],
			usage: { cost: 0.4 },
		});
		expect(harness.upstream.at(-1)).toMatchObject({
			url: "https://openrouter.ai/api/v1/videos/job-upstream-123",
			method: "GET",
			authorization: "Bearer openrouter-secret",
		});
		expect(observed).toEqual([
			expect.objectContaining({ provider: "openrouter", model: "google/veo-3.1", costUsd: 0.4 }),
		]);
	});

	it("streams content bytes and the upstream media type", async () => {
		harness = await boot();
		const submitted = await submit(harness);
		const gatewayId = submitted.body.id as string;
		const response = await fetch(`${harness.url}/v1/videos/${gatewayId}/content`, {
			headers: { Authorization: "Bearer gw-token" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(response.headers.get("content-length")).toBe(String(VIDEO_BYTES.byteLength));
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(VIDEO_BYTES);
		expect(harness.upstream.at(-1)).toMatchObject({
			url: "https://openrouter.ai/api/v1/videos/job-upstream-123/content",
			authorization: "Bearer openrouter-secret",
		});
	});

	it("rejects garbage ids and unknown encoded models before upstream dispatch", async () => {
		harness = await boot();
		const garbage = await fetch(`${harness.url}/v1/videos/not-base64!`, {
			headers: { Authorization: "Bearer gw-token" },
		});
		expect(garbage.status).toBe(400);
		expect(await garbage.json()).toMatchObject({ error: { code: 400, type: "invalid_request_error" } });
		const unknownId = encodeGatewayJobId({ provider: "missing", modelId: "video", upstreamId: "job-1" });
		const unknown = await fetch(`${harness.url}/v1/videos/${unknownId}`, {
			headers: { Authorization: "Bearer gw-token" },
		});
		expect(unknown.status).toBe(404);
		expect(harness.upstream).toHaveLength(0);
	});

	it("rejects models on the wrong API", async () => {
		harness = await boot();
		const gatewayId = encodeGatewayJobId({ provider: "openrouter", modelId: "openrouter/auto", upstreamId: "job-1" });
		const response = await fetch(`${harness.url}/v1/videos/${gatewayId}`, {
			headers: { Authorization: "Bearer gw-token" },
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { message: expect.stringContaining("does not support video") },
		});
		expect(harness.upstream).toHaveLength(0);
	});
});

describe("auth-gateway video jobs under account evidence limits", () => {
	let handle: AuthGatewayServerHandle | undefined;
	let storage: AuthStorage | undefined;
	afterEach(async () => {
		await handle?.close();
		storage?.close();
		handle = undefined;
		storage = undefined;
		vi.restoreAllMocks();
	});

	/**
	 * A gateway serving one OAuth account under a `usage` limit of 0.8, with a job already submitted
	 * at 0.5 used; `exhaust` moves the account past the limit. `poll` answers upstream job polls.
	 */
	async function bootLimited(poll: () => Promise<Response>) {
		let usedFraction = 0.5;
		const usageProvider: UsageProvider = {
			id: "openrouter",
			fetchUsage: async () => ({
				provider: "openrouter",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "window",
						label: "window",
						scope: { provider: "openrouter" },
						window: { id: "window", label: "window", resetsAt: Date.now() + 60_000 },
						amount: { usedFraction, unit: "percent" },
						status: "ok",
					},
				],
			}),
		};
		const strategy: CredentialRankingStrategy = {
			findWindowLimits: usage => ({ primary: usage.limits[0] }),
			windowDefaults: { primaryMs: 60 * 60_000, secondaryMs: 7 * 24 * 60 * 60_000 },
		};
		let refreshes = 0;
		// Every refresh mints a new access token, so an auth retry has a fresh key to replay with.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			const access = `access-video-${++refreshes}`;
			return { newCredentials: { ...credential, access }, apiKey: access };
		});
		const limited = await AuthStorage.create(":memory:", {
			accountPolicies: [
				{
					provider: "openrouter",
					name: "work",
					account: { accountId: "acc-video" },
					limits: [{ metric: "usage", max: 0.8, onLimit: "skip" }],
				},
			],
			usageProviderResolver: provider => (provider === "openrouter" ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === "openrouter" ? strategy : undefined),
		});
		storage = limited;
		await limited.credentials.set("openrouter", [
			{
				type: "oauth",
				access: "access-video",
				refresh: "refresh-video",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-video",
			},
		]);
		const video = model("google/veo-3.1");
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/videos") && init?.method === "POST") {
				return Response.json({ id: "job-1", status: "pending" }, { status: 202 });
			}
			if (url.endsWith("/videos/job-1")) return poll();
			if (url.endsWith("/videos/job-1/content")) {
				return new Response(VIDEO_BYTES, { headers: { "Content-Type": "video/mp4" } });
			}
			return Response.json({ error: { message: "unexpected upstream request" } }, { status: 500 });
		};
		handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-token"],
			storage: limited,
			resolveModel: id => (id === `openrouter/${video.id}` ? video : undefined),
			version: "test",
			fetch: fetchImpl,
		});
		const url = handle.url;
		const submitJob = () =>
			fetch(`${url}/v1/videos`, {
				method: "POST",
				headers: gatewayHeaders(),
				body: JSON.stringify({ model: `openrouter/${video.id}`, prompt: "A lighthouse" }),
			});
		const get = (pathName: string) => fetch(`${url}${pathName}`, { headers: { Authorization: "Bearer gw-token" } });
		const submitted = await submitJob();
		expect(submitted.status).toBe(202);
		const { id } = (await submitted.json()) as { id: string };
		const exhaust = async () => {
			usedFraction = 0.9;
			await limited.usage.invalidate("openrouter");
		};
		return { storage: limited, submitJob, get, id, exhaust };
	}

	const completed = () => Response.json({ id: "job-1", status: "completed", usage: { cost: 0.4, is_byok: false } });

	it("refuses a new submit once a usage limit is reached, but polls (through an auth retry) and downloads an existing job", async () => {
		let pollAttempts = 0;
		// The first poll's credential is rejected, so the job is fetched with the re-resolved one.
		const gw = await bootLimited(async () =>
			++pollAttempts === 1 ? Response.json({ error: { message: "unauthorized" } }, { status: 401 }) : completed(),
		);

		await gw.exhaust();
		expect((await gw.submitJob()).status).toBe(429);
		const selections = vi.spyOn(gw.storage.keys, "getWithCredential");
		expect((await gw.get(`/v1/videos/${gw.id}`)).status).toBe(200);
		expect(pollAttempts).toBe(2);
		// The retry re-resolves the key exempt too, rather than falling through to invalidating it.
		expect(selections.mock.calls.map(([, , options]) => options)).toEqual([
			expect.objectContaining({ committedSpend: true }),
			expect.objectContaining({ committedSpend: true, forceRefresh: true }),
		]);
		selections.mockRestore();
		const content = await gw.get(`/v1/videos/${gw.id}/content`);
		expect(content.status).toBe(200);
		expect(new Uint8Array(await content.arrayBuffer())).toEqual(VIDEO_BYTES);
		expect((await gw.submitJob()).status).toBe(429);
	});

	it("refuses a submit made while a poll is in flight", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const gw = await bootLimited(async () => {
			reached.resolve();
			await release.promise;
			return completed();
		});

		await gw.exhaust();
		const poll = gw.get(`/v1/videos/${gw.id}`);
		await reached.promise;
		expect((await gw.submitJob()).status).toBe(429);
		release.resolve();
		expect((await poll).status).toBe(200);
	});
});
