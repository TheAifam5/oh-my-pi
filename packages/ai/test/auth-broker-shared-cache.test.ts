import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	type AuthBrokerAccountPool,
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	SHARED_CACHE_MAX_KEY_LENGTH,
	SHARED_CACHE_MAX_LISTING_BYTES,
	SHARED_CACHE_MAX_ROWS_PER_PREFIX,
	SHARED_CACHE_MAX_TTL_SEC,
	SHARED_CACHE_MAX_VALUE_BYTES,
} from "@oh-my-pi/pi-ai/auth-broker/shared-cache";
import { drainStateKey, sessionDrainKey } from "@oh-my-pi/pi-ai/auth/drain-state";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { CredentialRankingStrategy, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOKEN = "shared-cache-bearer";
const DRAIN_KEY = drainStateKey("anthropic", 1, undefined, "/reset");
const SESSION_DRAIN_KEY = sessionDrainKey("anthropic", "session-1");

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitUntil timeout");
		await Bun.sleep(10);
	}
}

describe("auth-broker shared cache routes", () => {
	let tempDir: TempDir;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let handle: AuthBrokerServerHandle;

	beforeEach(async () => {
		tempDir = await TempDir.create("@pi-ai-shared-cache-");
		store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
	});

	afterEach(async () => {
		await handle.close();
		storage.close();
		await tempDir.remove();
	});

	function request(method: string, path: string, body?: unknown, token = TOKEN): Promise<Response> {
		return fetch(`${handle.url}${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
		});
	}

	function put(key: string, body: unknown): Promise<Response> {
		return request("PUT", `/v1/cache/${encodeURIComponent(key)}`, body);
	}

	async function list(prefix: string): Promise<{ rows: { key: string; value: string; expiresAtSec: number }[] }> {
		const response = await request("GET", `/v1/cache?prefix=${encodeURIComponent(prefix)}`);
		expect(response.status).toBe(200);
		return (await response.json()) as { rows: { key: string; value: string; expiresAtSec: number }[] };
	}

	test("refuses every cache row outside the drain prefixes", async () => {
		store.setCache("usage:anthropic:report", "secret-usage", nowSec() + 3600);
		store.setCache("session:pin:anthropic:s", '{"credentialId":1}', nowSec() + 3600);
		for (const key of ["usage:anthropic:report", "session:pin:anthropic:s", "session:sticky:anthropic:s", "mcp:x"]) {
			expect((await put(key, { value: "x", expiresAtSec: nowSec() + 60 })).status).toBe(403);
			expect((await request("GET", `/v1/cache?prefix=${encodeURIComponent(key)}`)).status).toBe(403);
			expect((await request("DELETE", `/v1/cache?prefix=${encodeURIComponent(key)}`)).status).toBe(403);
		}
		// A prefix broader than a shared one would reach unshared rows.
		expect((await request("GET", "/v1/cache?prefix=session%3A")).status).toBe(403);
		expect((await request("DELETE", "/v1/cache?prefix=drain%3A")).status).toBe(403);
		expect((await request("GET", "/v1/cache")).status).toBe(400);
		expect(store.getCache("usage:anthropic:report")).toBe("secret-usage");
		expect(store.getCache("session:pin:anthropic:s")).toBe('{"credentialId":1}');
	});

	test("round-trips a drain row, caps its lifetime, deletes it on an expired write, and hides expired rows", async () => {
		expect((await put(DRAIN_KEY, { value: '{"since":1}', expiresAtSec: Number.MAX_SAFE_INTEGER })).status).toBe(200);
		const [row] = (await list("drain:state:")).rows;
		expect(row?.key).toBe(DRAIN_KEY);
		expect(row?.value).toBe('{"since":1}');
		expect(row!.expiresAtSec).toBeLessThanOrEqual(nowSec() + SHARED_CACHE_MAX_TTL_SEC);
		expect(row!.expiresAtSec).toBeGreaterThan(nowSec() + SHARED_CACHE_MAX_TTL_SEC - 60);

		// The clients' delete idiom: an empty value expiring at 0.
		expect((await put(DRAIN_KEY, { value: "", expiresAtSec: 0 })).status).toBe(200);
		expect((await list("drain:state:")).rows).toEqual([]);
		expect(store.getCache(DRAIN_KEY)).toBeNull();
		expect((await put(DRAIN_KEY, { value: "", expiresAtSec: nowSec() + 60 })).status).toBe(200);
		expect((await list("drain:state:")).rows).toEqual([]);

		store.setCache(`${DRAIN_KEY}:expired`, '{"since":2}', nowSec() - 1);
		expect((await list("drain:state:")).rows).toEqual([]);
	});

	test("rejects malformed bodies, oversized values, and malformed keys", async () => {
		expect((await put(DRAIN_KEY, "{not json")).status).toBe(400);
		expect((await put(DRAIN_KEY, { value: "x" })).status).toBe(400);
		expect((await put(DRAIN_KEY, { value: "x", expiresAtSec: nowSec() + 60, extra: 1 })).status).toBe(400);
		// JSON overflow parses to Infinity: an immortal row.
		expect((await put(DRAIN_KEY, `{"value":"x","expiresAtSec":1e400}`)).status).toBe(400);
		expect(
			(await put(DRAIN_KEY, { value: "x".repeat(SHARED_CACHE_MAX_VALUE_BYTES + 1), expiresAtSec: nowSec() + 60 }))
				.status,
		).toBe(413);
		expect((await put(`${DRAIN_KEY}\u0001`, { value: "x", expiresAtSec: nowSec() + 60 })).status).toBe(400);
		expect((await put(`drain:state:${"x".repeat(600)}`, { value: "x", expiresAtSec: nowSec() + 60 })).status).toBe(
			400,
		);
		expect((await request("PUT", "/v1/cache/drain%3Astate%3A%E0%A4%A", { value: "x", expiresAtSec: 1 })).status).toBe(
			400,
		);
		expect((await list("drain:state:")).rows).toEqual([]);
	});

	test("refuses a new key once a prefix is full but still overwrites an existing one", async () => {
		for (let index = 0; index < SHARED_CACHE_MAX_ROWS_PER_PREFIX; index += 1) {
			store.setCache(`session:drain:p:${index}`, '{"credentialId":1}', nowSec() + 3600);
		}
		expect(
			(await put("session:drain:p:new", { value: '{"credentialId":2}', expiresAtSec: nowSec() + 60 })).status,
		).toBe(507);
		expect(
			(await put("session:drain:p:0", { value: '{"credentialId":2}', expiresAtSec: nowSec() + 60 })).status,
		).toBe(200);
		expect(store.getCache("session:drain:p:0")).toBe('{"credentialId":2}');
		// The other shared prefix has its own budget.
		expect((await put(DRAIN_KEY, { value: '{"since":1}', expiresAtSec: nowSec() + 60 })).status).toBe(200);
	});

	test("deletes rows under a shared prefix only", async () => {
		await put(SESSION_DRAIN_KEY, { value: '{"credentialId":1}', expiresAtSec: nowSec() + 60 });
		await put(DRAIN_KEY, { value: '{"since":1}', expiresAtSec: nowSec() + 60 });
		expect((await request("DELETE", "/v1/cache?prefix=session%3Adrain%3A")).status).toBe(200);
		expect((await list("session:drain:")).rows).toEqual([]);
		expect((await list("drain:state:")).rows.map(row => row.key)).toEqual([DRAIN_KEY]);
	});

	test("requires the bearer token", async () => {
		expect((await request("GET", "/v1/cache?prefix=drain%3Astate%3A", undefined, "wrong")).status).toBe(401);
		const response = await fetch(`${handle.url}/v1/cache/${encodeURIComponent(DRAIN_KEY)}`, {
			method: "PUT",
			body: JSON.stringify({ value: "x", expiresAtSec: nowSec() + 60 }),
		});
		expect(response.status).toBe(401);
		expect(store.getCache(DRAIN_KEY)).toBeNull();
	});
});

describe("auth-broker shared cache storage bounds", () => {
	let tempDir: TempDir;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let handle: AuthBrokerServerHandle;

	beforeEach(async () => {
		tempDir = await TempDir.create("@pi-ai-shared-cache-bounds-");
		store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
	});

	afterEach(async () => {
		await handle.close();
		storage.close();
		await tempDir.remove();
	});

	function put(key: string, body: unknown): Promise<Response> {
		return fetch(`${handle.url}/v1/cache/${encodeURIComponent(key)}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function cacheRowsIncludingExpired(): number {
		const db = new Database(tempDir.join("agent.db"), { readonly: true });
		try {
			return (db.query("SELECT COUNT(*) AS count FROM cache").get() as { count: number }).count;
		} finally {
			db.close();
		}
	}

	test("deletes rows outright, so deletes of absent keys leave no expired rows behind", async () => {
		const before = cacheRowsIncludingExpired();
		for (let index = 0; index < 100; index += 1) {
			expect((await put(`${DRAIN_KEY}:${index}`, { value: "", expiresAtSec: 0 })).status).toBe(200);
		}
		expect(cacheRowsIncludingExpired()).toBe(before);
	});

	test("a full prefix of maximal rows fits the client's read limit and seeds", async () => {
		const value = "\u0001".repeat(Math.floor((SHARED_CACHE_MAX_VALUE_BYTES - 2) / 6));
		expect((await put(DRAIN_KEY, { value: `${value}\u0001`, expiresAtSec: nowSec() + 60 })).status).toBe(413);
		const key = (index: number) =>
			`drain:state:${String(index).padStart(4, "0")}${"\u20ac".repeat(SHARED_CACHE_MAX_KEY_LENGTH - 16)}`;
		for (let index = 0; index < SHARED_CACHE_MAX_ROWS_PER_PREFIX; index += 1) {
			expect((await put(key(index), { value, expiresAtSec: nowSec() + 3600 })).status).toBe(200);
		}
		const listing = await fetch(`${handle.url}/v1/cache?prefix=drain%3Astate%3A`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		const bytes = (await listing.arrayBuffer()).byteLength;
		expect(bytes).toBeLessThanOrEqual(SHARED_CACHE_MAX_LISTING_BYTES);
		const remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token: TOKEN, maxRetries: 0 }),
			streamSnapshots: false,
			backgroundIdleMs: 50,
		});
		try {
			await remote.syncSharedCache();
			expect(remote.getCache(key(SHARED_CACHE_MAX_ROWS_PER_PREFIX - 1))).toBe(value);
		} finally {
			remote.close();
		}
	}, 30_000);

	test("expired short-lived rows do not pile up past a prefix's row cap", async () => {
		for (let round = 0; round < 3; round += 1) {
			for (let index = 0; index < SHARED_CACHE_MAX_ROWS_PER_PREFIX; index += 1) {
				const response = await put(`${DRAIN_KEY}:${round}:${index}`, {
					value: '{"since":1}',
					expiresAtSec: nowSec() + 1,
				});
				expect(response.status).toBe(200);
			}
			expect(cacheRowsIncludingExpired()).toBeLessThanOrEqual(SHARED_CACHE_MAX_ROWS_PER_PREFIX + 8);
			await Bun.sleep(2_100);
		}
	}, 60_000);

	test("sweeps expired cache rows when the broker starts", async () => {
		store.setCache(`${DRAIN_KEY}:expired`, '{"since":1}', nowSec() - 60);
		store.setCache("usage:expired", "x", nowSec() - 60);
		const before = cacheRowsIncludingExpired();
		const second = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
		try {
			expect(cacheRowsIncludingExpired()).toBe(before - 2);
		} finally {
			await second.close();
		}
	});

	test("matches prefixes by characters, including characters outside the BMP", async () => {
		const prefix = "drain:state:\u{1F600}";
		const key = `${prefix}:1::/reset`;
		expect((await put(key, { value: '{"since":1}', expiresAtSec: nowSec() + 60 })).status).toBe(200);
		const listed = await fetch(`${handle.url}/v1/cache?prefix=${encodeURIComponent(prefix)}`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(((await listed.json()) as { rows: { key: string }[] }).rows.map(row => row.key)).toEqual([key]);
		const deleted = await fetch(`${handle.url}/v1/cache?prefix=${encodeURIComponent(prefix)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(deleted.status).toBe(200);
		expect(store.getCache(key)).toBeNull();
	});

	test("refuses an oversized body sent without a length before buffering it whole", async () => {
		const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
		let chunks = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks++ >= 4) controller.close();
				else controller.enqueue(chunk);
			},
		});
		const response = await fetch(`${handle.url}/v1/cache/${encodeURIComponent(DRAIN_KEY)}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit);
		expect(response.status).toBe(413);
		expect(store.getCache(DRAIN_KEY)).toBeNull();
	});
});

