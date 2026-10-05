import { afterEach, expect, it } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { completeSimple } from "@oh-my-pi/pi-ai/stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { flushBackgroundUsage } from "@oh-my-pi/pi-coding-agent/session/stream-usage-observer";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let root: TempDir | undefined;
let registry: ModelRegistry | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	registry?.authStorage.close();
	AgentStorage.close();
	root?.removeSync();
	clearCustomApis();
});

async function startSession(mock: MockModel): Promise<{ storage: AgentStorage; session: AgentSession }> {
	registerMockApi();
	root = TempDir.createSync("@pi-sdk-usage-");
	const storage = await AgentStorage.open(root.join("agent.db"));
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	registry = new ModelRegistry(auth);
	({ session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry: registry,
		model: mock,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }, { storage }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: [],
	}));
	return { storage, session };
}

async function endSession(active: AgentSession): Promise<void> {
	await active.waitForIdle();
	await active.dispose();
	session = undefined;
	await flushBackgroundUsage();
}

it("records a main session turn once, not again through the background request observer", async () => {
	const mock = createMockModel({
		baseUrl: "HTTPS://Mock.Example/v1/",
		responses: [{ content: ["done"], usage: { input: 5, output: 2, cacheRead: 15 } }],
	});
	const background = createMockModel({
		baseUrl: "https://mock.example/v1",
		handler: () => ({ content: ["title"], usage: { input: 10, cacheWrite: 10 } }),
	});
	const { storage, session: active } = await startSession(mock);

	await active.prompt("hello");
	await completeSimple(background, { messages: [{ role: "user", content: "title this", timestamp: 1 }] });
	await endSession(active);
	// One turn plus one background call: a turn the observer also recorded would count three.
	expect(storage.usageLedger.totals([{ provider: mock.provider }], 0).requests).toBe(2n);
	// Both endpoint spellings are one endpoint.
	expect(storage.cacheLedger.cacheHitRate(mock.provider, mock.id, "https://mock.example/v1/", 0, Date.now())).toEqual({
		rate: 15 / 40,
		samples: 2,
	});
});

it("still records usage when the cache ledger cannot be written", async () => {
	const mock = createMockModel({ responses: [{ content: ["done"], usage: { input: 5, output: 2 } }] });
	const background = createMockModel({ handler: () => ({ content: ["title"], usage: { input: 10 } }) });
	const { storage, session: active } = await startSession(mock);
	storage.cacheLedger.close();

	await active.prompt("hello");
	await completeSimple(background, { messages: [{ role: "user", content: "title this", timestamp: 1 }] });
	await endSession(active);
	expect(storage.usageLedger.totals([{ provider: mock.provider }], 0).requests).toBe(2n);
});
