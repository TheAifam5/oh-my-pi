import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { customToolToDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveToolReplayClass } from "@oh-my-pi/pi-coding-agent/tools/approval";

function createSession(): ToolSession {
	const sessionManager = SessionManager.inMemory();
	return {
		cwd: process.cwd(),
		hasUI: true,
		settings: Settings.isolated(),
		sessionManager,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		skipPythonPreflight: true,
	};
}

describe("tool replay classification", () => {
	it("every constructible built-in declares an explicit replay class", async () => {
		const session = createSession();
		const unclassified: string[] = [];
		const constructed: string[] = [];
		for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
			const tool = await factory(session);
			if (!tool) continue;
			constructed.push(name);
			if (typeof tool.replay !== "string" && typeof tool.replay !== "function") unclassified.push(name);
		}
		expect(constructed).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "glob", "think"]));
		expect(unclassified).toEqual([]);
	});

	it("classifies local reads as safe and URL reads, mutations, and execution as unsafe", async () => {
		const session = createSession();
		const read = await BUILTIN_TOOLS.read(session);
		const bash = await BUILTIN_TOOLS.bash(session);
		const grep = await BUILTIN_TOOLS.grep(session);
		const webSearch = await BUILTIN_TOOLS.web_search(session);

		expect(resolveToolReplayClass(read ?? undefined, { path: "README.md" })).toBe("safe");
		expect(resolveToolReplayClass(read ?? undefined, { path: "https://example.com/page" })).toBe("unsafe");
		expect(resolveToolReplayClass(grep ?? undefined, { pattern: "x", paths: ["src"] })).toBe("safe");
		expect(resolveToolReplayClass(grep ?? undefined, { pattern: "x", paths: ["xd://device"] })).toBe("unsafe");
		expect(resolveToolReplayClass(bash ?? undefined, { command: "ls" })).toBe("unsafe");
		expect(resolveToolReplayClass(webSearch ?? undefined, { query: "x" })).toBe("unsafe");
	});

	it("treats extension, MCP, and custom tools as unsafe unless they declare replay safe", () => {
		const base = {
			label: "Custom",
			description: "custom",
			parameters: type({}),
			approval: "read" as const,
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		const undeclared = customToolToDefinition({ ...base, name: "mcp__server__lookup" });
		const declaredSafe = customToolToDefinition({ ...base, name: "custom_lookup", replay: "safe" });
		const throwing = {
			replay: () => {
				throw new Error("broken");
			},
		};

		expect(resolveToolReplayClass(undeclared, {})).toBe("unsafe");
		expect(resolveToolReplayClass(declaredSafe, {})).toBe("safe");
		expect(resolveToolReplayClass(throwing, {})).toBe("unsafe");
		expect(resolveToolReplayClass({ replay: "maybe" }, {})).toBe("unsafe");
		expect(resolveToolReplayClass(undefined, {})).toBe("unsafe");
	});
});
