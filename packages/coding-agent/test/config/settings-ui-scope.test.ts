import { afterEach, beforeAll, beforeEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getKeybindings, setKeybindings, visibleWidth } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let state: SettingsTestState | undefined;
let temp: TempDir;
let cwd: string;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	state = beginSettingsTest();
	temp = TempDir.createSync("@settings-ui-scope-");
	cwd = temp.join("project", "child");
	await fs.mkdir(cwd, { recursive: true });
	await Settings.init({ cwd, agentDir: temp.join("agent") });
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	temp.removeSync();
});

function panel(host: SettingsHost): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			settings: host,
			plugins: createPluginSettingsHost(cwd),
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

function setting() {
	const result = lookup("searxng.endpoint");
	if (!result) throw new Error("Missing searxng.endpoint setting");
	return result;
}

it("defaults to Global without a current layer and writes to the newly selected directory", async () => {
	const host = createSettingsHost();
	await host.ready;
	expect(host.target).toBe("global");
	const selector = panel(host);
	await selector.ready;
	selector.handleInput("\x13");
	expect(host.target).toBe(cwd);
	for (const ch of "searxng endpoint") selector.handleInput(ch);
	selector.handleInput("\n");
	for (const ch of "https://directory.example") selector.handleInput(ch);
	selector.handleInput("\n");
	expect(await selector.pendingWrite).toBe(true);
	expect(settings.getLayerValues(setting())).toContainEqual({
		source: "directory",
		dir: cwd,
		value: "https://directory.example",
	});
	expect(settings.getLayerValues(setting()).some(layer => layer.source === "global")).toBe(false);
});

it("defaults to the existing current directory and unsets only that layer, restoring its ancestor value", async () => {
	await settings.setDirectoryValue(path.dirname(cwd), setting(), "https://ancestor.example");
	await settings.setDirectoryValue(cwd, setting(), "https://current.example");
	const host = createSettingsHost();
	const selector = panel(host);
	await selector.ready;
	expect(host.target).toBe(cwd);
	for (const ch of "searxng endpoint") selector.handleInput(ch);
	selector.handleInput("\n");
	selector.handleInput("\x15");
	selector.handleInput("\n");
	expect(await selector.pendingWrite).toBe(true);
	expect(host.get("searxng.endpoint")).toBe("https://ancestor.example");
	expect(settings.getLayerValues(setting()).filter(layer => layer.source === "directory")).toEqual([
		{ source: "directory", dir: path.dirname(cwd), value: "https://ancestor.example" },
	]);
});

it("cycles Global, current directory and existing ancestors with Home, Temp and Root labels", async () => {
	spyOn(Settings.instance, "listDirectoryLayerTargets").mockResolvedValue([
		{ dir: cwd, file: "current", exists: false, label: "dir" },
		{ dir: path.dirname(cwd), file: "parent", exists: true, label: "dir" },
		{ dir: "/fixture/home", file: "home", exists: true, label: "home" },
		{ dir: "/fixture", file: "temp", exists: true, label: "tmp" },
		{ dir: "/", file: "root", exists: true, label: "root" },
	]);
	const host = createSettingsHost();
	const selector = panel(host);
	await host.ready;
	expect(host.targets?.map(target => target.label)).toEqual([
		"Global",
		"This directory",
		path.dirname(cwd),
		"Home (~)",
		"Temp",
		"Root (/)",
	]);
	for (const target of host.targets?.slice(1) ?? []) {
		selector.handleInput("\x13");
		expect(host.target).toBe(target.id);
		const rendered = selector.render(80);
		expect(rendered.join("\n")).toContain("change scope");
		expect(rendered.every(line => visibleWidth(line) <= 80)).toBe(true);
		if (target.label === "Home (~)" || target.label === "Root (/)") {
			expect(rendered.join("\n")).toContain("overrides project config");
		}
	}
	selector.handleInput("\x13");
	expect(host.target).toBe("global");
});

it("shows a directory provenance badge and a shadow warning when Global is selected at 80 columns", async () => {
	await settings.setDirectoryValue(cwd, setting(), "https://directory.example");
	const host = createSettingsHost();
	const selector = panel(host);
	await host.ready;
	host.selectTarget?.("global");
	for (const ch of "searxng endpoint") selector.handleInput(ch);
	const lines = selector.render(80);
	expect(lines.join("\n")).toContain("[directory ");
	expect(lines.join("\n")).toMatch(/\[directory [^\]\n]*…\] /);
	expect(host.shadowWarning?.("searxng.endpoint")).toContain(`directory ${cwd} layer`);
	expect(lines.join("\n")).toContain("set in the directory");
	expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
	await host.set("searxng.endpoint", "https://global.example");
	expect(host.get("searxng.endpoint")).toBe("https://directory.example");
	expect(settings.getLayerValues(setting())).toContainEqual({ source: "global", value: "https://global.example" });
});

