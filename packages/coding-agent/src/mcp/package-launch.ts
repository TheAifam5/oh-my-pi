/**
 * Resolution of `package` launch specs on stdio MCP servers.
 *
 * A spec names an npm package instead of a command. Before connecting, the project's installed
 * copy is preferred; otherwise the configured runner fetches `name@version`, as the policy allows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, isEnotdir, isRecord } from "@oh-my-pi/pi-utils";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { MCPPackageLaunch, MCPPackagePolicy, MCPStdioServerConfig } from "./types";

export const MCP_PACKAGE_POLICIES = [
	"local-first",
	"local-only",
	"fallback-only",
] as const satisfies readonly MCPPackagePolicy[];
export const DEFAULT_MCP_PACKAGE_RUNNER: readonly string[] = ["bunx"];
export const DEFAULT_MCP_PACKAGE_RUNTIME: readonly string[] = ["bun"];
export const DEFAULT_MCP_PACKAGE_POLICY: MCPPackagePolicy = "local-first";

/** Values a spec falls back to for `runner`, `runtime`, and `policy` (the `mcp.package*` settings). */
export interface MCPPackageLaunchDefaults {
	runner: readonly string[];
	runtime: readonly string[];
	policy: MCPPackagePolicy;
}

export const DEFAULT_MCP_PACKAGE_LAUNCH: MCPPackageLaunchDefaults = {
	runner: DEFAULT_MCP_PACKAGE_RUNNER,
	runtime: DEFAULT_MCP_PACKAGE_RUNTIME,
	policy: DEFAULT_MCP_PACKAGE_POLICY,
};

/** Size cap for each `package.json` read while resolving. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPEC_KEYS = new Set(["name", "bin", "version", "policy", "runner", "runtime"]);

/** A launch that cannot be resolved; the message names the cause and is safe to show. */
export class MCPPackageLaunchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MCPPackageLaunchError";
	}
}

/** Returns why `value` is not a nonempty argv prefix starting with an executable, or `undefined`. */
export function checkArgvPrefix(value: unknown, key: string): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return `${key} must be a nonempty argument array`;
	if (value.some(item => typeof item !== "string" || item.includes("\0"))) {
		return `${key} must contain strings without NUL bytes`;
	}
	const head = value[0] as string;
	if (!head.trim() || head.startsWith("-")) return `${key} must start with an executable`;
	return undefined;
}

/** Returns why `value` is not a valid {@link MCPPackageLaunch}, or `undefined` when it is. */
export function validatePackageLaunch(value: unknown): string | undefined {
	if (!isRecord(value)) return "must be an object";
	const unknown = Object.keys(value)
		.filter(key => !SPEC_KEYS.has(key))
		.sort();
	if (unknown.length > 0) return `has unknown keys: ${unknown.join(", ")}`;
	if (typeof value.name !== "string" || !PACKAGE_NAME.test(value.name)) return "name must be an npm package name";
	if (value.bin !== undefined && (typeof value.bin !== "string" || !BIN_NAME.test(value.bin))) {
		return "bin must be a bin entry name";
	}
	const version = value.version;
	if (
		version !== undefined &&
		(typeof version !== "string" || !version.trim() || version !== version.trim() || /[\0\n\r/@:]/.test(version))
	) {
		return "version must be a registry tag, version, or range";
	}
	if (value.policy !== undefined && !MCP_PACKAGE_POLICIES.includes(value.policy as MCPPackagePolicy)) {
		return `policy must be one of ${MCP_PACKAGE_POLICIES.join(", ")}`;
	}
	for (const key of ["runner", "runtime"] as const) {
		if (value[key] !== undefined) {
			const problem = checkArgvPrefix(value[key], key);
			if (problem) return problem;
		}
	}
	return undefined;
}

/**
 * Validates a `package` value read from config and expands `${VAR}` in its `runner` and `runtime`
 * argv only. `name`, `bin`, `version`, and `policy` stay literal so the environment cannot pick
 * which package runs.
 */
export function parsePackageLaunchConfig(raw: unknown): { spec?: MCPPackageLaunch; problem?: string } {
	const literalProblem = validatePackageLaunch(raw);
	if (literalProblem) return { problem: literalProblem };
	const spec = { ...(raw as MCPPackageLaunch) };
	if (spec.runner) spec.runner = expandEnvVarsDeep(spec.runner);
	if (spec.runtime) spec.runtime = expandEnvVarsDeep(spec.runtime);
	const problem = validatePackageLaunch(spec);
	return problem ? { problem } : { spec };
}

async function present(p: string): Promise<boolean> {
	try {
		await fs.promises.lstat(p);
		return true;
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return false;
		throw new MCPPackageLaunchError(`Cannot inspect path: ${p}`);
	}
}

async function readManifest(p: string): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		const stats = await fs.promises.stat(p);
		if (!stats.isFile()) throw new MCPPackageLaunchError(`Expected a regular file: ${p}`);
		if (stats.size > MAX_MANIFEST_BYTES)
			throw new MCPPackageLaunchError(`File exceeds ${MAX_MANIFEST_BYTES} bytes: ${p}`);
		value = JSON.parse(await Bun.file(p).text());
	} catch (error) {
		if (error instanceof MCPPackageLaunchError) throw error;
		throw new MCPPackageLaunchError(`Cannot read package manifest: ${p}`);
	}
	if (!isRecord(value)) throw new MCPPackageLaunchError(`Expected a JSON object in ${p}`);
	return value;
}

/** How a directory on the upward walk bounds the search for `node_modules`. */
type WalkStop = "root" | "package" | "none" | "uninspectable";

