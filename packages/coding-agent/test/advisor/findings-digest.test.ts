import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ADVISOR_FINDINGS_DIGEST_LIMIT,
	type AdvisorFinding,
	AdvisorFindingsLedger,
	type AnchorIdentityContext,
	canReadFileAnchor,
	fileAnchorLinePresent,
	renderFindingsDigest,
	resolveAnchorIdentity,
} from "../../src/advisor";

function finding(id: number, overrides: Partial<AdvisorFinding> = {}): AdvisorFinding {
	return {
		id: `F${id}`,
		category: "logic",
		identity: `claim:${id}`,
		anchor: `claim ${id}`,
		owner: "Correctness",
		status: "open",
		severity: "concern",
		reports: [
			{ advisor: "Correctness", kind: "defect", defect: `secret defect ${id}`, turn: id, owner: true },
			{ advisor: "Security", kind: "defect", defect: "other", turn: id, owner: false },
		],
		createdTurn: id,
		lastTouchedTurn: id,
		...overrides,
	};
}

const viewAll = { owns: () => true, canReadAnchor: () => true };

describe("renderFindingsDigest", () => {
	it("lists open findings blockers first, then concerns, then nits, newest first, without report or anchor text", () => {
		const digest = renderFindingsDigest(
			[
				finding(1, { severity: "blocker" }),
				finding(2),
				finding(3, { severity: "nit" }),
				finding(4, { severity: "blocker", owner: undefined, category: "security" }),
				finding(5, { status: "resolved" }),
			],
			viewAll,
		);
		expect(digest).toBeDefined();
		const lines = digest!.split("\n").filter(line => line.startsWith("- F"));
		expect(lines).toEqual([
			"- F4 security blocker owner=- reporters=2",
			"- F1 logic blocker owner=Correctness reporters=2",
			"- F2 logic concern owner=Correctness reporters=2",
			"- F3 logic nit owner=Correctness reporters=2",
		]);
		expect(digest).not.toContain("secret defect");
		expect(digest).not.toContain("claim 1");
	});

	it("caps the digest and counts the rest", () => {
		const findings = Array.from({ length: ADVISOR_FINDINGS_DIGEST_LIMIT + 3 }, (_, i) => finding(i + 1));
		const digest = renderFindingsDigest(findings, viewAll)!;
		expect(digest.split("\n").filter(line => line.startsWith("- F"))).toHaveLength(ADVISOR_FINDINGS_DIGEST_LIMIT);
		expect(digest).toContain("- and 3 more");
		expect(digest).toContain("- F15 ");
		expect(digest).not.toContain("- F3 ");
	});

	it("shows a file anchor only to an advisor allowed to read it, and the changed-line hint only to the owner", () => {
		const fileFinding = finding(1, {
			where: { type: "file", path: "src/auth.ts", line: 10, symbol: "check" },
			anchor: "src/auth.ts:10 (check) label text",
			possiblyFixed: true,
		});
		const owner = renderFindingsDigest([fileFinding], { owns: () => true, canReadAnchor: () => true })!;
		expect(owner).toContain("- F1 logic concern owner=Correctness reporters=2 at src/auth.ts:10 possibly-fixed");
		expect(owner).not.toContain("label text");
		const reader = renderFindingsDigest([fileFinding], { owns: () => false, canReadAnchor: () => true })!;
		expect(reader).toContain("reporters=2 at src/auth.ts:10\n");
		const blind = renderFindingsDigest([fileFinding], { owns: () => false, canReadAnchor: () => false })!;
		expect(blind).toContain("- F1 logic concern owner=Correctness reporters=2\n");
		expect(blind).not.toContain("src/auth.ts");
	});

	it("shows an approach topic to every advisor and no other non-file anchor text", () => {
		const approach = finding(1, { identity: "approach:worktree-isolation", anchor: "worktree\n isolation" });
		const command = finding(2, { identity: "command:rm -rf build", anchor: "rm -rf build" });
		const blind = { owns: () => false, canReadAnchor: () => false };
		const digest = renderFindingsDigest([approach, command], blind)!;
		expect(digest).toContain('- F1 logic concern owner=Correctness reporters=2 approach="worktree isolation"\n');
		expect(digest).toContain("- F2 logic concern owner=Correctness reporters=2\n");
		expect(digest).not.toContain("rm -rf");
	});

	it("is undefined when nothing is open", () => {
		expect(renderFindingsDigest([finding(1, { status: "expired" })], viewAll)).toBeUndefined();
	});
});