it("keeps the scope hint visible for long ancestor paths", async () => {
	const longDir = `/fixture/${"long-directory/".repeat(12)}`;
	spyOn(Settings.instance, "listDirectoryLayerTargets").mockResolvedValue([
		{ dir: cwd, file: "current", exists: false, label: "dir" },
		{ dir: longDir, file: "ancestor", exists: true, label: "dir" },
	]);
	const host = createSettingsHost();
	const selector = panel(host);
	await host.ready;
	selector.handleInput("\x13");
	selector.handleInput("\x13");
	const lines = selector.render(80);
	expect(host.target).toBe(longDir);
	expect(lines[1]).toContain("change scope");
	expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
});

it("writes an ancestor destination without creating a current-directory override", async () => {
	const ancestor = path.dirname(cwd);
	await settings.setDirectoryValue(ancestor, setting(), "https://before.example");
	const host = createSettingsHost();
	await host.ready;
	host.selectTarget?.(ancestor);
	await host.set("searxng.endpoint", "https://after.example");
	expect(settings.getLayerValues(setting()).filter(layer => layer.source === "directory")).toEqual([
		{ source: "directory", dir: ancestor, value: "https://after.example" },
	]);
});

it("reports a failed directory write without changing its effective value", async () => {
	const host = createSettingsHost();
	const selector = panel(host);
	await selector.ready;
	const current = (await settings.listDirectoryLayerTargets())[0];
	await fs.mkdir(current.file, { recursive: true });
	selector.handleInput("\x13");
	for (const ch of "searxng endpoint") selector.handleInput(ch);
	selector.handleInput("\n");
	for (const ch of "https://failed.example") selector.handleInput(ch);
	selector.handleInput("\n");
	expect(await selector.pendingWrite).toBe(false);
	expect(host.get("searxng.endpoint")).not.toBe("https://failed.example");
	expect(selector.render(80).join("\n")).toMatch(/EISDIR|cannot be read like files|Is a directory/i);
});

it("does not offer directory scope controls for plugin-owned settings", async () => {
	const host = createSettingsHost();
	const selector = panel(host);
	await selector.ready;
	selector.handleNativeEvent({ type: "action", key: "", act: "page", value: "plugins", mods: [] });
	expect(selector.render(80).join("\n")).not.toContain("change scope");
	selector.handleInput("\x13");
	expect(host.target).toBe("global");
});

it("does not write Global through a native control while the initial directory target is loading", async () => {
	await settings.setDirectoryValue(cwd, setting(), "https://current.example");
	const host = createSettingsHost();
	const selector = panel(host);
	selector.handleNativeEvent({ type: "change", key: "", item: "searxng.endpoint", value: "https://early.example" });
	expect(selector.pendingWrite).toBeUndefined();
	await selector.ready;
	expect(host.target).toBe(cwd);
	expect(host.get("searxng.endpoint")).toBe("https://current.example");
	expect(settings.getLayerValues(setting()).some(layer => layer.source === "global")).toBe(false);
});

it("falls back to editable Global settings when directory targets cannot be listed", async () => {
	spyOn(Settings.instance, "listDirectoryLayerTargets").mockRejectedValue(new Error("layer listing failed"));
	const host = createSettingsHost();
	const selector = panel(host);
	await selector.ready;
	for (const ch of "searxng endpoint") selector.handleInput(ch);
	selector.handleInput("\n");
	for (const ch of "https://global.example") selector.handleInput(ch);
	selector.handleInput("\n");
	expect(await selector.pendingWrite).toBe(true);
	expect(host.target).toBe("global");
	expect(settings.getLayerValues(setting())).toContainEqual({ source: "global", value: "https://global.example" });
});

it("warns when a deeper directory layer overrides the selected ancestor target", async () => {
	const ancestor = path.dirname(cwd);
	await settings.setDirectoryValue(ancestor, setting(), "https://ancestor.example");
	await settings.setDirectoryValue(cwd, setting(), "https://current.example");
	const host = createSettingsHost();
	await host.ready;
	host.selectTarget?.(ancestor);
	expect(host.shadowWarning?.("searxng.endpoint")).toContain(`directory ${cwd} layer`);
	host.selectTarget?.(cwd);
	expect(host.shadowWarning?.("searxng.endpoint")).toBeUndefined();
});

