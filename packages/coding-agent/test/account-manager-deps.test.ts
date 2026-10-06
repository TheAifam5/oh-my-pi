import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAccountManagerDeps } from "@oh-my-pi/pi-coding-agent/modes/account-manager-deps";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { loadEffectiveAuthAccountPolicyConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { retryFallbackBillingRegistry } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-groups";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const workPolicy = { provider: "anthropic", name: "work", account: { email: "a@example.com" } };

describe("account manager deps", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-account-manager-");
		agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 3_600_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
		]);
		await authStorage.credentials.set("openai", [{ type: "api_key", key: "sk-test-secret" }]);
	});

	afterEach(() => {
		authStorage.close();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	async function open(
		config: Record<string, unknown>,
		overrides?: Record<string, unknown>,
		usageReports?: () => readonly UsageReport[],
	) {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir, overrides });
		authStorage.setAccountPolicies(await loadEffectiveAuthAccountPolicyConfig({ settings }));
		const deps = createAccountManagerDeps({ settings, authStorage, cwd: () => tempDir.path(), usageReports });
		const ids = Object.fromEntries(deps.load().map(account => [account.provider, account.id]));
		return { settings, deps, ids };
	}

	it("writes an edit through the validated policy write and refuses an invalid one without writing", async () => {
		const { settings, deps, ids } = await open({ auth: { accountPolicies: [workPolicy] } });

		expect(await deps.apply(ids.anthropic!, "priority", "7")).toEqual({ message: "Set priority 7 for work." });
		expect(settings.getGlobalSettings().auth).toEqual({ accountPolicies: [{ ...workPolicy, priority: 7 }] });

		const refused = await deps.apply(ids.openai!, "limit:add", "usage 0.5");
		expect(refused.error).toContain("applies to OAuth accounts only");
		expect(settings.getGlobalSettings().auth).toEqual({ accountPolicies: [{ ...workPolicy, priority: 7 }] });

		const openai = deps.load().find(account => account.provider === "openai")!;
		expect(openai.identity).toMatch(/^API key [0-9a-f]{16}$/);
		expect(JSON.stringify(openai)).not.toContain("sk-test-secret");
	});

	it("shows policies from a runtime layer read-only and refuses their edits", async () => {
		const { settings, deps, ids } = await open({}, { "auth.accountPolicies": [workPolicy] });

		const anthropic = deps.load().find(account => account.provider === "anthropic")!;
		expect(anthropic.fields.find(field => field.id === "priority")?.readOnly).toBe(
			"auth.accountPolicies is set in the runtime layer",
		);
		expect((await deps.apply(ids.anthropic!, "priority", "7")).error).toContain("runtime layer");
		expect(settings.getGlobalSettings().auth).toBeUndefined();
	});

	it("sets and clears a pool member's preferred account in the user config", async () => {
		const pool = { strategy: "random", models: { opus: { model: "anthropic/claude-opus-4-5" } } };
		const { settings, deps, ids } = await open({
			auth: { accountPolicies: [workPolicy] },
			modelRoles: { default: pool },
		});

		const field = deps
			.load()
			.find(account => account.provider === "anthropic")!
			.fields.find(f => f.id === "pool")!;
		expect(field.choices?.map(choice => choice.label)).toEqual([
			"modelRoles.default.models.opus (anthropic/claude-opus-4-5)",
		]);

		const action = field.choices![0]!.id;
		expect((await deps.apply(ids.anthropic!, action, "on")).message).toBe(
			"modelRoles.default.models.opus tries work first.",
		);
		expect(settings.getGlobalSettings().modelRoles).toEqual({
			default: { ...pool, models: { opus: { model: "anthropic/claude-opus-4-5", account: "work" } } },
		});
		await deps.apply(ids.anthropic!, action, "off");
		expect(settings.getGlobalSettings().modelRoles).toEqual({ default: pool });
	});

	it("warns about pins and pool members a rename leaves dangling, and keeps name-based pins on the policy layer", async () => {
		const pool = { strategy: "random", models: { opus: { model: "anthropic/claude-opus-4-5", account: "work" } } };
		const project = tempDir.path();
		const { settings, deps, ids } = await open({
			auth: { accountPolicies: [workPolicy], accountPins: { [project]: { anthropic: "work" } } },
			modelRoles: { default: pool },
		});
		const renamed = await deps.apply(ids.anthropic!, "name", "home");
		expect(renamed.warning).toContain(
			`auth.accountPins["${project}"], modelRoles.default.models.opus still name "work"`,
		);
		expect(settings.getGlobalSettings().modelRoles).toEqual({ default: pool });

		const blocked = await open({ modelRoles: { default: pool } }, { "auth.accountPolicies": [workPolicy] });
		const member = blocked.deps.load()[0]!.fields.find(field => field.id === "pool")!.choices![0]!.id;
		expect((await blocked.deps.apply(blocked.ids.anthropic!, member, "off")).error).toContain("runtime layer");
		expect((await blocked.deps.apply(blocked.ids.anthropic!, "pin-project", "on")).error).toContain("runtime layer");
		expect(blocked.settings.getGlobalSettings().modelRoles).toEqual({ default: pool });
		expect(blocked.settings.getGlobalSettings().auth).toBeUndefined();
	});

	it("rejects malformed and stale limit actions and applies toggles to their target state", async () => {
		const limited = {
			...workPolicy,
			limits: [{ metric: "requests", max: 10, window: { type: "calendar", period: "day" } }],
		};
		const { settings, deps, ids } = await open({ auth: { accountPolicies: [limited] } });
		const policies = () => settings.getGlobalSettings().auth;
		const before = policies();
		for (const action of [
			"limit:remove:1",
			"limit:remove:x",
			"limit:edit",
			"limit:add:0",
			"limit:drop:0",
			"limit:remove:00",
			"limit:remove:0x",
		]) {
			expect(
				(await deps.apply(ids.anthropic!, action, "requests 5 day", "requests 10 day skip")).error,
			).toBeDefined();
		}
		expect((await deps.apply(ids.anthropic!, "limit:remove:0", "", "usd 5 day skip")).error).toContain("changed");
		expect((await deps.apply(ids.anthropic!, "spend:credits", "on")).error).toBe("Drain work first.");
		expect((await deps.apply(ids.anthropic!, "drain")).error).toBe("A toggle needs its target state (on or off).");
		expect(policies()).toEqual(before);

		await deps.apply(ids.anthropic!, "drain", "on");
		expect((await deps.apply(ids.anthropic!, "drain", "on")).message).toBe("work is already drained first.");
		expect(policies()).toEqual({ accountPolicies: [{ ...limited, drain: true }] });
		expect((await deps.apply(ids.anthropic!, "limit:remove:0", "", "requests 10 day skip")).error).toBeUndefined();
		expect(policies()).toEqual({ accountPolicies: [{ ...workPolicy, drain: true }] });
	});

	it("attributes billing evidence only to the OAuth account a report names", async () => {
		const unregister = retryFallbackBillingRegistry.register({
			id: "acme",
			readBilling: report => ({
				status: "known",
				snapshot: {
					provider: "acme",
					fetchedAt: report.fetchedAt,
					sources: [{ mode: "prepaid-credits", state: "available" }],
				},
			}),
		});
		try {
			const oauth = (suffix: string) => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 3_600_000,
				email: `${suffix}@acme.test`,
			});
			await authStorage.credentials.set("acme", [oauth("x"), oauth("y")]);
			let reports: UsageReport[] = [{ provider: "acme", fetchedAt: Date.now(), limits: [] }];
			const { deps } = await open({}, undefined, () => reports);
			const billing = () =>
				deps
					.load()
					.filter(account => account.provider === "acme")
					.map(account => account.details.find(detail => detail.label === "billing")?.value);
			expect(billing()).toEqual(["unknown (no-report)", "unknown (no-report)"]);
			reports = [{ provider: "acme", fetchedAt: Date.now(), limits: [], metadata: { email: "x@acme.test" } }];
			expect(billing()).toEqual(["prepaid-credits available", "unknown (no-report)"]);
		} finally {
			unregister();
		}
	});
});