describe("RemoteAuthCredentialStore shared cache", () => {
	let tempDir: TempDir;
	let storage: AuthStorage;
	let handle: AuthBrokerServerHandle;
	const remotes: RemoteAuthCredentialStore[] = [];

	beforeEach(async () => {
		tempDir = await TempDir.create("@pi-ai-shared-cache-client-");
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(tempDir.join("agent.db")));
		await storage.credentials.reload();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const remote of remotes.splice(0)) remote.close();
		await handle.close();
		storage.close();
		await tempDir.remove();
	});

	function remote(
		url = handle.url,
		options: {
			retry?: { initialBackoffMs?: number; maxBackoffMs?: number; deadlineMs?: number };
			reprobeMs?: number;
		} = {},
	) {
		const store = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url, token: TOKEN, maxRetries: 0 }),
			streamSnapshots: false,
			backgroundIdleMs: 50,
			sharedCacheRetry: options.retry,
			featureReprobeMs: options.reprobeMs,
		});
		remotes.push(store);
		return store;
	}

	test("a drain row one client writes is seen and cleared by another; pins stay local", async () => {
		const a = remote();
		const b = remote();
		a.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
		a.setCache("session:pin:anthropic:s", '{"credentialId":1}', nowSec() + 3600);
		// The write-through copy satisfies select.ts's read-back.
		expect(a.getCache(DRAIN_KEY)).toBe('{"since":1}');
		await waitUntil(() => storage.cache.get(DRAIN_KEY) !== null);
		await b.syncSharedCache();
		expect(b.getCache(DRAIN_KEY)).toBe('{"since":1}');
		expect(storage.cache.get("session:pin:anthropic:s")).toBeNull();

		a.setCache(DRAIN_KEY, "", 0);
		await waitUntil(() => storage.cache.get(DRAIN_KEY) === null);
		await b.syncSharedCache();
		expect(b.getCache(DRAIN_KEY)).toBeNull();
	});

	test("a broker that answered 404 is probed again later and then receives the rows written meanwhile", async () => {
		let supported = false;
		const getPaths: string[] = [];
		const rows = new Map<string, string>();
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (!supported) {
					if (url.pathname.startsWith("/v1/cache")) getPaths.push(`${req.method} ${url.pathname}`);
					return Response.json({ error: "no route" }, { status: 404 });
				}
				if (url.pathname === "/v1/cache" && req.method === "GET") {
					getPaths.push(`${req.method} ${url.pathname}`);
					return Response.json({ generatedAt: Date.now(), rows: [], truncated: false });
				}
				if (url.pathname.startsWith("/v1/cache/") && req.method === "PUT") {
					const body = (await req.json()) as { value: string };
					rows.set(decodeURIComponent(url.pathname.slice("/v1/cache/".length)), body.value);
					return Response.json({ ok: true });
				}
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${broker.port}`, { reprobeMs: 200 });
			await store.syncSharedCache();
			store.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
			await store.syncSharedCache();
			expect(getPaths).toEqual(["GET /v1/cache"]);

			supported = true;
			await Bun.sleep(250);
			await store.syncSharedCache();
			await waitUntil(() => rows.get(DRAIN_KEY) === '{"since":1}');
		} finally {
			broker.stop(true);
		}
	});

	test("failed seeds back off instead of retrying at the seed interval", async () => {
		let listings = 0;
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname === "/v1/cache") listings += 1;
				return Response.json({ error: "unavailable" }, { status: 500 });
			},
		});
		try {
			const store = new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: `http://127.0.0.1:${broker.port}`, token: TOKEN, maxRetries: 0 }),
				streamSnapshots: false,
				backgroundIdleMs: 50,
				sharedCacheSeedIntervalMs: 20,
			});
			remotes.push(store);
			const deadline = Date.now() + 500;
			while (Date.now() < deadline) {
				store.getCache(DRAIN_KEY);
				await Bun.sleep(5);
			}
			// At a fixed 20 ms interval this would be about 25 seeds; doubling keeps it near log2(500 / 20).
			expect(listings).toBeLessThanOrEqual(8);
		} finally {
			broker.stop(true);
		}
	});

	test("a full prefix is not retried and does not hold up writes to the other prefix", async () => {
		let drainPuts = 0;
		const delivered = new Set<string>();
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/cache" && req.method === "GET") {
					return Response.json({ generatedAt: Date.now(), rows: [], truncated: false });
				}
				if (url.pathname.startsWith("/v1/cache/") && req.method === "PUT") {
					const key = decodeURIComponent(url.pathname.slice("/v1/cache/".length));
					if (key.startsWith("drain:state:")) {
						drainPuts += 1;
						return Response.json({ error: "full" }, { status: 507 });
					}
					delivered.add(key);
					return Response.json({ ok: true });
				}
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${broker.port}`, { retry: { initialBackoffMs: 5, maxBackoffMs: 10 } });
			await store.syncSharedCache();
			store.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
			store.setCache(SESSION_DRAIN_KEY, '{"credentialId":1}', nowSec() + 3600);
			await waitUntil(() => delivered.has(SESSION_DRAIN_KEY));
			// While the prefix is full its new writes stay local, and seeds do not resend them.
			store.setCache(`${DRAIN_KEY}:other`, '{"since":2}', nowSec() + 3600);
			await store.syncSharedCache();
			await Bun.sleep(100);
			expect(drainPuts).toBe(1);
			expect(store.getCache(`${DRAIN_KEY}:other`)).toBe('{"since":2}');
		} finally {
			broker.stop(true);
		}
	});

	test("a seed whose listing predates an acknowledged write keeps that row", async () => {
		let listings = 0;
		const putDone = Promise.withResolvers<void>();
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/cache" && req.method === "GET") {
					listings += 1;
					// The listing was taken before the write landed but answers after it was acknowledged.
					if (listings > 4) await putDone.promise;
					return Response.json({ generatedAt: Date.now(), rows: [], truncated: false });
				}
				if (url.pathname.startsWith("/v1/cache/") && req.method === "PUT") {
					setTimeout(() => putDone.resolve(), 50);
					return Response.json({ ok: true });
				}
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${broker.port}`);
			await store.syncSharedCache();
			const seed = store.syncSharedCache();
			store.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
			await seed;
			expect(store.getCache(DRAIN_KEY)).toBe('{"since":1}');
		} finally {
			broker.stop(true);
		}
	});

	test("accepts at most a prefix's worth of seeded rows and skips expired ones", async () => {
		const key = (index: number) => `drain:state:anthropic:${String(index).padStart(5, "0")}::/reset`;
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/cache" && url.searchParams.get("prefix") === "drain:state:") {
					const rows = Array.from({ length: 2000 }, (_, index) => ({
						key: key(index),
						value: '{"since":1}',
						expiresAtSec: index === 3 ? nowSec() - 10 : nowSec() + 3600,
					}));
					return Response.json({ generatedAt: Date.now(), rows, truncated: false });
				}
				if (url.pathname === "/v1/cache") {
					return Response.json({ generatedAt: Date.now(), rows: [], truncated: false });
				}
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${broker.port}`);
			await store.syncSharedCache();
			expect(store.getCache(key(5))).toBe('{"since":1}');
			expect(store.getCache(key(3))).toBeNull();
			expect(store.getCache(key(1500))).toBeNull();
		} finally {
			broker.stop(true);
		}
	});

	test("a broker without the routes leaves drain rows local and is not asked again", async () => {
		const paths: string[] = [];
		const legacy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				paths.push(`${req.method} ${url.pathname}`);
				return Response.json({ error: `No route: ${req.method} ${url.pathname}` }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${legacy.port}`);
			await store.syncSharedCache();
			store.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
			await Bun.sleep(50);
			expect(store.getCache(DRAIN_KEY)).toBe('{"since":1}');
			expect(paths.filter(path => path.includes("/v1/cache"))).toEqual(["GET /v1/cache"]);
		} finally {
			legacy.stop(true);
		}
	});

	test("retries a failing broker within bounds, then delivers every write after it recovers", async () => {
		let healthy = false;
		const rows = new Map<string, string>();
		let puts = 0;
		const flaky = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/cache" && req.method === "GET") {
					const prefix = url.searchParams.get("prefix") ?? "";
					const listed = [...rows]
						.filter(([key]) => key.startsWith(prefix))
						.map(([key, value]) => ({ key, value, expiresAtSec: nowSec() + 3600 }));
					return Response.json({ generatedAt: Date.now(), rows: listed, truncated: false });
				}
				if (url.pathname.startsWith("/v1/cache/") && req.method === "PUT") {
					puts += 1;
					if (!healthy) return Response.json({ error: "unavailable" }, { status: 503 });
					const body = (await req.json()) as { value: string };
					rows.set(decodeURIComponent(url.pathname.slice("/v1/cache/".length)), body.value);
					return Response.json({ ok: true });
				}
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${flaky.port}`, {
				retry: { initialBackoffMs: 5, maxBackoffMs: 20, deadlineMs: 500 },
			});
			await store.syncSharedCache();
			const keys = Array.from({ length: 300 }, (_, index) => drainStateKey("anthropic", index, undefined, "/reset"));
			for (const key of keys) store.setCache(key, '{"since":1}', nowSec() + 3600);
			await Bun.sleep(1_500);
			const failedPuts = puts;
			// Bounded attempts and backoff, then the queue gives up instead of retrying forever.
			expect(failedPuts).toBeGreaterThan(0);
			expect(failedPuts).toBeLessThan(60);
			await Bun.sleep(300);
			expect(puts).toBe(failedPuts);

			// Each seed re-sends at most a queue's worth of the writes the broker missed.
			healthy = true;
			await store.syncSharedCache();
			await waitUntil(() => rows.size === 256, 10_000);
			await Bun.sleep(50);
			expect(rows.size).toBe(256);
			await store.syncSharedCache();
			await waitUntil(() => rows.size === keys.length, 10_000);
			expect([...rows.keys()].sort()).toEqual([...keys].sort());
		} finally {
			flaky.stop(true);
		}
	}, 20_000);

	test("close abandons queued writes and aborts the one in flight", async () => {
		let received = 0;
		let aborted = false;
		const hanging = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/cache" && req.method === "GET") {
					return Response.json({ generatedAt: Date.now(), rows: [], truncated: false });
				}
				if (url.pathname.startsWith("/v1/cache/")) {
					received += 1;
					const { promise, resolve } = Promise.withResolvers<void>();
					req.signal.addEventListener("abort", () => {
						aborted = true;
						resolve();
					});
					await promise;
					return Response.json({ ok: true });
				}
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${hanging.port}`);
			await store.syncSharedCache();
			store.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
			store.setCache(SESSION_DRAIN_KEY, '{"credentialId":1}', nowSec() + 3600);
			await waitUntil(() => received === 1);
			store.close();
			await waitUntil(() => aborted);
			await Bun.sleep(50);
			expect(received).toBe(1);
		} finally {
			hanging.stop(true);
		}
	});

	test("an undelivered drain row outlives a flood of session pins and reaches the broker once it answers", async () => {
		let supported = false;
		const rows = new Map<string, string>();
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (!supported) return Response.json({ error: "no route" }, { status: 404 });
				if (url.pathname === "/v1/cache" && req.method === "GET") {
					return Response.json({ generatedAt: Date.now(), rows: [], truncated: false });
				}
				if (url.pathname.startsWith("/v1/cache/") && req.method === "PUT") {
					const body = (await req.json()) as { value: string };
					rows.set(decodeURIComponent(url.pathname.slice("/v1/cache/".length)), body.value);
					return Response.json({ ok: true });
				}
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const store = remote(`http://127.0.0.1:${broker.port}`, { reprobeMs: 200 });
			await store.syncSharedCache();
			store.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
			// More session pins than the hot set holds: the oldest row is the undelivered drain row.
			for (let index = 0; index < 5000; index += 1) {
				store.setCache(`session:sticky:anthropic:${index}`, "credential-1", nowSec() + 3600);
			}
			expect(store.getCache("session:sticky:anthropic:0")).toBeNull();
			expect(store.getCache(DRAIN_KEY)).toBe('{"since":1}');

			supported = true;
			await Bun.sleep(250);
			await store.syncSharedCache();
			await waitUntil(() => rows.get(DRAIN_KEY) === '{"since":1}');
		} finally {
			broker.stop(true);
		}
	});

	test("a delivered drain row evicted by session pins comes back with the next seed", async () => {
		const writer = remote();
		const reader = remote();
		writer.setCache(DRAIN_KEY, '{"since":1}', nowSec() + 3600);
		await waitUntil(() => storage.cache.get(DRAIN_KEY) !== null);
		await reader.syncSharedCache();
		for (let index = 0; index < 5000; index += 1) {
			reader.setCache(`session:sticky:anthropic:${index}`, "credential-1", nowSec() + 3600);
		}
		expect(reader.getCache(DRAIN_KEY)).toBeNull();
		// Eviction dropped only the local copy; the broker row is untouched.
		expect(storage.cache.get(DRAIN_KEY)).toBe('{"since":1}');

		await reader.syncSharedCache();
		expect(reader.getCache(DRAIN_KEY)).toBe('{"since":1}');
		expect(reader.getCache("session:sticky:anthropic:4999")).toBe("credential-1");
	});
});

