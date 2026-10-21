/**
 * Typed anchors of structured advisor findings: the `advise` `where` schema,
 * the display string shown in advisories, and the host-side anchor identity
 * used to recognize the same anchor across reports.
 *
 * Identities never leave the host: they are not shown to advisors or the
 * primary, and the tool result of an `advise` call is the same whether or not
 * computing the identity read a file.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger } from "@oh-my-pi/pi-utils";
import { expandTilde } from "../tools/path-utils";

const anchorLineSchema = type("1 <= number.integer <= 9007199254740991");

/** Sources an `instruction` anchor may quote. */
export const ADVISE_INSTRUCTION_SOURCES = ["user", "agents-md", "watchdog", "other"] as const;

/** `advise` `where`: a tagged union discriminated by `type`. */
export const adviseWhereSchema = type({
	type: "'file'",
	path: type("string").describe("File path, relative to the session cwd or absolute."),
	"line?": anchorLineSchema.describe("1-based line the finding is anchored to."),
	"endLine?": anchorLineSchema.describe("Last line of an anchored range."),
	"symbol?": type("string").describe("Function, type, or key at the anchor."),
})
	.or({ type: "'command'", text: type("string").describe("The shell command.") })
	.or({ type: "'tool-call'", id: type("string").describe("The tool call id.") })
	.or({
		type: "'instruction'",
		source: type.enumerated(...ADVISE_INSTRUCTION_SOURCES).describe("Where the instruction comes from."),
		quote: type("string").describe("The instruction, quoted verbatim."),
	})
	.or({ type: "'claim'", quote: type("string").describe("The claim, quoted verbatim.") })
	.or({
		type: "'approach'",
		topic: type("string").describe("The plan step, strategy, or verification approach, in a few words."),
	})
	.describe(
		"Where the finding is: a file location, a command, a tool call, a quoted instruction or claim, or an approach.",
	);

/** Anchor of a structured advisor finding. */
export type AdviseWhere = typeof adviseWhereSchema.infer;

/** A `file` anchor's path field split into the path, an embedded line range, and trailing label text. */
export interface ParsedFileAnchor {
	path: string;
	line?: number;
	endLine?: number;
	label?: string;
}

