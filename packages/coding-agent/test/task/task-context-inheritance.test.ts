import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { getAgentDir } from "@oh-my-pi/pi-utils";

describe("Task context inheritance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	for (const inherited of [true, false, undefined]) {
		const title =
			inherited === false
				? "excludes user and project AGENTS.md when inheritance is false"
				: `includes only user AGENTS.md when inheritance is ${inherited ?? "absent"}`;
		it(title, async () => {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [{ name: "task", description: "Task", systemPrompt: "Task", source: "bundled" }],
				projectAgentsDir: null,
			});
			let childPrompt: string[] = [];
			vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				childPrompt = (
					await buildSystemPrompt({
						cwd: options.cwd,
						contextFiles: options.contextFiles,
						skills: [],
						workspaceTree: {
							rootPath: options.cwd,
							rendered: "",
							truncated: false,
							totalLines: 0,
							agentsMdFiles: [],
						},
					})
				).systemPrompt;
				return {
					index: 0,
					id: options.id,
					agent: "task",
					agentSource: "bundled",
					task: options.task,
					exitCode: 0,
					output: "Finished",
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: 0,
					requests: 0,
				};
			});
			const cwd = path.join(getAgentDir(), "project");
			const session = {
				cwd,
				hasUI: false,
				settings: Settings.isolated({
					"async.enabled": false,
					...(inherited === undefined ? {} : { "task.inheritUserAgentsMd": inherited }),
				}),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				contextFiles: [
					{ path: path.join(getAgentDir(), "AGENTS.md"), content: "USER_CONTEXT_SENTINEL" },
					{ path: path.join(cwd, "AGENTS.md"), content: "PROJECT_CONTEXT_SENTINEL" },
					{ path: path.join(cwd, "nested", "agents.md"), content: "DIRECTORY_CONTEXT_SENTINEL" },
					{ path: path.join(cwd, "CLAUDE.md"), content: "OTHER_CONTEXT_SENTINEL" },
				],
			} as unknown as ToolSession;
			const tool = await TaskTool.create(session);
			await tool.execute("inheritance", {
				agent: "task",
				name: "ContextChild",
				task: "Inspect context",
			} as TaskParams);
			const text = childPrompt.join("\n");
			if (inherited === false) {
				expect(text).not.toContain("USER_CONTEXT_SENTINEL");
			} else {
				expect(text).toContain("USER_CONTEXT_SENTINEL");
			}
			expect(text).not.toContain("PROJECT_CONTEXT_SENTINEL");
			expect(text).not.toContain("DIRECTORY_CONTEXT_SENTINEL");
			expect(text).toContain("OTHER_CONTEXT_SENTINEL");
		});
	}
});
