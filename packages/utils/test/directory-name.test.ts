import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { encodeDirectoryName } from "../src/directory-name";

describe("session-compatible directory names", () => {
	for (const [name, cwd, expected] of [
		["home root", "/home/me", "-"],
		["home descendant", "/home/me/projects/app", "-projects-app"],
		["temp root", "/tmp", "-tmp"],
		["temp descendant", "/tmp/project", "-tmp-project"],
		["absolute", "/srv/projects/app", "--srv-projects-app--"],
		["filesystem root", "/", "----"],
		["spaces and dots", "/home/me/my app/.hidden", "-my app-.hidden"],
		["home prefix sibling", "/home/me-other/app", "--home-me-other-app--"],
		["temp prefix sibling", "/tmp-other/app", "--tmp-other-app--"],
	] as const) {
		it(`encodes ${name} without filesystem access`, () => {
			expect(encodeDirectoryName(cwd, "/home/me", "/tmp", path.posix)).toBe(expected);
		});
	}

	it("checks Windows temp nested in home before home", () => {
		expect(
			encodeDirectoryName(
				"C:\\Users\\me\\AppData\\Local\\Temp\\my app\\.hidden",
				"C:\\Users\\me",
				"C:\\Users\\me\\AppData\\Local\\Temp",
				path.win32,
			),
		).toBe("-tmp-my app-.hidden");
		expect(
			encodeDirectoryName(
				"C:\\Users\\me\\AppData\\Local\\Temp",
				"C:\\Users\\me",
				"C:\\Users\\me\\AppData\\Local\\Temp",
				path.win32,
			),
		).toBe("-tmp");
	});

	it("encodes a Windows home root and absolute drive with legacy separators", () => {
		expect(encodeDirectoryName("C:\\Users\\me", "C:\\Users\\me", "C:\\Temp", path.win32)).toBe("-");
		expect(encodeDirectoryName("D:\\work\\app", "C:\\Users\\me", "C:\\Temp", path.win32)).toBe("--D--work-app--");
	});
});
