import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const PROVIDER = "affinity-provider";
const COLD = `${PROVIDER}/cold-model`;
const WARM = `${PROVIDER}/warm-model`;

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

/** A provider whose every response reports a prompt-cache write. */
const provider: ExtensionFactory = pi => {
	const model = (id: string) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 128000,
		maxTokens: 8192,
		promptCache: { short: 300 },
	});
	pi.registerProvider(PROVIDER, {
		baseUrl: "https://affinity.example.com/v1",
		apiKey: "AFFINITY_KEY",
		api: "affinity-test-api",
		streamSimple: (streamModel: Model) => {
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: streamModel.api,
				provider: streamModel.provider,
				model: streamModel.id,
				usage: {
					input: 10,
					output: 2,
					cacheRead: 0,
					cacheWrite: 4000,
					totalTokens: 4012,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		},
		models: [model("cold-model"), model("warm-model")],
	});
};

/** A `priority` pool trying the cold model first, with cache affinity. */
const affinityPool = {
	strategy: "priority",
	strategyOptions: { order: ["cold", "warm"] },
	models: { cold: { model: COLD }, warm: { model: WARM } },
	routing: { cache: { affinity: true } },
};

const ROLES = ["engineer", "reviewer", "planner", "designer", "architect"];

/** A session on the warm model whose roles each hold {@link affinityPool}, and a pick of one role. */
async function startSession(): Promise<{ session: AgentSession; pick(role: string): Promise<string | undefined> }> {
	tempDir = TempDir.createSync("@omp-cache-affinity-");
	authStorage = createInMemoryAuthStorage();
	({ session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		// Each check reads its own role, so no pick kept from an earlier check answers it.
		settings: Settings.isolated({
			"retry.enabled": false,
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			modelRoles: Object.fromEntries(ROLES.map(role => [role, affinityPool])),
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: [],
		extensions: [provider],
		modelPattern: WARM,
		cacheWarming: false,
	}));
	const current = session;
	return {
		session: current,
		pick: async role => {
			const resolved = await current.resolveRoleModelAsync(role);
			return resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined;
		},
	};
}

async function turn(current: AgentSession, text: string): Promise<void> {
	await current.prompt(text);
	await current.waitForIdle();
}

it("prefers the member a session turn left warm, and forgets it on a new or switched session", async () => {
	const { session: current, pick } = await startSession();
	expect(await pick("engineer")).toBe(COLD);

	await turn(current, "hello");
	expect(await pick("reviewer")).toBe(WARM);

	await current.newSession();
	expect(await pick("planner")).toBe(COLD);

	const target = SessionManager.create(tempDir!.path(), tempDir!.path());
	target.appendMessage({ role: "user", content: "target", timestamp: 1 });
	await target.flush();
	const targetFile = target.getSessionFile();
	await target.close();
	await turn(current, "again");
	expect(await pick("designer")).toBe(WARM);
	expect(await current.switchSession(targetFile!)).toBe(true);
	expect(await pick("architect")).toBe(COLD);
});

it("keeps warmth across a branch and forgets it once compaction rewrites the prompt", async () => {
	const { session: current, pick } = await startSession();
	await turn(current, "first");
	await turn(current, "second");
	const secondPrompt = current.sessionManager
		.getEntries()
		.findLast(entry => entry.type === "message" && entry.message.role === "user");
	expect((await current.branch(secondPrompt!.id)).cancelled).toBe(false);
	expect(await pick("engineer")).toBe(WARM);

	await turn(current, "third");
	await current.compact();
	expect(await pick("reviewer")).toBe(COLD);
});
