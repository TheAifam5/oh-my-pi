import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { identityHash, SESSION_PIN_CACHE_PREFIX } from "@oh-my-pi/pi-ai/auth/affinity";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-restrict";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage session account restrictions", () => {
	let tempDir = "";
	let stores: SqliteAuthCredentialStore[] = [];
	let storage: AuthStorage;
	/** Access tokens the OAuth exchange was asked to serve, in order. */
	let exchanged: string[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-session-restrict-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		stores = [store];
		storage = new AuthStorage(store);
		exchanged = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (credential) exchanged.push(credential.access);
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores) store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("serves only allowed accounts, over inherited and explicit pins", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		expect(storage.sessions.pin(PROVIDER, "parent", accountB.credentialId)).toBe(true);
		expect(storage.sessions.inherit("parent", "child")).toBe(1);

		storage.sessions.restrict(PROVIDER, "child", ["account:acc-c"]);

		expect(storage.oauth.identity(PROVIDER, "child")?.accountId).toBe("acc-c");
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		expect(storage.sessions.pin(PROVIDER, "child", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		// Excluded accounts are never ranked, refreshed, or exchanged for the child.
		expect(exchanged).toEqual(["access-c", "access-c"]);
		// The parent keeps its own pin; restrictions are per session.
		expect(await storage.keys.get(PROVIDER, "parent")).toBe("access-b");
	});

	test("skips a runtime key and stored API keys, and fails closed past a config key", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), { type: "api_key", key: "stored-key" }]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");

		storage.sessions.restrict(PROVIDER, "allowed", ["account:acc-a"]);
		const missing = storage.sessions.restrict(PROVIDER, "missing", ["account:acc-z"]);
		storage.sessions.restrict(PROVIDER, "empty", []);

		expect(await storage.keys.get(PROVIDER, "allowed")).toBe("access-a");
		// Metadata, usage attribution, and OAuth-access callers (web search) follow
		// the account the request uses, not the runtime key.
		expect(storage.oauth.identity(PROVIDER, "allowed")?.accountId).toBe("acc-a");
		expect((await storage.oauth.access(PROVIDER, "allowed"))?.accessToken).toBe("access-a");
		for (const sessionId of ["missing", "empty"]) {
			await expect(storage.keys.get(PROVIDER, sessionId)).rejects.toThrow(
				`No API key for provider: ${PROVIDER} (session ${sessionId} is restricted to its OAuth account pool`,
			);
		}
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");

		// The owner lifts a restriction when its session ends.
		storage.sessions.unrestrict(PROVIDER, "missing", missing);
		expect(await storage.keys.get(PROVIDER, "missing")).toBe("runtime-key");

		// A config key marks the provider's endpoint (often a proxy) as taking that
		// key: the pooled session fails rather than sending it an OAuth token.
		storage.keys.setConfig(PROVIDER, "config-key");
		await expect(storage.keys.get(PROVIDER, "allowed")).rejects.toThrow("pooled OAuth tokens are never sent past it");
		expect(await storage.oauth.access(PROVIDER, "allowed")).toBeUndefined();
		expect(storage.oauth.identity(PROVIDER, "allowed")).toBeUndefined();
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");
	});

	test("lifts a restriction only with the lease that installed it", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const stale = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		// A revived owner restricts the same session id again.
		const current = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);

		storage.sessions.unrestrict(PROVIDER, "session", stale);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");

		storage.sessions.unrestrict(PROVIDER, "session", current);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("runtime-key");
	});

	test("rotates only among allowed accounts", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);

		const allowedKeys = ["access-a", "access-b"];
		const first = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(first ?? "");
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(true);
		const second = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(second ?? "");
		expect(second).not.toBe(first);

		// Account c is free, but outside the pool: no sibling is left to switch to,
		// and the last-resort pass retries a blocked allowed account instead.
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(false);
		expect(allowedKeys).toContain((await storage.keys.get(PROVIDER, "session")) ?? "");
	});

	test("exact-row OAuth reads leave out accounts outside the session's restriction", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		storage.sessions.restrict(PROVIDER, "child", ["account:acc-b"]);

		expect(storage.oauth.accounts(PROVIDER, "child").map(account => account.accountId)).toEqual(["acc-b"]);
		expect(await storage.oauth.accessById(PROVIDER, accountA.credentialId, { sessionId: "child" })).toBeUndefined();
		expect((await storage.oauth.accessById(PROVIDER, accountB.credentialId, { sessionId: "child" }))?.ok).toBe(true);
		expect(
			(await storage.oauth.accessAll(PROVIDER, { sessionId: "child" })).map(access => access.credentialId),
		).toEqual([accountB.credentialId]);
		// An unrestricted session, or none, still reads every stored row.
		expect(storage.oauth.accounts(PROVIDER, "parent")).toHaveLength(2);
		expect((await storage.oauth.accessById(PROVIDER, accountA.credentialId, { sessionId: "parent" }))?.ok).toBe(true);
		expect(await storage.oauth.accessAll(PROVIDER)).toHaveLength(2);
	});

	test("ignores a pin it cannot show inside the allowlist, and fails closed on a gone allowed account", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		// A missing-account pin carries no identity; a project pin may name no stored account.
		storage.sessions.pinMissing(PROVIDER, "missing");
		storage.sessions.setAccountPinSource({
			project: (_provider, sessionId) => (sessionId === "project" ? "ghost" : undefined),
		});
		expect(storage.sessions.pin(PROVIDER, "outside", accountA.credentialId)).toBe(true);
		expect(storage.sessions.pin(PROVIDER, "inside", accountB.credentialId)).toBe(true);
		for (const sessionId of ["missing", "project", "outside", "inside"]) {
			storage.sessions.restrict(PROVIDER, sessionId, ["account:acc-b", "account:acc-c"]);
		}

		// Both pinned accounts are deleted.
		await storage.credentials.set(PROVIDER, [oauthCredential("c")]);

		for (const sessionId of ["missing", "project", "outside"]) {
			expect(await storage.keys.get(PROVIDER, sessionId)).toBe("access-c");
		}
		// The pin recorded an allowed account, so the restriction does not lift it.
		await expect(storage.keys.get(PROVIDER, "inside")).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
		// An unrestricted session keeps failing closed on any pin to a gone account.
		storage.sessions.pinMissing(PROVIDER, "unrestricted");
		await expect(storage.keys.get(PROVIDER, "unrestricted")).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
	});

	test("an ended session forgets inherited pins in memory but resumes them from the store", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		if (!accountB) throw new Error("expected stored accounts");
		expect(storage.sessions.pin(PROVIDER, "parent", accountB.credentialId)).toBe(true);
		storage.sessions.inherit("parent", "persisted");
		storage.sessions.inherit("parent", "dropped");
		const [store] = stores;
		if (!store) throw new Error("expected a store");
		const setCache = store.setCache.bind(store);
		// The only copy of this inherited pin is in memory: its row failed to persist.
		vi.spyOn(store, "setCache").mockImplementation((key, value, expiresAtSec) => {
			if (key.endsWith(":unsaved")) throw new Error("disk full");
			setCache(key, value, expiresAtSec);
		});
		storage.sessions.inherit("parent", "unsaved");
		storage.sessions.unpin(PROVIDER, "parent");

		for (const sessionId of ["persisted", "dropped", "unsaved"]) storage.sessions.forgetInherited(sessionId);
		// No stale in-memory copy shadows a row another process removed since.
		const peer = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await peer.credentials.reload();
		expect(peer.sessions.unpin(PROVIDER, "dropped")).toBe(true);
		peer.close();

		expect(storage.sessions.accounts(PROVIDER, "dropped").some(account => account.pinned)).toBe(false);
		expect(storage.sessions.accounts(PROVIDER, "persisted").find(account => account.pinned)?.credentialId).toBe(
			accountB.credentialId,
		);
		expect(storage.sessions.accounts(PROVIDER, "unsaved").find(account => account.pinned)?.credentialId).toBe(
			accountB.credentialId,
		);
	});

	test("pin rows hold a one-way identity digest; a legacy plaintext identity reads as unknown", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		const [store] = stores;
		if (!accountB || !store) throw new Error("expected stored accounts");
		expect(storage.sessions.pin(PROVIDER, "hashed", accountB.credentialId)).toBe(true);
		const row = store.getCache(`${SESSION_PIN_CACHE_PREFIX}${PROVIDER}:hashed`) ?? "";
		expect(JSON.parse(row)).toEqual({
			credentialId: accountB.credentialId,
			identityHash: identityHash("account:acc-b"),
		});
		expect(row).not.toContain("acc-b");
		// A row written with the plaintext key proves nothing about the allowlist.
		store.setCache(
			`${SESSION_PIN_CACHE_PREFIX}${PROVIDER}:legacy`,
			JSON.stringify({ credentialId: accountB.credentialId, identityKey: "account:acc-b" }),
			Math.floor(Date.now() / 1000) + 3600,
		);
		for (const sessionId of ["hashed", "legacy"]) {
			storage.sessions.restrict(PROVIDER, sessionId, ["account:acc-b", "account:acc-c"]);
		}

		await storage.credentials.set(PROVIDER, [oauthCredential("c")]);

		await expect(storage.keys.get(PROVIDER, "hashed")).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
		expect(await storage.keys.get(PROVIDER, "legacy")).toBe("access-c");
	});

	test("an ended session also forgets pins read back from the store, but not its own", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const peer = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		try {
			await peer.credentials.reload();
			const peerB = peer.oauth.accounts(PROVIDER)[1];
			expect(peer.sessions.pin(PROVIDER, "resumed", peerB?.credentialId ?? -1)).toBe(true);
			const accountB = storage.oauth.accounts(PROVIDER)[1];
			expect(storage.sessions.pin(PROVIDER, "own", accountB?.credentialId ?? -1)).toBe(true);
			// This process reads the resumed session's pin back from the shared store.
			expect(storage.sessions.accounts(PROVIDER, "resumed").some(account => account.pinned)).toBe(true);

			storage.sessions.forgetInherited("resumed");
			storage.sessions.forgetInherited("own");
			peer.sessions.unpin(PROVIDER, "resumed");
			peer.sessions.unpin(PROVIDER, "own");

			expect(storage.sessions.accounts(PROVIDER, "resumed").some(account => account.pinned)).toBe(false);
			expect(storage.sessions.accounts(PROVIDER, "own").some(account => account.pinned)).toBe(true);
		} finally {
			peer.close();
		}
	});

	test("a store swap carries a pin another process wrote for a session this process knows", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);
		const peer = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await peer.credentials.reload();
		const peerB = peer.oauth.accounts(PROVIDER)[1];
		expect(peer.sessions.pin(PROVIDER, "session", peerB?.credentialId ?? -1)).toBe(true);
		peer.close();

		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		stores.push(replacement);
		await replacement.replaceAuthCredentials(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		await storage.replaceStore(replacement);

		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");
		expect(storage.sessions.accounts(PROVIDER, "session").find(account => account.pinned)?.accountId).toBe("acc-b");
	});

	test("keeps restrictions across a credential store replacement", async () => {
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		stores.push(replacement);
		await storage.replaceStore(replacement);
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");

		expect(storage.sessions.pin(PROVIDER, "session", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");
	});
});
