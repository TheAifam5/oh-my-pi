import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { registerMockApi, createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { ApprovalRelayHost } from "../../src/task/approval-relay";
import type { ExtensionApprovalAnswer, ExtensionApprovalPrompt } from "../../src/extensibility/extensions/types";
import type { ToolSession } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";
import { VibeSessionRegistry } from "../../src/vibe/runtime";
import type { VibeCli } from "@oh-my-pi/pi-tui/tools/vibe";
import { TempDir, setAgentDir, getAgentDir } from "@oh-my-pi/pi-utils";

const source = "vibe-approval-fixture";
const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
	VibeSessionRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(source);
	vi.restoreAllMocks();
});

async function harness(
	cli: VibeCli,
	approve: (prompt: ExtensionApprovalPrompt) => Promise<ExtensionApprovalAnswer>,
	policy?: "allow" | "deny" | "prompt",
) {
	const dir = TempDir.createSync("@omp-vibe-approval-");
	const previous = getAgentDir();
	setAgentDir(dir.join("agent"));
	disposers.push(() => {
		setAgentDir(previous);
		dir.removeSync();
	});
	registerMockApi(source);
	const auth = await AuthStorage.create(dir.join("auth.db"));
	disposers.push(() => auth.close());
	auth.keys.setRuntime("mock", "fixture-key");
	const marker = path.resolve(dir.join("tool-ran"));
	let requests = 0;
	const mock = createMockModel({
		provider: "mock",
		id: "vibe-approval",
		handler: () => {
			requests++;
			return requests === 1
				? {
						content: [{ type: "toolCall", name: "bash", arguments: { command: `printf approved >> ${marker}` } }],
						stopReason: "toolUse",
					}
				: {
						content: [
							{ type: "toolCall", name: "yield", arguments: { type: "result", data: "Worker finished." } },
						],
						stopReason: "toolUse",
					};
		},
	});
	const models = new ModelRegistry(auth, dir.join("models.yml"));
	const find = models.find.bind(models);
	vi.spyOn(models, "find").mockImplementation((provider, id) =>
		provider === mock.provider && id === mock.id ? mock : find(provider, id),
	);
	const hasProvider = models.hasProvider.bind(models);
	vi.spyOn(models, "hasProvider").mockImplementation(provider => provider === mock.provider || hasProvider(provider));
	const available = models.getAvailable.bind(models);
	vi.spyOn(models, "getAvailable").mockImplementation(kind => [mock, ...available(kind)]);
	const bus = new EventBus();
	const host = new ApprovalRelayHost(bus, () => ({ approve, select: async () => undefined }));
	disposers.push(() => host.dispose());
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const settings = Settings.isolated({
		modelRoles: { default: "mock/vibe-approval", task: "mock/vibe-approval", smol: "mock/vibe-approval" },
		"task.agentApproval": policy ? { [cli === "fast" ? "sonic" : "task"]: { bash: policy } } : {},
		"tools.approval": { bash: "prompt" },
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"task.structured": false,
		"compaction.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"retry.enabled": false,
		"bash.autoBackground.enabled": false,
	});
	const sessionManager = SessionManager.inMemory(dir.path());
	const parent = {
		cwd: dir.path(),
		settings,
		authStorage: auth,
		modelRegistry: models,
		asyncJobManager: manager,
		subagentEventBus: bus,
		sessionManager,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getAgentId: () => "Main",
		taskDepth: 0,
		enableLsp: false,
		skills: [],
		contextFiles: [],
		rules: [],
		promptTemplates: [],
		extensionPaths: [],
		preparedExtensions: [],
		customToolPaths: [],
	} as unknown as ToolSession;
	const registry = VibeSessionRegistry.global();
	disposers.push(async () => {
		await registry.killAll(parent);
	});
	return { dir, marker, parent, registry, host, bus, manager, cli };
}

describe("real vibe worker approvals", () => {
	it("vibe_spawn worker relays to the root with its id and executes only after approval", async () => {
		const opened = Promise.withResolvers<ExtensionApprovalPrompt>();
		const answer = Promise.withResolvers<ExtensionApprovalAnswer>();
		const h = await harness("fast", prompt => {
			opened.resolve(prompt);
			return answer.promise;
		});
		await h.registry.spawn(h.parent, { cli: h.cli, name: "FastWorker", prompt: "Run the fixture command once." });
		const prompt = await opened.promise;
		expect(prompt.full).toContain("FastWorker (sonic)");
		expect(await Bun.file(h.marker).exists()).toBe(false);
		answer.resolve("once");
		await h.registry.wait(h.parent, { timeoutMs: 30000 });
		expect(await Bun.file(h.marker).text()).toBe("approved");
	}, 30000);

	it("vibe_spawn denial refuses the worker tool", async () => {
		let prompts = 0;
		const h = await harness("good", async () => {
			prompts++;
			return "deny";
		});
		await h.registry.spawn(h.parent, { cli: h.cli, name: "GoodWorker", prompt: "Run the fixture command once." });
		await h.registry.wait(h.parent, { timeoutMs: 30000 });
		expect(prompts).toBe(1);
		expect(await Bun.file(h.marker).exists()).toBe(false);
	}, 30000);

	for (const cli of ["fast", "good"] as const) {
		it(`vibe_spawn ${cli} honors its bundled agent allow policy`, async () => {
			let prompts = 0;
			const h = await harness(
				cli,
				async () => {
					prompts++;
					return "deny";
				},
				"allow",
			);
			await h.registry.spawn(h.parent, { cli, name: "AllowedWorker", prompt: "Run the fixture command once." });
			await h.registry.wait(h.parent, { timeoutMs: 30000 });
			expect(prompts).toBe(0);
			expect(await Bun.file(h.marker).text()).toBe("approved");
		}, 30000);
	}

	for (const kind of ["kill", "exit"] as const) {
		it(`vibe ${kind} aborts an open approval and a late approve never executes`, async () => {
			const opened = Promise.withResolvers<void>();
			const dismissed = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<ExtensionApprovalAnswer>();
			const h = await harness("fast", async () => {
				opened.resolve();
				return answer.promise;
			});
			const originalUI = h.host.getUI;
			vi.spyOn(h.host, "getUI").mockImplementation(() => ({
				...originalUI(),
				select: async () => undefined,
				approve: (prompt, options) => {
					options?.signal?.addEventListener("abort", () => dismissed.resolve(), { once: true });
					return originalUI()!.approve!(prompt, options);
				},
			}));
			await h.registry.spawn(h.parent, {
				cli: h.cli,
				name: "CancelledWorker",
				prompt: "Run the fixture command once.",
			});
			await opened.promise;
			if (kind === "kill") await h.registry.kill(h.parent, "CancelledWorker");
			else await h.registry.killAll(h.parent);
			await dismissed.promise;
			answer.resolve("once");
			expect(await Bun.file(h.marker).exists()).toBe(false);
		}, 30000);
	}
});
