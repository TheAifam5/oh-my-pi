import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { AUTH_BROKER_CAPABILITIES_HEADER } from "@oh-my-pi/pi-ai/auth-broker/types";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-broker-user-disabled";
const TOKEN = "user-disabled-bearer";

describe("broker user-disabled credentials", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const clients: AuthStorage[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-user-disabled-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.credentials.set(PROVIDER, [
			{ type: "api_key", key: "sk-first", source: "login" },
			{ type: "api_key", key: "sk-second", source: "login" },
		]);
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) client.close();
		await handle?.close();
		serverStorage?.close();
		await removeWithRetries(tempDir);
	});

	async function client(fetchImpl?: typeof fetch): Promise<AuthStorage> {
		const storage = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: handle!.url, token: TOKEN, fetchImpl }),
				streamSnapshots: false,
			}),
		);
		clients.push(storage);
		await storage.credentials.revalidate();
		return storage;
	}

	function secondId(): number {
		const row = serverStore!
			.listAuthCredentials(PROVIDER)
			.find(entry => entry.credential.type === "api_key" && entry.credential.key === "sk-second");
		if (!row) throw new Error("missing second key");
		return row.id;
	}

	function post(id: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
		return fetch(`${handle!.url}/v1/credential/${id}/enabled`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	}

	test("the route requires the bearer, addresses the exact id, and returns no credential material", async () => {
		const id = secondId();
		const unauthenticated = await post(id, { enabled: false });
		expect(unauthenticated.status).toBe(401);
		const wrongToken = await post(id, { enabled: false }, { Authorization: "Bearer nope" });
		expect(wrongToken.status).toBe(401);
		expect(serverStore!.listUserDisabledCredentials(PROVIDER)).toEqual([]);

		const unknown = await post(id + 1000, { enabled: false }, { Authorization: `Bearer ${TOKEN}` });
		expect(unknown.status).toBe(404);

		const response = await post(id, { enabled: false }, { Authorization: `Bearer ${TOKEN}` });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual({ ok: true });
		expect(text).not.toContain("sk-second");
		expect(serverStore!.listUserDisabledCredentials(PROVIDER).map(row => row.id)).toEqual([id]);
		expect(serverStore!.listAuthCredentials(PROVIDER).map(row => row.id)).not.toContain(id);
	});

	test("a remote client disables and re-enables an account through the broker", async () => {
		const storage = await client();
		const id = secondId();
		expect(await storage.keys.get(PROVIDER, "s1")).toBe("sk-second");
		expect(await storage.credentials.setEnabled(id, false)).toBe(true);
		expect(serverStore!.listUserDisabledCredentials(PROVIDER).map(row => row.id)).toEqual([id]);
		expect(storage.credentials.listUserDisabled(PROVIDER).map(row => row.id)).toEqual([id]);
		for (const session of ["s1", "s2", "s3"]) expect(await storage.keys.get(PROVIDER, session)).toBe("sk-first");

		const other = await client();
		expect(other.credentials.list(PROVIDER).map(row => row.id)).not.toContain(id);
		expect(other.sessions.accounts(PROVIDER).find(account => account.credentialId === id)?.disabled).toBe(true);

		expect(await storage.credentials.setEnabled(id, true)).toBe(true);
		expect(storage.credentials.list(PROVIDER).map(row => row.id)).toContain(id);
		expect(storage.credentials.listUserDisabled(PROVIDER)).toEqual([]);
	});

	test("clients without the capability never receive a disabled row", async () => {
		const id = secondId();
		await serverStorage!.credentials.setEnabled(id, false);
		const headers = { Authorization: `Bearer ${TOKEN}` };
		const legacy = (await (await fetch(`${handle!.url}/v1/snapshot`, { headers })).json()) as {
			credentials: Array<{ id: number }>;
		};
		expect(legacy.credentials.map(entry => entry.id)).not.toContain(id);
		const capable = (await (
			await fetch(`${handle!.url}/v1/snapshot`, {
				headers: { ...headers, [AUTH_BROKER_CAPABILITIES_HEADER]: "user-disabled-credentials" },
			})
		).json()) as { credentials: Array<{ id: number; userDisabledAtMs?: number }> };
		expect(capable.credentials.find(entry => entry.id === id)?.userDisabledAtMs).toBeNumber();
	});

	test("a disable holds locally when the broker's next snapshot read is stale", async () => {
		const id = secondId();
		let disabled = false;
		const fetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url = String(input);
				// Background long-polls never answer, so only the explicit post-write read is applied;
				// after the disable that read is a lower-generation copy without the flag.
				if (url.includes("/v1/snapshot?")) {
					const { promise, resolve } = Promise.withResolvers<Response>();
					init?.signal?.addEventListener("abort", () => resolve(new Response(null, { status: 304 })), {
						once: true,
					});
					return promise;
				}
				const response = await fetch(input, init);
				if (url.endsWith(`/v1/credential/${id}/enabled`)) disabled = true;
				else if (disabled && url.endsWith("/v1/snapshot")) {
					const body = (await response.json()) as {
						generation: number;
						credentials: Array<Record<string, unknown>>;
					};
					for (const entry of body.credentials) delete entry.userDisabledAtMs;
					return Response.json({ ...body, generation: 0 }, { headers: { etag: '"0"' } });
				}
				return response;
			},
			{ preconnect: fetch.preconnect },
		);
		const storage = await client(fetchImpl);
		expect(await storage.credentials.setEnabled(id, false)).toBe(true);
		expect(storage.credentials.list(PROVIDER).map(row => row.id)).not.toContain(id);
		expect(await storage.keys.get(PROVIDER, "after-disable")).toBe("sk-first");
	});

	test("a refresh of a disabled credential answers 404", async () => {
		await serverStore!.saveOAuth(PROVIDER, {
			access: "access-oauth",
			refresh: "refresh-oauth",
			expires: Date.now() + 60_000,
			email: "oauth@example.com",
		});
		await serverStorage!.credentials.reload();
		const row = serverStore!.listAuthCredentials(PROVIDER).find(entry => entry.credential.type === "oauth");
		if (!row) throw new Error("missing oauth row");
		await serverStorage!.credentials.setEnabled(row.id, false);
		const response = await fetch(`${handle!.url}/v1/credential/${row.id}/refresh`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("refresh-oauth");
	});

	test("a broker without the route makes the command fail with an update message", async () => {
		const fetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
				String(input).endsWith("/enabled")
					? Response.json({ error: "No route: POST /v1/credential/1/enabled" }, { status: 404 })
					: fetch(input, init),
			{ preconnect: fetch.preconnect },
		);
		const storage = await client(fetchImpl);
		await expect(storage.credentials.setEnabled(secondId(), false)).rejects.toThrow(/update the broker/);
		expect(serverStore!.listUserDisabledCredentials(PROVIDER)).toEqual([]);
	});
});
