import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthAccountPolicies,
	type AuthCredentialStore,
	AuthStorage,
	apiKeyFingerprint,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-account-pins";
const SESSION = "session-account-pins";
const API_KEY = "sk-unit-account-pins";

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

const POLICIES: AuthAccountPolicies = [
	{ provider: PROVIDER, name: "personal", account: { email: "a@example.com" } },
	{ provider: PROVIDER, name: "team", account: { email: "b@example.com" }, priority: 10 },
	{ provider: PROVIDER, name: "work", account: { keyFingerprint: apiKeyFingerprint(API_KEY) } },
];

describe("AuthStorage account names and exclusive pins", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-account-pins-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	async function storageWithAccounts(): Promise<AuthStorage> {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { accountPolicies: POLICIES });
		await storage.credentials.set(PROVIDER, [
			oauthCredential("a"),
			oauthCredential("b"),
			{ type: "api_key", key: API_KEY },
		]);
		return storage;
	}

	function credentialId(storage: AuthStorage, name: string): number {
		const account = storage.sessions.accounts(PROVIDER).find(entry => entry.name === name);
		if (!account) throw new Error(`no stored account named ${name}`);
		return account.credentialId;
	}

	test("rejects malformed and duplicate account names per provider", () => {
		if (!store) throw new Error("test setup failed");
		const credentialStore = store;
		const build = (accountPolicies: AuthAccountPolicies) => () =>
			new AuthStorage(credentialStore, { accountPolicies });

		expect(build([{ provider: PROVIDER, name: "Work", account: { email: "a@example.com" } }])).toThrow(
			AIError.ConfigurationError,
		);
		expect(
			build([
				{ provider: PROVIDER, name: "work", account: { email: "a@example.com" } },
				{ provider: PROVIDER, name: "work", account: { email: "b@example.com" } },
			]),
		).toThrow(/both name a unit-account-pins account "work"/);
		expect(
			build([
				{ provider: PROVIDER, name: "work", account: { email: "a@example.com" } },
				{ provider: "other-provider", name: "work", account: { email: "a@example.com" } },
			]),
		).not.toThrow();
	});

	test("an exclusive session pin beats priority and keeps serving a blocked account", async () => {
		const storage = await storageWithAccounts();
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");

		expect(storage.sessions.pin(PROVIDER, SESSION, credentialId(storage, "personal"))).toBe(true);
		const usageLimit = new Error("usage limit reached for this account");
		const rotation = await storage.limits.rotate(PROVIDER, SESSION, { error: usageLimit, apiKey: "access-a" });

		expect(rotation.switched).toBe(false);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
		expect(storage.sessions.release(PROVIDER, SESSION)).toBe(false);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
	});

	test("a session pin overrides the project pin until it is removed", async () => {
		const storage = await storageWithAccounts();
		storage.sessions.setAccountPinSource({
			project: (provider, sessionId) => (provider === PROVIDER && sessionId === SESSION ? "work" : undefined),
		});
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe(API_KEY);

		expect(storage.sessions.pin(PROVIDER, SESSION, credentialId(storage, "personal"))).toBe(true);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

		expect(storage.sessions.unpin(PROVIDER, SESSION)).toBe(true);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe(API_KEY);
	});

	test("an unknown pinned account name fails instead of falling back", async () => {
		const storage = await storageWithAccounts();
		storage.sessions.setAccountPinSource({ project: () => "missing" });

		await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
	});

	test("an unresolvable pool member account falls through to normal selection", async () => {
		const storage = await storageWithAccounts();
		storage.sessions.setAccountPinSource({ member: () => "missing" });

		expect(await storage.keys.get(PROVIDER, SESSION, { modelId: "model-a" })).toBe("access-b");
	});

	test.each(["forbidden", "401", "unauthorized"])(
		"a github-copilot pin named %s fails as a non-auth, non-retryable error and keeps credentials",
		async name => {
			if (!store) throw new Error("test setup failed");
			const storage = new AuthStorage(store);
			await storage.credentials.set("github-copilot", { type: "api_key", key: "copilot-key" });
			storage.sessions.setAccountPinSource({ project: () => name });

			const error = await storage.keys.get("github-copilot", SESSION).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(AIError.AccountUnavailableError);
			const message = (error as Error).message;
			expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(false);
			expect(
				AIError.is(
					AIError.classifyMessage({ provider: "github-copilot", errorMessage: message }),
					AIError.Flag.AuthFailed,
				),
			).toBe(false);
			expect(AIError.isProviderRetryableError(error)).toBe(false);
			expect(storage.credentials.list("github-copilot")).toHaveLength(1);
		},
	);

	test("an exclusive pin survives credential changes and fails closed once its account is removed", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store);
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const accountId = (email: string) => {
			const account = storage.sessions.accounts(PROVIDER).find(entry => entry.email === email);
			if (!account) throw new Error(`no stored account ${email}`);
			return account.credentialId;
		};
		const pinnedId = accountId("a@example.com");
		expect(storage.sessions.pin(PROVIDER, SESSION, pinnedId)).toBe(true);

		await storage.credentials.upsert(PROVIDER, oauthCredential("c"));
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
		expect(await storage.credentials.removeById(PROVIDER, accountId("c@example.com"))).toBe(true);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

		expect(await storage.credentials.removeById(PROVIDER, pinnedId)).toBe(true);
		await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
	});

	test("a runtime key override beats an exclusive pin", async () => {
		const storage = await storageWithAccounts();
		expect(storage.sessions.pin(PROVIDER, SESSION, credentialId(storage, "personal"))).toBe(true);

		storage.keys.setRuntime(PROVIDER, "runtime-key");
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("runtime-key");
		storage.keys.removeRuntime(PROVIDER);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
	});

	test("a credential store swap keeps an exclusive pin on the same account or fails closed", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store);
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const pinnedId = storage.sessions
			.accounts(PROVIDER)
			.find(account => account.email === "a@example.com")?.credentialId;
		expect(storage.sessions.pin(PROVIDER, SESSION, pinnedId ?? -1)).toBe(true);

		const reordered = await SqliteAuthCredentialStore.open(path.join(tempDir, "reordered.db"));
		await reordered.replaceAuthCredentials(PROVIDER, [
			oauthCredential("b"),
			oauthCredential("c"),
			oauthCredential("a"),
		]);
		await storage.replaceStore(reordered);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

		const withoutPinned = await SqliteAuthCredentialStore.open(path.join(tempDir, "without-pinned.db"));
		await withoutPinned.replaceAuthCredentials(PROVIDER, [oauthCredential("b")]);
		await storage.replaceStore(withoutPinned);
		await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(AIError.AccountUnavailableError);
		storage.close();
	});
});
