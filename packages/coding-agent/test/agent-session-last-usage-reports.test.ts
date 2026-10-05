import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function report(provider: string, fetchedAt: number): UsageReport {
	return { provider, fetchedAt, limits: [] };
}

describe("AgentSession held usage reports", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-last-usage-");
		authStorage = createInMemoryAuthStorage();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("keeps each provider's last polled reports through empty, failed, and partial polls", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		const polls: (UsageReport[] | null)[] = [
			[report("anthropic", 1), report("cursor", 1), report("cursor", 2)],
			[],
			null,
			[report("cursor", 3)],
		];
		vi.spyOn(authStorage.usage, "reports").mockImplementation(async () => polls.shift() ?? null);
		const held = () => (session?.lastUsageReports ?? []).map(entry => `${entry.provider}@${entry.fetchedAt}`).sort();

		expect(session.lastUsageReports).toBeUndefined();
		await session.fetchUsageReports();
		expect(held()).toEqual(["anthropic@1", "cursor@1", "cursor@2"]);
		const first = session.lastUsageReports;

		await session.fetchUsageReports();
		await session.fetchUsageReports();
		// Neither the empty nor the failed poll replaced anything, not even the array.
		expect(session.lastUsageReports).toBe(first);

		await session.fetchUsageReports();
		// The partial poll replaces only its own provider's reports.
		expect(held()).toEqual(["anthropic@1", "cursor@3"]);
	});
});
