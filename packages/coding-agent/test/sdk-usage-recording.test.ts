import { afterEach, expect, it } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
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

it("records a main session turn once, not again through the background request observer", async () => {
	registerMockApi();
	root = TempDir.createSync("@pi-sdk-usage-");
	const storage = await AgentStorage.open(root.join("agent.db"));
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	registry = new ModelRegistry(auth);
	const mock = createMockModel({ responses: [{ content: ["done"], usage: { input: 5, output: 2 } }] });
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

	await session.prompt("hello");
	await session.waitForIdle();
	await session.dispose();
	session = undefined;
	await flushBackgroundUsage();
	expect(storage.usageLedger.totals([{ provider: mock.model.provider }], 0).requests).toBe(1n);
});
