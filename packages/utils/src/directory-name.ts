import * as path from "node:path";

/** Encodes canonical directory paths using the session directory naming contract. */
export function encodeDirectoryName(cwd: string, home: string, tempRoot: string, pathApi: typeof path = path): string {
	const relativeName = (prefix: string, relative: string): string => {
		const encoded = relative.replace(/[/\\:]/g, "-");
		return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
	};
	const within = (relative: string): boolean =>
		relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
	const tempRelative = pathApi.relative(tempRoot, cwd);
	if (within(tempRelative)) return relativeName("-tmp", tempRelative);
	const homeRelative = pathApi.relative(home, cwd);
	if (within(homeRelative)) return relativeName("-", homeRelative);
	return `--${pathApi
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}