describe("account drain through a shared broker", () => {
	const PROVIDER = "unit-shared-drain";
	const POLICIES: AuthAccountPolicies = [
		{ provider: PROVIDER, name: "cool", account: { accountId: "acc-a" }, priority: 10 },
		{
			provider: PROVIDER,
			name: "first",
			account: { accountId: "acc-b" },
			drain: true,
			returnCooldownMs: 60 * 60_000,
		},
	];
	const strategy: CredentialRankingStrategy = {
		findWindowLimits: usage => ({ primary: usage.limits[0] }),
		scopeLimits: usage => usage.limits,
		windowDefaults: { primaryMs: 5 * 60 * 60_000, secondaryMs: 7 * 24 * 60 * 60_000 },
	};
	const used = new Map<string, number>();
	let resetsAt = 0;
	const usageProvider: UsageProvider = {
		id: PROVIDER,
		fetchUsage: async ({ credential }): Promise<UsageReport | null> => {
			const accountId = credential.accountId;
			if (!accountId) return null;
			const usedFraction = used.get(accountId) ?? 0;
			return {
				provider: PROVIDER,
				fetchedAt: Date.now(),
				metadata: { accountId },
				limits: [
					{
						id: "window",
						label: "window",
						scope: { provider: PROVIDER },
						window: { id: "window", label: "window", resetsAt },
						amount: { usedFraction, unit: "percent" },
						status: usedFraction >= 1 ? "exhausted" : "ok",
					},
				],
			};
		},
	};

	let tempDir: TempDir;
	let brokerStorage: AuthStorage;
	let handle: AuthBrokerServerHandle;
	const clients: { remote: RemoteAuthCredentialStore; storage: AuthStorage }[] = [];

	beforeEach(async () => {
		used.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		tempDir = await TempDir.create("@pi-ai-shared-drain-");
		brokerStorage = new AuthStorage(await SqliteAuthCredentialStore.open(tempDir.join("agent.db")), {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === PROVIDER ? strategy : undefined),
		});
		for (const suffix of ["a", "b"]) {
			await brokerStorage.credentials.upsert(PROVIDER, {
				type: "oauth",
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 24 * 60 * 60_000,
				accountId: `acc-${suffix}`,
			});
		}
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const { remote, storage } of clients.splice(0)) {
			storage.close();
			remote.close();
		}
		await handle.close();
		brokerStorage.close();
		await tempDir.remove();
	});

	async function client(
		accountPool?: AuthBrokerAccountPool,
		accountPolicies: AuthAccountPolicies = POLICIES,
	): Promise<{ remote: RemoteAuthCredentialStore; storage: AuthStorage }> {
		const brokerClient = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const result = await brokerClient.fetchSnapshot();
		const initialSnapshot: SnapshotResponse | undefined = result.status === 200 ? result.snapshot : undefined;
		const remote = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot,
			streamSnapshots: false,
			backgroundIdleMs: 50,
			accountPool,
		});
		const storage = new AuthStorage(remote, {
			accountPolicies,
			rankingStrategyResolver: provider => (provider === PROVIDER ? strategy : undefined),
		});
		await storage.credentials.reload();
		const opened = { remote, storage };
		clients.push(opened);
		return opened;
	}

	test("a shared session drain override never serves an account outside a client's pool or session restriction", async () => {
		used.set("acc-a", 0.2);
		used.set("acc-b", 0.2);
		const open = await client();
		const accounts = open.remote.snapshot.credentials;
		const target = accounts.find(
			entry => entry.credential.type === "oauth" && entry.credential.accountId === "acc-b",
		)!;
		const visible = accounts.find(
			entry => entry.credential.type === "oauth" && entry.credential.accountId === "acc-a",
		)!;
		// The unrestricted client drains its session on acc-b; the override is shared through the broker.
		expect(open.storage.sessions.drain(PROVIDER, "shared-session", target.id)).toBe(true);
		expect(await open.storage.keys.get(PROVIDER, "shared-session")).toBe("access-b");
		await waitUntil(() => (brokerStorage.cache.list("session:drain:", 10) ?? []).length === 1);

		// A policy may name only accounts the pool shows.
		const pooled = await client(new Map([[PROVIDER, new Set([visible.identityKey!])]]), [POLICIES[0]!]);
		await pooled.remote.syncSharedCache();
		expect(await pooled.storage.keys.get(PROVIDER, "shared-session")).toBe("access-a");

		const restricted = await client();
		await restricted.remote.syncSharedCache();
		restricted.storage.sessions.restrict(PROVIDER, "shared-session", [visible.identityKey!]);
		expect(await restricted.storage.keys.get(PROVIDER, "shared-session")).toBe("access-a");
	});

	test("a client that cannot see an override's account stops following it without deleting it for others", async () => {
		used.set("acc-a", 0.2);
		used.set("acc-b", 0.2);
		used.set("acc-c", 0.2);
		await brokerStorage.credentials.upsert(PROVIDER, {
			type: "oauth",
			access: "access-c",
			refresh: "refresh-c",
			expires: Date.now() + 24 * 60 * 60_000,
			accountId: "acc-c",
		});
		const open = await client();
		const accounts = open.remote.snapshot.credentials;
		const target = accounts.find(
			entry => entry.credential.type === "oauth" && entry.credential.accountId === "acc-b",
		)!;
		const visible = accounts.find(
			entry => entry.credential.type === "oauth" && entry.credential.accountId === "acc-a",
		)!;
		expect(open.storage.sessions.drain(PROVIDER, "shared-session", target.id)).toBe(true);
		await waitUntil(() => (brokerStorage.cache.list("session:drain:", 10) ?? []).length === 1);

		// The pooled client has its own drain policy, so selection consults the shared override.
		const other = accounts.find(
			entry => entry.credential.type === "oauth" && entry.credential.accountId === "acc-c",
		)!;
		const pooled = await client(new Map([[PROVIDER, new Set([visible.identityKey!, other.identityKey!])]]), [
			{ ...POLICIES[0]!, drain: true },
		]);
		await pooled.remote.syncSharedCache();
		expect(await pooled.storage.keys.get(PROVIDER, "shared-session")).toBe("access-a");
		await Bun.sleep(200);
		expect((brokerStorage.cache.list("session:drain:", 10) ?? []).length).toBe(1);
		await open.remote.syncSharedCache();
		expect(await open.storage.keys.get(PROVIDER, "shared-session")).toBe("access-b");
	});

	test("a target one process saw drain stays behind in another process during its cooldown", async () => {
		resetsAt = Date.now() + 300;
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		const first = await client();
		expect(await first.storage.keys.get(PROVIDER, "session-first")).toBe("access-a");
		await waitUntil(() => (brokerStorage.cache.list("drain:state:", 10) ?? []).length === 1);

		// The window reset and its usage block lapse; only the shared drain state holds the target back.
		used.set("acc-b", 0.5);
		await Bun.sleep(400);
		await brokerStorage.usage.invalidate(PROVIDER);
		const second = await client();
		await second.remote.syncSharedCache();
		expect(await second.storage.keys.get(PROVIDER, "session-second")).toBe("access-a");
	});
});
