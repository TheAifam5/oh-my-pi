import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serializeCredential } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import {
	type AuthAccountPolicies,
	AuthStorage,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { Provider } from "@oh-my-pi/pi-ai/types";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";

const PROVIDER = "unit-user-disabled";
const SESSION = "session-user-disabled";

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

const POLICIES: AuthAccountPolicies = [
	{ provider: PROVIDER, name: "personal", account: { email: "a@example.com" } },
	{ provider: PROVIDER, name: "team", account: { email: "b@example.com" }, priority: 10 },
];

describe("user-disabled accounts", () => {
	let tempDir = "";
	let dbPath = "";
	const opened: AuthStorage[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-user-disabled-"));
		dbPath = path.join(tempDir, "agent.db");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const storage of opened.splice(0)) storage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function open(options: ConstructorParameters<typeof AuthStorage>[1] = {}): Promise<AuthStorage> {
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), {
			accountPolicies: POLICIES,
			...options,
		});
		opened.push(storage);
		await storage.credentials.reload();
		return storage;
	}

	async function seeded(): Promise<AuthStorage> {
		const storage = await open();
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		return storage;
	}

	function idOf(storage: AuthStorage, name: string): number {
		const account = storage.sessions.accounts(PROVIDER).find(entry => entry.name === name);
		if (!account) throw new Error(`no stored account named ${name}`);
		return account.credentialId;
	}

	test("selection skips a disabled account and uses it again once enabled", async () => {
		const storage = await seeded();
		const team = idOf(storage, "team");
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");

		expect(await storage.credentials.setEnabled(team, false)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "other-session")).toBe("access-a");
		expect(storage.credentials.list(PROVIDER).map(row => row.id)).not.toContain(team);
		expect(storage.oauth.accounts(PROVIDER).map(account => account.credentialId)).not.toContain(team);

		expect(await storage.credentials.setEnabled(team, true)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "third-session")).toBe("access-b");
	});

	test("a session or project pin to a disabled account fails like an unavailable pin; a pool member falls through", async () => {
		const storage = await seeded();
		const team = idOf(storage, "team");
		expect(storage.sessions.pin(PROVIDER, SESSION, team)).toBe(true);
		await storage.credentials.setEnabled(team, false);
		await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
		expect(storage.sessions.pin(PROVIDER, "fresh", team)).toBe(false);

		storage.sessions.setAccountPinSource({
			project: (_provider, sessionId) => (sessionId === "project" ? "team" : undefined),
			member: (_provider, sessionId) => (sessionId === "member" ? "team" : undefined),
		});
		await expect(storage.keys.get(PROVIDER, "project")).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
		expect(await storage.keys.get(PROVIDER, "member", { modelId: "model-a" })).toBe("access-a");
	});

	test("the flag survives a store reload and is listed only in the owner's view", async () => {
		const first = await seeded();
		const team = idOf(first, "team");
		await first.credentials.setEnabled(team, false);
		first.close();
		opened.splice(opened.indexOf(first), 1);

		const reopened = await open();
		expect(reopened.credentials.listUserDisabled(PROVIDER).map(row => row.id)).toEqual([team]);
		expect(reopened.sessions.accounts(PROVIDER).find(account => account.credentialId === team)?.disabled).toBe(true);
		expect(reopened.sessions.accounts(PROVIDER, SESSION).map(account => account.credentialId)).not.toContain(team);
		const listed = await reopened.credentials.listDisabled(PROVIDER);
		expect(listed).toEqual([expect.objectContaining({ id: team, userDisabled: true, email: "b@example.com" })]);
		expect(JSON.stringify(listed)).not.toContain("access-b");
		expect(await reopened.keys.get(PROVIDER, SESSION)).toBe("access-a");
	});

	test("a running session on another handle stops using a disabled account at its next request", async () => {
		const running = await seeded();
		expect(await running.keys.get(PROVIDER, SESSION)).toBe("access-b");
		const admin = await open();
		await admin.credentials.setEnabled(idOf(admin, "team"), false);

		expect(await running.keys.get(PROVIDER, SESSION)).toBe("access-a");
	});

	test("an OAuth re-login and a token refresh keep the account disabled", async () => {
		const storage = await seeded();
		const team = idOf(storage, "team");
		await storage.credentials.setEnabled(team, false);

		await storage.credentials.upsert(PROVIDER, { ...oauthCredential("b"), access: "access-b-relogin" });
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			store.updateAuthCredential(team, { ...oauthCredential("b"), access: "access-b-refreshed" });
			expect(store.listUserDisabledCredentials(PROVIDER).map(row => row.id)).toEqual([team]);
		} finally {
			store.close();
		}
		await storage.credentials.reload();
		expect(storage.credentials.listUserDisabled(PROVIDER).map(row => row.id)).toEqual([team]);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
	});

	test("a refresh already in flight cannot clear a disable written by another handle", async () => {
		const admin = await seeded();
		const team = idOf(admin, "team");
		const arrived = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const running = await open({
			refreshOAuthCredential: async (_provider, _id, credential) => {
				arrived.resolve();
				await release.promise;
				return {
					...credential,
					access: "access-b-refreshed",
					refresh: "refresh-b-rotated",
					expires: Date.now() + 3_600_000,
				};
			},
		});
		const refreshing = running.oauth.refresh(team).catch((error: unknown) => error);
		try {
			await arrived.promise;
			expect(await admin.credentials.setEnabled(team, false)).toBe(true);
		} finally {
			release.resolve();
			await refreshing;
		}
		expect(await running.keys.get(PROVIDER, SESSION)).toBe("access-a");
		expect(running.credentials.listUserDisabled(PROVIDER).map(row => row.id)).toEqual([team]);
		expect(running.credentials.listUserDisabled(PROVIDER)[0]?.credential).toMatchObject({
			access: "access-b-refreshed",
			refresh: "refresh-b-rotated",
		});
		expect(await admin.credentials.setEnabled(team, true)).toBe(true);
		expect(await running.keys.get(PROVIDER, "after-enable")).toBe("access-b-refreshed");
	});

	test.each([
		{ leased: false, changed: false },
		{ leased: false, changed: true },
		{ leased: true, changed: false },
		{ leased: true, changed: true },
	])("refresh CAS preserves disabled rows (leased=$leased, changed=$changed)", async ({ leased, changed }) => {
		const storage = await seeded();
		const team = idOf(storage, "team");
		const credential = oauthCredential("b");
		const serialized = serializeCredential(PROVIDER, credential);
		if (!serialized) throw new Error("Expected a serialized OAuth credential");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			store.updateAuthCredential(team, credential);
			const nowMs = Date.now();
			expect(store.tryAcquireCredentialRefreshLease(team, "test-owner", nowMs + 60_000)).toBe(true);
			expect(await storage.credentials.setEnabled(team, false)).toBe(true);
			expect(
				store.tryUpdateAuthCredentialIfMatches(
					team,
					serialized.data,
					changed ? { ...credential, access: "rotated-access", refresh: "rotated-refresh" } : credential,
					leased ? { owner: "test-owner", nowMs } : undefined,
				),
			).toBe(true);
			expect(store.listUserDisabledCredentials(PROVIDER).map(row => row.id)).toEqual([team]);
			expect(store.listUserDisabledCredentials(PROVIDER)[0]?.credential).toMatchObject({
				refresh: changed ? "rotated-refresh" : credential.refresh,
			});
		} finally {
			store.close();
		}
	});

	test("with every account disabled, requests fail naming the enable command", async () => {
		const storage = await seeded();
		await storage.credentials.setEnabled(idOf(storage, "team"), false);
		await storage.credentials.setEnabled(idOf(storage, "personal"), false);

		const error = await storage.keys.get(PROVIDER, SESSION).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AIError.MissingApiKeyError);
		expect((error as Error).message).toContain(`omp account enable ${PROVIDER}/`);
	});

	test("usage polling skips a disabled account", async () => {
		const polled: Array<string | undefined> = [];
		const usageProvider: UsageProvider = {
			id: PROVIDER as Provider,
			async fetchUsage(params) {
				polled.push(params.credential.accessToken);
				return null;
			},
		};
		const storage = await open({
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const admin = await open();
		await admin.credentials.setEnabled(idOf(admin, "team"), false);

		await storage.usage.reports();
		expect(polled).toContain("access-a");
		expect(polled).not.toContain("access-b");
	});

	test("setEnabled reports false for an unknown id", async () => {
		const storage = await seeded();
		expect(await storage.credentials.setEnabled(9_999, false)).toBe(false);
	});

	test("a database from the previous schema opens with every row enabled", async () => {
		const legacy = new Database(dbPath);
		legacy.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 8);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		const { type: _type, ...data } = oauthCredential("a");
		legacy
			.prepare("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, ?, ?, ?)")
			.run(PROVIDER, "oauth", JSON.stringify(data), "email:a@example.com");
		legacy.close();

		const storage = await open();
		expect(storage.credentials.list(PROVIDER)).toHaveLength(1);
		expect(storage.credentials.listUserDisabled()).toEqual([]);
		const check = new Database(dbPath, { readonly: true });
		try {
			const version = check.query("SELECT version FROM auth_schema_version WHERE id = 1").get() as {
				version: number;
			};
			expect(version.version).toBe(9);
		} finally {
			check.close();
		}
	});
});
