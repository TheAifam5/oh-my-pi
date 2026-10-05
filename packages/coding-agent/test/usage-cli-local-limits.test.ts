import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import * as utils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

let tmp: TempDir;

beforeEach(async () => {
	tmp = await TempDir.create("@usage-local-limits-");
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.credentials.reload();
	await authStorage.credentials.set("ext-usage", { type: "api_key", key: "sk-test" });
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	// No agent.db exists here, so reading the ledger must not create one.
	vi.spyOn(utils, "getAgentDbPath").mockReturnValue(tmp.join("agent.db"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await tmp.remove();
});

async function localLimits(settings: Settings): Promise<unknown> {
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(settings);
	const chunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		chunks.push(String(chunk));
		return true;
	});
	await runUsageCommand({ json: true, noExtensions: true });
	return (JSON.parse(chunks.join("")) as { localLimits: unknown }).localLimits;
}

test("omp usage --json lists no local limits when none are configured", async () => {
	expect(await localLimits(Settings.isolated())).toEqual([]);
});

test("omp usage --json lists configured limits with null usage when the ledger cannot be read, creating no agent.db", async () => {
	const window = { type: "rolling", durationMs: 3_600_000 };
	expect(
		await localLimits(Settings.isolated({ limits: { openai: [{ metric: "requests", max: 4, window }] } })),
	).toEqual([{ name: "openai", metric: "requests", max: 4, used: null, window, resetsAt: null }]);
	expect(await Bun.file(tmp.join("agent.db")).exists()).toBe(false);
});
