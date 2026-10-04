import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	applyDefaultToolsList,
	type DefaultToolsPolicy,
	resolveDefaultToolSelection,
} from "@oh-my-pi/pi-coding-agent/tools/default-tools";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const BUILTINS = new Set(["read", "bash", "edit", "write", "grep", "find", "ask"]);
const isBuiltin: DefaultToolsPolicy = {
	isReplaceable: name => BUILTINS.has(name),
	isProtected: name => name === "ask",
	canSelect: () => true,
};
const BASELINE = ["read", "bash", "edit", "write", "grep", "find", "mcp_docs_search"];

describe("applyDefaultToolsList", () => {
	it("changes the inherited selection when the list holds only +name and -name", () => {
		expect(applyDefaultToolsList(["-bash", "+powershell", "+grep"], ["read", "bash", "edit"], isBuiltin)).toEqual([
			"read",
			"edit",
			"powershell",
			"grep",
		]);
	});

	it("replaces built-in tools with plain names and applies modifiers after them", () => {
		expect(applyDefaultToolsList(["+find", "read", "-read", "grep"], BASELINE, isBuiltin)).toEqual([
			"mcp_docs_search",
			"grep",
			"find",
		]);
	});
});

describe("resolveDefaultToolSelection layering", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-default-tools-");
		agentDir = tempDir.join("agent");
		project = tempDir.join("project");
		for (const dir of [agentDir, project]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	async function settingsWith(global?: unknown, projectList?: unknown): Promise<Settings> {
		if (global !== undefined) {
			await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ defaultTools: global }));
		}
		if (projectList !== undefined) {
			fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
			fs.writeFileSync(
				path.join(getProjectAgentDir(project), "settings.json"),
				JSON.stringify({ defaultTools: projectList }),
			);
		}
		return Settings.init({ cwd: project, agentDir });
	}

	it("keeps the baseline when no layer configures defaultTools", async () => {
		expect(resolveDefaultToolSelection(await settingsWith(), BASELINE, isBuiltin)).toBeUndefined();
	});

	it("lets a project list narrow the user list but not add a tool the user list leaves out", async () => {
		const settings = await settingsWith(["read", "bash"], ["+grep", "-bash"]);

		expect(resolveDefaultToolSelection(settings, BASELINE, isBuiltin)).toEqual(["mcp_docs_search", "read"]);
	});

	it("lets a user -name win over a project +name", async () => {
		const settings = await settingsWith(["-bash"], ["+bash"]);

		expect(resolveDefaultToolSelection(settings, BASELINE, isBuiltin)).not.toContain("bash");
	});
});
