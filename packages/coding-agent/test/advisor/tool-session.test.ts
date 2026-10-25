import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { isolateAdvisorToolSession } from "@oh-my-pi/pi-coding-agent/advisor/tool-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-advisor-tool-session-");
});

afterEach(() => {
	tempDir.removeSync();
});

function primaryToolSession(registry: AgentRegistry): ToolSession {
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated(),
		taskDepth: 1,
		getSessionFile: () => null,
		getSessionId: () => `primary-${tempDir.path()}`,
		getSessionSpawns: () => "*",
		getAgentId: () => "Worker",
		agentRegistry: registry,
		enableIrc: true,
	};
}

function advisorToolSession(primary: ToolSession): ToolSession {
	return isolateAdvisorToolSession({
		...primary,
		getAgentId: () => "advisor",
		getSessionId: () => `${primary.getSessionId?.()}-advisor`,
	});
}

describe("advisor peer isolation", () => {
	it("preserves live working-directory and skill-visibility getters while stripping capabilities", () => {
		let cwd = tempDir.path();
		let skillHintVisible = false;
		const primary = primaryToolSession(new AgentRegistry());
		const source: ToolSession = {
			...primary,
			get cwd() {
				return cwd;
			},
			get skillHintVisible() {
				return skillHintVisible;
			},
		};
		const advisor = isolateAdvisorToolSession(source);
		expect(advisor.cwd).toBe(cwd);
		expect(advisor.skillHintVisible).toBe(false);
		cwd = path.join(tempDir.path(), "moved");
		skillHintVisible = true;
		expect(advisor.cwd).toBe(cwd);
		expect(advisor.skillHintVisible).toBe(true);
		expect(advisor.agentRegistry).toBeUndefined();
		expect(advisor.enableIrc).toBe(false);
		expect(primary.agentRegistry).toBeDefined();
		expect(primary.enableIrc).toBe(true);
	});

	it("strips frozen capability properties and copies only the memory binding fields", () => {
		const primary = primaryToolSession(new AgentRegistry());
		const memoryContext = { settings: primary.settings, agentRegistry: primary.agentRegistry };
		const source = Object.freeze({ ...primary, memoryContext });
		const advisor = isolateAdvisorToolSession(source);
		expect(advisor.agentRegistry).toBeUndefined();
		expect(advisor.enableIrc).toBe(false);
		expect(advisor.memoryContext).not.toBe(memoryContext);
		expect(Object.keys(advisor.memoryContext ?? {}).sort()).toEqual([
			"getMnemopiSessionState",
			"isDisposed",
			"settings",
		]);
		expect(source.agentRegistry).toBe(primary.agentRegistry);
		expect(source.enableIrc).toBe(true);
	});

	it("preserves private-field memory receivers and live settings without restoring capabilities", async () => {
		const primary = primaryToolSession(new AgentRegistry());
		class MemoryContext {
			#settings = Settings.isolated({ "memory.backend": "mnemopi" });
			#disposed = false;
			#state: MnemopiSessionState | undefined;
			agentRegistry = primary.agentRegistry;

			get settings() {
				return this.#settings;
			}

			set settings(settings: Settings) {
				this.#settings = settings;
			}

			getMnemopiSessionState() {
				return this.#state;
			}

			isDisposed() {
				return this.#disposed;
			}

			dispose() {
				this.#disposed = true;
			}
		}
		const memoryContext = new MemoryContext();
		const advisor = isolateAdvisorToolSession({ ...primary, memoryContext });
		const scopedMemory = advisor.memoryContext;
		expect(scopedMemory).not.toBe(memoryContext);
		expect(scopedMemory?.getMnemopiSessionState?.()).toBeUndefined();
		expect(scopedMemory?.isDisposed?.()).toBe(false);
		expect(scopedMemory?.settings).toBe(memoryContext.settings);
		expect(Object.keys(scopedMemory ?? {}).sort()).toEqual(["getMnemopiSessionState", "isDisposed", "settings"]);
		expect(advisor.agentRegistry).toBeUndefined();
		expect(advisor.enableIrc).toBe(false);
		const read = new ReadTool(advisor);
		await expect(read.execute("class-memory", { path: "memory://root" })).rejects.toThrow("active backend: mnemopi");
		memoryContext.settings = Settings.isolated({ "memory.backend": "hindsight" });
		expect(scopedMemory?.settings).toBe(memoryContext.settings);
		await expect(read.execute("updated-memory", { path: "memory://root" })).rejects.toThrow(
			"active backend: hindsight",
		);
		memoryContext.dispose();
		expect(scopedMemory?.isDisposed?.()).toBe(true);
		await expect(read.execute("disposed-class-memory", { path: "memory://root" })).rejects.toThrow(
			"Unknown protocol: memory://",
		);
	});

	it.each(["hindsight", "mnemopi"])("keeps memory reads bound to %s without a peer registry", async backend => {
		let disposed = false;
		const primary = primaryToolSession(new AgentRegistry());
		primary.settings = Settings.isolated({ "memory.backend": backend });
		primary.isDisposed = () => disposed;
		const advisor = advisorToolSession(primary);
		const read = new ReadTool(advisor);
		await expect(read.execute("advisor-memory", { path: "memory://root" })).rejects.toThrow(
			`active backend: ${backend}`,
		);
		expect(advisor.agentRegistry).toBeUndefined();
		expect(advisor.memoryContext?.settings).toBe(primary.settings);
		disposed = true;
		await expect(read.execute("disposed-memory", { path: "memory://root" })).rejects.toThrow(
			"Unknown protocol: memory://",
		);
	});

	it("refuses direct and broadcast writes without delivery while primary peer writes work", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const bus = new IrcBus(registry, lifecycle);
		const busLookup = spyOn(IrcBus, "global").mockReturnValue(bus);
		const delivered: IrcMessage[] = [];
		const recipient = {
			deliverIrcMessage: async (message: IrcMessage) => {
				delivered.push(message);
				return "injected";
			},
		} as unknown as AgentSession;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: recipient, sessionFile: null });
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: recipient,
			sessionFile: null,
		});
		try {
			const primary = primaryToolSession(registry);
			const advisor = advisorToolSession(primary);
			expect(advisor.agentRegistry).toBeUndefined();
			expect(advisor.enableIrc).toBe(false);
			const write = new WriteTool(advisor);
			for (const target of ["agent://Main", "agent://all"]) {
				await expect(write.execute("advisor-send", { path: target, content: "advisor message" })).rejects.toThrow(
					"Peer messaging is unavailable in this session.",
				);
			}
			expect(delivered).toHaveLength(0);

			const result = await new WriteTool(primary).execute("primary-send", {
				path: "agent://Main",
				content: "primary message",
			});
			expect(result.isError).toBe(false);
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toMatchObject({ from: "Worker", to: "Main", body: "primary message" });
		} finally {
			busLookup.mockRestore();
			await lifecycle.dispose();
		}
	});

	it("does not recover a primary-bound write through either eval lookup", async () => {
		const primary = primaryToolSession(new AgentRegistry());
		const write = new WriteTool(primary);
		const bridgedWrite = write as AgentTool;
		const lookup = () => bridgedWrite;
		primary.getToolByName = lookup;
		primary.getToolForEvalBridge = lookup;
		primary.getEvalBridgeToolNames = () => ["write"];
		primary.toolRegistry = new Map([["write", write]]);
		const advisor = advisorToolSession(primary);

		expect(advisor.getToolByName).toBeUndefined();
		expect(advisor.getToolForEvalBridge).toBeUndefined();
		expect(advisor.getEvalBridgeToolNames).toBeUndefined();
		expect(advisor.toolRegistry).toBeUndefined();
		const execute = spyOn(write, "execute");
		try {
			await expect(
				callSessionTool("write", { path: "agent://Main", content: "bridged message" }, { session: advisor }),
			).rejects.toThrow("Unknown tool from js runtime: write");
			expect(execute).not.toHaveBeenCalled();
			expect(primary.getToolByName?.("write")).toBe(bridgedWrite);
			expect(primary.getToolForEvalBridge?.("write")).toBe(bridgedWrite);
		} finally {
			execute.mockRestore();
		}
	});

	it("preserves explicitly granted filesystem writes and read-only investigation", async () => {
		const primary = primaryToolSession(new AgentRegistry());
		const advisor = advisorToolSession(primary);
		const target = path.join(tempDir.path(), "advisor-output.txt");
		const write = await new WriteTool(advisor).execute("advisor-file", {
			path: target,
			content: "review evidence\n",
		});
		expect(write.isError).toBeUndefined();
		expect(await Bun.file(target).text()).toBe("review evidence\n");
		const read = await new ReadTool(advisor).execute("advisor-read", { path: target });
		expect(read.isError).toBeUndefined();
		expect(JSON.stringify(read.content)).toContain("review evidence");
		expect(primary.agentRegistry).toBeDefined();
		expect(primary.enableIrc).toBe(true);
	});
});
