import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";
import { directoryLayerFile } from "../src/config/directory-layers";
import { cfgAuthAccountPolicies, cfgAuthDisabledAccounts } from "../src/config/model-settings";
import { Settings } from "../src/config/settings";
import { cfgCompactionModelOverrides } from "../src/session/context-settings";
import { cfgDefaultThinkingLevel } from "../src/session/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("settings trust and last-good boundaries", () => {
	let state: SettingsTestState;
	let root: string;
	let agentDir: string;
	let cwd: string;
	const instances: Settings[] = [];

	beforeEach(async () => {
		state = beginSettingsTest();
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "settings-trust-"));
		agentDir = path.join(root, "agent");
		cwd = path.join(root, "project", "nested");
		await fs.promises.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "{}\n");
	});

	afterEach(async () => {
		for (const settings of instances.splice(0)) {
			settings.stopWatching();
			settings.cancelPendingSaves();
		}
		restoreSettingsTestState(state);
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	async function load(configFiles: string[] = []): Promise<Settings> {
		const settings = await Settings.init({ cwd, agentDir, configFiles });
		instances.push(settings);
		return settings;
	}

	// Filesystem events and watcher debounce require the real platform event loop.
	async function waitFor(accept: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (accept()) return;
			await Bun.sleep(30);
		}
		throw new Error("Settings watcher did not update the effective configuration");
	}

	it("project policies cannot authorize saved resets or paid account draining", async () => {
		const trusted: AuthAccountPolicies = [
			{ provider: "anthropic", account: { email: "private@example.com" }, autoRedeem: "unset" },
		];
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ auth: { accountPolicies: trusted } }));
		await Bun.write(
			path.join(cwd, ".omp", "config.yml"),
			YAML.stringify({
				auth: {
					accountPolicies: [
						{
							provider: "anthropic",
							account: { email: "private@example.com" },
							autoRedeem: "yes",
							drain: true,
							spend: ["money"],
						},
					],
				},
			}),
		);
		const warn = vi.spyOn(logger, "warn");
		const settings = await load();
		expect(cfgAuthAccountPolicies.get(settings)).toEqual(trusted);
		expect(warn.mock.calls.some(call => JSON.stringify(call).includes("auth.accountPolicies"))).toBe(true);
	});

	it("child directory writes retain malformed ancestor exclusions and provenance", async () => {
		const file = directoryLayerFile(agentDir, root);
		await Bun.write(file, YAML.stringify({ path: root, auth: { disabledAccounts: ["anthropic/#14"] } }));
		const settings = await load();
		await Bun.write(file, "path: [broken");
		await settings.setDirectoryValue(cwd, cfgDefaultThinkingLevel, "high");
		expect(cfgAuthDisabledAccounts.get(settings)).toEqual(["anthropic/#14"]);
		expect(settings.getProvenanceDirectory(cfgAuthDisabledAccounts)).toBe(root);
		expect(String(cfgDefaultThinkingLevel.get(settings))).toBe("high");
	});

	async function fullOverrides(): Promise<void> {
		const modelOverrides = Object.fromEntries(
			Array.from({ length: 256 }, (_, index) => [`test/model-${index}`, { reserveTokens: 1 }]),
		);
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ compaction: { modelOverrides } }));
	}

	it("directory writes reject merged overflow before changing the file", async () => {
		await fullOverrides();
		const file = directoryLayerFile(agentDir, cwd);
		await Bun.write(file, YAML.stringify({ path: cwd }));
		const settings = await load();
		const before = await Bun.file(file).text();
		await expect(
			settings.setDirectoryValue(cwd, cfgCompactionModelOverrides, { "test/extra": { reserveTokens: 1 } }),
		).rejects.toThrow("256");
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("watch reload retains last-good directory state when merged overrides overflow", async () => {
		await fullOverrides();
		const settings = await load();
		settings.startWatching();
		await Bun.sleep(300);
		const warn = vi.spyOn(logger, "warn");
		await Bun.write(
			directoryLayerFile(agentDir, cwd),
			YAML.stringify({ path: cwd, compaction: { modelOverrides: { "test/extra": { reserveTokens: 1 } } } }),
		);
		await waitFor(
			() =>
				warn.mock.calls.some(call => JSON.stringify(call).includes("256")) ||
				Object.keys(cfgCompactionModelOverrides.get(settings)).length > 256,
		);
		expect(Object.keys(cfgCompactionModelOverrides.get(settings))).toHaveLength(256);
		expect(settings.getLayerValues(cfgCompactionModelOverrides).some(value => value.source === "directory")).toBe(
			false,
		);
	});

	it("watcher follows replacement config directories and their subsequent edits", async () => {
		const dir = path.join(root, "overlay");
		const file = path.join(dir, "config.yml");
		await Bun.write(file, "defaultThinkingLevel: low\n");
		const settings = await load([file]);
		settings.startWatching();
		await Bun.sleep(300);
		await fs.promises.rename(dir, `${dir}-old`);
		await Bun.write(file, "defaultThinkingLevel: high\n");
		await waitFor(() => cfgDefaultThinkingLevel.get(settings) === "high");
		await Bun.write(file, "defaultThinkingLevel: medium\n");
		await waitFor(() => cfgDefaultThinkingLevel.get(settings) === "medium");
	});
});