async function classifyWalkDir(dir: string): Promise<WalkStop> {
	const manifest = path.join(dir, "package.json");
	try {
		if (
			(await present(path.join(dir, ".git"))) ||
			(await present(path.join(dir, "pnpm-workspace.yaml"))) ||
			(await present(path.join(dir, "aube-workspace.yaml")))
		) {
			return "root";
		}
		if (!(await present(manifest))) return "none";
	} catch (error) {
		if (!(error instanceof MCPPackageLaunchError)) throw error;
		return "uninspectable";
	}
	try {
		const workspaces = (await readManifest(manifest)).workspaces;
		return workspaces && typeof workspaces === "object" ? "root" : "package";
	} catch (error) {
		if (!(error instanceof MCPPackageLaunchError)) throw error;
		return "package";
	}
}

/**
 * Directories searched for `node_modules`: `cwd` and its ancestors up to the nearest Git or
 * workspace root, never `home` (as given or its real path) or above. Without such a root, stops at
 * the nearest `package.json`. An unreadable `package.json` bounds the search but is not a workspace
 * root; a directory that cannot be inspected ends the walk as if no root was found.
 */
async function searchRoots(cwd: string, home: string): Promise<string[]> {
	const homes = new Set([path.resolve(home)]);
	try {
		homes.add(await fs.promises.realpath(home));
	} catch {
		// A missing home leaves only the resolved form to compare against.
	}
	const roots: string[] = [];
	let nearestPackage: number | undefined;
	for (let dir = cwd; ; dir = path.dirname(dir)) {
		if (dir !== cwd && (homes.has(dir) || path.dirname(dir) === dir)) break;
		const stop = await classifyWalkDir(dir);
		if (stop === "uninspectable") break;
		roots.push(dir);
		if (stop === "root") return roots;
		if (stop === "package") nearestPackage ??= roots.length;
		if (path.dirname(dir) === dir) break;
	}
	return nearestPackage !== undefined ? roots.slice(0, nearestPackage) : [cwd];
}

/** Real path of the installed package's bin entry, confined to the package directory. */
async function findInstalledBin(roots: string[], pkg: string, bin: string): Promise<string | undefined> {
	for (const root of roots) {
		const directory = path.join(root, "node_modules", pkg);
		if (!(await present(directory))) {
			if (await present(path.join(root, "node_modules", ".bin", bin))) {
				throw new MCPPackageLaunchError(
					`Local ${bin} shim exists without ${pkg} at ${root}; reinstall it or set policy "fallback-only"`,
				);
			}
			continue;
		}
		const manifestPath = path.join(directory, "package.json");
		const manifest = await readManifest(manifestPath);
		if (manifest.name !== pkg) throw new MCPPackageLaunchError(`Package identity mismatch in ${manifestPath}`);
		const bins = manifest.bin;
		const entry = isRecord(bins)
			? bins[bin]
			: typeof bins === "string" && bin === pkg.split("/").pop()
				? bins
				: undefined;
		if (typeof entry !== "string" || !entry || entry.includes("\0") || path.isAbsolute(entry)) {
			throw new MCPPackageLaunchError(`${manifestPath} does not declare a relative ${bin} bin entry`);
		}
		let packageReal: string;
		let executable: string;
		let isFile: boolean;
		try {
			packageReal = await fs.promises.realpath(directory);
			executable = await fs.promises.realpath(path.join(directory, entry));
			isFile = (await fs.promises.stat(executable)).isFile();
		} catch {
			throw new MCPPackageLaunchError(`Broken ${bin} bin entry for ${pkg} at ${directory}`);
		}
		// Checked at resolve time only: a swap before spawn needs write access to the project's
		// node_modules, which already lets an attacker replace the package itself.
		if (!executable.startsWith(packageReal + path.sep) || !isFile) {
			throw new MCPPackageLaunchError(`The ${bin} bin entry escapes ${pkg} or is not a file: ${directory}`);
		}
		return executable;
	}
	return undefined;
}

/**
 * Replaces a stdio config's `package` spec with the concrete `command` and `args` to spawn.
 *
 * `cwd` is the directory the server starts in; the search for an installed package begins there.
 * Rejects with {@link MCPPackageLaunchError} when the spec is invalid, the installed package is
 * broken, or `local-only` finds no installation.
 */
export async function resolvePackageLaunch(
	config: MCPStdioServerConfig & { package: MCPPackageLaunch },
	options: { cwd: string; home: string; defaults: MCPPackageLaunchDefaults },
): Promise<MCPStdioServerConfig> {
	const problem = validatePackageLaunch(config.package);
	if (problem) throw new MCPPackageLaunchError(`package ${problem}`);
	const { package: spec, ...base } = config;
	const policy = spec.policy ?? options.defaults.policy;
	const bin = spec.bin ?? spec.name.split("/").pop() ?? spec.name;
	const args = config.args ?? [];

	let cwd: string;
	try {
		cwd = await fs.promises.realpath(options.cwd);
	} catch {
		throw new MCPPackageLaunchError(`Server working directory does not exist: ${options.cwd}`);
	}
	const installed =
		policy === "fallback-only"
			? undefined
			: await findInstalledBin(await searchRoots(cwd, options.home), spec.name, bin);
	let argv: string[];
	if (installed) {
		argv = [...(spec.runtime ?? options.defaults.runtime), installed, ...args];
	} else if (policy === "local-only") {
		throw new MCPPackageLaunchError(`${spec.name} is not installed in this project and policy is "local-only"`);
	} else {
		argv = [...(spec.runner ?? options.defaults.runner), `${spec.name}@${spec.version ?? "latest"}`, ...args];
	}
	const [command, ...commandArgs] = argv;
	return { ...base, command, args: commandArgs };
}
