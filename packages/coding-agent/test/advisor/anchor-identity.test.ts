import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isAllowedWithoutPrompt } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
	AdviseTool,
	type AdvisorAdvice,
	type AdviseWhere,
	adviseWhereSchema,
	type AnchorIdentityContext,
	discoverWorkspaceRoots,
	formatAnchorDisplay,
	parseFileAnchor,
	resolveAnchorIdentity,
} from "../../src/advisor";

describe("parseFileAnchor", () => {
	it("splits the real path spellings advisors send", () => {
		expect(parseFileAnchor({ path: "packages/ai/src/auth-broker/server.ts:1043" })).toEqual({
			path: "packages/ai/src/auth-broker/server.ts",
			line: 1043,
		});
		expect(parseFileAnchor({ path: "auth-broker/server.ts:1043 reversed-auth probe" })).toEqual({
			path: "auth-broker/server.ts",
			line: 1043,
			label: "reversed-auth probe",
		});
		expect(parseFileAnchor({ path: "usage-amounts.ts:122-126" })).toEqual({
			path: "usage-amounts.ts",
			line: 122,
			endLine: 126,
		});
		expect(parseFileAnchor({ path: "~/.omp/agent/WATCHDOG.yml:11-14" })).toEqual({
			path: "~/.omp/agent/WATCHDOG.yml",
			line: 11,
			endLine: 14,
		});
		expect(parseFileAnchor({ path: "`src/retry.ts` backoff loop" })).toEqual({
			path: "src/retry.ts",
			label: "backoff loop",
		});
	});

	it("prefers explicit line fields over an embedded range and drops an inverted range", () => {
		expect(parseFileAnchor({ path: "src/a.ts:3", line: 9, endLine: 12 })).toEqual({
			path: "src/a.ts",
			line: 9,
			endLine: 12,
		});
		expect(parseFileAnchor({ path: "src/a.ts", line: 9, endLine: 4 })).toEqual({ path: "src/a.ts", line: 9 });
	});

	it("renders one display string per anchor type", () => {
		expect(formatAnchorDisplay({ type: "file", path: "auth-broker/server.ts:1043 reversed-auth probe" })).toBe(
			"auth-broker/server.ts:1043 reversed-auth probe",
		);
		expect(formatAnchorDisplay({ type: "file", path: " src/a.ts ", line: 4, endLine: 6, symbol: "retry" })).toBe(
			"src/a.ts:4-6 (retry)",
		);
		expect(formatAnchorDisplay({ type: "command", text: " bun test " })).toBe("bun test");
		expect(formatAnchorDisplay({ type: "tool-call", id: "toolu_1" })).toBe("toolu_1");
		expect(formatAnchorDisplay({ type: "instruction", source: "user", quote: "no stubs" })).toBe("no stubs");
		expect(formatAnchorDisplay({ type: "claim", quote: "tests pass" })).toBe("tests pass");
		expect(formatAnchorDisplay({ type: "approach", topic: "test plan" })).toBe("test plan");
	});

	it("rejects the untyped `ref` anchor and unknown instruction sources", () => {
		expect(adviseWhereSchema({ type: "file", ref: "src/a.ts:1" }) instanceof type.errors).toBe(true);
		expect(adviseWhereSchema({ type: "instruction", source: "boss", quote: "q" }) instanceof type.errors).toBe(true);
		expect(adviseWhereSchema({ type: "instruction", source: "agents-md", quote: "q" })).toEqual({
			type: "instruction",
			source: "agents-md",
			quote: "q",
		});
	});
});

