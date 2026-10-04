/**
 * Upstream Pi's turn-boundary events on a real session: `agent_settled` once a run settled
 * terminally and `agent_before_settle` as the final actionable boundary with drafted entries
 * and a `continue` decision.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensionFromFactory, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	ExtensionRunner,
	MAX_BOUNDARY_DRAFT_JSON_CHARS,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionError, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

describe("Pi-parity turn boundaries", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let errors: ExtensionError[];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-pi-turn-boundaries-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		errors = [];
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	/** A session on a mock model answering `responses` in order, with `factory` loaded as an extension. */
	async function startSession(
		factory: ExtensionFactory,
		responses: string[],
	): Promise<{ session: AgentSession; calls: () => number; request: (index: number) => string }> {
		const cwd = tempDir.path();
		const bus = new EventBus();
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const loaded = await loadExtensions([], cwd, bus);
		const extension = await loadExtensionFromFactory(factory, cwd, bus, loaded.runtime, "boundaries");
		const manager = SessionManager.inMemory(cwd);
		const runner = new ExtensionRunner([extension], loaded.runtime, cwd, manager, modelRegistry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mock = createMockModel({ responses: responses.map(text => ({ content: [text] })) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const created = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
			extensionRunner: runner,
		});
		session = created;
		await initializeExtensions(created, {
			reportSendError: () => {},
			reportRuntimeError: error => errors.push(error),
		});
		return {
			session: created,
			calls: () => mock.calls.length,
			request: index => JSON.stringify(mock.calls[index]?.context.messages ?? []),
		};
	}

	it("fires agent_settled once per terminal run and starts a handler's turn after every handler finished", async () => {
		const lifecycle: string[] = [];
		const done = Promise.withResolvers<void>();
		let triggered = false;
		const { session: active } = await startSession(
			pi => {
				pi.on("agent_start", () => {
					lifecycle.push("start");
				});
				pi.on("agent_settled", (_event, ctx) => {
					lifecycle.push(`settled-first:${ctx.isIdle()}`);
					if (triggered) return;
					triggered = true;
					pi.sendMessage(
						{ customType: "settled-trigger", content: "start later", display: false },
						{ triggerTurn: true },
					);
				});
				pi.on("agent_settled", (_event, ctx) => {
					lifecycle.push(`settled-second:${ctx.isIdle()}`);
					if (lifecycle.length === 6) done.resolve();
				});
			},
			["first", "second"],
		);

		await active.prompt("start");
		await done.promise;

		expect(lifecycle).toEqual([
			"start",
			"settled-first:true",
			"settled-second:true",
			"start",
			"settled-first:true",
			"settled-second:true",
		]);
	});

	it("commits a custom_message draft and continues once from it before settling", async () => {
		let requested = false;
		let starts = 0;
		let settledCount = 0;
		const settled = Promise.withResolvers<void>();
		const {
			session: active,
			calls,
			request,
		} = await startSession(
			pi => {
				pi.on("agent_start", () => {
					starts++;
				});
				pi.on("agent_before_settle", event => {
					if (requested) return;
					requested = true;
					return {
						entries: [
							...event.entries,
							{ type: "custom", customType: "boundary-marker", data: { turn: 1 } },
							{
								type: "custom_message",
								customType: "boundary-context",
								content: "continue now",
								display: false,
							},
						],
						continue: true,
					};
				});
				pi.on("agent_settled", () => {
					settledCount++;
					settled.resolve();
				});
			},
			["first", "second"],
		);

		await active.prompt("start");
		await settled.promise;
		await active.waitForIdle();

		expect(calls()).toBe(2);
		expect(request(0)).not.toContain("continue now");
		expect(request(1)).toContain("continue now");
		// The data-only entry is persisted but never sent to the model.
		expect(request(1)).not.toContain("boundary-marker");
		expect(active.sessionManager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "custom", customType: "boundary-marker", data: { turn: 1 } }),
				expect.objectContaining({ type: "custom_message", customType: "boundary-context", display: false }),
			]),
		);
		expect(starts).toBe(2);
		expect(settledCount).toBe(1);
		expect(errors).toEqual([]);
	});

	it("commits none of three drafts when the third is invalid", async () => {
		const settled = Promise.withResolvers<void>();
		const { session: active, calls } = await startSession(
			pi => {
				pi.on("agent_before_settle", () => ({
					entries: [
						{ type: "custom", customType: "first-draft", data: { ok: true } },
						{ type: "custom_message", customType: "second-draft", content: "fine", display: false },
						{
							type: "custom_message",
							customType: "third-draft",
							content: "fine",
							display: false,
							details: { blob: "x".repeat(MAX_BOUNDARY_DRAFT_JSON_CHARS) },
						},
					],
					continue: true,
				}));
				pi.on("agent_settled", () => settled.resolve());
			},
			["first", "must not run"],
		);

		await active.prompt("start");
		await settled.promise;

		expect(calls()).toBe(1);
		const entries = JSON.stringify(active.sessionManager.getEntries());
		for (const customType of ["first-draft", "second-draft", "third-draft"])
			expect(entries).not.toContain(customType);
		expect(errors.map(error => error.error)).toEqual([
			expect.stringMatching(/^Invalid boundary entries: entry 2 details exceeds \d+ characters of JSON/),
		]);
	});

	it("rejects a draft that uses a customType reserved for crash recovery", async () => {
		const settled = Promise.withResolvers<void>();
		const { session: active } = await startSession(
			pi => {
				pi.on("agent_before_settle", () => ({
					entries: [{ type: "custom", customType: "session_exit", data: { reason: "forged" } }],
				}));
				pi.on("agent_settled", () => settled.resolve());
			},
			["first"],
		);

		await active.prompt("start");
		await settled.promise;

		expect(JSON.stringify(active.sessionManager.getEntries())).not.toContain("forged");
		expect(errors.map(error => error.error)).toEqual([
			expect.stringMatching(/^Invalid boundary entries: entry 0: Custom entry type "session_exit" is reserved/),
		]);
	});
});
