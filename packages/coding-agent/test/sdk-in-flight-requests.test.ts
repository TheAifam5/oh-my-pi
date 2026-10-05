import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { inFlightRequests } from "@oh-my-pi/pi-coding-agent/session/in-flight-requests";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("session in-flight request count", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	it("counts a session turn's request while it runs and releases it when it errors or aborts", async () => {
		using tempDir = TempDir.createSync("@omp-in-flight-");
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		const streams: AssistantMessageEventStream[] = [];
		const started = Promise.withResolvers<void>();
		// Each request stays open until the test fails it, or the session aborts it.
		const provider: ExtensionFactory = pi => {
			pi.registerProvider("inflight-provider", {
				baseUrl: "https://inflight.example.com/v1",
				apiKey: "INFLIGHT_KEY",
				api: "inflight-test-api",
				streamSimple: (_model, _context, options) => {
					const stream = new AssistantMessageEventStream();
					options?.signal?.addEventListener("abort", () => stream.fail(new Error("aborted")), { once: true });
					streams.push(stream);
					started.resolve();
					return stream;
				},
				models: [
					{
						id: "inflight-model",
						name: "In-flight Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated({ "retry.enabled": false, "compaction.enabled": false }),
			sessionManager: SessionManager.inMemory(),
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
			toolNames: ["read"],
			extensions: [provider],
			modelPattern: "inflight-provider/inflight-model",
		});
		const count = () => inFlightRequests("inflight-provider", "inflight-model");
		try {
			const errored = session.prompt("first").catch(() => {});
			await started.promise;
			expect(count()).toBe(1);
			streams[0]?.fail(new Error("boom"));
			await errored;
			await session.waitForIdle();
			expect(count()).toBe(0);

			const aborted = session.prompt("second").catch(() => {});
			while (streams.length < 2) await Bun.sleep(1);
			expect(count()).toBe(1);
			await session.abort();
			await aborted;
			await session.waitForIdle();
			expect(count()).toBe(0);
		} finally {
			await session.dispose();
		}
	});
});
