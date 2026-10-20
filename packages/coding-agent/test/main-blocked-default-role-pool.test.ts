/**
 * A `modelRoles.default` pool whose funding policy excludes every member must not kill startup
 * through the unhandled-rejection postmortem path: the interactive TUI starts with no model, and a
 * non-interactive launch exits 1 with the pool's one-line reason.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { RolePoolUnavailableError } from "@oh-my-pi/pi-coding-agent/session/pool-selection";
import { setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

const BLOCKED = new RolePoolUnavailableError("default", [
	{ selector: "anthropic/claude-sonnet-5-5:medium", reason: { kind: "disabled" } },
	{ selector: "openai-codex/gpt-6.1-sol:low", reason: { kind: "exhausted" } },
]);

interface LaunchResult {
	thrown: unknown;
	exitCodes: number[];
	stderr: string;
	observed: CreateAgentSessionOptions | undefined;
}

async function launch(rawArgs: string[], interactive: boolean): Promise<LaunchResult> {
	using dir = TempDir.createSync("@omp-blocked-pool-");
	const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = path.join(dir.path(), "sessions");
	const previousHost = setInteractiveHost(false);
	const originalIsTTY = process.stdin.isTTY;
	if (interactive) Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	const exitCodes: number[] = [];
	let stderr = "";
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	});
	let observed: CreateAgentSessionOptions | undefined;
	let thrown: unknown;
	try {
		await runRootCommand(parsed, rawArgs, {
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			discoverAuthStorage: async () => authStorage,
			createAgentSession: async options => {
				observed = options;
				throw BLOCKED;
			},
		});
	} catch (error) {
		thrown = error;
	} finally {
		vi.restoreAllMocks();
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		setInteractiveHost(previousHost);
		authStorage.close();
	}
	return { thrown, exitCodes, stderr, observed };
}

describe("runRootCommand — blocked default role pool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exits 1 with the pool's one-line reason in print mode instead of an unhandled rejection", async () => {
		const result = await launch(["--print", "hi"], false);

		expect(result.thrown).toBeInstanceOf(ProcessExitSignal);
		expect(result.exitCodes).toEqual([1]);
		const lines = result.stderr.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`Error: ${BLOCKED.message}`);
		expect(result.stderr).not.toContain("    at ");
		expect(result.stderr).not.toContain("Fatal error");
		expect(result.observed?.allowBlockedDefaultRolePool).toBe(false);
	}, 15_000);

	it("lets the interactive TUI start without a model", async () => {
		const result = await launch([], true);

		expect(result.observed?.allowBlockedDefaultRolePool).toBe(true);
	}, 15_000);
});
