import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskIsolationMaxBaselineBytes } from "@oh-my-pi/pi-coding-agent/task/settings";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function loadLimit(value?: number): Promise<number> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-settings-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir);
	if (value !== undefined) {
		await Bun.write(path.join(agentDir, "config.yml"), `task:\n  isolation:\n    maxBaselineBytes: ${value}\n`);
	}
	const state = beginSettingsTest();
	try {
		const settings = await Settings.init({ cwd: root, agentDir });
		return cfgTaskIsolationMaxBaselineBytes.get(settings);
	} finally {
		restoreSettingsTestState(state);
	}
}

describe("task isolation baseline limit", () => {
	it("loads absent limits and honors a configured byte budget", async () => {
		expect(await loadLimit()).toBe(1024 * 1024 * 1024);
		expect(await loadLimit(256)).toBe(256);
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid byte budget of %s", async value => {
		await expect(loadLimit(value)).rejects.toThrow("task.isolation.maxBaselineBytes");
	});
});