it("cycles the scope with a rebound key and shows that key in the scope hint", async () => {
	const previous = getKeybindings();
	setKeybindings(KeybindingsManager.inMemory({ "tui.settings.cycleScope": "alt+o" }));
	try {
		const host = createSettingsHost();
		const selector = panel(host);
		await selector.ready;
		expect(Bun.stripANSI(selector.render(80).join("\n"))).toContain("Alt+O to change scope");
		selector.handleInput("\x13");
		expect(host.target).toBe("global");
		selector.handleInput("\x1bo");
		expect(host.target).toBe(cwd);
	} finally {
		setKeybindings(previous);
	}
});

const NATIVE = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

it("keeps the native scope label and Home/Root note visible while actions and keys cycle the same targets", async () => {
	spyOn(Settings.instance, "listDirectoryLayerTargets").mockResolvedValue([
		{ dir: cwd, file: "current", exists: false, label: "dir" },
		{ dir: "/fixture/home", file: "home", exists: true, label: "home" },
		{ dir: "/", file: "root", exists: true, label: "root" },
	]);
	const host = createSettingsHost();
	const selector = panel(host);
	await selector.ready;
	const nativePrefs = () => {
		const node = selector.describe(NATIVE);
		if (node.k !== "prefs" || !node.p) throw new Error("Expected native prefs");
		return node.p;
	};
	expect(nativePrefs().lead).toContain("Scope: Global");
	expect(
		nativePrefs()
			.sections.flatMap(section => section.rows)
			.some(row => row.control.k === "action" && row.control.act === "cycleScope"),
	).toBe(true);
	for (const target of host.targets?.slice(1) ?? []) {
		selector.handleNativeEvent({ type: "action", key: "", act: "cycleScope", mods: [] });
		expect(host.target).toBe(target.id);
		expect(nativePrefs().lead).toContain(`Scope: ${target.label}`);
		if (target.note) expect(nativePrefs().lead).toContain(target.note);
	}
	selector.handleInput("\x13");
	expect(host.target).toBe("global");
	expect(nativePrefs().lead).toContain("Scope: Global");
	selector.handleNativeEvent({ type: "action", key: "", act: "page", value: "plugins", mods: [] });
	expect(
		nativePrefs()
			.sections.flatMap(section => section.rows)
			.some(row => row.control.k === "action" && row.control.act === "cycleScope"),
	).toBe(false);
	selector.handleNativeEvent({ type: "action", key: "", act: "cycleScope", mods: [] });
	expect(host.target).toBe("global");
});

it.each(["global", "directory"])(
	"edits disabled accounts as JSON in the selected %s scope from ANSI and native settings",
	async scope => {
		const host = createSettingsHost();
		const selector = panel(host);
		await selector.ready;
		if (scope === "directory") selector.handleInput("\x13");
		for (const character of "Disabled Accounts") selector.handleInput(character);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("Disabled Accounts");
		const native = selector.describe(NATIVE);
		if (native.k !== "prefs" || !native.p) throw new Error("Expected native prefs");
		expect(
			native.p.sections.flatMap(section => section.rows).find(row => row.id === "auth.disabledAccounts")?.control.k,
		).toBe("text");
		const submit = (value: string) => {
			if (scope === "directory") {
				selector.handleNativeEvent({ type: "change", key: "", item: "auth.disabledAccounts", value });
			} else {
				selector.handleInput("\n");
				selector.handleInput("\x01");
				selector.handleInput("\x0b");
				for (const character of value) selector.handleInput(character);
				selector.handleInput("\n");
			}
		};
		submit('["anthropic/private",{"provider":"openai","email":"private@example.com"}]');
		expect(await selector.pendingWrite).toBe(true);
		const def = lookup("auth.disabledAccounts");
		if (!def) throw new Error("Missing disabled accounts setting");
		expect(settings.getLayerValues(def)).toContainEqual({
			source: scope,
			...(scope === "directory" ? { dir: cwd } : {}),
			value: ["anthropic/private", { provider: "openai", email: "private@example.com" }],
		});
		submit('["invalid"]');
		expect(await selector.pendingWrite).toBe(false);
		expect(host.get("auth.disabledAccounts")).toEqual([
			"anthropic/private",
			{ provider: "openai", email: "private@example.com" },
		]);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("auth.disabledAccounts[0] must be");
		const rejected = selector.describe(NATIVE);
		if (rejected.k !== "prefs" || !rejected.p) throw new Error("Expected native prefs");
		expect(rejected.p.lead).toContain("auth.disabledAccounts[0] must be");
	},
);
