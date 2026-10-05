import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { memberAccount, projectAccountPin } from "@oh-my-pi/pi-coding-agent/session/account-pins";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("project account pins", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-account-pins-");
		agentDir = tempDir.join("agent");
		project = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("resolves the nearest pinned ancestor from user config and ignores pins in project settings", async () => {
		const nested = path.join(project, "packages", "app");
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				auth: { accountPins: { [project]: { anthropic: "work" }, [nested]: { anthropic: "client" } } },
			}),
		);
		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "settings.json"),
			JSON.stringify({ auth: { accountPins: { [project]: { anthropic: "intruder", openai: "intruder" } } } }),
		);
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });

		expect(projectAccountPin(settings, project, "anthropic")).toBe("work");
		expect(projectAccountPin(settings, path.join(nested, "src"), "anthropic")).toBe("client");
		expect(projectAccountPin(settings, project, "openai")).toBeUndefined();
	});

	it("ignores a pool member account set in project settings and honors the same value from user config", async () => {
		const group = { strategy: "random", models: { opus: { model: "anthropic/claude-opus-4-5", account: "work" } } };
		const projectSettings = path.join(getProjectAgentDir(project), "settings.json");
		fs.writeFileSync(projectSettings, JSON.stringify({ modelGroups: { fast: group } }));
		const fromProject = await Settings.loadIsolated({ cwd: project, agentDir });
		expect(memberAccount(fromProject, "anthropic", "claude-opus-4-5")).toBeUndefined();

		fs.rmSync(projectSettings);
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify({ modelGroups: { fast: group } }));
		const fromUser = await Settings.loadIsolated({ cwd: project, agentDir });
		expect(memberAccount(fromUser, "anthropic", "claude-opus-4-5")).toBe("work");
	});
});
