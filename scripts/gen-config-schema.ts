#!/usr/bin/env bun
/**
 * Generates `packages/coding-agent/src/config/omp-config.schema.json`, the JSON
 * Schema of `config.yml`, from the settings registry (the same output as
 * `omp config schema`). The file is published as a release asset.
 *
 * Usage:
 *   bun scripts/gen-config-schema.ts          # rewrite the schema file
 *   bun scripts/gen-config-schema.ts --check  # exit 1 when the file is stale
 */
import * as path from "node:path";
import { renderSettingsSchema } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { isEnoent } from "@oh-my-pi/pi-utils";

const repoRoot = path.join(import.meta.dir, "..");
const relativePath = "packages/coding-agent/src/config/omp-config.schema.json";
const outputPath = path.join(repoRoot, relativePath);

async function readCurrent(): Promise<string | undefined> {
	try {
		return await Bun.file(outputPath).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

const args = process.argv.slice(2);
const unknownArgs = args.filter(arg => arg !== "--check");
if (unknownArgs.length > 0) {
	console.error(`Unknown argument(s): ${unknownArgs.join(" ")}\nUsage: bun scripts/gen-config-schema.ts [--check]`);
	process.exit(2);
}
const check = args.includes("--check");

const expected = renderSettingsSchema();
const current = await readCurrent();

if (check) {
	if (current !== expected) {
		console.error(
			`${relativePath} is stale relative to the settings registry.\n` +
				"Run `bun run gen:config-schema` and commit the result.",
		);
		process.exit(1);
	}
	console.log(`${relativePath} is in sync with the settings registry.`);
} else if (current === expected) {
	console.log(`${relativePath} already up to date.`);
} else {
	await Bun.write(outputPath, expected);
	console.log(`Wrote ${relativePath}.`);
}