describe("resolveAnchorIdentity", () => {
	let base: string;
	let root: string;
	let outside: string;
	let ctx: AnchorIdentityContext;

	const file = (filePath: string, line?: number): AdviseWhere =>
		line === undefined ? { type: "file", path: filePath } : { type: "file", path: filePath, line };

	beforeEach(async () => {
		base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-anchor-")));
		root = path.join(base, "root");
		outside = path.join(base, "outside");
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await Bun.write(path.join(root, "src", "retry.ts"), "const a = 1;\nlet budget = 3;\nwhile (budget) {}\n");
		await Bun.write(path.join(outside, "secret.ts"), "const secret = 1;\n");
		ctx = { cwd: root, roots: [root], canRead: () => true, home: path.join(base, "home") };
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it("gives every spelling of an in-root line the same content identity", async () => {
		const identity = await resolveAnchorIdentity(file("src/retry.ts", 2), ctx);
		expect(identity).toMatch(/^file:src\/retry\.ts#[0-9a-f]{64}:0$/);
		for (const spelling of [
			file("./src/retry.ts", 2),
			file(path.join(root, "src", "retry.ts"), 2),
			file("src/retry.ts:2"),
			file("src/retry.ts:2-3 budget loop"),
			file("src/../src/retry.ts", 2),
		]) {
			expect(await resolveAnchorIdentity(spelling, ctx)).toBe(identity);
		}
		expect(await resolveAnchorIdentity(file("retry.ts", 2), { ...ctx, cwd: path.join(root, "src") })).toBe(identity);
	});

	it("keeps the identity when the anchored line shifts", async () => {
		const before = await resolveAnchorIdentity(file("src/retry.ts", 2), ctx);
		await Bun.write(
			path.join(root, "src", "retry.ts"),
			"// header\n\nconst a = 1;\n   let   budget = 3;\nwhile (budget) {}\n",
		);
		expect(await resolveAnchorIdentity(file("src/retry.ts", 4), ctx)).toBe(before);
		expect(await resolveAnchorIdentity(file("src/retry.ts", 2), ctx)).not.toBe(before);
	});

	it("distinguishes identical lines by occurrence index", async () => {
		await Bun.write(path.join(root, "src", "dup.ts"), "retry();\nother();\nretry();\n");
		const first = await resolveAnchorIdentity(file("src/dup.ts", 1), ctx);
		const second = await resolveAnchorIdentity(file("src/dup.ts", 3), ctx);
		expect(first.endsWith(":0")).toBe(true);
		expect(second.endsWith(":1")).toBe(true);
		expect(first.slice(0, -2)).toBe(second.slice(0, -2));
	});

	it("does not read outside-root, `..`, absolute, `~`, and symlink-escape anchors", async () => {
		await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "src", "link.ts"));
		const secret = path.join(outside, "secret.ts");
		const cases: [AdviseWhere, string][] = [
			[file(secret, 1), `file:${secret}:1`],
			[file("../outside/secret.ts", 1), `file:${secret}:1`],
			[file("src/link.ts", 1), "file:src/link.ts:1"],
			[file("~/notes.md:3"), `file:${path.join(base, "home", "notes.md")}:3`],
		];
		for (const [where, expected] of cases) {
			const unread = await resolveAnchorIdentity(where, ctx);
			expect(unread).toBe(expected);
			await Bun.write(secret, "changed();\n");
			expect(await resolveAnchorIdentity(where, ctx)).toBe(unread);
		}
	});

	it("does not read without a read grant, a line, or an existing line", async () => {
		expect(await resolveAnchorIdentity(file("src/retry.ts", 2), { ...ctx, canRead: () => false })).toBe(
			"file:src/retry.ts:2",
		);
		expect(await resolveAnchorIdentity(file("src/retry.ts"), ctx)).toBe("file:src/retry.ts");
		expect(await resolveAnchorIdentity(file("src/retry.ts", 99), ctx)).toBe("file:src/retry.ts:99");
		expect(await resolveAnchorIdentity(file("src/missing.ts", 1), ctx)).toBe("file:src/missing.ts:1");
		expect(await resolveAnchorIdentity(file("src", 1), ctx)).toBe("file:src:1");
	});

	it("normalizes non-file anchors", async () => {
		expect(await resolveAnchorIdentity({ type: "command", text: "  bun   test\n src " })).toBe(
			"command:bun test src",
		);
		expect(await resolveAnchorIdentity({ type: "tool-call", id: " toolu_9 " })).toBe("tool-call:toolu_9");
		const instruction = await resolveAnchorIdentity({ type: "instruction", source: "user", quote: "no  stubs" });
		expect(instruction).toBe(
			await resolveAnchorIdentity({ type: "instruction", source: "user", quote: " no stubs " }),
		);
		expect(instruction).toMatch(/^instruction:user:[0-9a-f]{64}$/);
		expect(instruction).not.toBe(
			await resolveAnchorIdentity({ type: "instruction", source: "agents-md", quote: "no stubs" }),
		);
		expect(await resolveAnchorIdentity({ type: "claim", quote: "tests pass" })).toMatch(/^claim:[0-9a-f]{64}$/);
		expect(await resolveAnchorIdentity({ type: "approach", topic: " Test Plan: retries " })).toBe(
			"approach:test-plan-retries",
		);
	});

	it("returns byte-identical advise results whether or not the anchor was read", async () => {
		const run = async (canRead: boolean) => {
			const routed: AdvisorAdvice[] = [];
			const tool = new AdviseTool(advice => routed.push(advice), undefined, {
				resolveAnchorIdentity: where => resolveAnchorIdentity(where, { ...ctx, canRead: () => canRead }),
			});
			const result = await tool.execute("a-0", {
				kind: "defect",
				severity: "nit",
				where: { type: "file", path: "src/retry.ts", line: 2 },
				defect: "budget is never decremented",
			});
			return { result, routed };
		};
		const read = await run(true);
		const unread = await run(false);
		expect(JSON.stringify(read.result)).toBe(JSON.stringify(unread.result));
		expect(read.routed[0]?.anchorIdentity).toMatch(/#[0-9a-f]{64}:0$/);
		expect(unread.routed[0]?.anchorIdentity).toBe("file:src/retry.ts:2");
		expect(JSON.stringify(read.result)).not.toContain(read.routed[0]!.anchorIdentity);
	});

	describe("read tool policy gate", () => {
		const policyGate = (settings: Record<string, unknown> | undefined) => {
			const session = {
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
			} as unknown as ToolSession;
			const readTool = new ReadTool(session);
			const context = settings === undefined ? undefined : { settings: Settings.isolated(settings) };
			const asked: string[] = [];
			return {
				asked,
				canRead: (absolutePath: string) => {
					asked.push(absolutePath);
					return isAllowedWithoutPrompt(readTool, { path: absolutePath }, context, "anchor-test");
				},
			};
		};
		const advise = async (canRead: (absolutePath: string) => boolean) => {
			const routed: AdvisorAdvice[] = [];
			const tool = new AdviseTool(advice => routed.push(advice), undefined, {
				resolveAnchorIdentity: where => resolveAnchorIdentity(where, { ...ctx, canRead }),
			});
			const result = await tool.execute("p-0", {
				kind: "defect",
				where: { type: "file", path: "src/retry.ts", line: 2 },
				defect: "budget is never decremented",
			});
			return { result: JSON.stringify(result), identity: routed[0]?.anchorIdentity };
		};

		it("reads only on an unconditional allow for the exact path", async () => {
			const allowed = policyGate({ "tools.approvalMode": "yolo" });
			const read = await advise(allowed.canRead);
			expect(read.identity).toMatch(/^file:src\/retry\.ts#[0-9a-f]{64}:0$/);
			expect(allowed.asked).toEqual([path.join(root, "src", "retry.ts")]);

			const cases = {
				denied: { "tools.approvalMode": "yolo", "tools.approval": { read: "deny" } },
				"ask-required": { "tools.approvalMode": "yolo", "tools.approval": { read: "prompt" } },
				"ask-required for an ungranted path": { "tools.approvalMode": "always-ask-cached" },
				"unavailable policy": undefined,
			};
			for (const [label, settings] of Object.entries(cases)) {
				const unread = await advise(policyGate(settings).canRead);
				expect({ label, identity: unread.identity }).toEqual({ label, identity: "file:src/retry.ts:2" });
				expect(unread.result).toBe(read.result);
			}
		});

		it("checks the real path of a symlink inside the root as well", async () => {
			await fs.symlink(path.join(root, "src", "retry.ts"), path.join(root, "alias.ts"));
			const gate = policyGate({ "tools.approvalMode": "yolo" });
			const identity = await resolveAnchorIdentity(file("alias.ts", 2), { ...ctx, canRead: gate.canRead });
			expect(identity).toBe(await resolveAnchorIdentity(file("src/retry.ts", 2), ctx));
			expect(gate.asked).toEqual([path.join(root, "alias.ts"), path.join(root, "src", "retry.ts")]);
			const realDenied = await resolveAnchorIdentity(file("alias.ts", 2), {
				...ctx,
				canRead: absolutePath => absolutePath !== path.join(root, "src", "retry.ts"),
			});
			expect(realDenied).toBe("file:alias.ts:2");
		});
	});

	it("treats a sibling git worktree as a workspace root", async () => {
		const repo = path.join(base, "repo");
		const sibling = path.join(base, "sibling");
		await fs.mkdir(repo);
		await Bun.write(path.join(repo, "lib.ts"), "export const x = 1;\nexport const y = 2;\n");
		const git = (...args: string[]) =>
			Bun.$`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`.cwd(repo).quiet();
		await git("init", "-q");
		await git("add", ".");
		await git("commit", "-qm", "init");
		await git("worktree", "add", "-q", sibling);
		const roots = await discoverWorkspaceRoots(repo);
		expect(roots).toContain(sibling);
		const siblingCtx = { cwd: repo, roots, canRead: () => true };
		const identity = await resolveAnchorIdentity(file(path.join(sibling, "lib.ts"), 2), siblingCtx);
		expect(identity).toMatch(/^file:lib\.ts#[0-9a-f]{64}:0$/);
		expect(await resolveAnchorIdentity(file(path.join(sibling, "lib.ts"), 2), { ...siblingCtx, roots: [repo] })).toBe(
			`file:${path.join(sibling, "lib.ts")}:2`,
		);
	});
});
