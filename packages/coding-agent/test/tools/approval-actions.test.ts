import { describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { cfgTaskAgentApproval } from "../../src/task/settings";
import type { ToolSession } from "../../src/tools";
import { formatApprovalPrompt, resolveApproval } from "../../src/tools/approval";
import { mcpApprovalActions, validateApprovalPolicyKeys } from "../../src/tools/approval-actions";
import { GithubTool } from "../../src/tools/gh";
import { cfgToolsApproval } from "../../src/tools/settings";
import { TodoTool } from "../../src/tools/todo";
import { WriteTool } from "../../src/tools/write";
import type { XdevState } from "../../src/tools/xdev";

const github = new GithubTool({} as ToolSession);
const create = { op: "pr_create" };
const watch = { op: "run_watch" };

describe("exact action approval policies", () => {
	it("enforces todo action policies globally and per agent without authorizing other operations", () => {
		const todo = new TodoTool({} as ToolSession);
		const drop = { op: "drop", task: "task" };
		const view = { op: "view" };
		for (const policy of ["allow", "prompt", "deny"] as const) {
			expect(resolveApproval(todo, drop, "yolo", { "todo:drop": policy }).policy).toBe(policy);
			expect(resolveApproval(todo, drop, "yolo", {}, undefined, { "todo:drop": policy }).policy).toBe(policy);
		}
		expect(resolveApproval(todo, view, "yolo", { "todo:drop": "deny" }).policy).toBe("allow");
		expect(resolveApproval(todo, view, "yolo", { todo: "prompt" }, undefined, { "todo:view": "allow" }).policy).toBe(
			"allow",
		);
		expect(resolveApproval(todo, drop, "yolo", { todo: "prompt" }, undefined, { "todo:view": "allow" }).policy).toBe(
			"prompt",
		);
	});

	it("applies todo action policies to repaired missing-op calls using current todo state", () => {
		let existing = false;
		const todo = new TodoTool({
			getTodoPhases: () => (existing ? [{ name: "work", tasks: [] }] : []),
		} as unknown as ToolSession);
		const inferredInit = { items: ["task"] };
		expect(resolveApproval(todo, inferredInit, "yolo", { "todo:init": "deny" }).policy).toBe("deny");
		expect(
			resolveApproval(todo, { items: ["task"], phase: "work" }, "yolo", { "todo:append": "prompt" }).policy,
		).toBe("prompt");
		existing = true;
		expect(todo.approvalActions.get(inferredInit)).toBeUndefined();
		expect(todo.approvalActions.get({ list: [{ phase: "work", items: ["task"] }] })).toBe("init");
		expect(todo.approvalActions.get({ task: "task" })).toBeUndefined();
	});

	it("preserves exact restrictive policies for dynamic tool names outside identifier syntax", () => {
		for (const name of ["ns/tool", "ext tool", "@extension", "ext:tool"]) {
			const tool = { name, approval: "exec" as const };
			expect(resolveApproval(tool, {}, "yolo", { [name]: "deny" }).policy).toBe("deny");
			expect(resolveApproval(tool, {}, "yolo", { [name]: "prompt" }).policy).toBe("prompt");
			expect(resolveApproval(tool, {}, "yolo", {}, undefined, { [name]: "deny" }).policy).toBe("deny");
		}
	});

	it("matches bare tool policies for action-bearing tools without action keys", () => {
		for (const policy of ["allow", "deny", "prompt"] as const) {
			const settings = Settings.isolated({ "tools.approval": { github: policy } });
			expect(resolveApproval(github, create, "always-ask", cfgToolsApproval.get(settings))).toMatchObject({
				policy,
				policyKey: "github",
			});
		}
	});

	it("matches only the declared operation and gives action prompts priority over tool allows", () => {
		const policies = { github: "allow", "github:pr_create": "prompt" };
		expect(resolveApproval(github, create, "yolo", policies).policy).toBe("prompt");
		expect(resolveApproval(github, watch, "yolo", policies).policy).toBe("allow");
		expect(resolveApproval(github, create, "always-ask", { "github:run_watch": "allow" }).policy).toBe("prompt");
		expect(resolveApproval(github, create, "yolo", { github: "prompt", "github:pr_create": "allow" }).policy).toBe(
			"allow",
		);
	});

	it("does not let a coarser agent grant override a global action prompt", () => {
		const global = { "github:pr_create": "prompt" };
		const agent = { github: "allow" };
		expect(resolveApproval(github, create, "yolo", global, undefined, agent)).toMatchObject({
			policy: "prompt",
			policyKey: "github:pr_create",
			source: "user",
		});
		expect(resolveApproval(github, watch, "yolo", global, undefined, agent).policy).toBe("allow");
		expect(resolveApproval(github, create, "yolo", global, undefined, { "github:pr_create": "allow" }).policy).toBe(
			"allow",
		);
	});

	it("limits agent action allows and gives agent action prompts priority over bare grants", () => {
		const global = { github: "prompt" };
		const agent = { "github:run_watch": "allow" };
		expect(resolveApproval(github, watch, "yolo", global, undefined, agent).policy).toBe("allow");
		expect(resolveApproval(github, create, "yolo", global, undefined, agent).policy).toBe("prompt");
		expect(
			resolveApproval(github, create, "yolo", {}, undefined, { github: "allow", "github:pr_create": "prompt" })
				.policy,
		).toBe("prompt");
	});

	it("keeps tool and action denies absolute in either source", () => {
		for (const key of ["github", "github:pr_create"]) {
			expect(
				resolveApproval(github, create, "yolo", { [key]: "deny", "github:run_watch": "allow" }, undefined, {
					"github:pr_create": "allow",
				}).policy,
			).toBe("deny");
			expect(
				resolveApproval(github, create, "yolo", { "github:pr_create": "allow" }, undefined, { [key]: "deny" })
					.policy,
			).toBe("deny");
		}
		expect(resolveApproval(github, create, "yolo", { github: "deny", "github:pr_create": "allow" }).policy).toBe(
			"deny",
		);
		expect(
			resolveApproval(github, create, "yolo", {}, undefined, { github: "deny", "github:pr_create": "allow" }).policy,
		).toBe("deny");
		const denied = { ...github, approval: { tier: "exec", policy: "deny" } } satisfies Partial<AgentTool>;
		expect(resolveApproval(denied, create, "yolo", {}, undefined, { "github:pr_create": "allow" }).policy).toBe(
			"deny",
		);
	});

	it("warns about unknown actions in both settings maps and ignores them", () => {
		const warn = spyOn(logger, "warn");
		try {
			const settings = Settings.isolated({
				"tools.approval": { "github:unknown": "allow", github: "prompt" },
				"task.agentApproval": { engineer: { "github:unknown": "allow" } },
			});
			const global = cfgToolsApproval.get(settings);
			const agent = cfgTaskAgentApproval.get(settings).engineer;
			expect(resolveApproval(github, create, "yolo", global, undefined, agent).policy).toBe("prompt");
			expect(
				warn.mock.calls.filter(call => JSON.stringify(call).includes("github:unknown")).length,
			).toBeGreaterThanOrEqual(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("accepts exact action keys through settings and does not infer actions on other tools or bash", () => {
		const settings = Settings.isolated({
			"tools.approval": { "github:run_watch": "allow", "github:pr_create": "prompt" },
			"task.agentApproval": { engineer: { "github:run_watch": "allow" } },
		});
		expect(resolveApproval(github, create, "yolo", cfgToolsApproval.get(settings)).policy).toBe("prompt");
		for (const name of ["read", "bash"]) {
			expect(
				resolveApproval({ name, approval: "exec" }, { op: "run_watch" }, "always-ask", {
					[`${name}:run_watch`]: "allow",
				}).policy,
			).toBe("prompt");
		}
	});

	it("derives MCP actions only from its declared op enum", () => {
		const approvalActions = mcpApprovalActions({
			type: "object",
			properties: { op: { type: "string", enum: ["inspect", "mutate"] } },
		});
		const device = { name: "mcp__server_dispatch", approval: "write", approvalActions } satisfies Partial<AgentTool>;
		expect(
			resolveApproval(device, { op: "inspect" }, "always-ask", { "mcp__server_dispatch:inspect": "allow" }).policy,
		).toBe("allow");
		expect(
			resolveApproval(device, { op: "mutate" }, "always-ask", { "mcp__server_dispatch:inspect": "allow" }).policy,
		).toBe("prompt");
		expect(mcpApprovalActions({ properties: { action: { enum: ["inspect"] } } })).toBeUndefined();
		const warn = spyOn(logger, "warn");
		try {
			validateApprovalPolicyKeys({ "mcp__server_dispatch:unknown": "allow" }, device);
			expect(warn).toHaveBeenCalledWith(
				"Ignoring unknown approval action",
				expect.objectContaining({ action: "unknown" }),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("preserves action keys and intrinsic denies through xd write dispatch", () => {
		const device: AgentTool = {
			name: "github",
			label: "GitHub",
			description: "Dispatcher",
			parameters: type({ op: "string" }),
			approval: "exec",
			approvalActions: github.approvalActions,
			execute: async () => ({ content: [] }),
		};
		const xdev: XdevState = {
			tools: new Map([[device.name, device]]),
			mountedNames: new Set([device.name]),
			isActive: () => false,
			builtInNames: new Set([device.name]),
			resolve: name => (name === device.name ? device : undefined),
		};
		const write = new WriteTool({ cwd: ".", xdev } as ToolSession);
		const args = { path: "xd://github", content: JSON.stringify(create) };
		expect(
			resolveApproval(write, args, "yolo", { "github:pr_create": "prompt" }, undefined, { github: "allow" }),
		).toMatchObject({ policy: "prompt", policyKey: "github:pr_create" });
		expect(resolveApproval(write, args, "yolo", { github: "deny", "github:pr_create": "allow" }).policy).toBe("deny");
		device.approval = { tier: "exec", policy: "deny" };
		expect(resolveApproval(write, args, "yolo", {}, undefined, { "github:pr_create": "allow" }).policy).toBe("deny");
	});

	it("includes the exact action in approval prompts", () => {
		expect(formatApprovalPrompt(github, create)).toContain("Allow tool: github:pr_create");
	});
});
