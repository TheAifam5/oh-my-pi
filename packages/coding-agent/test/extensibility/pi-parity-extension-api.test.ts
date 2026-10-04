/**
 * Extensions written against upstream Pi's published `ExtensionAPI` shapes,
 * loaded through the real loader and the `@earendil-works/pi-coding-agent`
 * compatibility specifier, observe the documented events and payloads.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

type RecordedEvent = { type: string } & Record<string, unknown>;

/** Pi-shaped extension: records events on the shared bus and reads per-test knobs from it. */
const PI_EXTENSION_SOURCE = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const knobs: Record<string, unknown> = {};
	pi.events.on("parity:knobs", data => Object.assign(knobs, data));
	pi.on("session_start", event => {
		pi.events.emit("parity:event", event);
	});
	pi.on("session_before_fork", event => {
		pi.events.emit("parity:event", event);
		return knobs.cancelFork ? { cancel: true } : undefined;
	});
}
`;

describe("Pi-parity extension API", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let bus: EventBus;
	let events: RecordedEvent[];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pi-parity-"));
		await Bun.write(path.join(tempDir, "parity.ts"), PI_EXTENSION_SOURCE);
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		bus = new EventBus();
		events = [];
		bus.on("parity:event", event => {
			events.push(event as RecordedEvent);
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function createRunner(manager: SessionManager): Promise<ExtensionRunner> {
		const loaded = await loadExtensions([path.join(tempDir, "parity.ts")], tempDir, bus);
		expect(loaded.errors).toEqual([]);
		return new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, manager, modelRegistry);
	}

	async function createSession(manager: SessionManager): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const runner = await createRunner(manager);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: manager.buildSessionContext().messages,
			},
			streamFn: createMockModel({ responses: [{ content: ["done"] }, { content: ["done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner: runner,
		});
	}

	const ofType = (type: string) => events.filter(event => event.type === type);

	it("emits session_start with reason new and the previous session file after /new", async () => {
		const sessionDir = path.join(tempDir, "sessions");
		const manager = SessionManager.create(tempDir, sessionDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await manager.flush();
		const previous = manager.getSessionFile();
		await createSession(manager);

		expect(await session!.newSession()).toBe(true);
		expect(ofType("session_start")).toEqual([
			{ type: "session_start", reason: "new", previousSessionFile: previous },
		]);
	});

	it("emits session_before_fork before branching and session_start with reason fork after it", async () => {
		const sessionDir = path.join(tempDir, "sessions");
		const manager = SessionManager.create(tempDir, sessionDir);
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const second = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await manager.flush();
		await createSession(manager);

		bus.emit("parity:knobs", { cancelFork: true });
		expect((await session!.branch(second)).cancelled).toBe(true);
		expect(ofType("session_start")).toEqual([]);

		bus.emit("parity:knobs", { cancelFork: false });
		expect((await session!.branch(first)).cancelled).toBe(false);
		expect(ofType("session_before_fork")).toEqual([
			{ type: "session_before_fork", entryId: second, position: "before" },
			{ type: "session_before_fork", entryId: first, position: "before" },
		]);
		expect(ofType("session_start")).toMatchObject([{ type: "session_start", reason: "fork" }]);
	});
});
