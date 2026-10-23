import { describe, expect, it } from "bun:test";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { $ } from "bun";
import { formatVersion } from "../src/build-identity";

const version = "18.12.6";
const commit = "174d8192e6abcdef";
const buildTime = "2026-10-22T20:49:38.123Z";

describe("version output", () => {
	it("prints a clean compiled build in one line with UTC minute precision", () => {
		expect(formatVersion({ version, commit, dirty: false, buildTime })).toBe(
			"omp/18.12.6 (174d8192e6, 2026-10-22 20:49 UTC)",
		);
	});

	it("identifies tracked edits in a compiled build", () => {
		expect(formatVersion({ version, commit, dirty: true, buildTime })).toBe(
			"omp/18.12.6 (174d8192e6, dirty, 2026-10-22 20:49 UTC)",
		);
	});

	it("marks a source checkout without claiming a build time", () => {
		expect(formatVersion({ version, commit, dirty: true, diff: "unknown" })).toBe("omp/18.12.6 (174d8192e6, source)");
	});

	it("marks source launches without loading checkout metadata", () => {
		expect(formatVersion({ version })).toBe("omp/18.12.6 (source)");
	});

	it("keeps plain version output compatible with old updaters and opts into verbose identity", async () => {
		const cli = new URL("../src/cli.ts", import.meta.url).pathname;
		const plain = await $`bun ${cli} --version`.quiet().nothrow();
		expect(plain.exitCode).toBe(0);
		expect(plain.text()).toBe(`omp/${VERSION}\n`);
		const oldVersionPattern = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
		expect(plain.text().trim().slice("omp/".length).match(oldVersionPattern)?.[1]).toBe(VERSION);
		const verbose = await $`bun ${cli} --version --verbose`.quiet().nothrow();
		expect(verbose.exitCode).toBe(0);
		expect(verbose.text()).toBe(`omp/${VERSION} (source)\n`);
	});
});
