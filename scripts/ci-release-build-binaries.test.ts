import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";
import { captureBuildIdentity } from "../packages/coding-agent/scripts/build-identity";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("builds both Windows architecture release assets with their native runtimes", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64,win32-arm64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-arm64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-arm64 outfile=packages/coding-agent/binaries/omp-windows-arm64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
		native: null,
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);

it("runs code behind a lazy import() from a split chunk of the compiled binary", async () => {
	using temp = TempDir.createSync("@omp-split-chunk-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	// The probe's dynamic import() is the chunk boundary under test: with
	// `splitting`, lazy.ts compiles into a separate embedded chunk.
	await Bun.write(temp.join("lazy.ts"), 'export const value = ["lazy", "chunk"].join(" ");\n');
	await Bun.write(entrypoint, 'const { value } = await import("./lazy.ts");\nconsole.log(value);\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
		native: null,
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("lazy chunk");
}, 30_000);

it("embeds the captured checkout identity in compiled version output", async () => {
	using temp = TempDir.createSync("@omp-build-identity-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	const identityModule = path.join(repoRoot, "packages/coding-agent/src/build-identity.ts");
	await Bun.write(
		entrypoint,
		`import { formatVersion, getBuildIdentity } from ${JSON.stringify(identityModule)};\n` +
			`process.stdout.write(formatVersion({ version: "18.12.6", ...getBuildIdentity() }) + "\\n");\n`,
	);
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
		native: null,
		buildIdentity: {
			commit: "174d8192e6",
			dirty: false,
			buildTime: "2026-10-22T20:49:38.123Z",
		},
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text()).toBe("omp/18.12.6 (174d8192e6, 2026-10-22 20:49 UTC)\n");
}, 30_000);

it("retains a UTC build timestamp when Git metadata is unavailable", async () => {
	using temp = TempDir.createSync("@omp-no-build-repo-");
	const identity = await captureBuildIdentity(temp.path());
	expect(identity.commit).toBe("unknown");
	expect(identity.dirty).toBeUndefined();
	expect(new Date(identity.buildTime).toISOString()).toBe(identity.buildTime);
});
describe("macOS release binary entitlements", () => {
	it("allows Xcode MCP automation through Apple Events", async () => {
		const entitlements = await Bun.file(path.join(repoRoot, "scripts/macos-entitlements.plist")).text();

		expect(entitlements).toContain("<key>com.apple.security.automation.apple-events</key>\n\t<true/>");
	});
});
