import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@oh-my-pi/pi-agent-core/compaction/compaction";
import { SESSION_PIN_CACHE_PREFIX } from "@oh-my-pi/pi-ai/auth/affinity";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { AccountUnavailableError, MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isRecord, logger, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { SessionAccountPoolScope } from "../src/config/account-pools";
import { ModelRegistry } from "../src/config/model-registry";
import { exportFromFile } from "../src/export/html";
import { Settings } from "../src/config/settings";
import type { InteractiveModeContext } from "../src/modes/types";
import * as accountAdmin from "../src/session/account-admin";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { credentialPinHash, recordCredentialPin, seedCredentialPins } from "../src/session/credential-pin";
import { SessionManager } from "../src/session/session-manager";
import { executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, extra?: { orgId?: string }) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...extra,
	};
}

function assistantMessage(provider: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "hi" }],
		api: "anthropic-messages",
		provider,
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

describe("credential pins", () => {
	let tempDir: TempDir;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = TempDir.createSync("@pi-credential-pin-");
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.saveOAuth("anthropic", mintOAuthCredential("a"));
		await store.saveOAuth("anthropic", mintOAuthCredential("b"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of ANTHROPIC_ENV) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		tempDir[Symbol.dispose]();
	});

	test("pin entries survive a session reload and the latest pin per provider wins", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		manager.appendCredentialPin("anthropic", "hash-old");
		manager.appendCredentialPin("openai-codex", "hash-codex");
		manager.appendCredentialPin("anthropic", "hash-new");
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		const reopened = await SessionManager.open(file);
		const pins = reopened.getCredentialPins();
		expect(pins.get("anthropic")?.hash).toBe("hash-new");
		expect(pins.get("openai-codex")?.hash).toBe("hash-codex");
	});

	test("later assistant turns advance the pin's effective last-use; other providers and new pins do not", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const pinId = manager.appendCredentialPin("anthropic", "hash-a");
		const pinnedAt = new Date(manager.getEntry(pinId)!.timestamp).getTime();

		// Long session on one account: no new pin entries, only assistant turns.
		const lastTurnAt = pinnedAt + 3 * 60 * 60 * 1000;
		manager.appendMessage(assistantMessage("anthropic", pinnedAt + 60_000));
		manager.appendMessage(assistantMessage("anthropic", lastTurnAt));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// A different provider's turn never advances this provider's pin.
		manager.appendMessage(assistantMessage("openai-codex", lastTurnAt + 60_000));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// An account change re-bases last-use at the new pin.
		const newPinId = manager.appendCredentialPin("anthropic", "hash-b");
		const newPinnedAt = new Date(manager.getEntry(newPinId)!.timestamp).getTime();
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(newPinnedAt);
	});

	test("seeding re-pins the recorded account in a store with no session stickiness", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		manager.appendCredentialPin("anthropic", hash);

		// Fresh process: no sticky exists yet (the broker-mode resume scenario).
		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
	});

	test("pins are org-scoped: the same account in two orgs re-pins the matching org credential", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-1" }));
		await store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-2" }));
		const orgStorage = new AuthStorage(store);
		await orgStorage.credentials.reload();

		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const identity = { accountId: "account-x", email: "x@example.com" };
		const orgTwoHash = credentialPinHash("anthropic", { ...identity, orgId: "org-2" });
		if (!orgTwoHash) throw new Error("expected a pin hash");
		expect(orgTwoHash).not.toBe(credentialPinHash("anthropic", { ...identity, orgId: "org-1" }));
		manager.appendCredentialPin("anthropic", orgTwoHash);

		seedCredentialPins(orgStorage, manager, sessionId);

		const active = orgStorage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.orgId).toBe("org-2");
	});

	test("seeding never clobbers a live sticky from the same process", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		expect(storage.sessions.pin("anthropic", sessionId, accountA!.credentialId)).toBe(true);

		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-a");
	});

	test("seeding advances a same-account sticky that is older than the session-file pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		const pinLastUsedAt = manager.getCredentialPins().get("anthropic")!.lastUsedAt;
		const accountB = storage.oauth
			.accounts("anthropic", sessionId)
			.find(account => account.accountId === "account-b");
		// A lazily-persisted sticky for the same account, older than the session's last turn.
		storage.sessions.pin("anthropic", sessionId, accountB!.credentialId, { restoredAtMs: pinLastUsedAt - 600_000 });

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
		expect(active?.lastUsedAtMs).toBe(pinLastUsedAt);
	});

	test("seeding never rewinds a same-account sticky that is newer than the pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		const newerUse = manager.getCredentialPins().get("anthropic")!.lastUsedAt + 60_000;
		const accountB = storage.oauth
			.accounts("anthropic", sessionId)
			.find(account => account.accountId === "account-b");
		storage.sessions.pin("anthropic", sessionId, accountB!.credentialId, { restoredAtMs: newerUse });

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.oauth.accounts("anthropic", sessionId).find(account => account.active)?.lastUsedAtMs).toBe(
			newerUse,
		);
	});

	test("seeding is a no-op when the pinned account is no longer stored", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" });
		manager.appendCredentialPin("anthropic", hash!);

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test("recording appends the serving account's hash once and dedupes repeats", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		storage.sessions.pin("anthropic", sessionId, accountA!.credentialId);

		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		const entries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(entries).toHaveLength(1);
		const identity = storage.oauth.identity("anthropic", sessionId);
		expect(manager.getCredentialPins().get("anthropic")?.hash).toBe(credentialPinHash("anthropic", identity!));
	});

	test("an exclusive entry restores a pin that overrides live affinity; a legacy entry restores a warm sticky", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accountA = storage.oauth
			.accounts("anthropic", sessionId)
			.find(account => account.accountId === "account-a");
		storage.sessions.pin("anthropic", sessionId, accountA!.credentialId, { restoredAtMs: Date.now() });
		const hashB = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hashB!, true);

		expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);
		const pinned = storage.sessions.accounts("anthropic", sessionId).find(account => account.pinned);
		expect(pinned?.accountId).toBe("account-b");

		const legacy = SessionManager.create(tempDir.path(), tempDir.path());
		const legacySessionId = legacy.getSessionId();
		legacy.appendCredentialPin("anthropic", hashB!);
		seedCredentialPins(storage, legacy, legacySessionId);
		const restored = storage.sessions.accounts("anthropic", legacySessionId);
		expect(restored.find(account => account.active)?.accountId).toBe("account-b");
		expect(restored.some(account => account.pinned)).toBe(false);
	});

	test("an exclusive entry for a removed account fails closed and is reported", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendCredentialPin("anthropic", credentialPinHash("anthropic", { accountId: "account-gone" })!, true);

		expect(seedCredentialPins(storage, manager, sessionId)).toEqual(["anthropic"]);
		await expect(storage.keys.get("anthropic", sessionId)).rejects.toBeInstanceOf(AccountUnavailableError);
	});

	test("an unavailable exclusive pin found while the session is built stays visible until unpinned", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		manager.appendCredentialPin("anthropic", credentialPinHash("anthropic", { accountId: "account-gone" })!, true);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({}),
			modelRegistry: new ModelRegistry(storage),
		});
		try {
			// No listener exists during construction, so a notice would be dropped.
			expect(session.configWarnings.filter(warning => warning.includes("pinned to this session"))).toHaveLength(1);

			const changes: string[] = [];
			session.subscribe(event => changes.push(event.type));
			expect(session.unpinCurrentProviderAccount()).toBe("unpinned");
			expect(session.configWarnings.some(warning => warning.includes("pinned to this session"))).toBe(false);
			expect(changes).toContain("config_warnings_changed");
		} finally {
			await session.dispose();
		}
	});

	/** Serve each stored OAuth credential's access token without a network refresh. */
	function serveStoredTokens(): void {
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	}

	function identityKey(suffix: string): string {
		const key = resolveCredentialIdentityKey("anthropic", mintOAuthCredential(suffix));
		if (!key) throw new Error("expected an identity key");
		return key;
	}

	function storedAccount(suffix: string): { credentialId: number } {
		const account = storage.sessions.accounts("anthropic").find(entry => entry.accountId === `account-${suffix}`);
		if (!account) throw new Error(`expected stored account ${suffix}`);
		return account;
	}

	function pinnedCredentialId(sessionId: string): number | undefined {
		return storage.sessions.accounts("anthropic", sessionId).find(account => account.pinned)?.credentialId;
	}

	function createSession(manager: SessionManager, accountPoolScope?: SessionAccountPoolScope): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		return new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({}),
			modelRegistry: new ModelRegistry(storage),
			accountPoolScope,
		});
	}

	function unpinCommandRuntime(session: AgentSession) {
		const showStatus = vi.fn();
		return {
			showStatus,
			runtime: {
				ctx: {
					session,
					showStatus,
					editor: { setText: vi.fn() },
					statusLine: { invalidate: vi.fn() },
					ui: { requestRender: vi.fn() },
				} as unknown as InteractiveModeContext,
			},
		};
	}

	function useCodexFallback(session: AgentSession): void {
		const model = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!model) throw new Error("Expected bundled Codex fallback model");
		session.agent.setModel(model);
	}

	test("/session unpin removes the Anthropic API key pin after a Codex fallback, including on resume", async () => {
		await store.saveApiKey("anthropic", "test-anthropic-api-key");
		await storage.credentials.reload();
		const account = storage.sessions.accounts("anthropic").find(candidate => candidate.type === "api_key");
		if (!account) throw new Error("Expected stored API key");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		const session = createSession(manager);
		try {
			expect(session.pinCurrentProviderAccount(account.credentialId)).toBe("pinned");
			useCodexFallback(session);
			const { runtime, showStatus } = unpinCommandRuntime(session);

			expect(await executeBuiltinSlashCommand("/session unpin", runtime)).toBe(true);
			expect(showStatus).toHaveBeenCalledWith("Removed this session's account pin for anthropic.");
			expect(pinnedCredentialId(session.sessionId)).toBeUndefined();
			expect(manager.getCredentialPins().get("anthropic")?.exclusive).toBe(false);
			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected persisted session");
			const resumed = await SessionManager.open(file);
			expect(resumed.getCredentialPins().get("anthropic")?.exclusive).toBe(false);
			expect(seedCredentialPins(storage, resumed, "resumed-after-unpin")).toEqual([]);
			expect(pinnedCredentialId("resumed-after-unpin")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("/session unpin refuses ambiguous provider pins and an explicit provider removes only its pin", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		const session = createSession(manager);
		try {
			expect(session.pinCurrentProviderAccount(storedAccount("b").credentialId)).toBe("pinned");
			manager.appendCredentialPin("google", "missing-google-account", true);
			useCodexFallback(session);
			const { runtime, showStatus } = unpinCommandRuntime(session);
			const before = manager.getEntries().length;

			await executeBuiltinSlashCommand("/session unpin", runtime);
			expect(showStatus).toHaveBeenLastCalledWith(
				"This session has account pins for anthropic, google. Use /session unpin <provider> to choose one.",
			);
			expect(manager.getEntries()).toHaveLength(before);
			expect(pinnedCredentialId(session.sessionId)).toBe(storedAccount("b").credentialId);
			expect(manager.getCredentialPins().get("google")?.exclusive).toBe(true);

			await executeBuiltinSlashCommand("/session unpin anthropic", runtime);
			expect(showStatus).toHaveBeenLastCalledWith("Removed this session's account pin for anthropic.");
			expect(pinnedCredentialId(session.sessionId)).toBeUndefined();
			expect(manager.getCredentialPins().get("anthropic")?.exclusive).toBe(false);
			expect(manager.getCredentialPins().get("google")?.exclusive).toBe(true);

			await executeBuiltinSlashCommand("/session unpin google extra", runtime);
			expect(showStatus).toHaveBeenLastCalledWith("Usage: /session unpin [provider]");
			expect(manager.getCredentialPins().get("google")?.exclusive).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	test("/session unpin prefers the current provider pin over other provider pins", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		const session = createSession(manager);
		try {
			expect(session.pinCurrentProviderAccount(storedAccount("a").credentialId)).toBe("pinned");
			manager.appendCredentialPin("google", "missing-google-account", true);
			const { runtime, showStatus } = unpinCommandRuntime(session);
			await executeBuiltinSlashCommand("/session unpin", runtime);
			expect(showStatus).toHaveBeenLastCalledWith("Removed this session's account pin for anthropic.");
			expect(pinnedCredentialId(session.sessionId)).toBeUndefined();
			expect(manager.getCredentialPins().get("google")?.exclusive).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	test("/session unpin ignores automatic affinity and pins outside the resumed branch", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendCredentialPin("anthropic", accountHash("a"), true);
		const branchPoint = manager.getLeafId();
		if (!branchPoint) throw new Error("Expected branch point");
		manager.appendCredentialPin("google", "other-branch-pin", true);
		manager.branch(branchPoint);
		manager.appendCredentialPin("openai-codex", "automatic-affinity");
		const session = createSession(manager);
		try {
			useCodexFallback(session);
			const { runtime, showStatus } = unpinCommandRuntime(session);
			await executeBuiltinSlashCommand("/session unpin", runtime);
			expect(showStatus).toHaveBeenLastCalledWith("Removed this session's account pin for anthropic.");
			expect(manager.getCredentialPins().has("google")).toBe(false);
			expect(manager.getCredentialPins().get("openai-codex")?.hash).toBe("automatic-affinity");
			expect(manager.getCredentialPins().get("anthropic")?.exclusive).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	test("/session unpin removes an unavailable explicit provider pin after fallback", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		manager.appendCredentialPin("google", "missing-account", true);
		const session = createSession(manager);
		try {
			useCodexFallback(session);
			const { runtime, showStatus } = unpinCommandRuntime(session);
			await executeBuiltinSlashCommand("/session unpin google", runtime);
			expect(showStatus).toHaveBeenLastCalledWith("Removed this session's account pin for google.");
			expect(manager.getCredentialPins().get("google")?.exclusive).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	test("/session unpin removes an ignored provider pin after fallback without changing the account pool", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		manager.appendCredentialPin("anthropic", accountHash("b"), true);
		const scope = new SessionAccountPoolScope(storage, { anthropic: [identityKey("a")] }, manager.getSessionId());
		const session = createSession(manager, scope);
		try {
			useCodexFallback(session);
			const { runtime, showStatus } = unpinCommandRuntime(session);
			await executeBuiltinSlashCommand("/session unpin", runtime);
			expect(showStatus).toHaveBeenLastCalledWith("Removed this session's account pin for anthropic.");
			expect(manager.getCredentialPins().get("anthropic")?.exclusive).toBe(false);
			expect(storage.sessions.isRestricted("anthropic", session.sessionId)).toBe(true);
			expect(storage.sessions.accounts("anthropic", session.sessionId).map(account => account.accountId)).toEqual([
				"account-a",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("/session unpin keeps current-provider live pin precedence without a recorded pin", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		const session = createSession(manager);
		try {
			expect(storage.sessions.pin("anthropic", session.sessionId, storedAccount("a").credentialId)).toBe(true);
			manager.appendCredentialPin("google", "other-provider-pin", true);
			const { runtime, showStatus } = unpinCommandRuntime(session);
			await executeBuiltinSlashCommand("/session unpin", runtime);
			expect(showStatus).toHaveBeenLastCalledWith("Removed this session's account pin for anthropic.");
			expect(pinnedCredentialId(session.sessionId)).toBeUndefined();
			expect(manager.getCredentialPins().get("google")?.exclusive).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	test("/session unpin reports the current provider's project pin without removing another session pin", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		const session = createSession(manager);
		try {
			manager.appendCredentialPin("google", "other-provider-pin", true);
			vi.spyOn(session, "unpinCurrentProviderAccount").mockReturnValue("project-pin");
			const unpinProvider = vi.spyOn(session, "unpinProviderAccount");
			const before = manager.getEntries().length;
			const { runtime, showStatus } = unpinCommandRuntime(session);
			await executeBuiltinSlashCommand("/session unpin", runtime);
			expect(showStatus).toHaveBeenLastCalledWith(
				"This session follows the project account pin for anthropic; remove it from auth.accountPins.",
			);
			expect(unpinProvider).not.toHaveBeenCalled();
			expect(manager.getEntries()).toHaveLength(before);
			expect(manager.getCredentialPins().get("google")?.exclusive).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	test("a fresh or reset provider session keeps the user's exclusive pin", async () => {
		serveStoredTokens();
		const session = createSession(SessionManager.inMemory(tempDir.path()));
		try {
			const accountB = storedAccount("b");
			expect(session.pinCurrentProviderAccount(accountB.credentialId)).toBe("pinned");

			const fresh = session.freshSession();
			expect(fresh?.sessionId).not.toBe(fresh?.previousSessionId);
			expect(pinnedCredentialId(session.sessionId)).toBe(accountB.credentialId);
			expect(await storage.keys.get("anthropic", session.sessionId)).toBe("access-b");

			const beforeReset = session.sessionId;
			expect(await session.resetSessionContext()).toBeDefined();
			expect(session.sessionId).not.toBe(beforeReset);
			expect(pinnedCredentialId(session.sessionId)).toBe(accountB.credentialId);
			expect(await storage.keys.get("anthropic", session.sessionId)).toBe("access-b");
		} finally {
			await session.dispose();
		}
	});

	test("a restricted session keeps its pin and pool across a fresh provider session", async () => {
		serveStoredTokens();
		const manager = SessionManager.inMemory(tempDir.path());
		const scope = new SessionAccountPoolScope(storage, { anthropic: [identityKey("a")] }, manager.getSessionId());
		const session = createSession(manager, scope);
		try {
			const accountA = storedAccount("a");
			const accountB = storedAccount("b");
			expect(session.pinCurrentProviderAccount(accountB.credentialId)).toBe("restricted");
			expect(session.pinCurrentProviderAccount(accountA.credentialId)).toBe("pinned");

			session.freshSession();
			const providerSessionId = session.sessionId;
			expect(providerSessionId).not.toBe(manager.getSessionId());
			expect(pinnedCredentialId(providerSessionId)).toBe(accountA.credentialId);
			expect(session.pinCurrentProviderAccount(accountB.credentialId)).toBe("restricted");
			expect(session.drainCurrentProviderAccount(accountB.credentialId)).toBe("restricted");
			expect(session.drainCurrentProviderAccount(accountA.credentialId)).toBe("drained");
			expect(await storage.keys.get("anthropic", providerSessionId)).toBe("access-a");
			// Tools read the auth store under the session file's id (security scans, web search); it stays restricted too.
			for (const sessionId of [manager.getSessionId(), providerSessionId]) {
				expect(storage.oauth.accounts("anthropic", sessionId).map(account => account.accountId)).toEqual([
					"account-a",
				]);
				expect((await storage.oauth.access("anthropic", sessionId))?.accountId).toBe("account-a");
			}
		} finally {
			await session.dispose();
		}
	});

	test("a restricted session ignores a recorded pin outside its pool without persisting a missing-account pin", async () => {
		serveStoredTokens();
		const warn = vi.spyOn(logger, "warn");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hashB = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hashB!, true);
		const lease = storage.sessions.restrict("anthropic", sessionId, [identityKey("a")]);

		expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);
		expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);
		expect(store.getCache(`${SESSION_PIN_CACHE_PREFIX}anthropic:${sessionId}`)).toBeNull();
		expect(await storage.keys.get("anthropic", sessionId)).toBe("access-a");
		expect(
			warn.mock.calls.filter(([message]) => String(message).startsWith("Session account restriction")),
		).toHaveLength(1);

		// The pool account that served the session does not replace the ignored user pin in the file,
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		expect(manager.getCredentialPins().get("anthropic")).toMatchObject({ hash: hashB, exclusive: true });
		// It is kept beside the pin as the session's affinity instead,
		expect(affinityHashes(manager)).toEqual([accountHash("a")]);
		// so a resume without the restriction restores it.
		storage.sessions.unrestrict("anthropic", sessionId, lease);
		expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);
		expect(pinnedCredentialId(sessionId)).toBe(storedAccount("b").credentialId);
	});

	test("unpinning removes a recorded pin a restriction ignores, after one info notice", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		const hashB = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hashB!, true);
		const scope = new SessionAccountPoolScope(storage, { anthropic: [identityKey("a")] }, manager.getSessionId());
		const session = createSession(manager, scope);
		try {
			const notices: string[] = [];
			session.subscribe(event => {
				if (event.type === "notice" && event.level === "info") notices.push(event.message);
			});
			session.freshSession();
			session.freshSession();
			expect(notices).toHaveLength(1);

			expect(session.unpinCurrentProviderAccount()).toBe("unpinned");
			expect(manager.getCredentialPins().get("anthropic")?.exclusive).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	test("a pin a restriction ignores while the session is built stays reported until unpinned", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		const hashB = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hashB!, true);
		const scope = new SessionAccountPoolScope(storage, { anthropic: [identityKey("a")] }, manager.getSessionId());
		const session = createSession(manager, scope);
		try {
			// Internal listeners (autolearn, memory backends) subscribe before any host renders notices.
			session.subscribe(() => {});
			const ignored = (warnings: readonly string[]) =>
				warnings.filter(warning => warning.includes("outside the account pool this session is restricted to"));
			// The header, RPC mode, and headless stderr report these once a host attaches.
			expect(ignored(session.accountPinWarnings)).toHaveLength(1);
			expect(ignored(session.configWarnings)).toHaveLength(1);

			expect(session.unpinCurrentProviderAccount()).toBe("unpinned");
			expect(ignored(session.accountPinWarnings)).toHaveLength(0);
			expect(ignored(session.configWarnings)).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});

	test("a restricted session lists, redeems, and drains only its pool's accounts", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		const scope = new SessionAccountPoolScope(storage, { anthropic: [identityKey("a")] }, manager.getSessionId());
		const session = createSession(manager, scope);
		const saveDrain = vi.spyOn(accountAdmin, "setAccountDrain");
		try {
			const listed = await session.listCurrentProviderAccounts();
			expect(listed?.accounts.map(account => account.email)).toEqual(["a@example.com"]);
			const outcome = await session.redeemResetCredit({
				provider: "anthropic",
				credentialId: storedAccount("b").credentialId,
			});
			expect(outcome.code).toBe("no_account");

			const output: string[] = [];
			const runtime = {
				ctx: {
					editor: { setText: vi.fn() },
					session,
					showStatus: (message: string) => output.push(message),
					statusLine: { invalidate: vi.fn() },
					ui: { requestRender: vi.fn() },
				} as unknown as InteractiveModeContext,
			};
			await executeBuiltinSlashCommand("/session drain b@example.com --save", runtime);
			expect(saveDrain).not.toHaveBeenCalled();
			expect(output.join("\n")).toContain("No stored anthropic OAuth account matches");

			// Even a list holding every stored row never saves or drains an account outside the pool.
			const drainCurrentProviderAccount = vi.fn(() => "drained");
			runtime.ctx.session = {
				sessionId: session.sessionId,
				isStreaming: false,
				settings: session.settings,
				modelRegistry: session.modelRegistry,
				listCurrentProviderAccounts: async () => ({
					provider: "anthropic",
					accounts: storage.sessions.accounts("anthropic"),
				}),
				drainCurrentProviderAccount,
			} as unknown as AgentSession;
			await executeBuiltinSlashCommand("/session drain b@example.com --save", runtime);
			expect(saveDrain).not.toHaveBeenCalled();
			expect(drainCurrentProviderAccount).not.toHaveBeenCalled();
			expect(output.at(-1)).toContain("outside the anthropic account pool");
		} finally {
			await session.dispose();
		}
	});

	test("a released pool scope refuses later lookups without restricting new ids", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const scope = new SessionAccountPoolScope(storage, { anthropic: [identityKey("a")] }, "primary");
		const registry = scope.registry(new ModelRegistry(storage));
		storage.keys.setRuntime("anthropic", "runtime-key");
		scope.release();

		for (const sessionId of ["late-1", "late-2", undefined]) {
			await expect(registry.getApiKey(model, sessionId)).rejects.toBeInstanceOf(MissingApiKeyError);
			await expect(
				Promise.resolve(registry.resolver(model, sessionId)({ lastChance: false, error: undefined })),
			).rejects.toBeInstanceOf(MissingApiKeyError);
		}
		scope.restrict("late-3");
		for (const sessionId of ["late-1", "late-2", "late-3"]) {
			expect(storage.sessions.isRestricted("anthropic", sessionId)).toBe(false);
		}
		// The id the scope restricted before release keeps its pool for direct auth store lookups.
		expect(storage.sessions.isRestricted("anthropic", "primary")).toBe(true);
	});

	test("recording never appends an automatic entry over the user's pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hashB = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hashB!, true);

		// No sticky is recorded, so the identity lookup falls back to the first stored account.
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		expect(manager.getCredentialPins().get("anthropic")).toMatchObject({ hash: hashB, exclusive: true });
	});

	async function storeAccountC(): Promise<void> {
		await store.saveOAuth("anthropic", mintOAuthCredential("c"));
		await storage.credentials.reload();
	}

	function accountHash(suffix: string): string {
		const hash = credentialPinHash("anthropic", { accountId: `account-${suffix}`, email: `${suffix}@example.com` });
		if (!hash) throw new Error("expected a pin hash");
		return hash;
	}

	function affinityHashes(manager: SessionManager): string[] {
		return manager.getBranch().flatMap(entry => (entry.type === "credential_affinity" ? [entry.hash] : []));
	}

	test("a restricted session records the pool account serving an ignored pin beside it, once per change", async () => {
		await storeAccountC();
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendCredentialPin("anthropic", accountHash("b"), true);
		storage.sessions.restrict("anthropic", sessionId, [identityKey("a"), identityKey("c")]);
		const now = Date.now();
		storage.sessions.pin("anthropic", sessionId, storedAccount("c").credentialId, { restoredAtMs: now });

		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		expect(affinityHashes(manager)).toEqual([accountHash("c")]);

		storage.sessions.pin("anthropic", sessionId, storedAccount("a").credentialId, { restoredAtMs: now + 1 });
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		expect(affinityHashes(manager)).toEqual([accountHash("c"), accountHash("a")]);
		expect(manager.getCredentialPins().get("anthropic")).toMatchObject({ hash: accountHash("b"), exclusive: true });
	});

	test("recording appends no affinity while the user's pin is honored", async () => {
		await storeAccountC();
		const unrestricted = SessionManager.create(tempDir.path(), tempDir.path());
		const pooled = SessionManager.create(tempDir.path(), tempDir.path());
		storage.sessions.restrict("anthropic", pooled.getSessionId(), [identityKey("b"), identityKey("c")]);
		for (const manager of [unrestricted, pooled]) {
			const sessionId = manager.getSessionId();
			manager.appendCredentialPin("anthropic", accountHash("b"), true);
			expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);
			expect(pinnedCredentialId(sessionId)).toBe(storedAccount("b").credentialId);

			recordCredentialPin(storage, manager, sessionId, "anthropic");

			expect(affinityHashes(manager)).toEqual([]);
		}
	});

	test("resume seeds the recorded pool account while a restriction ignores the user's pin", async () => {
		serveStoredTokens();
		await storeAccountC();
		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		const withoutAffinity = SessionManager.create(tempDir.path(), tempDir.path());
		for (const manager of [resumed, withoutAffinity]) {
			manager.appendCredentialPin("anthropic", accountHash("b"), true);
			storage.sessions.restrict("anthropic", manager.getSessionId(), [identityKey("a"), identityKey("c")]);
		}
		resumed.appendCredentialAffinity("anthropic", accountHash("c"));

		for (const manager of [resumed, withoutAffinity]) {
			expect(seedCredentialPins(storage, manager, manager.getSessionId())).toEqual([]);
		}

		expect(await storage.keys.get("anthropic", withoutAffinity.getSessionId())).toBe("access-a");
		expect(await storage.keys.get("anthropic", resumed.getSessionId())).toBe("access-c");
		expect(pinnedCredentialId(resumed.getSessionId())).toBeUndefined();
	});

	test("resume ignores an affinity outside the restriction or for an account no longer stored", async () => {
		serveStoredTokens();
		await storeAccountC();
		for (const hash of [accountHash("b"), accountHash("gone")]) {
			const manager = SessionManager.create(tempDir.path(), tempDir.path());
			const sessionId = manager.getSessionId();
			manager.appendCredentialPin("anthropic", accountHash("b"), true);
			manager.appendCredentialAffinity("anthropic", hash);
			storage.sessions.restrict("anthropic", sessionId, [identityKey("a"), identityKey("c")]);

			expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);

			expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);
			expect(await storage.keys.get("anthropic", sessionId)).toBe("access-a");
		}
	});

	test("an unrestricted resume never seeds a recorded affinity", async () => {
		await storeAccountC();
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendCredentialAffinity("anthropic", accountHash("c"));

		expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);

		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test("an honored user pin wins over a recorded affinity on resume", async () => {
		serveStoredTokens();
		await storeAccountC();
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendCredentialPin("anthropic", accountHash("b"), true);
		manager.appendCredentialAffinity("anthropic", accountHash("c"));

		expect(seedCredentialPins(storage, manager, sessionId)).toEqual([]);

		expect(pinnedCredentialId(sessionId)).toBe(storedAccount("b").credentialId);
		expect(await storage.keys.get("anthropic", sessionId)).toBe("access-b");
	});

	test("a session file with affinity entries loads, compacts, forks, and exports like the same file without them", async () => {
		await storeAccountC();
		const writer = SessionManager.create(tempDir.path(), tempDir.path());
		writer.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		writer.appendMessage(assistantMessage("anthropic", Date.now()));
		const pinId = writer.appendCredentialPin("anthropic", accountHash("b"), true);
		await writer.flush();
		const file = writer.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		// Written raw, as a build that predates the entry type finds it on disk.
		const affinity = {
			type: "credential_affinity",
			id: "aff00001",
			parentId: pinId,
			timestamp: new Date().toISOString(),
			provider: "anthropic",
			hash: accountHash("c"),
		};
		await Bun.write(file, `${await Bun.file(file).text()}${JSON.stringify(affinity)}\n`);
		const continued = await SessionManager.open(file);
		continued.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		continued.appendMessage(assistantMessage("anthropic", Date.now()));
		await continued.flush();

		const strippedFile = tempDir.join("stripped.jsonl");
		const stripped = (await Bun.file(file).text())
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.filter(entry => entry.type !== "credential_affinity")
			.map(entry => (entry.parentId === affinity.id ? { ...entry, parentId: pinId } : entry));
		await Bun.write(strippedFile, `${stripped.map(entry => JSON.stringify(entry)).join("\n")}\n`);

		const [withEntries, without] = await Promise.all([SessionManager.open(file), SessionManager.open(strippedFile)]);
		expect(withEntries.getCredentialPins()).toEqual(without.getCredentialPins());
		expect(withEntries.buildSessionContext().messages).toEqual(without.buildSessionContext().messages);
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1, remoteEnabled: false };
		const prepared = prepareCompaction(withEntries.getBranch(), settings);
		const preparedWithout = prepareCompaction(without.getBranch(), settings);
		if (!prepared || !preparedWithout) throw new Error("expected compaction preparations");
		expect(prepared.messagesToSummarize).toEqual(preparedWithout.messagesToSummarize);
		expect(prepared.recentMessages).toEqual(preparedWithout.recentMessages);

		// Compaction and fork keep the affinity readable, as they keep the pin.
		withEntries.appendCompaction("summary", undefined, prepared.firstKeptEntryId, prepared.tokensBefore);
		const forked = await withEntries.fork();
		if (!forked) throw new Error("expected a forked session file");
		expect((await SessionManager.open(forked.newSessionFile)).getCredentialAffinities().get("anthropic")?.hash).toBe(
			accountHash("c"),
		);

		const outputPath = tempDir.join("export.html");
		await exportFromFile(file, { outputPath });
		const html = await Bun.file(outputPath).text();
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		if (!encoded) throw new Error("expected embedded session data");
		const exported = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
			entries: Array<Record<string, unknown>>;
		};
		expect(exported.entries.filter(entry => entry.type === "credential_affinity")).toEqual([affinity]);
	});

	test("RPC mode reports an unavailable pin found while the session is built as a notice frame", async () => {
		const sourceDir = path.resolve(import.meta.dir, "../src");
		const fixturePath = tempDir.join("rpc-pin.ts");
		await Bun.write(
			fixturePath,
			`
import { Database } from "bun:sqlite";
import { Agent } from ${JSON.stringify(Bun.resolveSync("@oh-my-pi/pi-agent-core", import.meta.dir))};
import { getBundledModel } from ${JSON.stringify(Bun.resolveSync("@oh-my-pi/pi-catalog/models", import.meta.dir))};
import { ModelRegistry } from ${JSON.stringify(path.join(sourceDir, "config/model-registry.ts"))};
import { Settings } from ${JSON.stringify(path.join(sourceDir, "config/settings.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { AgentSession } from ${JSON.stringify(path.join(sourceDir, "session/agent-session.ts"))};
import { AuthStorage, SqliteAuthCredentialStore } from ${JSON.stringify(path.join(sourceDir, "session/auth-storage.ts"))};
import { credentialPinHash } from ${JSON.stringify(path.join(sourceDir, "session/credential-pin.ts"))};
import { SessionManager } from ${JSON.stringify(path.join(sourceDir, "session/session-manager.ts"))};
const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
await storage.credentials.reload();
const manager = SessionManager.inMemory(process.cwd());
manager.appendCredentialPin("anthropic", credentialPinHash("anthropic", { accountId: "account-gone" }), true);
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
const session = new AgentSession({
  agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
  sessionManager: manager,
  settings: Settings.isolated({}),
  modelRegistry: new ModelRegistry(storage),
});
await runRpcMode(session);
`,
		);
		const child = Bun.spawn([process.execPath, fixturePath], {
			cwd: tempDir.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: tempDir.join("home"),
				PI_CODING_AGENT_DIR: tempDir.join("agent"),
				XDG_CONFIG_HOME: tempDir.join("config"),
				XDG_DATA_HOME: tempDir.join("data"),
				XDG_CACHE_HOME: tempDir.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		const stderr = new Response(child.stderr).text();
		let notice: Record<string, unknown> | undefined;
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (isRecord(frame) && frame.type === "notice") {
					notice = frame;
					break;
				}
			}
		} finally {
			child.stdin.end();
			await child.exited;
		}
		expect(notice, await stderr).toMatchObject({ level: "warning", source: "account-pin" });
		expect(notice?.message).toContain("pinned to this session for anthropic");
	}, 30_000);
});
