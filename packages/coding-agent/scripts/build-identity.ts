import { $ } from "bun";
import type { BuildIdentity } from "../src/build-identity";

/** Captures tracked checkout changes and UTC build time; unavailable Git metadata is unknown. */
export async function captureBuildIdentity(repoRoot: string): Promise<BuildIdentity> {
	const buildTime = new Date().toISOString();
	try {
		const head = await $`git rev-parse --short=10 HEAD`.cwd(repoRoot).quiet().nothrow();
		const diff = await $`git diff --quiet HEAD --`.cwd(repoRoot).quiet().nothrow();
		return {
			commit: head.exitCode === 0 ? head.text().trim() : "unknown",
			dirty: diff.exitCode === 0 ? false : diff.exitCode === 1 ? true : undefined,
			buildTime,
		};
	} catch {
		return { commit: "unknown", buildTime };
	}
}
