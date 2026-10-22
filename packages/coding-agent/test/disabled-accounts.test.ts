import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type { AuthCredential, OAuthCredential } from "@oh-my-pi/pi-ai";
import { apiKeyFingerprint } from "@oh-my-pi/pi-ai/auth/policy";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { accountPoolScopeOf, SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { validateDisabledAccounts } from "@oh-my-pi/pi-coding-agent/config/disabled-accounts";
import { directoryLayerFile } from "@oh-my-pi/pi-coding-agent/config/directory-layers";
import { cfgAuthDisabledAccounts } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const PROVIDER = "anthropic";
const SESSION = "session-1";

function oauth(suffix: string, access = `access-${suffix}`): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		orgId: `org-${suffix}`,
	};
}

describe("auth.disabledAccounts", () => {
	let state: SettingsTestState;
	let root: string;
	let agentDir: string;
	let cwd: string;
	let storage: AuthStorage;
	let instances: Settings[];
	let scopes: SessionAccountPoolScope[];
	let sessions: AgentSession[];

	beforeEach(async () => {
		state = beginSettingsTest();
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY"]) delete process.env[key];
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "disabled-accounts-"));
		agentDir = path.join(root, "agent");
		cwd = path.join(root, "project", "nested");
		await fs.promises.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "{}\n");
		storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await storage.credentials.set(PROVIDER, [oauth("a"), oauth("b"), oauth("c")]);
		instances = [];
		scopes = [];
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions.reverse()) await session.dispose();
		for (const scope of scopes) scope.release();
		for (const instance of instances) instance.cancelPendingSaves();
		storage.close();
		restoreSettingsTestState(state);
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	function rowId(suffix: string, provider = PROVIDER): number {
		const row = storage.credentials
			.list(provider)
			.find(entry => entry.credential.type === "oauth" && entry.credential.accountId === `account-${suffix}`);
		if (!row) throw new Error(`expected stored account ${suffix}`);
		return row.id;
	}

	async function writeGlobal(values: Record<string, unknown>): Promise<void> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(values));
	}

	async function writeDirectory(dir: string, values: Record<string, unknown>): Promise<void> {
		await Bun.write(directoryLayerFile(agentDir, dir), YAML.stringify({ path: dir, ...values }));
	}

	async function writeProject(values: Record<string, unknown>): Promise<void> {
		await Bun.write(path.join(cwd, ".omp", "config.yml"), YAML.stringify(values));
	}

	async function load(options: { overrides?: Record<string, unknown>; configFiles?: string[] } = {}) {
		const settings = await Settings.loadIsolated({ cwd, agentDir, ...options });
		instances.push(settings);
		return settings;
	}

	/** A scope over `settings` whose raised and cleared problems are recorded. */
	function scopeFor(settings: Settings, pools: Record<string, string[]> = {}, sessionId = SESSION) {
		const raised: string[] = [];
		const cleared: string[] = [];
		const scope = new SessionAccountPoolScope(storage, pools, sessionId, settings);
		scope.setIssueSink({ raised: message => raised.push(message), cleared: message => cleared.push(message) });
		scopes.push(scope);
		return { scope, raised, cleared };
	}

	function allowed(sessionId = SESSION, provider = PROVIDER): string[] {
		return storage.sessions
			.accounts(provider, sessionId)
			.map(account => account.accountId ?? `key ${account.keyFingerprint}`)
			.sort();
	}

	const policies = [
		{ provider: PROVIDER, name: "private", account: { email: "a@example.com" } },
		{ provider: PROVIDER, name: "work", account: { accountId: "account-b" } },
	];

	describe("entry kinds", () => {
		it.each([
			["#id", () => `${PROVIDER}/#${rowId("a")}`],
			["name", () => `${PROVIDER}/private`],
			["matcher", () => ({ provider: PROVIDER, email: "a@example.com" })],
		])("a %s entry excludes its account and keeps the others", async (_kind, entry) => {
			await writeGlobal({ auth: { accountPolicies: policies, disabledAccounts: [entry()] } });
			const { raised } = scopeFor(await load());
			expect(allowed()).toEqual(["account-b", "account-c"]);
			expect(raised).toEqual([]);
		});

		it("entries of every kind combine, and a provider without entries stays unrestricted", async () => {
			storage.keys.setRuntime("openai", "openai-runtime-key");
			await writeGlobal({
				auth: {
					accountPolicies: policies,
					disabledAccounts: [`${PROVIDER}/#${rowId("a")}`, `${PROVIDER}/work`],
				},
			});
			scopeFor(await load());
			expect(allowed()).toEqual(["account-c"]);
			expect(storage.sessions.isRestricted(PROVIDER, SESSION)).toBe(true);
			expect(storage.sessions.isRestricted("openai", SESSION)).toBe(false);
			expect(await storage.keys.get("openai", SESSION)).toBe("openai-runtime-key");
		});

		it("restricting a provider also excludes its runtime and environment API keys in that scope", async () => {
			storage.keys.setRuntime(PROVIDER, "runtime-key");
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			scopeFor(await load());
			expect(await storage.keys.get(PROVIDER, SESSION)).not.toBe("runtime-key");
			expect(await storage.keys.get(PROVIDER, "unscoped-session")).toBe("runtime-key");
		});
	});

	describe("selection", () => {
		it("never selects an excluded account through rotation, fallback passes, or a session pin", async () => {
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			scopeFor(await load());
			expect(storage.sessions.pin(PROVIDER, SESSION, rowId("a"))).toBe(false);

			const served = new Set<string | undefined>();
			served.add(await storage.keys.get(PROVIDER, SESSION));
			await storage.limits.markReached(PROVIDER, SESSION, { retryAfterMs: 3_600_000 });
			served.add(await storage.keys.get(PROVIDER, SESSION));
			// Both allowed accounts are now blocked; the relaxed fallback passes stay inside the allowlist.
			const last = await storage.limits.markReached(PROVIDER, SESSION, { retryAfterMs: 3_600_000 });
			expect(last.switched).toBe(false);
			served.add(await storage.keys.get(PROVIDER, SESSION).catch(() => undefined));
			expect(served.has("access-a")).toBe(false);
			expect(served).toContain("access-b");
			expect(served).toContain("access-c");
		});

		it("a session pinned to an account before it is excluded leaves that account", async () => {
			const settings = await load();
			scopeFor(settings);
			expect(storage.sessions.pin(PROVIDER, SESSION, rowId("a"))).toBe(true);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

			cfgAuthDisabledAccounts.override(settings, [`${PROVIDER}/#${rowId("a")}`]);
			expect(allowed()).toEqual(["account-b", "account-c"]);
			expect(["access-b", "access-c"]).toContain((await storage.keys.get(PROVIDER, SESSION)) ?? "");
		});
	});

	describe("trusted layers", () => {
		it("a project list (empty or shorter) lifts neither global nor directory exclusions, with a warning", async () => {
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			await writeProject({ auth: { disabledAccounts: [] } });
			const warn = vi.spyOn(logger, "warn");
			const global = scopeFor(await load());
			expect(allowed()).toEqual(["account-b", "account-c"]);
			expect(global.raised).toHaveLength(1);
			expect(global.raised[0]).toContain("project settings (.omp/config.yml) is ignored");
			expect(warn.mock.calls.some(([message]) => String(message).includes("auth.disabledAccounts"))).toBe(true);

			await writeDirectory(cwd, {
				auth: {
					disabledAccounts: [
						{ provider: PROVIDER, email: "a@example.com" },
						{ provider: PROVIDER, email: "b@example.com" },
					],
				},
			});
			await writeProject({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			const settings = await load();
			expect(cfgAuthDisabledAccounts.get(settings)).toHaveLength(2);
			scopeFor(settings, {}, "session-2");
			expect(allowed("session-2")).toEqual(["account-c"]);
		});

		it("a project redefining or removing a trusted account name does not change what it excludes", async () => {
			await writeGlobal({ auth: { accountPolicies: policies, disabledAccounts: [`${PROVIDER}/private`] } });
			await writeProject({
				auth: { accountPolicies: [{ provider: PROVIDER, name: "private", account: { email: "c@example.com" } }] },
			});
			scopeFor(await load());
			expect(allowed()).toEqual(["account-b", "account-c"]);

			await writeProject({ auth: { accountPolicies: [] } });
			scopeFor(await load(), {}, "session-2");
			expect(allowed("session-2")).toEqual(["account-b", "account-c"]);
		});

		it("a name defined only in project settings fails the provider closed with a notice", async () => {
			await writeGlobal({ auth: { disabledAccounts: [`${PROVIDER}/private`] } });
			await writeProject({ auth: { accountPolicies: policies } });
			const { raised } = scopeFor(await load());
			expect(allowed()).toEqual([]);
			await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(MissingApiKeyError);
			expect(raised).toHaveLength(1);
			expect(raised[0]).toContain(`"${PROVIDER}/private" names an account defined only in project settings`);
			expect(raised[0]).toContain(`${PROVIDER} is unavailable in this directory`);
		});

		it("a directory-layer edit applies mid-session, and the deepest layer replaces shallower lists", async () => {
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			const settings = await load();
			scopeFor(settings);
			expect(allowed()).toEqual(["account-b", "account-c"]);

			await writeDirectory(path.dirname(cwd), {
				auth: { disabledAccounts: [{ provider: PROVIDER, email: "c@example.com" }] },
			});
			await settings.reloadFromDisk();
			expect(allowed()).toEqual(["account-a", "account-b"]);

			await writeDirectory(cwd, { auth: { disabledAccounts: [{ provider: PROVIDER, email: "b@example.com" }] } });
			await settings.reloadFromDisk();
			expect(allowed()).toEqual(["account-a", "account-c"]);

			await fs.promises.rm(directoryLayerFile(agentDir, cwd));
			await fs.promises.rm(directoryLayerFile(agentDir, path.dirname(cwd)));
			await settings.reloadFromDisk();
			expect(allowed()).toEqual(["account-b", "account-c"]);

			await writeGlobal({});
			await settings.reloadFromDisk();
			expect(storage.sessions.isRestricted(PROVIDER, SESSION)).toBe(false);
		});
	});

	describe("unresolvable entries", () => {
		it("a dead #id fails the provider closed with a notice, cleared once the entry is fixed", async () => {
			const settings = await load({ overrides: { auth: { disabledAccounts: [`${PROVIDER}/#999`] } } });
			const { raised, cleared } = scopeFor(settings);
			expect(allowed()).toEqual([]);
			await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(MissingApiKeyError);
			expect(raised).toEqual([
				`auth.disabledAccounts entry "${PROVIDER}/#999" names no stored ${PROVIDER} credential; ${PROVIDER} is unavailable in this directory until you run \`omp account list\` to see stored accounts, then fix or remove the entry.`,
			]);

			cfgAuthDisabledAccounts.override(settings, [`${PROVIDER}/#${rowId("a")}`]);
			expect(allowed()).toEqual(["account-b", "account-c"]);
			expect(cleared).toEqual(raised);
		});

		it("an #id of another provider's row is dead for the named provider", async () => {
			await storage.credentials.set("openai-codex", [oauth("x")]);
			const settings = await load({
				overrides: { auth: { disabledAccounts: [`${PROVIDER}/#${rowId("x", "openai-codex")}`] } },
			});
			scopeFor(settings);
			expect(allowed()).toEqual([]);
			expect(storage.sessions.isRestricted("openai-codex", SESSION)).toBe(false);
		});

		it("an undefined name fails closed; a defined name or matcher matching nothing keeps the provider usable and warns once", async () => {
			const settings = await load({ overrides: { auth: { disabledAccounts: [`${PROVIDER}/ghost`] } } });
			const { raised } = scopeFor(settings);
			expect(allowed()).toEqual([]);
			expect(raised[0]).toContain(`names no ${PROVIDER} account in auth.accountPolicies`);

			cfgAuthDisabledAccounts.override(settings, [{ provider: PROVIDER, email: "nobody@example.com" }]);
			expect(allowed()).toEqual(["account-a", "account-b", "account-c"]);
			await storage.credentials.upsert(PROVIDER, oauth("b", "access-b-2"));
			expect(await storage.keys.get(PROVIDER, SESSION)).toMatch(/^access-/);
			const unmatched = raised.filter(message => message.includes("matches no stored"));
			expect(unmatched).toEqual([
				`auth.disabledAccounts entry "${PROVIDER} email=nobody@example.com" matches no stored ${PROVIDER} account; it excludes nothing.`,
			]);
		});

		it("rejects entries that resolve only to credentials without an OAuth identity", async () => {
			await storage.credentials.set(PROVIDER, [
				oauth("a"),
				{ type: "api_key", key: "sk-ant-test" } as AuthCredential,
			]);
			const apiRow = storage.credentials.list(PROVIDER).find(row => row.credential.type === "api_key");
			if (!apiRow) throw new Error("expected a stored API key");
			const settings = await load({
				overrides: {
					auth: {
						disabledAccounts: [
							`${PROVIDER}/#${apiRow.id}`,
							{ provider: PROVIDER, keyFingerprint: apiKeyFingerprint("sk-ant-test") },
						],
					},
				},
			});
			const { raised } = scopeFor(settings);
			expect(storage.sessions.isRestricted(PROVIDER, SESSION)).toBe(false);
			expect(raised).toHaveLength(2);
			for (const message of raised) {
				expect(message).toContain("API keys cannot be disabled individually per directory");
				expect(message).toContain(`Disabling any ${PROVIDER} OAuth account already excludes ${PROVIDER} API keys`);
			}

			// With an OAuth entry the provider is restricted, which leaves the API key out too.
			cfgAuthDisabledAccounts.override(settings, [`${PROVIDER}/#${apiRow.id}`, `${PROVIDER}/#${rowId("a")}`]);
			expect(allowed()).toEqual([]);
		});
	});

	describe("credential changes", () => {
		it("a re-login of an account excluded by name or matcher stays excluded", async () => {
			await writeGlobal({
				auth: {
					accountPolicies: policies,
					disabledAccounts: [`${PROVIDER}/private`, { provider: PROVIDER, accountId: "account-b" }],
				},
			});
			scopeFor(await load());
			expect(allowed()).toEqual(["account-c"]);
			await storage.credentials.upsert(PROVIDER, oauth("a", "access-a-2"));
			await storage.credentials.upsert(PROVIDER, oauth("b", "access-b-2"));
			expect(allowed()).toEqual(["account-c"]);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-c");
		});

		it("a login added mid-session is excluded when it matches an entry and usable otherwise", async () => {
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "d@example.com" }] } });
			scopeFor(await load());
			expect(allowed()).toEqual(["account-a", "account-b", "account-c"]);

			await storage.credentials.upsert(PROVIDER, oauth("d"));
			expect(allowed()).toEqual(["account-a", "account-b", "account-c"]);

			await storage.credentials.upsert(PROVIDER, oauth("e"));
			expect(allowed()).toEqual(["account-a", "account-b", "account-c", "account-e"]);
			const e = storage.credentials
				.list(PROVIDER)
				.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-e");
			expect(storage.sessions.pin(PROVIDER, SESSION, e?.id ?? -1)).toBe(true);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-e");
		});

		it("intersects a session's account pool with its exclusions", async () => {
			const keyA = "email:a@example.com|org:org-a";
			const keyB = "email:b@example.com|org:org-b";
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			scopeFor(await load(), { [PROVIDER]: [keyA, keyB] });
			expect(allowed()).toEqual(["account-b"]);
		});
	});

	describe("sessions", () => {
		async function createSession(
			settings: Settings,
			modelRegistry: ModelRegistry,
			providerSessionId: string,
			oauthAccountPools?: Record<string, string[]>,
		) {
			const model = getBundledModel(PROVIDER, "claude-sonnet-4-5");
			if (!model) throw new Error("expected a bundled model");
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				authStorage: storage,
				modelRegistry,
				settings,
				model,
				providerSessionId,
				oauthAccountPools,
				toolNames: ["read"],
				disableExtensionDiscovery: true,
			});
			sessions.push(session);
			return session;
		}

		it("restricts main, subagent, and advisor session ids, each under its own id", async () => {
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			const settings = await load();
			const parent = await createSession(
				settings,
				new ModelRegistry(storage, path.join(root, "models.yml")),
				"main",
			);
			const child = await createSession(settings, parent.modelRegistry, "child");
			const parentScope = accountPoolScopeOf(parent.modelRegistry);
			parentScope?.restrict("advisor");

			for (const sessionId of [parent.sessionId, child.sessionId, "advisor"]) {
				expect(allowed(sessionId)).toEqual(["account-b", "account-c"]);
			}
			const model = getBundledModel(PROVIDER, "claude-sonnet-4-5");
			if (!model) throw new Error("expected a bundled model");
			// A lookup without a session id resolves under the session's own id, not unrestricted.
			expect(["access-b", "access-c"]).toContain((await child.modelRegistry.getApiKey(model)) ?? "");

			// A later exclusion reaches every id already restricted.
			cfgAuthDisabledAccounts.override(settings, [
				{ provider: PROVIDER, email: "a@example.com" },
				{ provider: PROVIDER, email: "b@example.com" },
			]);
			for (const sessionId of [parent.sessionId, child.sessionId, "advisor"]) {
				expect(allowed(sessionId)).toEqual(["account-c"]);
			}
		});

		it("a subagent without its own pool keeps its parent's pool, narrowed by exclusions", async () => {
			await writeGlobal({ auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			const settings = await load();
			const parent = await createSession(
				settings,
				new ModelRegistry(storage, path.join(root, "models.yml")),
				"main",
				{ [PROVIDER]: ["email:a@example.com|org:org-a", "email:b@example.com|org:org-b"] },
			);
			const child = await createSession(settings, parent.modelRegistry, "child");
			expect(allowed(parent.sessionId)).toEqual(["account-b"]);
			expect(allowed(child.sessionId)).toEqual(["account-b"]);
		});

		it("holds a dead-entry warning until a host attaches, notices later ones, and retracts fixed ones", async () => {
			const settings = await load({ overrides: { auth: { disabledAccounts: [`${PROVIDER}/#999`] } } });
			const session = await createSession(
				settings,
				new ModelRegistry(storage, path.join(root, "models.yml")),
				"main",
			);
			expect(session.configWarnings.filter(message => message.includes(`"${PROVIDER}/#999"`))).toHaveLength(1);

			const notices: AgentSessionEvent[] = [];
			session.subscribe(event => {
				if (event.type === "notice") notices.push(event);
			});
			cfgAuthDisabledAccounts.override(settings, [`${PROVIDER}/#998`]);
			expect(session.configWarnings.some(message => message.includes(`"${PROVIDER}/#999"`))).toBe(false);
			expect(notices).toEqual([
				expect.objectContaining({
					type: "notice",
					level: "warning",
					source: "disabled-accounts",
					message: expect.stringContaining(`"${PROVIDER}/#998"`),
				}),
			]);
		});
	});

	describe("validation", () => {
		it.each([
			[["anthropic"], "must be"],
			[["/#3"], "must be"],
			[["anthropic/#0"], "account name must match"],
			[["anthropic/Private"], "account name must match"],
			[[{ provider: "anthropic" }], "must include at least one of"],
			[[{ provider: "anthropic", email: "a@example.com", nick: "x" }], "nick is not a field"],
			[
				[{ provider: "anthropic", keyFingerprint: "nothex" }],
				"keyFingerprint must be 16 lowercase hexadecimal digits",
			],
			[[{ email: "a@example.com" }], "provider must be a non-empty string"],
			["anthropic/#1", "must be a list"],
		])("rejects %j", (value, message) => {
			expect(() => validateDisabledAccounts(value)).toThrow(message);
		});

		it("accepts every entry form", () => {
			expect(() =>
				validateDisabledAccounts([
					"anthropic/#12",
					"anthropic/private",
					{ provider: "anthropic", email: "a@example.com", orgId: "org" },
					{ provider: "anthropic", keyFingerprint: "0123456789abcdef" },
				]),
			).not.toThrow();
		});

		it("an invalid directory-layer edit keeps the last good exclusions", async () => {
			await writeDirectory(cwd, { auth: { disabledAccounts: [{ provider: PROVIDER, email: "a@example.com" }] } });
			const settings = await load();
			scopeFor(settings);
			await writeDirectory(cwd, { auth: { disabledAccounts: ["anthropic"] } });
			await settings.reloadFromDisk().catch(() => {});
			expect(allowed()).toEqual(["account-b", "account-c"]);
		});
	});
});
