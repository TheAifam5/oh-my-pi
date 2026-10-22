import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { directoryAncestors, directoryLayerFile } from "../src/config/directory-layers";
import { Settings } from "../src/config/settings";
import {
	cfgDisabledProviders,
	cfgModelRoles,
	cfgModelGroups,
	cfgLimits,
	cfgModelTags,
} from "../src/config/model-settings";
import { cfgDefaultThinkingLevel, cfgProvidersMuseCodeStoreResponses } from "../src/session/settings";
import { listDirectoryLayers, parseConfigArgs } from "../src/cli/config-cli";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { configuredLimitTargets } from "../src/session/local-limits";

describe("user-owned directory layers", () => {
	let state: SettingsTestState;
	let root: string;
	let agentDir: string;
	let cwd: string;
	let instances: Settings[];

	beforeEach(async () => {
		state = beginSettingsTest();
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "directory-layers-"));
		agentDir = path.join(root, "agent");
		cwd = path.join(root, "project", "nested");
		await fs.promises.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "{}\n");
		instances = [];
	});

	afterEach(async () => {
		for (const instance of instances) instance.cancelPendingSaves();
		restoreSettingsTestState(state);
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	async function layer(dir: string, values: Record<string, unknown>): Promise<string> {
		const file = directoryLayerFile(agentDir, dir);
		await Bun.write(file, YAML.stringify({ path: dir, ...values }));
		return file;
	}

	async function load(
		options: { cwd?: string; configFiles?: string[]; overrides?: Record<string, unknown>; watch?: boolean } = {},
	): Promise<Settings> {
		const { watch, ...rest } = options;
		const settings = await (watch ? Settings.init : Settings.loadIsolated)({ cwd, agentDir, ...rest });
		instances.push(settings);
		return settings;
	}

	it("does not create directory storage when no ancestor has a layer", async () => {
		const settings = await load();
		expect(settings.getLayerValues(cfgDefaultThinkingLevel)).toEqual([]);
		expect(fs.existsSync(path.join(agentDir, "directories"))).toBe(false);
	});

	it("merges every ancestor outermost first with deepest values winning", async () => {
		await layer(path.parse(cwd).root, { defaultThinkingLevel: "minimal" });
		await layer(root, { defaultThinkingLevel: "low" });
		await layer(path.dirname(cwd), { defaultThinkingLevel: "medium" });
		await layer(cwd, { defaultThinkingLevel: "high" });
		const settings = await load();
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
		expect(settings.getLayerValues(cfgDefaultThinkingLevel).map(value => value.dir)).toEqual([
			path.parse(cwd).root,
			root,
			path.dirname(cwd),
			cwd,
		]);
		expect(settings.getProvenance(cfgDefaultThinkingLevel)).toBe("directory");
		expect(settings.getProvenanceDirectory(cfgDefaultThinkingLevel)).toBe(cwd);
	});

	it("applies the home directory itself and its descendants", async () => {
		const home = await fs.promises.realpath(os.homedir());
		await layer(home, { defaultThinkingLevel: "high" });
		const settings = await load({ cwd: home });
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
		expect(settings.getProvenanceDirectory(cfgDefaultThinkingLevel)).toBe(home);
	});

	it("applies temp-root directory layers to temp projects", async () => {
		const temp = await fs.promises.realpath(os.tmpdir());
		await layer(temp, { defaultThinkingLevel: "high" });
		const settings = await load();
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
		expect(settings.getProvenanceDirectory(cfgDefaultThinkingLevel)).toBe(temp);
	});

	it("resolves symlinked cwd through the real directory", async () => {
		const alias = path.join(root, "alias");
		await fs.promises.symlink(cwd, alias);
		await layer(cwd, { defaultThinkingLevel: "high" });
		const settings = await load({ cwd: alias });
		expect(settings.getProvenanceDirectory(cfgDefaultThinkingLevel)).toBe(cwd);
	});

	it("tolerates a deleted cwd while still reading ancestor layers", async () => {
		await layer(root, { defaultThinkingLevel: "high" });
		await fs.promises.rmdir(cwd);
		const settings = await load();
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
		expect(directoryAncestors(cwd).at(-1)).toBe(cwd);
	});

	it("directory beats project and global, overlay beats directory, runtime beats overlay", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), "defaultThinkingLevel: minimal\n");
		await Bun.write(path.join(cwd, ".omp", "config.yml"), "defaultThinkingLevel: low\n");
		await layer(cwd, { defaultThinkingLevel: "medium" });
		const overlay = path.join(root, "overlay.yml");
		await Bun.write(overlay, "defaultThinkingLevel: high\n");
		expect(cfgDefaultThinkingLevel.get(await load())).toBe(Effort.Medium);
		expect(cfgDefaultThinkingLevel.get(await load({ configFiles: [overlay] }))).toBe(Effort.High);
		expect(
			cfgDefaultThinkingLevel.get(
				await load({ configFiles: [overlay], overrides: { defaultThinkingLevel: "minimal" } }),
			),
		).toBe(Effort.Minimal);
	});

	it("environment values outrank directory settings", async () => {
		await layer(cwd, { providers: { "muse-code": { storeResponses: false } } });
		const settings = await load();
		process.env.PI_MUSE_STORE_RESPONSES = "true";
		expect(cfgProvidersMuseCodeStoreResponses.get(settings)).toBe(true);
		expect(cfgProvidersMuseCodeStoreResponses.provenance(settings)).toBe("env");
	});

	it("ordinary record fields deep-merge across directory ancestors", async () => {
		await layer(root, { modelTags: { custom: { name: "Parent", color: "blue" } } });
		await layer(cwd, { modelTags: { custom: { name: "Child" } } });
		const settings = await load();
		expect(cfgModelTags.get(settings).custom).toEqual({ name: "Child", color: "blue" });
	});

	it("trusted directory null values clear lower scalar values using existing null semantics", async () => {
		await layer(root, { defaultThinkingLevel: "high" });
		await layer(cwd, { defaultThinkingLevel: null });
		const settings = await load();
		expect(settings.getProvenance(cfgDefaultThinkingLevel)).toBe("default");
		expect(settings.getLayerValues(cfgDefaultThinkingLevel).at(-1)).toEqual({
			source: "directory",
			dir: cwd,
			value: null,
		});
	});

	it("writer refuses missing path metadata and malformed files without backups or replacement", async () => {
		const file = directoryLayerFile(agentDir, cwd);
		const settings = await load();
		await Bun.write(file, "defaultThinkingLevel: high\n");
		await expect(settings.setDirectoryValue(cwd, cfgDefaultThinkingLevel, "low")).rejects.toThrow("collision");
		expect(await Bun.file(file).text()).toBe("defaultThinkingLevel: high\n");
		await Bun.write(file, "path: [broken");
		await expect(settings.setDirectoryValue(cwd, cfgDefaultThinkingLevel, "low")).rejects.toThrow();
		expect(await Bun.file(file).text()).toBe("path: [broken");
		expect(await fs.promises.readdir(path.dirname(file))).toEqual(["config.yml"]);
	});

	it("replaces whole arrays instead of appending", async () => {
		await layer(root, { disabledProviders: ["anthropic", "openai"] });
		await layer(cwd, { disabledProviders: ["google"] });
		expect(cfgDisabledProviders.get(await load())).toEqual(["google"]);
	});

	it("replaces model-role entries while preserving unrelated roles", async () => {
		await layer(root, {
			modelRoles: {
				default: {
					strategy: "random",
					models: { a: { model: "anthropic/one" } },
					routing: { funding: { order: ["included"] } },
				},
				smol: "openai/other",
			},
		});
		await layer(cwd, { modelRoles: { default: { strategy: "random", models: { b: { model: "anthropic/two" } } } } });
		const roles = cfgModelRoles.get(await load());
		expect(roles.default).toEqual({ strategy: "random", models: { b: { model: "anthropic/two" } } });
		expect(roles.smol).toBe("openai/other");
	});

	it("replaces limits entries rather than retaining lower entry fields", async () => {
		await layer(root, {
			limits: { anthropic: [{ metric: "requests", window: { type: "calendar", period: "day" }, max: 5 }] },
		});
		await layer(cwd, {
			limits: { anthropic: [{ metric: "tokens", window: { type: "calendar", period: "day" }, max: 100 }] },
		});
		const settings = await load();
		expect(cfgLimits.get(settings).anthropic).toEqual([
			{ metric: "tokens", window: { type: "calendar", period: "day" }, max: 100 },
		]);
	});

	it("the limit consumer trusts directory limits and ignores project-only limits", async () => {
		await layer(cwd, {
			limits: { anthropic: [{ metric: "requests", window: { type: "calendar", period: "day" }, max: 5 }] },
		});
		await Bun.write(
			path.join(cwd, ".omp", "config.yml"),
			YAML.stringify({
				limits: { openai: [{ metric: "requests", window: { type: "calendar", period: "day" }, max: 1 }] },
			}),
		);
		const settings = await load();
		expect(configuredLimitTargets(settings).map(target => target.key)).toEqual(["anthropic#0"]);
	});

	it("directory allowProjectMeteredPools permits a repository metered pool", async () => {
		await layer(cwd, { allowProjectMeteredPools: true });
		const group = {
			strategy: "random",
			models: { a: { model: "anthropic/one" } },
			routing: { funding: { order: ["metered"] }, spending: { policy: "provider-managed" } },
		};
		await Bun.write(path.join(cwd, ".omp", "config.yml"), YAML.stringify({ modelGroups: { repo: group } }));
		const settings = await load();
		expect(cfgModelGroups.get(settings).repo).toEqual(group);
	});

	it("concurrent writers retain disjoint keys from both instances", async () => {
		const first = await load();
		const second = await load();
		await Promise.all([
			first.setDirectoryValue(cwd, cfgDefaultThinkingLevel, "high"),
			second.setDirectoryValue(cwd, cfgDisabledProviders, ["google"]),
		]);
		const persisted = YAML.parse(await Bun.file(directoryLayerFile(agentDir, cwd)).text());
		expect(persisted).toEqual({ path: cwd, defaultThinkingLevel: "high", disabledProviders: ["google"] });
	});

	it("trusts directory routing accounts and metered funding while project cannot redefine its group", async () => {
		const warn = vi.spyOn(logger, "warn");
		const group = {
			strategy: "random",
			models: { a: { model: "anthropic/one", account: "work" } },
			routing: {
				accounts: { order: ["work"] },
				funding: { order: ["metered"] },
				spending: { policy: "provider-managed" },
			},
		};
		await layer(cwd, { modelGroups: { work: group } });
		await Bun.write(
			path.join(cwd, ".omp", "config.yml"),
			YAML.stringify({
				modelGroups: { work: { strategy: "random", models: { evil: { model: "openai/untrusted" } } } },
			}),
		);
		const settings = await load();
		expect(cfgModelGroups.get(settings).work).toEqual(group);
		expect(
			warn.mock.calls.some(
				([, meta]) => isRecord(meta) && meta.setting === "modelGroups.work" && meta.layer === "project",
			),
		).toBe(true);
	});

	it("project pool account fields remain restricted below a directory layer", async () => {
		await layer(root, { defaultThinkingLevel: "high" });
		await Bun.write(
			path.join(cwd, ".omp", "config.yml"),
			YAML.stringify({
				modelGroups: {
					repo: {
						strategy: "random",
						models: { a: { model: "anthropic/one", account: "work" } },
						routing: { accounts: { order: ["work"] } },
					},
				},
			}),
		);
		const settings = await load();
		expect(cfgModelGroups.get(settings).repo).toEqual({
			strategy: "random",
			models: { a: { model: "anthropic/one" } },
			routing: {},
		});
	});

	it("failed cwd reload retains the previous directory scope and values", async () => {
		await layer(cwd, { defaultThinkingLevel: "high" });
		const other = path.join(root, "other");
		await fs.promises.mkdir(other);
		await layer(other, { defaultThinkingLevel: "low" });
		await Bun.write(
			path.join(other, ".omp", "config.yml"),
			YAML.stringify({ providers: { maxInFlightRequests: { openai: 0 } } }),
		);
		const settings = await load();
		await expect(settings.reloadForCwd(other)).rejects.toThrow();
		expect(settings.getCwd()).toBe(cwd);
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
		expect(settings.getProvenanceDirectory(cfgDefaultThinkingLevel)).toBe(cwd);
	});

	it("read-only clones and cwd changes re-scope directory layers without writing", async () => {
		const other = path.join(root, "other");
		await fs.promises.mkdir(other);
		await layer(cwd, { defaultThinkingLevel: "high" });
		await layer(other, { defaultThinkingLevel: "low" });
		const settings = await Settings.loadReadOnly({ cwd, agentDir });
		instances.push(settings);
		const clone = await settings.cloneForCwd(other);
		instances.push(clone);
		expect(cfgDefaultThinkingLevel.get(clone)).toBe(Effort.Low);
		await settings.reloadForCwd(other);
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
		await expect(settings.setDirectoryValue(other, cfgDefaultThinkingLevel, "medium")).rejects.toThrow("writable");
	});

	it("an invalid hot edit keeps only its own last good layer while other layers refresh", async () => {
		await layer(root, { disabledProviders: ["anthropic"] });
		await layer(cwd, { defaultThinkingLevel: "high" });
		const settings = await load();
		await layer(root, { disabledProviders: ["openai"] });
		await layer(cwd, { defaultThinkingLevel: ["invalid"] });
		await settings.reloadFromDisk();
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
		expect(cfgDisabledProviders.get(settings)).toEqual(["openai"]);
	});

	it("mismatched hot path markers discard the old layer instead of applying it to another directory", async () => {
		await layer(cwd, { defaultThinkingLevel: "high" });
		const settings = await load();
		await layer(cwd, { path: root, defaultThinkingLevel: "low" });
		await settings.reloadFromDisk();
		expect(settings.getLayerValues(cfgDefaultThinkingLevel)).toEqual([]);
	});

	it("record entry replacement covers groups and fallback chains across directory ancestors", async () => {
		await layer(root, {
			modelGroups: {
				shared: { strategy: "random", models: { a: { model: "anthropic/one" } } },
				other: { strategy: "random", models: { a: { model: "openai/other" } } },
			},
			retry: { fallbackChains: { default: ["anthropic/one"], other: ["openai/other"] } },
		});
		await layer(cwd, {
			modelGroups: { shared: { strategy: "random", models: { b: { model: "anthropic/two" } } } },
			retry: { fallbackChains: { default: ["anthropic/two"] } },
		});
		const settings = await load();
		expect(cfgModelGroups.get(settings).shared).toEqual({
			strategy: "random",
			models: { b: { model: "anthropic/two" } },
		});
		expect(cfgModelGroups.get(settings).other).toBeDefined();
		expect(settings.getFallbackChainSpec("default")).toEqual({ kind: "list", value: ["anthropic/two"] });
	});

	it("inaccessible cwd canonicalization does not prevent a known root layer from applying", async () => {
		await layer(path.parse(cwd).root, { defaultThinkingLevel: "high" });
		const realpath = fs.realpathSync;
		vi.spyOn(fs, "realpathSync").mockImplementation(((value: fs.PathLike, options?: unknown) => {
			if (String(value) === cwd) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			return realpath(value, options as fs.ObjectEncodingOptions);
		}) as typeof fs.realpathSync);
		const settings = await load();
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
	});

	for (const [name, source] of [
		["malformed YAML", "path: [broken"],
		["unknown setting", "path: PLACEHOLDER\nunknownSetting: true\n"],
		["invalid setting type", "path: PLACEHOLDER\ndefaultThinkingLevel: [high]\n"],
		["unknown empty mapping", "path: PLACEHOLDER\nunknownSetting: {}\n"],
		["missing path", "defaultThinkingLevel: high\n"],
	] as const) {
		it(`skips ${name} at startup with a warning and no file mutation`, async () => {
			const file = directoryLayerFile(agentDir, cwd);
			const text = source.replace("PLACEHOLDER", JSON.stringify(cwd));
			await Bun.write(file, text);
			const warn = vi.spyOn(logger, "warn");
			const settings = await load();
			expect(settings.getLayerValues(cfgDefaultThinkingLevel)).toEqual([]);
			expect(warn).toHaveBeenCalled();
			expect(await Bun.file(file).text()).toBe(text);
		});
	}

	it("keeps the last good layer on malformed hot reload, then accepts correction and deletion", async () => {
		const file = await layer(cwd, { defaultThinkingLevel: "high" });
		const settings = await load();
		await Bun.write(file, "path: [broken");
		await settings.reloadFromDisk();
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
		await layer(cwd, { defaultThinkingLevel: "low" });
		await settings.reloadFromDisk();
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
		await fs.promises.unlink(file);
		await settings.reloadFromDisk();
		expect(settings.getLayerValues(cfgDefaultThinkingLevel)).toEqual([]);
	});

	it("does not load a colliding path spelling and refuses to overwrite its layer", async () => {
		const flat = path.join(root, "x-a-b");
		const nested = path.join(root, "x", "a", "b");
		await fs.promises.mkdir(flat, { recursive: true });
		await fs.promises.mkdir(nested, { recursive: true });
		expect(directoryLayerFile(agentDir, flat)).toBe(directoryLayerFile(agentDir, nested));
		await layer(flat, { defaultThinkingLevel: "high" });
		const warn = vi.spyOn(logger, "warn");
		const settings = await load({ cwd: nested });
		expect(settings.getLayerValues(cfgDefaultThinkingLevel)).toEqual([]);
		expect(warn).toHaveBeenCalled();
		await expect(settings.setDirectoryValue(nested, cfgDefaultThinkingLevel, "low")).rejects.toThrow(flat);
		await expect(settings.setDirectoryValue(nested, cfgDefaultThinkingLevel, "low")).rejects.toThrow(nested);
		await layer(nested, { defaultThinkingLevel: "medium" });
		expect((await load({ cwd: flat })).getLayerValues(cfgDefaultThinkingLevel)).toEqual([]);
	});

	it("ignores a copied layer folder whose stored path differs", async () => {
		const file = await layer(root, { defaultThinkingLevel: "high" });
		await Bun.write(directoryLayerFile(agentDir, cwd), await Bun.file(file).text());
		const settings = await load();
		expect(settings.getLayerValues(cfgDefaultThinkingLevel).map(value => value.dir)).toEqual([root]);
	});

	it("reloadForCwd replaces directory scope without moving global/runtime values", async () => {
		const other = path.join(root, "other");
		await fs.promises.mkdir(other);
		await layer(cwd, { defaultThinkingLevel: "high" });
		await layer(other, { defaultThinkingLevel: "low" });
		const settings = await load();
		await settings.reloadForCwd(other);
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
		expect(settings.getProvenanceDirectory(cfgDefaultThinkingLevel)).toBe(other);
	});

	it("cloneForCwd loads destination layers while the original retains its scope", async () => {
		const other = path.join(root, "other");
		await fs.promises.mkdir(other);
		await layer(cwd, { defaultThinkingLevel: "high" });
		await layer(other, { defaultThinkingLevel: "low" });
		const settings = await load();
		const clone = await settings.cloneForCwd(other);
		instances.push(clone);
		expect(cfgDefaultThinkingLevel.get(clone)).toBe(Effort.Low);
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.High);
	});

	it("subagent overlay inherits its parent's layers and subsequent edits", async () => {
		await layer(cwd, { defaultThinkingLevel: "high" });
		const settings = await load();
		const child = settings.overlay();
		instances.push(child);
		expect(cfgDefaultThinkingLevel.get(child)).toBe(Effort.High);
		await settings.setDirectoryValue(cwd, cfgDefaultThinkingLevel, "low");
		expect(cfgDefaultThinkingLevel.get(child)).toBe(Effort.Low);
		expect(child.getProvenanceDirectory(cfgDefaultThinkingLevel)).toBe(cwd);
	});

	it("first write creates path metadata; unset keeps an empty metadata-only file", async () => {
		const settings = await load();
		await settings.setDirectoryValue(cwd, cfgDefaultThinkingLevel, "high");
		const file = directoryLayerFile(agentDir, cwd);
		expect(YAML.parse(await Bun.file(file).text())).toEqual({ path: cwd, defaultThinkingLevel: "high" });
		await settings.unsetDirectoryValue(cwd, cfgDefaultThinkingLevel);
		expect(YAML.parse(await Bun.file(file).text())).toEqual({ path: cwd });
		expect(settings.getProvenance(cfgDefaultThinkingLevel)).toBe("default");
	});

	it("per-key writes preserve external settings and external record entries", async () => {
		await layer(cwd, { defaultThinkingLevel: "high", modelRoles: { default: "anthropic/one" } });
		const settings = await load();
		await layer(cwd, {
			defaultThinkingLevel: "low",
			disabledProviders: ["google"],
			modelRoles: { default: "anthropic/external", slow: "openai/external" },
		});
		await settings.writeDirectoryEntry(cwd, cfgModelRoles, "smol", "openai/small");
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
		expect(cfgDisabledProviders.get(settings)).toEqual(["google"]);
		expect(cfgModelRoles.get(settings)).toEqual({
			default: "anthropic/external",
			slow: "openai/external",
			smol: "openai/small",
		});
		await settings.writeDirectoryEntry(cwd, cfgModelRoles, "default", undefined);
		expect(cfgModelRoles.get(settings)).toEqual({ slow: "openai/external", smol: "openai/small" });
	});

	it("writer rejects invalid values and leaves the persisted layer unchanged", async () => {
		const file = await layer(cwd, { defaultThinkingLevel: "high" });
		const settings = await load();
		const before = await Bun.file(file).text();
		await expect(settings.setDirectoryValue(cwd, cfgDefaultThinkingLevel, "invalid")).rejects.toThrow();
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("lists current directory plus existing ancestors, deepest first, with labels", async () => {
		await layer(path.parse(cwd).root, {});
		await layer(root, {});
		const settings = await load();
		expect(await settings.listDirectoryLayerTargets()).toEqual([
			{ dir: cwd, file: directoryLayerFile(agentDir, cwd), exists: false, label: "dir" },
			{ dir: root, file: directoryLayerFile(agentDir, root), exists: true, label: "dir" },
			{
				dir: path.parse(cwd).root,
				file: directoryLayerFile(agentDir, path.parse(cwd).root),
				exists: true,
				label: "root",
			},
		]);
	});

	it("config dirs reports inaccessible directory status as invalid, not orphan", async () => {
		await layer(cwd, {});
		vi.spyOn(fs.promises, "stat").mockRejectedValue(
			Object.assign(new Error("permission denied"), { code: "EACCES" }),
		);
		expect(await listDirectoryLayers(agentDir)).toEqual([
			{ dir: cwd, folder: path.dirname(directoryLayerFile(agentDir, cwd)), status: "invalid" },
		]);
	});

	it("config dirs reports ok, orphan, mismatch, and invalid without changing storage", async () => {
		await layer(cwd, { defaultThinkingLevel: "high" });
		const missing = path.join(root, "missing");
		await layer(missing, {});
		await Bun.write(path.join(agentDir, "directories", "copied", "config.yml"), YAML.stringify({ path: cwd }));
		await Bun.write(path.join(agentDir, "directories", "broken", "config.yml"), "bad: [yaml");
		const listings = await listDirectoryLayers(agentDir);
		expect(listings.find(entry => entry.dir === missing)?.status).toBe("orphan");
		expect(listings.find(entry => entry.folder.endsWith("copied"))?.status).toBe("mismatch");
		expect(listings.find(entry => entry.folder.endsWith("broken"))?.status).toBe("invalid");
		expect(listings.find(entry => entry.folder === path.dirname(directoryLayerFile(agentDir, cwd)))?.status).toBe(
			"ok",
		);
		expect(parseConfigArgs(["config", "dirs", "--json"])).toEqual({ action: "dirs", flags: { json: true } });
	});

	it("watcher observes ancestor layer creation, edit, malformed edit, and deletion", async () => {
		const settings = await load({ watch: true });
		settings.startWatching();
		// Filesystem watcher events require the real platform event loop and debounce clock.
		const waitFor = async (accept: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (accept()) return;
				await Bun.sleep(30);
			}
			throw new Error("Directory layer watcher did not update the effective value");
		};
		const file = await layer(root, { defaultThinkingLevel: "high" });
		await waitFor(() => cfgDefaultThinkingLevel.get(settings) === "high");
		await layer(root, { defaultThinkingLevel: "low" });
		await waitFor(() => cfgDefaultThinkingLevel.get(settings) === "low");
		await Bun.write(file, "path: [broken");
		await Bun.sleep(250);
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
		await fs.promises.unlink(file);
		await waitFor(() => settings.getProvenance(cfgDefaultThinkingLevel) === "default");
		settings.stopWatching();
	});
});
