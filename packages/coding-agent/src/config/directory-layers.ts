import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeDirectoryName } from "@oh-my-pi/pi-utils/directory-name";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

/** A directory-layer write target and the file that stores it. */
export interface DirectoryLayerTarget {
	dir: string;
	file: string;
	exists: boolean;
	label: "root" | "home" | "tmp" | "dir";
}

/** Layer file for canonical `dir` under `agentDir`, named like that directory's session folder. */
export function directoryLayerFile(agentDir: string, dir: string): string {
	return path.join(
		agentDir,
		"directories",
		encodeDirectoryName(dir, resolveEquivalentPath(os.homedir()), resolveEquivalentPath(os.tmpdir())),
		"config.yml",
	);
}

/** Returns canonical ancestors, outermost first, including the filesystem root. */
export function directoryAncestors(cwd: string): string[] {
	let dir = resolveEquivalentPath(path.resolve(cwd));
	const dirs: string[] = [];
	for (;;) {
		dirs.push(dir);
		const parent = path.dirname(dir);
		if (parent === dir) return dirs.reverse();
		dir = parent;
	}
}

/** Canonical `cwd` plus every ancestor with an existing layer file, deepest first. */
export async function directoryLayerTargets(agentDir: string, cwd: string): Promise<DirectoryLayerTarget[]> {
	const home = resolveEquivalentPath(os.homedir());
	const temp = resolveEquivalentPath(os.tmpdir());
	const ancestors = directoryAncestors(cwd).reverse();
	const targets: DirectoryLayerTarget[] = [];
	for (const [index, dir] of ancestors.entries()) {
		const file = directoryLayerFile(agentDir, dir);
		let exists = false;
		try {
			exists = (await fs.promises.stat(file)).isFile();
		} catch {}
		if (index === 0 || exists)
			targets.push({
				dir,
				file,
				exists,
				label: path.dirname(dir) === dir ? "root" : dir === home ? "home" : dir === temp ? "tmp" : "dir",
			});
	}
	return targets;
}