describe("file anchor re-checks", () => {
	let root: string;
	let ctx: AnchorIdentityContext;
	let allowed: (absolutePath: string) => boolean;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "advisor-digest-")));
		allowed = () => true;
		ctx = { cwd: root, roots: [root], canRead: absolutePath => allowed(absolutePath) };
		await fs.writeFile(path.join(root, "auth.ts"), "a\nif (token == expected) {\nb\n");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const where = { type: "file", path: "auth.ts", line: 2 } as const;

	it("keeps the anchored line present across line shifts and reports it gone once changed", async () => {
		const identity = await resolveAnchorIdentity(where, ctx);
		await fs.writeFile(path.join(root, "auth.ts"), "x\ny\na\nif (token == expected) {\nb\n");
		expect(await fileAnchorLinePresent(where, identity, ctx)).toBe(true);
		await fs.writeFile(path.join(root, "auth.ts"), "a\nif (timingSafeEqual(token, expected)) {\nb\n");
		expect(await fileAnchorLinePresent(where, identity, ctx)).toBe(false);
		await fs.rm(path.join(root, "auth.ts"));
		expect(await fileAnchorLinePresent(where, identity, ctx)).toBe(false);
	});

	it("does not check without the read gate or a read identity", async () => {
		const identity = await resolveAnchorIdentity(where, ctx);
		allowed = () => false;
		expect(await fileAnchorLinePresent(where, identity, ctx)).toBeUndefined();
		expect(await canReadFileAnchor(where, ctx)).toBe(false);
		allowed = () => true;
		expect(await canReadFileAnchor(where, ctx)).toBe(true);
		expect(await fileAnchorLinePresent(where, "file:auth.ts:2", ctx)).toBeUndefined();
	});

	it("gates the real path of a symlinked anchor", async () => {
		const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "advisor-digest-out-")));
		try {
			await fs.writeFile(path.join(outside, "secret.ts"), "s\n");
			await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
			allowed = absolutePath => absolutePath.startsWith(root);
			expect(await canReadFileAnchor({ type: "file", path: "link.ts", line: 1 }, ctx)).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("AdvisorFindingsLedger relations", () => {
	const input = {
		advisor: "Security",
		category: "security",
		identity: "claim:x",
		anchor: "x",
		kind: "defect",
		severity: "concern",
		defect: "Lead.",
	} as const;

	it("records a related duplicate of the lead report as a reporter only, and resolves", () => {
		const ledger = new AdvisorFindingsLedger({ ownerOf: () => "Security" });
		const outcome = ledger.record(input);
		if (outcome.type !== "new") throw new Error("expected a new finding");
		const repeat = ledger.recordRelated(outcome.finding, { ...input, advisor: "Correctness", relation: "duplicate" });
		expect(repeat.type).toBe("duplicate");
		expect(ledger.reporters(outcome.finding)).toEqual(["Security", "Correctness"]);
		const adds = ledger.recordRelated(outcome.finding, {
			...input,
			advisor: "Correctness",
			defect: "More.",
			relation: "adds",
		});
		expect(adds.type).toBe("attached");
		expect(outcome.finding.reports.at(-1)?.relation).toBe("adds");
		expect(ledger.isOwner(outcome.finding, "Security")).toBe(true);
		expect(ledger.isOwner(outcome.finding, "Correctness")).toBe(false);
		expect(ledger.resolve(outcome.finding.id)).toBe(true);
		expect(ledger.findOpen("security", "claim:x")).toBeUndefined();
		expect(ledger.resolve(outcome.finding.id)).toBe(false);
	});

	it("always joins a resolved report, even one repeating a report's text", () => {
		const ledger = new AdvisorFindingsLedger({ ownerOf: () => "Security" });
		const outcome = ledger.record(input);
		if (outcome.type !== "new") throw new Error("expected a new finding");
		const resolved = ledger.recordRelated(outcome.finding, { ...input, relation: "resolved" });
		expect(resolved.type).toBe("attached");
		expect(outcome.finding.reports.at(-1)?.relation).toBe("resolved");
	});

	it("round-trips a finding's file anchor and changed-line mark through a snapshot", () => {
		const ledger = new AdvisorFindingsLedger();
		const outcome = ledger.record({
			...input,
			identity: "file:src/auth.ts#x:0",
			where: { type: "file", path: "src/auth.ts", line: 10 },
		});
		ledger.setPossiblyFixed(outcome.finding, true);
		const restored = new AdvisorFindingsLedger();
		restored.load(structuredClone(ledger.toEntry()));
		expect(restored.list()[0]?.where).toEqual({ type: "file", path: "src/auth.ts", line: 10 });
		expect(restored.list()[0]?.possiblyFixed).toBe(true);
		const malformed = structuredClone(ledger.toEntry());
		malformed.findings[0]!.where = { type: "file" } as never;
		restored.load(malformed);
		expect(restored.list()).toEqual([]);
	});
});
