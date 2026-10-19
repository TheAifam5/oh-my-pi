import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	identityHash,
	SESSION_PIN_CACHE_PREFIX,
	SESSION_RESTRICTION_EVICTION_LOG_INTERVAL_MS,
	SESSION_RESTRICTION_EXPIRY_LOG_INTERVAL_MS,
	SESSION_RESTRICTION_TOMBSTONE_TTL_MS,
	SESSION_RESTRICTION_TOMBSTONES_HARD_CAP,
} from "@oh-my-pi/pi-ai/auth/affinity";
import { SESSION_DRAIN_CACHE_PREFIX } from "@oh-my-pi/pi-ai/auth/drain-state";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { logger } from "@oh-my-pi/pi-utils";

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
	/** Reading of the monotonic clock that ages `storage`'s retired restrictions. */
	let monotonicMs = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-session-restrict-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		stores = [store];
		monotonicMs = 1_000_000;
		storage = new AuthStorage(store, { sessionRestrictionClock: () => monotonicMs });
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

	test("permits only allowed accounts for a restricted session", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		const lease = storage.sessions.restrict(PROVIDER, "session", ["account:acc-a"]);

		const unstoredId = Math.max(accountA.credentialId, accountB.credentialId) + 1;
		// permits and admits give one answer: a stored allowed account only, any row id when unrestricted.
		const answers = (sessionId: string) =>
			[accountA.credentialId, accountB.credentialId, unstoredId].map(id => [
				storage.sessions.permits(PROVIDER, sessionId, id),
				storage.sessions.admits(PROVIDER, sessionId, id),
			]);
		const restricted = [
			[true, true],
			[false, false],
			[false, false],
		];
		expect(answers("session")).toEqual(restricted);
		expect(answers("unrestricted")).toEqual([
			[true, true],
			[true, true],
			[true, true],
		]);

		// A retired restriction keeps the same allowlist.
		storage.sessions.retire(PROVIDER, "session", lease);
		expect(answers("session")).toEqual(restricted);

		storage.sessions.unrestrict(PROVIDER, "session", lease);
		expect(storage.sessions.permits(PROVIDER, "session", accountB.credentialId)).toBe(true);
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

	test("a restricted session lists only its allowed accounts; the owner's list without a session lists every row", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.sessions.restrict(PROVIDER, "child", ["account:acc-b"]);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-b");

		const listed = storage.sessions.accounts(PROVIDER, "child");
		expect(listed.map(account => [account.email, account.active])).toEqual([["b@example.com", true]]);
		expect(storage.sessions.accounts(PROVIDER).map(account => account.email)).toEqual([
			"a@example.com",
			"b@example.com",
			"c@example.com",
		]);
		expect(storage.sessions.accounts(PROVIDER, "unrestricted")).toHaveLength(3);
	});

	test("restrictLike copies a session's restriction until its own leases are lifted", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const hostLease = storage.sessions.restrict(PROVIDER, "host", ["account:acc-b"]);

		const leases = storage.sessions.restrictLike("host", "scan");
		expect([...leases.keys()]).toEqual([PROVIDER]);
		expect(await storage.keys.get(PROVIDER, "scan")).toBe("access-b");
		expect(storage.sessions.accounts(PROVIDER, "scan").map(account => account.accountId)).toEqual(["acc-b"]);
		// The copy outlives the host's own restriction until its leases are lifted.
		storage.sessions.unrestrict(PROVIDER, "host", hostLease);
		expect(await storage.keys.get(PROVIDER, "scan")).toBe("access-b");
		for (const [provider, lease] of leases) storage.sessions.unrestrict(provider, "scan", lease);
		expect(await storage.keys.get(PROVIDER, "scan")).toBe("runtime-key");
		expect(storage.sessions.restrictLike("unrestricted", "other").size).toBe(0);
	});

	test("a retired restriction keeps denying accounts outside its allowlist until its owner lifts it", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const lease = storage.sessions.restrict(PROVIDER, "released", ["account:acc-b"]);

		storage.sessions.retire(PROVIDER, "released", lease);
		// A late lookup straight to the store under the released id: the allowed account serves,
		expect(await storage.keys.get(PROVIDER, "released")).toBe("access-b");
		expect(storage.oauth.accounts(PROVIDER, "released").map(account => account.accountId)).toEqual(["acc-b"]);
		// and neither another account nor the runtime key does.
		expect(storage.sessions.admits(PROVIDER, "released", accountA.credentialId)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "released", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "released")).toBe("access-b");

		// A second release is a no-op; the owner's lease still lifts the retired restriction.
		storage.sessions.retire(PROVIDER, "released", lease);
		expect(storage.sessions.isRestricted(PROVIDER, "released")).toBe(true);
		storage.sessions.unrestrict(PROVIDER, "released", lease);
		expect(await storage.keys.get(PROVIDER, "released")).toBe("runtime-key");
	});

	test("a new restriction replaces a retired one, and a stale lease neither retires nor lifts the newer one", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const ended = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		storage.sessions.retire(PROVIDER, "session", ended);

		// A revived owner restricts the same id to its own pool; lifting it leaves nothing of the replaced one.
		const revived = storage.sessions.restrict(PROVIDER, "session", ["account:acc-a"]);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-a");
		storage.sessions.unrestrict(PROVIDER, "session", revived);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("runtime-key");

		// With no account of the pool stored, the refusal tells a live restriction from a retired one.
		const live = `(session other is restricted to its OAuth account pool and none of those accounts is available)`;
		const retired =
			"(session other is restricted to its OAuth account pool past the end of the session that installed it and";
		const stale = storage.sessions.restrict(PROVIDER, "other", ["account:acc-z"]);
		const current = storage.sessions.restrict(PROVIDER, "other", ["account:acc-z"]);
		storage.sessions.retire(PROVIDER, "other", stale);
		await expect(storage.keys.get(PROVIDER, "other")).rejects.toThrow(live);
		storage.sessions.retire(PROVIDER, "other", current);
		await expect(storage.keys.get(PROVIDER, "other")).rejects.toThrow(retired);
		storage.sessions.unrestrict(PROVIDER, "other", stale);
		await expect(storage.keys.get(PROVIDER, "other")).rejects.toThrow(retired);
		storage.sessions.unrestrict(PROVIDER, "other", current);
		expect(await storage.keys.get(PROVIDER, "other")).toBe("runtime-key");
	});

	test("a later owner without a restriction reusing a retired id resolves only the pool and names the ended restriction", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		storage.sessions.retire(PROVIDER, "served", storage.sessions.restrict(PROVIDER, "served", ["account:acc-b"]));
		storage.sessions.retire(PROVIDER, "refused", storage.sessions.restrict(PROVIDER, "refused", ["account:acc-z"]));

		expect(await storage.keys.get(PROVIDER, "served")).toBe("access-b");
		await expect(storage.keys.get(PROVIDER, "refused")).rejects.toThrow(
			`No API key for provider: ${PROVIDER} (session refused is restricted to its OAuth account pool past the end of the session that installed it and none of those accounts is available)`,
		);
		storage.keys.setConfig(PROVIDER, "config-key");
		await expect(storage.keys.get(PROVIDER, "served")).rejects.toThrow(
			"restricted to its OAuth account pool past the end of the session that installed it, but models.yml configures an apiKey",
		);
	});

	test("restrictLike copies a retired restriction", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		storage.sessions.retire(PROVIDER, "host", storage.sessions.restrict(PROVIDER, "host", ["account:acc-b"]));

		const leases = storage.sessions.restrictLike("host", "scan");
		expect([...leases.keys()]).toEqual([PROVIDER]);
		expect(await storage.keys.get(PROVIDER, "scan")).toBe("access-b");
		for (const [provider, lease] of leases) storage.sessions.unrestrict(provider, "scan", lease);
		expect(await storage.keys.get(PROVIDER, "scan")).toBe("runtime-key");
	});

	test("a retired restriction keeps denying other accounts and API keys after more than 256 other retirements", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		for (let index = 0; index <= 300; index += 1) {
			const sessionId = `released-${index}`;
			storage.sessions.retire(
				PROVIDER,
				sessionId,
				storage.sessions.restrict(PROVIDER, sessionId, ["account:acc-b"]),
			);
		}

		expect(await storage.keys.get(PROVIDER, "released-0")).toBe("access-b");
		expect(storage.sessions.admits(PROVIDER, "released-0", accountA.credentialId)).toBe(false);
	});

	/** Two accounts whose tokens outlive a wall-clock jump past the TTL, so only the restriction decides, and a runtime key. */
	async function seedFreshAccounts(): Promise<void> {
		const expires = Date.now() + 3 * SESSION_RESTRICTION_TOMBSTONE_TTL_MS;
		await storage.credentials.set(PROVIDER, [
			{ ...oauthCredential("a"), expires },
			{ ...oauthCredential("b"), expires },
		]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
	}

	function retireRestricted(sessionId: string): void {
		storage.sessions.retire(PROVIDER, sessionId, storage.sessions.restrict(PROVIDER, sessionId, ["account:acc-b"]));
	}

	test("a retired restriction expires once its TTL has passed on the monotonic clock, and not before", async () => {
		await seedFreshAccounts();
		const retiredAtMs = monotonicMs;
		retireRestricted("released");

		monotonicMs = retiredAtMs + SESSION_RESTRICTION_TOMBSTONE_TTL_MS - 1;
		expect(await storage.keys.get(PROVIDER, "released")).toBe("access-b");

		monotonicMs = retiredAtMs + SESSION_RESTRICTION_TOMBSTONE_TTL_MS;
		expect(storage.sessions.isRestricted(PROVIDER, "released")).toBe(false);
		expect(await storage.keys.get(PROVIDER, "released")).toBe("runtime-key");
	});

	test("a wall clock jumped forward past the TTL keeps a retired restriction the monotonic clock has not aged", async () => {
		await seedFreshAccounts();
		retireRestricted("released");
		setSystemTime(new Date(Date.now() + SESSION_RESTRICTION_TOMBSTONE_TTL_MS + 60 * 60_000));
		try {
			// Retiring another id sweeps; the wall-clock jump must not count as expiry either way.
			retireRestricted("other");
			expect(storage.sessions.isRestricted(PROVIDER, "released")).toBe(true);
			expect(await storage.keys.get(PROVIDER, "released")).toBe("access-b");
		} finally {
			setSystemTime();
		}
	});

	test("a clock reading below the retirement stamp keeps the restriction", async () => {
		await seedFreshAccounts();
		retireRestricted("released");

		monotonicMs -= 2 * SESSION_RESTRICTION_TOMBSTONE_TTL_MS;
		// Retiring another id sweeps; the negative age must not count as expiry either way.
		retireRestricted("other");
		expect(await storage.keys.get(PROVIDER, "released")).toBe("access-b");
	});

	test("expired retired restrictions log a rate-limited debug record with the provider, the count, and no session id", async () => {
		await seedFreshAccounts();
		const debug = vi.spyOn(logger, "debug");
		const expiryRecords = () =>
			debug.mock.calls.filter(([message]) =>
				String(message).startsWith("Retired session account restrictions expired"),
			);
		for (const sessionId of ["released-0", "released-1", "released-2"]) retireRestricted(sessionId);

		// Two expiries inside one interval: the first logs, the second is counted.
		monotonicMs += SESSION_RESTRICTION_TOMBSTONE_TTL_MS;
		expect(await storage.keys.get(PROVIDER, "released-0")).toBe("runtime-key");
		expect(await storage.keys.get(PROVIDER, "released-1")).toBe("runtime-key");
		expect(expiryRecords().map(([, fields]) => fields)).toEqual([{ provider: PROVIDER, expired: 1 }]);

		monotonicMs += SESSION_RESTRICTION_EXPIRY_LOG_INTERVAL_MS;
		expect(await storage.keys.get(PROVIDER, "released-2")).toBe("runtime-key");
		expect(expiryRecords().map(([, fields]) => fields)).toEqual([
			{ provider: PROVIDER, expired: 1 },
			{ provider: PROVIDER, expired: 2 },
		]);
		expect(JSON.stringify(expiryRecords())).not.toContain("released-");
	});

	test("past the safety cap the earliest retired restrictions are evicted, with a rate-limited warning and no session id", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const warn = vi.spyOn(logger, "warn");
		const evictionWarnings = () =>
			warn.mock.calls.filter(([message]) => String(message).startsWith("Evicted retired session account"));
		const retireSessions = (from: number, count: number) => {
			for (let index = from; index < from + count; index += 1) retireRestricted(`released-${index}`);
		};
		// Three evictions inside one interval: the first warns, the other two are counted.
		retireSessions(0, SESSION_RESTRICTION_TOMBSTONES_HARD_CAP + 3);
		expect(evictionWarnings().map(([, fields]) => fields)).toEqual([
			{ provider: PROVIDER, limit: SESSION_RESTRICTION_TOMBSTONES_HARD_CAP, evicted: 1 },
		]);
		expect(await storage.keys.get(PROVIDER, "released-2")).toBe("runtime-key");
		expect(await storage.keys.get(PROVIDER, "released-3")).toBe("access-b");

		monotonicMs += SESSION_RESTRICTION_EVICTION_LOG_INTERVAL_MS;
		retireSessions(SESSION_RESTRICTION_TOMBSTONES_HARD_CAP + 3, 1);
		expect(evictionWarnings().map(([, fields]) => fields)).toEqual([
			{ provider: PROVIDER, limit: SESSION_RESTRICTION_TOMBSTONES_HARD_CAP, evicted: 1 },
			{ provider: PROVIDER, limit: SESSION_RESTRICTION_TOMBSTONES_HARD_CAP, evicted: 3 },
		]);
		expect(JSON.stringify(evictionWarnings())).not.toContain("released-");
	});

	test("an unpinned session reads its pin and drain rows at most once per miss window", async () => {
		setSystemTime(new Date("2026-10-07T10:00:00Z"));
		try {
			await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const [store] = stores;
			if (!store) throw new Error("expected a store");
			const getCache = vi.spyOn(store, "getCache");
			const rowReads = (prefix: string) =>
				getCache.mock.calls.filter(([key]) => key === `${prefix}${PROVIDER}:session`).length;
			const pinned = () => storage.sessions.accounts(PROVIDER, "session").some(account => account.pinned);
			for (let request = 0; request < 5; request += 1) {
				expect(await storage.keys.get(PROVIDER, "session")).toBeDefined();
			}
			expect(rowReads(SESSION_PIN_CACHE_PREFIX)).toBe(1);
			expect(rowReads(SESSION_DRAIN_CACHE_PREFIX)).toBe(1);

			// A write through this process applies at once.
			const accountB = storage.oauth.accounts(PROVIDER)[1];
			expect(storage.sessions.pin(PROVIDER, "session", accountB?.credentialId ?? -1)).toBe(true);
			expect(pinned()).toBe(true);
			expect(storage.sessions.unpin(PROVIDER, "session")).toBe(true);
			expect(pinned()).toBe(false);

			// Another process's pin is seen once the miss window has passed.
			const peer = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
			try {
				await peer.credentials.reload();
				expect(peer.sessions.pin(PROVIDER, "session", peer.oauth.accounts(PROVIDER)[0]?.credentialId ?? -1)).toBe(
					true,
				);
			} finally {
				peer.close();
			}
			expect(pinned()).toBe(false);
			setSystemTime(new Date("2026-10-07T10:00:02Z"));
			expect(pinned()).toBe(true);
			expect(await storage.keys.get(PROVIDER, "session")).toBe("access-a");
		} finally {
			setSystemTime();
		}
	});

	test("a wall clock stepped backwards does not extend a cached pin miss", async () => {
		setSystemTime(new Date("2026-10-07T10:00:00Z"));
		try {
			await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const pinned = () => storage.sessions.accounts(PROVIDER, "session").some(account => account.pinned);
			expect(pinned()).toBe(false);
			setSystemTime(new Date("2026-10-07T09:00:00Z"));
			const peer = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
			try {
				await peer.credentials.reload();
				expect(peer.sessions.pin(PROVIDER, "session", peer.oauth.accounts(PROVIDER)[1]?.credentialId ?? -1)).toBe(
					true,
				);
			} finally {
				peer.close();
			}
			setSystemTime(new Date("2026-10-07T09:00:02Z"));
			expect(pinned()).toBe(true);
		} finally {
			setSystemTime();
		}
	});

	test("a store swap carries a pin another process wrote within the miss window", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);
		// This process reads the session as unpinned, caching the miss.
		expect(storage.sessions.accounts(PROVIDER, "session").some(account => account.pinned)).toBe(false);
		const peer = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await peer.credentials.reload();
		expect(peer.sessions.pin(PROVIDER, "session", peer.oauth.accounts(PROVIDER)[1]?.credentialId ?? -1)).toBe(true);
		peer.close();

		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		stores.push(replacement);
		await replacement.replaceAuthCredentials(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		await storage.replaceStore(replacement);

		expect(storage.sessions.accounts(PROVIDER, "session").find(account => account.pinned)?.accountId).toBe("acc-b");
	});

	test("a restricted session without a sticky is described by an allowed account only", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		const described = storage.keys.describe(PROVIDER, "session") ?? "";
		expect(described).toContain("b@example.com");
		expect(described).not.toContain("a@example.com");
		expect(storage.keys.describe(PROVIDER)).toContain("a@example.com");
	});

	test("keeps restrictions across a credential store replacement", async () => {
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		storage.sessions.retire(PROVIDER, "retired", storage.sessions.restrict(PROVIDER, "retired", ["account:acc-b"]));
		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		stores.push(replacement);
		await storage.replaceStore(replacement);
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");

		for (const sessionId of ["session", "retired"]) {
			expect(storage.sessions.pin(PROVIDER, sessionId, accountA.credentialId)).toBe(false);
			expect(await storage.keys.get(PROVIDER, sessionId)).toBe("access-b");
		}
	});
});
