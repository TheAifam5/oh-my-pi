import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cfgAuthAccountPolicies } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runAccountCommand } from "@oh-my-pi/pi-coding-agent/cli/account-cli";
import {
	AccountAdminError,
	labelAccount,
	listAccounts,
	logoutAccount,
	pinProjectAccount,
	resolveAccount,
	setAccountDrain,
	setAccountPriority,
	setAccountReserve,
	unpinProjectAccount,
} from "@oh-my-pi/pi-coding-agent/session/account-admin";
import {
	projectAccountPin,
	registerSessionAccountPins,
	settingsAccountPinSource,
} from "@oh-my-pi/pi-coding-agent/session/account-pins";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

function oauth(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("account administration", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-account-admin-");
		agentDir = tempDir.join("agent");
		project = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.credentials.set("anthropic", [oauth("a"), oauth("b")]);
	});

	afterEach(() => {
		authStorage.close();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("names accounts in the user config only and rejects a duplicate name", async () => {
		const projectPolicy = { provider: "openai", name: "team", account: { email: "x@example.com" } };
		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "settings.json"),
			JSON.stringify({ auth: { accountPolicies: [projectPolicy] } }),
		);
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });

		const accountA = resolveAccount(authStorage, "a@example.com");
		const result = labelAccount(settings, authStorage, accountA, "work");
		expect(result.warning).toContain("project");
		expect(settings.getGlobalSettings().auth).toEqual({
			accountPolicies: [{ provider: "anthropic", account: { accountId: "acc-a" }, name: "work" }],
		});

		const accountB = resolveAccount(authStorage, "anthropic/b@example.com");
		expect(() => labelAccount(settings, authStorage, accountB, "work")).toThrow(AccountAdminError);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([projectPolicy]);
	});

	it("pins the current project to a named account and logs a named account out", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				auth: {
					accountPolicies: [{ provider: "anthropic", name: "work", account: { email: "a@example.com" } }],
				},
			}),
		);
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		authStorage.setAccountPolicies({ accountPolicies: cfgAuthAccountPolicies.get(settings), defaultReservePct: 10 });

		const pinned = pinProjectAccount(settings, authStorage, path.join(project, "src"), "work");
		expect(pinned.provider).toBe("anthropic");
		expect(projectAccountPin(settings, path.join(project, "src", "deep"), "anthropic")).toBe("work");
		expect(() => pinProjectAccount(settings, authStorage, project, "missing")).toThrow(AccountAdminError);

		const result = await logoutAccount(settings, authStorage, resolveAccount(authStorage, "work"));
		expect(result.pinnedProjects).toHaveLength(1);
		expect(authStorage.sessions.accounts("anthropic").map(account => account.email)).toEqual(["b@example.com"]);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
	});

	it("marks a project pin in listings before the session makes a request", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				auth: {
					accountPolicies: [{ provider: "anthropic", name: "work", account: { email: "b@example.com" } }],
					accountPins: { [project]: { anthropic: "work" } },
				},
			}),
		);
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		authStorage.setAccountPolicies({ accountPolicies: cfgAuthAccountPolicies.get(settings), defaultReservePct: 10 });
		authStorage.sessions.setAccountPinSource(settingsAccountPinSource);
		const unregister = registerSessionAccountPins("session-1", settings, () => project);
		try {
			const pinned = authStorage.sessions.accounts("anthropic", "session-1").filter(account => account.pinned);
			expect(pinned.map(account => account.email)).toEqual(["b@example.com"]);
			expect(listAccounts(settings, authStorage, project).map(row => [row.label, row.projectPinned])).toEqual([
				["a@example.com", false],
				["b@example.com", true],
			]);
		} finally {
			unregister();
		}
	});

	it("keeps user policies when logout is refused by a project policy or fails in the store", async () => {
		const userPolicy = { provider: "anthropic", name: "work", account: { email: "a@example.com" } };
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify({ auth: { accountPolicies: [userPolicy] } }));
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		authStorage.setAccountPolicies({ accountPolicies: [userPolicy], defaultReservePct: 10 });
		const accountA = resolveAccount(authStorage, "a@example.com");

		vi.spyOn(authStorage.credentials, "removeById").mockRejectedValue(new Error("broker unreachable"));
		await expect(logoutAccount(settings, authStorage, accountA)).rejects.toThrow("broker unreachable");
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([userPolicy]);
		vi.restoreAllMocks();

		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "settings.json"),
			JSON.stringify({ auth: { accountPolicies: [userPolicy] } }),
		);
		const withProject = await Settings.loadIsolated({ cwd: project, agentDir });
		await expect(logoutAccount(withProject, authStorage, accountA)).rejects.toBeInstanceOf(AccountAdminError);
		expect(withProject.getGlobalSettings().auth).toEqual({ accountPolicies: [userPolicy] });
		expect(authStorage.sessions.accounts("anthropic")).toHaveLength(2);
	});

	it("writes priority and reserve, and unpins the nearest pinned project from a subdirectory", async () => {
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		const accountA = resolveAccount(authStorage, "a@example.com");
		setAccountPriority(settings, authStorage, accountA, -5);
		setAccountReserve(settings, authStorage, accountA, 20);
		labelAccount(settings, authStorage, accountA, "work");
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "anthropic", account: { accountId: "acc-a" }, priority: -5, reservePct: 20, name: "work" },
		]);

		pinProjectAccount(settings, authStorage, project, "work");
		const nested = path.join(project, "src");
		expect(pinProjectAccount(settings, authStorage, nested, "work").projectDir).toBe(fs.realpathSync(project));
		const result = unpinProjectAccount(settings, nested);
		expect(result.removed).toBe(1);
		expect(projectAccountPin(settings, nested, "anthropic")).toBeUndefined();
	});

	it("exits with status 1 on a rejected CLI action and prints list JSON", async () => {
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		const context = { settings, authStorage, cwd: project };
		const stdout: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		try {
			await runAccountCommand({ action: "list", json: true }, context);
			const rows = JSON.parse(stdout.join("")) as Array<Record<string, unknown>>;
			expect(rows.map(row => [row.provider, row.label, row.keyFingerprint, row.projectPinned])).toEqual([
				["anthropic", "a@example.com", null, false],
				["anthropic", "b@example.com", null, false],
			]);
			expect(process.exitCode).toBe(previousExitCode);

			await runAccountCommand({ action: "label", target: "nobody@example.com", value: "x" }, context);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
			vi.restoreAllMocks();
		}
	});

	it("lists account limits with their counted usage and reset in JSON", async () => {
		setSystemTime(new Date(2026, 9, 7, 15, 0));
		try {
			const storage = await AgentStorage.open(tempDir.join("limits.db"));
			const day = { type: "calendar", period: "day" };
			const settings = Settings.isolated(
				{
					auth: {
						accountPolicies: [
							{
								provider: "anthropic",
								account: { accountId: "acc-a" },
								limits: [
									{ metric: "requests", max: 5, window: day },
									{ metric: "usage", max: 0.8 },
								],
							},
						],
					},
				},
				{ storage },
			);
			storage.usageLedger.record({
				atMs: Date.now(),
				provider: "anthropic",
				model: "claude",
				account: "acc-a",
				costNanos: 0,
				inputTokens: 1,
				outputTokens: 1,
			});
			const stdout: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
				stdout.push(String(chunk));
				return true;
			});
			await runAccountCommand({ action: "list", json: true }, { settings, authStorage, cwd: project });
			const rows = JSON.parse(stdout.join("")) as Array<{ label: string; limits: unknown[] }>;
			expect(rows.find(row => row.label === "a@example.com")?.limits).toEqual([
				{ metric: "requests", max: 5, used: 1, window: day, resetsAt: new Date(2026, 9, 8).getTime() },
				{ metric: "usage", max: 0.8, used: null, window: null, resetsAt: null },
			]);
			expect(rows.find(row => row.label === "b@example.com")?.limits).toEqual([]);
		} finally {
			setSystemTime();
			vi.restoreAllMocks();
		}
	});

	it("saves one drain target per provider", async () => {
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		setAccountDrain(settings, authStorage, "anthropic", resolveAccount(authStorage, "a@example.com"));
		setAccountDrain(settings, authStorage, "anthropic", resolveAccount(authStorage, "b@example.com"));
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "anthropic", account: { accountId: "acc-b" }, drain: true },
		]);
		setAccountDrain(settings, authStorage, "anthropic", undefined);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
	});

	it("keeps a drain target's spend and returnWhen on re-save and drops them when the drain moves", async () => {
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		const a = resolveAccount(authStorage, "a@example.com");
		setAccountDrain(settings, authStorage, "anthropic", a, { spend: ["credits"], returnWhen: "credits-added" });
		setAccountDrain(settings, authStorage, "anthropic", a);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{
				provider: "anthropic",
				account: { accountId: "acc-a" },
				drain: true,
				spend: ["credits"],
				returnWhen: "credits-added",
			},
		]);
		setAccountDrain(settings, authStorage, "anthropic", resolveAccount(authStorage, "b@example.com"));
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "anthropic", account: { accountId: "acc-b" }, drain: true },
		]);
		expect(() => setAccountDrain(settings, authStorage, "anthropic", a, { returnWhen: ["money-available"] })).toThrow(
			/requires spend to include money/,
		);
		setAccountDrain(settings, authStorage, "anthropic", a, { spend: ["credits"], returnWhen: "credits-added" });
		setAccountDrain(settings, authStorage, "anthropic", a, { spend: ["plan"], returnWhen: ["reset"] });
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "anthropic", account: { accountId: "acc-a" }, drain: true },
		]);
	});
});
