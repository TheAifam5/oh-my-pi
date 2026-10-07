import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SESSION_PIN_CACHE_PREFIX } from "@oh-my-pi/pi-ai/auth/affinity";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { AccountUnavailableError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isRecord, logger, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { SessionAccountPoolScope } from "../src/config/account-pools";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { credentialPinHash, recordCredentialPin, seedCredentialPins } from "../src/session/credential-pin";
import { SessionManager } from "../src/session/session-manager";

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

	test("recording never appends an automatic entry over the user's pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hashB = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hashB!, true);

		// No sticky is recorded, so the identity lookup falls back to the first stored account.
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		expect(manager.getCredentialPins().get("anthropic")).toMatchObject({ hash: hashB, exclusive: true });
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