/** `path:line`, `path:line-end`, or `path:line:col`, then optional label text after whitespace. */
const PATH_WITH_LINE = /^(.+?):(\d+)(?:[-–](\d+))?(?::\d+)?(?:\s+(\S[\s\S]*))?$/;
/** `file.ext label…`: a whitespace-free path ending in an extension (optionally quoted), then label text. */
const PATH_WITH_LABEL = /^(\S*\.[A-Za-z0-9]+)[`'"]*\s+(\S[\s\S]*)$/;
const SURROUNDING_QUOTES = /^[`'"]+|[`'"]+$/g;

/**
 * Split a `file` anchor's `path` into the path proper, an embedded
 * `:line[-endLine]`, and trailing label text; explicit `line`/`endLine` fields
 * take precedence over the embedded range. Surrounding backticks and quotes are
 * stripped.
 */
export function parseFileAnchor(where: { path: string; line?: number; endLine?: number }): ParsedFileAnchor {
	const raw = where.path.trim().replace(SURROUNDING_QUOTES, "").trim();
	let filePath = raw;
	let line: number | undefined;
	let endLine: number | undefined;
	let label: string | undefined;
	const withLine = PATH_WITH_LINE.exec(raw);
	if (withLine) {
		filePath = withLine[1]!;
		line = Number(withLine[2]);
		endLine = withLine[3] === undefined ? undefined : Number(withLine[3]);
		label = withLine[4]?.trim() || undefined;
	} else {
		const withLabel = PATH_WITH_LABEL.exec(raw);
		if (withLabel) {
			filePath = withLabel[1]!;
			label = withLabel[2]!.trim() || undefined;
		}
	}
	filePath = filePath.replace(SURROUNDING_QUOTES, "");
	if (where.line !== undefined) {
		line = where.line;
		endLine = where.endLine;
	} else if (where.endLine !== undefined) {
		endLine = where.endLine;
	}
	if (line === undefined || endLine === undefined || endLine <= line) endLine = undefined;
	const parsed: ParsedFileAnchor = { path: filePath };
	if (line !== undefined) parsed.line = line;
	if (endLine !== undefined) parsed.endLine = endLine;
	if (label !== undefined) parsed.label = label;
	return parsed;
}

/** Names of the anchor's required text fields that are empty after trimming, as `where.<field>`. */
export function emptyAnchorFields(where: AdviseWhere): string[] {
	switch (where.type) {
		case "file":
			return parseFileAnchor(where).path ? [] : ["where.path"];
		case "command":
			return where.text.trim() ? [] : ["where.text"];
		case "tool-call":
			return where.id.trim() ? [] : ["where.id"];
		case "instruction":
		case "claim":
			return where.quote.trim() ? [] : ["where.quote"];
		case "approach":
			return where.topic.trim() ? [] : ["where.topic"];
	}
}

/**
 * Display string of an anchor: `path[:line[-endLine]][ (symbol)][ label]` for a
 * file, otherwise the command text, tool call id, quote, or topic, trimmed.
 */
export function formatAnchorDisplay(where: AdviseWhere): string {
	switch (where.type) {
		case "file": {
			const parsed = parseFileAnchor(where);
			let display = parsed.path;
			if (parsed.line !== undefined) display += `:${parsed.line}`;
			if (parsed.endLine !== undefined) display += `-${parsed.endLine}`;
			const symbol = where.symbol?.trim();
			if (symbol) display += ` (${symbol})`;
			if (parsed.label) display += ` ${parsed.label}`;
			return display;
		}
		case "command":
			return where.text.trim();
		case "tool-call":
			return where.id.trim();
		case "instruction":
		case "claim":
			return where.quote.trim();
		case "approach":
			return where.topic.trim();
	}
}

/** Host facts the file-anchor read gate needs. */
export interface AnchorIdentityContext {
	/** Session cwd; relative anchor paths not matched through `writtenPaths` resolve against it. */
	cwd: string;
	/** Absolute workspace roots (see {@link discoverWorkspaceRoots}); only files whose real path lies inside one are read. */
	roots: readonly string[];
	/**
	 * Absolute paths the primary agent wrote this session, least recent first
	 * (see {@link recordWrittenPaths}). A relative anchor path resolves under
	 * the workspace root (`cwd` or a root in `roots`) where that path was most
	 * recently written; without such a write, against `cwd`.
	 */
	writtenPaths?: ReadonlySet<string>;
	/**
	 * Whether the reporting advisor may read the absolute file path without a
	 * prompt; consulted for the lexical and the real path before any read.
	 */
	canRead: (absolutePath: string) => boolean;
	/** Home directory for `~` expansion; defaults to the OS home. */
	home?: string;
}

/** Largest file the identity read loads. */
const MAX_ANCHOR_READ_BYTES = 16 * 1024 * 1024;

function collapseWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function sha256(text: string): string {
	return Bun.SHA256.hash(text, "hex");
}

/** Absolute path of a file anchor's path (see {@link AnchorIdentityContext.writtenPaths}). */
function resolveAnchorPath(anchorPath: string, ctx: AnchorIdentityContext): string {
	const expanded = expandTilde(anchorPath, ctx.home);
	const fallback = path.resolve(ctx.cwd, expanded);
	if (path.isAbsolute(expanded) || !ctx.writtenPaths?.size) return fallback;
	const candidates = new Set([fallback, ...ctx.roots.map(root => path.resolve(root, expanded))]);
	let latest: string | undefined;
	for (const written of ctx.writtenPaths) if (candidates.has(written)) latest = written;
	return latest ?? fallback;
}

/** Most paths {@link recordWrittenPaths} keeps; the least recently written is dropped first. */
export const MAX_TRACKED_WRITTEN_PATHS = 1024;

const URL_PATH = /^[a-z][a-z0-9+.-]*:\/\//i;

/** `value` when it is a non-empty host path (not an internal URL), else undefined. */
function hostPath(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && !URL_PATH.test(value) ? value : undefined;
}

/** Files a `write` (`resolvedPath`) or `edit` (`path`, `perFileResults[].path`) result changed. */
function changedPaths(details: unknown): string[] {
	if (typeof details !== "object" || details === null) return [];
	const paths: string[] = [];
	const single =
		("resolvedPath" in details ? hostPath(details.resolvedPath) : undefined) ??
		("path" in details ? hostPath(details.path) : undefined);
	if (single !== undefined) paths.push(single);
	if ("perFileResults" in details && Array.isArray(details.perFileResults)) {
		for (const entry of details.perFileResults) {
			const changed =
				typeof entry === "object" && entry !== null && "path" in entry ? hostPath(entry.path) : undefined;
			if (changed !== undefined) paths.push(changed);
		}
	}
	return paths;
}

/**
 * Record the files changed by the successful `edit` and `write` results of
 * the last turn of `messages` (the tool results after its last assistant
 * message) into `written` as absolute paths resolved against `cwd`, each
 * moved to the most recent position. Past {@link MAX_TRACKED_WRITTEN_PATHS}
 * the least recent paths are dropped.
 */
export function recordWrittenPaths(written: Set<string>, messages: readonly AgentMessage[], cwd: string): void {
	let start = messages.length;
	while (start > 0 && messages[start - 1]!.role !== "assistant") start--;
	for (const message of messages.slice(start)) {
		if (message.role !== "toolResult" || message.isError) continue;
		if (message.toolName !== "edit" && message.toolName !== "write") continue;
		for (const changed of changedPaths(message.details)) {
			const absolute = path.resolve(cwd, changed);
			written.delete(absolute);
			written.add(absolute);
		}
	}
	for (const oldest of written) {
		if (written.size <= MAX_TRACKED_WRITTEN_PATHS) break;
		written.delete(oldest);
	}
}

/** `target` relative to the longest root containing it (POSIX separators), or undefined outside every root. */
function rootRelative(target: string, roots: readonly string[]): string | undefined {
	let best: string | undefined;
	for (const root of roots) {
		if (target !== root && !target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) continue;
		if (best === undefined || root.length > best.length) best = root;
	}
	if (best === undefined) return undefined;
	return path.relative(best, target).split(path.sep).join("/") || ".";
}

/** Content hash and occurrence index of line `line` (1-based), or undefined past the end. */
function lineDigest(content: string, line: number): { hash: string; occurrence: number } | undefined {
	const lines = content.split(/\r?\n/);
	if (line > lines.length) return undefined;
	const target = collapseWhitespace(lines[line - 1]!);
	let occurrence = 0;
	for (let index = 0; index < line - 1; index++) {
		if (collapseWhitespace(lines[index]!) === target) occurrence++;
	}
	return { hash: sha256(target), occurrence };
}

async function readAnchoredLine(
	realPath: string,
	line: number,
): Promise<{ hash: string; occurrence: number } | undefined> {
	const stat = await fs.stat(realPath);
	if (!stat.isFile() || stat.size > MAX_ANCHOR_READ_BYTES) return undefined;
	return lineDigest(await Bun.file(realPath).text(), line);
}

async function fileIdentity(
	where: Extract<AdviseWhere, { type: "file" }>,
	ctx: AnchorIdentityContext | undefined,
): Promise<string> {
	const parsed = parseFileAnchor(where);
	const lineSuffix = parsed.line === undefined ? "" : `:${parsed.line}`;
	if (!ctx) return `file:${path.posix.normalize(parsed.path.replaceAll("\\", "/"))}${lineSuffix}`;
	const absolute = resolveAnchorPath(parsed.path, ctx);
	const lexical = rootRelative(absolute, ctx.roots) ?? absolute;
	if (parsed.line !== undefined) {
		try {
			const realPath = await fs.realpath(absolute);
			const canonical = rootRelative(realPath, ctx.roots);
			if (canonical !== undefined && ctx.canRead(absolute) && (realPath === absolute || ctx.canRead(realPath))) {
				const digest = await readAnchoredLine(realPath, parsed.line);
				if (digest) return `file:${canonical}#${digest.hash}:${digest.occurrence}`;
			}
		} catch (err) {
			logger.debug("advisor anchor read skipped", { error: String(err) });
		}
	}
	return `file:${lexical}${lineSuffix}`;
}

/**
 * Host-side identity of an anchor; never rejects.
 *
 * - file: with `ctx`, a line, a real path (symlinks resolved) inside a
 *   workspace root, and `ctx.canRead` allowing both the given and the real
 *   path, `file:<root-relative real path>#<sha256 of the whitespace-normalized
 *   line>:<index among earlier identical lines>`, so the identity survives
 *   line shifts. Otherwise the file is not read and the identity is
 *   `file:<root-relative or absolute normalized path>[:<line>]`.
 * - command: whitespace-normalized text; tool-call: id; instruction: source
 *   and sha256 of the quote; claim: sha256 of the quote; approach: lower-kebab topic.
 */
export async function resolveAnchorIdentity(where: AdviseWhere, ctx?: AnchorIdentityContext): Promise<string> {
	switch (where.type) {
		case "file":
			return fileIdentity(where, ctx);
		case "command":
			return `command:${collapseWhitespace(where.text)}`;
		case "tool-call":
			return `tool-call:${where.id.trim()}`;
		case "instruction":
			return `instruction:${where.source}:${sha256(collapseWhitespace(where.quote))}`;
		case "claim":
			return `claim:${sha256(collapseWhitespace(where.quote))}`;
		case "approach":
			return `approach:${where.topic
				.normalize("NFKC")
				.toLowerCase()
				.replace(/[^\p{L}\p{N}]+/gu, "-")
				.replace(/^-+|-+$/g, "")}`;
	}
}

/** Whether `identity` (see {@link resolveAnchorIdentity}) is an `approach` anchor's. */
export function isApproachIdentity(identity: string): boolean {
	return identity.startsWith("approach:");
}

/** The lexical absolute path of a file anchor and, when it exists, its real path. */
async function anchorPaths(
	where: Extract<AdviseWhere, { type: "file" }>,
	ctx: AnchorIdentityContext,
): Promise<{ absolute: string; realPath: string | undefined }> {
	const absolute = resolveAnchorPath(parseFileAnchor(where).path, ctx);
	try {
		return { absolute, realPath: await fs.realpath(absolute) };
	} catch {
		return { absolute, realPath: undefined };
	}
}

/**
 * Whether `ctx.canRead` allows a file anchor's path and, when it exists, its
 * real path. No file content is read.
 */
export async function canReadFileAnchor(
	where: Extract<AdviseWhere, { type: "file" }>,
	ctx: AnchorIdentityContext,
): Promise<boolean> {
	const { absolute, realPath } = await anchorPaths(where, ctx);
	return ctx.canRead(absolute) && (realPath === undefined || realPath === absolute || ctx.canRead(realPath));
}

const READ_IDENTITY = /^file:.*#([0-9a-f]{64}):(\d+)$/;

/**
 * Whether the line a read identity (see {@link resolveAnchorIdentity}) hashed
 * still appears in the anchored file at the same occurrence index, anywhere
 * in the file. Undefined when the identity is not a read identity or the read
 * gate of {@link resolveAnchorIdentity} does not allow the read; `false` when
 * the gate allows the path and the file no longer exists.
 */
export async function fileAnchorLinePresent(
	where: Extract<AdviseWhere, { type: "file" }>,
	identity: string,
	ctx: AnchorIdentityContext,
): Promise<boolean | undefined> {
	const match = READ_IDENTITY.exec(identity);
	if (!match) return undefined;
	const { absolute, realPath } = await anchorPaths(where, ctx);
	if (!ctx.canRead(absolute)) return undefined;
	if (realPath === undefined) return false;
	if (rootRelative(realPath, ctx.roots) === undefined || (realPath !== absolute && !ctx.canRead(realPath))) {
		return undefined;
	}
	try {
		const stat = await fs.stat(realPath);
		if (!stat.isFile() || stat.size > MAX_ANCHOR_READ_BYTES) return undefined;
		const hash = match[1]!;
		const occurrence = Number(match[2]);
		let seen = 0;
		for (const line of (await Bun.file(realPath).text()).split(/\r?\n/)) {
			if (sha256(collapseWhitespace(line)) === hash && seen++ === occurrence) return true;
		}
		return false;
	} catch (err) {
		logger.debug("advisor anchor line check skipped", { error: String(err) });
		return undefined;
	}
}

/**
 * Workspace roots of a session: `cwd` and every worktree of its Git
 * repository, each as given and as its real path. Outside Git, only `cwd`.
 */
export async function discoverWorkspaceRoots(cwd: string): Promise<string[]> {
	const roots = new Set<string>();
	const add = async (dir: string): Promise<void> => {
		const absolute = path.resolve(dir);
		roots.add(absolute);
		try {
			roots.add(await fs.realpath(absolute));
		} catch {
			// A missing worktree contributes only its listed path.
		}
	};
	await add(cwd);
	try {
		const repository = vcs.git(cwd);
		if (repository) {
			for (const entry of await repository.worktrees()) await add(entry.path);
		}
	} catch (err) {
		logger.debug("advisor workspace roots: worktree listing failed", { error: String(err) });
	}
	return [...roots];
}
