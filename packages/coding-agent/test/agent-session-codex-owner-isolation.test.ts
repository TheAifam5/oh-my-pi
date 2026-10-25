import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession Codex owner isolation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-codex-owner-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		registry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	for (const transition of ["to-anthropic", "to-codex", "same-model", "dispose"] as const) {
		it(`preserves routing ownership during ${transition}`, async () => {
			const arrivals = Array.from({ length: 3 }, () => Promise.withResolvers<ServerWebSocket<unknown>>());
			let requestCount = 0;
			let opened = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request, server) {
					if (server.upgrade(request, { data: undefined })) return undefined;
					return new Response("WebSocket required", { status: 400 });
				},
				websocket: {
					open() {
						opened++;
					},
					message(socket: ServerWebSocket<unknown>) {
						arrivals[requestCount++]?.resolve(socket);
					},
				},
			});
			const bundled = registry.find("openai-codex", "gpt-6.1-sol");
			const anthropic = registry.find("anthropic", "claude-opus-5-5");
			if (!bundled || bundled.api !== "openai-codex-responses" || !anthropic) {
				throw new Error("Expected bundled Codex and Anthropic models");
			}
			const codex: Model<"openai-codex-responses"> = {
				...(bundled as Model<"openai-codex-responses">),
				api: "openai-codex-responses",
				baseUrl: `http://127.0.0.1:${server.port}`,
			};
			const payload = Buffer.from(
				JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
			).toBase64();
			const apiKey = `aaa.${payload}.bbb`;
			authStorage.keys.setRuntime(codex.provider, apiKey);
			authStorage.keys.setRuntime(anthropic.provider, "test-key");
			session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: transition === "to-codex" ? anthropic : codex,
						tools: [],
						messages: [],
					},
				}),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: registry,
			});
			const options = { apiKey, providerSessionState: session.providerSessionState, preferWebsockets: true };
			const context = { messages: [{ role: "user" as const, content: "Question", timestamp: 1 }] };
			const complete = (socket: ServerWebSocket<unknown>, id: string) => {
				socket.send(
					JSON.stringify({
						type: "response.completed",
						response: {
							id,
							status: "completed",
							output: [],
							usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
						},
					}),
				);
			};
			try {
				const advisor = streamOpenAICodexResponses(codex, context, { ...options, sessionId: "advisor" }).result();
				const advisorSocket = await arrivals[0].promise;
				const primary = streamOpenAICodexResponses(codex, context, {
					...options,
					sessionId: session.sessionId,
				}).result();
				await arrivals[1].promise;
				if (transition === "dispose") {
					await session.dispose();
				} else {
					await session.setModel(transition === "to-anthropic" ? anthropic : codex);
				}
				const primaryResult = await primary;
				expect(primaryResult.errorMessage).toContain("session_disposed");
				expect(AIError.retriable(primaryResult.errorId)).toBe(false);
				if (transition === "dispose") {
					expect((await advisor).errorMessage).toContain("session_disposed");
				} else {
					expect(advisorSocket.readyState).toBe(WebSocket.OPEN);
					complete(advisorSocket, "resp_advisor");
					expect((await advisor).stopReason).toBe("stop");
					const fresh = streamOpenAICodexResponses(codex, context, {
						...options,
						sessionId: session.sessionId,
					}).result();
					complete(await arrivals[2].promise, "resp_fresh");
					expect((await fresh).stopReason).toBe("stop");
				}
				expect(opened).toBe(transition === "dispose" ? 2 : 3);
				expect(requestCount).toBe(transition === "dispose" ? 2 : 3);
			} finally {
				await session.dispose();
				await server.stop(true);
			}
		});
	}
});
