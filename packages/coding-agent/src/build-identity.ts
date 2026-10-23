import type { RuntimeIdentity } from "./session/runtime-identity";

export interface BuildIdentity {
	commit: string;
	dirty?: boolean;
	buildTime: string;
}

declare const __OMP_BUILD_IDENTITY__: BuildIdentity | undefined;

/** Build-time identity embedded in standalone executables; absent in source and package runs. */
export function getBuildIdentity(): BuildIdentity | undefined {
	return typeof __OMP_BUILD_IDENTITY__ === "undefined" ? undefined : __OMP_BUILD_IDENTITY__;
}

/** UTC build timestamp displayed to minute precision. */
export function formatBuildTime(buildTime: string): string {
	return `${buildTime.slice(0, 10)} ${buildTime.slice(11, 16)} UTC`;
}

/** One-line CLI and welcome version, including embedded build metadata or a source marker. */
export function formatVersion(identity: RuntimeIdentity): string {
	const details: string[] = [];
	if (identity.commit) details.push(identity.commit.slice(0, 10));
	if (identity.buildTime) {
		if (identity.dirty) details.push("dirty");
		details.push(formatBuildTime(identity.buildTime));
	} else {
		details.push("source");
	}
	return `omp/${identity.version} (${details.join(", ")})`;
}
