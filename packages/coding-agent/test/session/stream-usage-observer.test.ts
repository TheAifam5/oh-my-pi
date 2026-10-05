import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { completeSimple, getStreamUsageObserver } from "@oh-my-pi/pi-ai/stream";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	flushBackgroundUsage,
	installStreamUsageObserver,
} from "@oh-my-pi/pi-coding-agent/session/stream-usage-observer";
import { sideRequestSessionId } from "@oh-my-pi/pi-coding-agent/session/request-session-ids";
import { TempDir } from "@oh-my-pi/pi-utils";

const context: Context = { messages: [{ role: "user", content: "title this", timestamp: 1 }] };
const DAY = { type: "calendar", period: "day" };

describe("background request usage", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const teardowns: (() => void)[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-stream-usage-");
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		registerMockApi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const teardown of teardowns.splice(0).reverse()) teardown();
		clearCustomApis();
		authStorage.close();
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("records one-shot calls and refuses them on a global limit, but never on a pool limit", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const mock = createMockModel({ handler: () => ({ content: ["A title"], usage: { input: 30, output: 4 } }) });
		const member = `${mock.model.provider}/${mock.model.id}`;
		const settings = Settings.isolated(
			{
				limits: { "*": [{ metric: "requests", max: 2, window: DAY }] },
				modelRoles: {
					engineer: {
						strategy: "random",
						routing: { limits: [{ metric: "requests", max: 1, window: DAY }] },
						models: { only: { model: member } },
					},
				},
			},
			{ storage },
		);
		storage.usageLedger.record({
			atMs: Date.now(),
			provider: mock.model.provider,
			model: mock.model.id,
			pool: "role:engineer",
			costNanos: 0,
			inputTokens: 1,
			outputTokens: 1,
		});
		teardowns.push(installStreamUsageObserver(settings, authStorage));

		await completeSimple(mock.model, context);
		await flushBackgroundUsage();
		expect(storage.usageLedger.totals([{ provider: mock.model.provider }], 0)).toEqual({
			costNanos: 0n,
			requests: 2n,
			tokens: 36n,
		});
		expect(
			storage.cacheLedger.cacheHitRate(mock.model.provider, mock.model.id, mock.model.baseUrl, 0, Date.now()),
		).toEqual({ rate: 0, samples: 1 });
		await expect(completeSimple(mock.model, context)).rejects.toThrow(
			`Usage preflight blocked: local limit refused ${member} (*: 2 requests per day: local limit reached)`,
		);
		expect(mock.calls).toHaveLength(1);
	});

	it("refuses on an unreadable ledger and hands the observer back when its session goes", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["x"] }) });
		const outer = installStreamUsageObserver(Settings.isolated(), authStorage);
		teardowns.push(outer);
		const installed = getStreamUsageObserver();
		const inner = installStreamUsageObserver(
			Settings.isolated({ limits: { "*": [{ metric: "requests", max: 5, window: DAY }] } }),
			authStorage,
		);
		await expect(completeSimple(mock.model, context)).rejects.toThrow("local limit usage unreadable");

		inner();
		expect(getStreamUsageObserver()).toBe(installed);
		await expect(completeSimple(mock.model, context)).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("records a cache-warming replay as usage but leaves it out of the cache ledger", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const mock = createMockModel({
			handler: () => ({ content: ["."], usage: { input: 0, cacheRead: 1000, output: 1 } }),
		});
		teardowns.push(installStreamUsageObserver(Settings.isolated({}, { storage }), authStorage));

		await completeSimple(mock.model, context, { cacheWarm: true });
		await flushBackgroundUsage();
		expect(storage.usageLedger.totals([{ provider: mock.model.provider }], 0).requests).toBe(1n);
		const rate = () =>
			storage.cacheLedger.cacheHitRate(mock.model.provider, mock.model.id, mock.model.baseUrl, 0, Date.now());
		expect(rate()).toBeUndefined();

		await completeSimple(mock.model, context);
		await flushBackgroundUsage();
		expect(rate()).toEqual({ rate: 1, samples: 1 });
	});

	it("records a side request under the account of the session that made it", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const mock = createMockModel({ handler: () => ({ content: ["btw"], usage: { input: 2, output: 1 } }) });
		vi.spyOn(authStorage.sessions, "accounts").mockImplementation((_provider, sessionId) =>
			sessionId === "parent"
				? [{ credentialId: 1, type: "oauth", accountId: "acc-parent", active: true, pinned: false }]
				: [],
		);
		teardowns.push(installStreamUsageObserver(Settings.isolated({}, { storage }), authStorage));

		await completeSimple(mock.model, context, { sessionId: sideRequestSessionId("parent", "123") });
		await flushBackgroundUsage();
		expect(storage.usageLedger.totals([{ account: "acc-parent" }], 0).requests).toBe(1n);
	});
});
