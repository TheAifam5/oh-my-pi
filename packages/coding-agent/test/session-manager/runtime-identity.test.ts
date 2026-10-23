import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as runtimeIdentity from "@oh-my-pi/pi-coding-agent/session/runtime-identity";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const BUILD_A: runtimeIdentity.RuntimeIdentity = { version: "1.0.0", commit: "a".repeat(40), branch: "will/a" };
const BUILD_B: runtimeIdentity.RuntimeIdentity = { ...BUILD_A, diff: "beef" };

function runAs(build: runtimeIdentity.RuntimeIdentity): void {
	spyOn(runtimeIdentity, "currentRuntimeIdentity").mockReturnValue(build);
}

function writers(entries: readonly SessionEntry[]): Array<string | undefined> {
	return entries.map(entry => (entry.runtime ? (entry.runtime.diff ?? entry.runtime.branch) : undefined));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session runtime identity", () => {
	it("credits each entry to the build that wrote it across a resume by a different build", async () => {
		using tempDir = TempDir.createSync("@pi-runtime-identity-");
		runAs(BUILD_A);
		const original = SessionManager.create(tempDir.path(), tempDir.path());
		original.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await original.ensureOnDisk();
		const file = original.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");

		runAs(BUILD_B);
		const resumed = await SessionManager.open(file, tempDir.path());
		resumed.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await resumed.flush();

		const reloaded = await SessionManager.open(file, tempDir.path());
		expect(writers(reloaded.getEntries())).toEqual(["will/a", "beef"]);
		expect(runtimeIdentity.runtimeIdentityHistory(reloaded.getEntries())).toEqual([BUILD_A, BUILD_B]);
	});

	it("keeps the original writers on entries a branched session copies", async () => {
		using tempDir = TempDir.createSync("@pi-runtime-identity-branch-");
		runAs(BUILD_A);
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const keptLeafId = session.appendMessage({ role: "user", content: "kept", timestamp: 2 });

		runAs(BUILD_B);
		session.createBranchedSession(keptLeafId);
		session.appendMessage({ role: "user", content: "after branching", timestamp: 3 });

		expect(writers(session.getEntries())).toEqual(["will/a", "will/a", "beef"]);
	});

	it("keeps the host's writer on entries a collab guest ingests", () => {
		runAs(BUILD_A);
		const host = SessionManager.inMemory();
		host.appendMessage({ role: "user", content: "from host", timestamp: 1 });
		const [hostEntry] = host.getEntries();

		runAs(BUILD_B);
		const guest = SessionManager.inMemory();
		guest.ingestReplicatedEntry(structuredClone(hostEntry));
		guest.appendMessage({ role: "user", content: "from guest", timestamp: 2 });

		expect(writers(guest.getEntries())).toEqual(["will/a", "beef"]);
	});

	it("lists a run that wrote before its diff was read under the diff it read, once", () => {
		const pending: runtimeIdentity.RuntimeIdentity = { ...BUILD_A, diff: "unknown" };
		const session = SessionManager.inMemory();
		for (const build of [pending, BUILD_B, pending, BUILD_A]) {
			runAs(build);
			session.appendMessage({ role: "user", content: "turn", timestamp: 1 });
		}
		// The second `unknown` run cannot be told apart from BUILD_B; BUILD_A (clean) is a new build.
		expect(runtimeIdentity.runtimeIdentityHistory(session.getEntries())).toEqual([BUILD_B, BUILD_A]);
	});

	it("does not invent a build transition when older stamps omit a clean checkout's dirty flag", () => {
		const clean = { ...BUILD_A, dirty: false };
		const session = SessionManager.inMemory();
		for (const build of [BUILD_A, clean, BUILD_A]) {
			runAs(build);
			session.appendMessage({ role: "user", content: "turn", timestamp: 1 });
		}
		expect(runtimeIdentity.runtimeIdentityHistory(session.getEntries())).toEqual([BUILD_A]);
	});

	it("treats a malformed stamp read from disk as unstamped", () => {
		runAs(BUILD_A);
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "turn", timestamp: 1 });
		const [entry] = session.getEntries();
		const malformed = { ...entry, runtime: { version: "1.0.0", commit: 42 } } as unknown as SessionEntry;
		expect(runtimeIdentity.runtimeIdentityHistory([malformed, entry])).toEqual([null, BUILD_A]);
	});

	it("preserves compiled build fields on disk and distinguishes rebuilds while reading older stamps", async () => {
		using tempDir = TempDir.createSync("@pi-compiled-identity-");
		const first = {
			version: "18.12.6",
			commit: "174d8192e6",
			dirty: false,
			buildTime: "2026-10-22T20:49:00.000Z",
		};
		const rebuilt = { ...first, buildTime: "2026-10-22T20:50:00.000Z" };
		const edited = { ...rebuilt, dirty: true };
		const legacy = { version: first.version };
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		for (const build of [legacy, first, rebuilt, edited]) {
			runAs(build);
			session.appendMessage({ role: "user", content: "turn", timestamp: 1 });
		}
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		const loaded = await SessionManager.open(file, tempDir.path());
		expect(runtimeIdentity.runtimeIdentityHistory(loaded.getEntries())).toEqual([legacy, first, rebuilt, edited]);
		expect(runtimeIdentity.formatRuntimeIdentity(edited)).toBe("18.12.6 174d8192e6 dirty 2026-10-22 20:50 UTC");
	});

	it("stamps embedded build metadata on new entries and accepts binaries without metadata", async () => {
		const embedded = {
			commit: "174d8192e6",
			dirty: true,
			buildTime: "2026-10-22T20:49:00.000Z",
		};
		const moduleUrl = new URL("../../src/session/session-manager.ts", import.meta.url).href;
		const script = [
			`import { SessionManager } from ${JSON.stringify(moduleUrl)};`,
			"const session = SessionManager.inMemory();",
			'session.appendMessage({ role: "user", content: "turn", timestamp: 1 });',
			"process.stdout.write(JSON.stringify(session.getEntries()[0].runtime));",
		].join("\n");
		for (const build of [embedded, undefined]) {
			const define = `__OMP_BUILD_IDENTITY__:${JSON.stringify(build) ?? "undefined"}`;
			const compiled = 'process.env.PI_COMPILED:"true"';
			const result = await $`bun --define ${define} --define ${compiled} --eval ${script}`.quiet().nothrow();
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.text())).toEqual({ version: VERSION, ...build });
		}
	});

	it("rejects malformed build fields without discarding entries with older stamps", () => {
		const session = SessionManager.inMemory();
		runAs(BUILD_A);
		session.appendMessage({ role: "user", content: "turn", timestamp: 1 });
		const [entry] = session.getEntries();
		for (const fields of [{ dirty: "true" }, { buildTime: 42 }]) {
			const malformed = { ...entry, runtime: { ...BUILD_A, ...fields } } as unknown as SessionEntry;
			expect(runtimeIdentity.runtimeIdentityHistory([malformed, entry])).toEqual([null, BUILD_A]);
		}
	});
});
