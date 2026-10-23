import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "./builtin-names";

function actions(field: "op" | "action", names: readonly string[]): NonNullable<AgentTool["approvalActions"]> {
	return {
		names,
		get: args => {
			const value = isRecord(args) ? args[field] : undefined;
			return typeof value === "string" && names.includes(value) ? value : undefined;
		},
	};
}

export const builtinApprovalActions = {
	github: actions("op", [
		"repo_view",
		"file_read",
		"pr_create",
		"pr_checkout",
		"pr_push",
		"search_issues",
		"search_prs",
		"search_code",
		"search_commits",
		"search_repos",
		"run_watch",
	]),
	debug: actions("action", [
		"launch",
		"attach",
		"set_breakpoint",
		"remove_breakpoint",
		"set_instruction_breakpoint",
		"remove_instruction_breakpoint",
		"data_breakpoint_info",
		"set_data_breakpoint",
		"remove_data_breakpoint",
		"continue",
		"step_over",
		"step_in",
		"step_out",
		"pause",
		"evaluate",
		"stack_trace",
		"threads",
		"scopes",
		"variables",
		"disassemble",
		"read_memory",
		"write_memory",
		"modules",
		"loaded_sources",
		"custom_request",
		"output",
		"terminate",
		"sessions",
	]),
	ida: actions("action", ["list", "open", "save", "close", "exec", "rename", "comment", "set_type", "make_function"]),
	lsp: actions("action", [
		"diagnostics",
		"definition",
		"references",
		"hover",
		"symbols",
		"rename",
		"rename_file",
		"code_actions",
		"type_definition",
		"implementation",
		"status",
		"reload",
		"capabilities",
		"request",
	]),
	security_scan: actions("action", [
		"preflight",
		"start",
		"status",
		"cancel",
		"validate",
		"cloud_scans",
		"cloud_start",
		"cloud_status",
		"cloud_pull",
	]),
	manage_skill: actions("action", ["create", "update", "delete"]),
	memory_edit: actions("op", ["update", "forget", "invalidate"]),
	goal: actions("op", ["create", "get", "complete", "resume", "drop"]),
	todo: actions("op", ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"]),
} satisfies Record<string, NonNullable<AgentTool["approvalActions"]>>;

const knownTools: ReadonlySet<string> = new Set([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES, "browser", "computer"]);
const knownActions: Readonly<Record<string, NonNullable<AgentTool["approvalActions"]>>> = builtinApprovalActions;

export function isApprovalPolicyKey(key: string): boolean {
	const parts = key.split(":");
	const [name, action] = parts;
	if (name && !knownTools.has(name)) return true;
	return Boolean(
		name &&
		parts.length <= 2 &&
		parts.every(part => /^[\w.-]+$/.test(part)) &&
		(action === undefined || !knownTools.has(name) || knownActions[name]?.names.includes(action)),
	);
}

/** Warn about malformed keys and unknown actions of built-in tools. Dynamic tool names remain valid. */
export function validateApprovalPolicyKeys(
	value: Record<string, unknown>,
	tool?: Pick<AgentTool, "name" | "approvalActions">,
): void {
	for (const key of Object.keys(value)) {
		const parts = key.split(":");
		const [name, action] = parts;
		if (tool && name !== tool.name) continue;
		if (!isApprovalPolicyKey(key) && (action === undefined || parts.length !== 2)) {
			logger.warn("Ignoring invalid approval policy key", { key });
		} else if (
			action !== undefined &&
			((tool && !tool.approvalActions?.names.includes(action)) ||
				(knownTools.has(name) && !knownActions[name]?.names.includes(action)))
		) {
			logger.warn("Ignoring unknown approval action", { key, tool: name, action });
		}
	}
}

/** MCP dispatchers expose their operation through an enumerated `op` schema. */
export function mcpApprovalActions(schema: unknown): AgentTool["approvalActions"] {
	if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
	const op = schema.properties.op;
	if (!isRecord(op) || !Array.isArray(op.enum) || !op.enum.every(value => typeof value === "string")) return undefined;
	return actions("op", op.enum);
}
