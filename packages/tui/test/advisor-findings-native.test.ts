import { beforeAll, expect, test } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import { AdvisorFindingsOverlay, type AdvisorFindingView } from "../src/overlays/advisor-findings";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";
import { visibleWidth } from "../src/utils";

const cx: DescribeContext = {
	cols: 80,
	dark: true,
	reduceMotion: false,
	supports: () => true,
	feature: () => true,
};
const ui = { requestRender: () => {}, terminal: { rows: 40 } } as TUI;

beforeAll(async () => {
	await initTheme(false);
});

function finding(id: string, extra: Partial<AdvisorFindingView> = {}): AdvisorFindingView {
	return {
		id,
		status: "open",
		severity: "concern",
		category: "security",
		anchor: "src/auth.ts:42",
		owner: "Security",
		reports: [
			{ advisor: "Correctness", owner: false, defect: "Other report" },
			{ advisor: "Security", owner: true, defect: "Token comparison", impact: "Timing leak", fix: "Constant time" },
			{ advisor: "Security", owner: true, defect: "Additional report" },
		],
		...extra,
	};
}

function sheet(findings: AdvisorFindingView[], filter: "open" | "all" = "open"): AdvisorFindingsOverlay {
	return new AdvisorFindingsOverlay(
		ui,
		{
			getFindings: () => findings,
			changeStatus: (action, id) => {
				const selected = findings.find(entry => entry.id === id)!;
				selected.status = action === "resolve" ? "resolved" : "open";
				return `${id} ${selected.status}`;
			},
		},
		() => {},
		filter,
	);
}

function props(overlay: AdvisorFindingsOverlay): TspPickerProps {
	const root = overlay.describe(cx);
	if (root.k !== "picker") throw new Error("Expected native picker");
	return root.p!;
}

test("native findings prioritize open severity and expose lead details, flags, reporters, and status actions", () => {
	const overlay = sheet(
		[
			finding("F1", { status: "resolved", severity: "blocker" }),
			finding("F2", { severity: "nit" }),
			finding("F3", { severity: "blocker", possiblyFixed: true, interrupted: true, merged: [{ id: "F9" }] }),
		],
		"all",
	);
	expect(overlay.nativeSheet(cx)).toBe(true);
	expect(props(overlay).items?.map(item => item.id)).toEqual(["F3", "F2", "F1"]);
	expect(props(overlay).items?.[0]?.facts).toEqual({
		status: "open",
		severity: "blocker",
		owner: "Security",
		reporters: 2,
	});
	const preview = JSON.stringify(overlay.describe(cx).c);
	for (const detail of [
		"Token comparison",
		"Timing leak",
		"Constant time",
		"Correctness, Security",
		"possibly-fixed",
		"interrupted",
		"F9",
	]) {
		expect(preview).toContain(detail);
	}
	expect(props(overlay).actions?.map(action => action.id)).toEqual(["resolve", "reopen", "filter", "close"]);
	overlay.handleNativeEvent({ type: "action", key: "", act: "tab", value: "open", mods: [] });
	expect(props(overlay).items?.map(item => item.id)).toEqual(["F3", "F2"]);
	overlay.handleNativeEvent({ type: "action", key: "", act: "resolve", mods: [] });
	expect(props(overlay).items?.map(item => item.id)).toEqual(["F2"]);
	overlay.handleNativeEvent({ type: "action", key: "", act: "filter", mods: [] });
	overlay.handleNativeEvent({ type: "select", key: "", item: "F3" });
	overlay.handleNativeEvent({ type: "action", key: "", act: "reopen", mods: [] });
	expect(props(overlay).items?.[0]?.id).toBe("F3");
	expect(props(overlay).items?.[0]?.facts?.status).toBe("open");
});

test("all findings show the resolution author and reason in native and ANSI previews", () => {
	const overlay = sheet(
		[
			finding("F1", {
				status: "resolved",
				resolution: { by: "agent", reason: "Verified bounds check", turn: 3 },
			}),
		],
		"all",
	);
	const native = JSON.stringify(overlay.describe(cx).c);
	expect(native).toContain("Resolved by: agent");
	expect(native).toContain("Resolution reason: Verified bounds check");
	const ansi = overlay.render(80).join("\n");
	expect(ansi).toContain("Resolved by: agent");
	expect(ansi).toContain("Resolution reason: Verified bounds check");
});

test("empty findings retain native filters, disabled mutation actions, and close", () => {
	let closed = 0;
	const overlay = new AdvisorFindingsOverlay(
		ui,
		{
			getFindings: () => [],
			changeStatus: () => {
				throw new Error("No selection");
			},
		},
		() => {
			closed++;
		},
	);
	expect(props(overlay).empty).toBe("No open advisor findings.");
	expect(
		props(overlay)
			.actions?.filter(action => action.disabled)
			.map(action => action.id),
	).toEqual(["resolve", "reopen"]);
	expect(overlay.render(80).join("\n")).toContain("No open advisor findings.");
	overlay.handleNativeEvent({ type: "action", key: "", act: "resolve", mods: [] });
	overlay.handleNativeEvent({ type: "action", key: "", act: "filter", mods: [] });
	expect(props(overlay).empty).toBe("No advisor findings.");
	expect(overlay.handleNativeEvent({ type: "action", key: "other", act: "close", mods: [] })).toBe(false);
	expect(overlay.handleNativeEvent({ type: "select", key: "", item: "F99" })).toBe(false);
	expect(overlay.handleNativeEvent({ type: "action", key: "", act: "tab", value: "invalid", mods: [] })).toBe(false);
	overlay.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	expect(closed).toBe(1);
});

test("ANSI findings fit 80 columns, navigate and change status, and scroll long previews", () => {
	const findings = [
		finding("F1"),
		finding("F2", {
			reports: [{ advisor: "Reviewer", owner: true, defect: "Long defect ".repeat(200) + "PREVIEW END" }],
		}),
	];
	const overlay = sheet(findings, "all");
	overlay.handleInput("\u001b[B");
	expect(props(overlay).selected).toBe("F2");
	const first = overlay.render(80).join("\n");
	expect(first).toContain("Long defect");
	expect(first).not.toContain("PREVIEW END");
	for (let i = 0; i < 20; i++) overlay.handleInput("\u001b[6~");
	const last = overlay.render(80);
	expect(last.join("\n")).toContain("PREVIEW END");
	for (const line of last) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	overlay.handleInput("r");
	expect(findings[1]?.status).toBe("resolved");
	overlay.handleInput("o");
	expect(findings[1]?.status).toBe("open");
	overlay.handleInput("f");
	expect(props(overlay).tab).toBe("open");
	const fallback = { ...cx, supports: () => false };
	expect(overlay.nativeSheet(fallback)).toBe(false);
	expect(overlay.describe(fallback).k).not.toBe("picker");
});

test("untrusted finding metadata and preview text cannot inject terminal controls or overflow ANSI rows", () => {
	const hostile = "before\t\u001b]0;title\u0007\u001b[31mAFTER\u0000\u0085\nafter";
	const overlay = sheet([
		finding("F1", {
			category: hostile,
			anchor: hostile,
			owner: hostile,
			reports: [{ advisor: hostile, owner: true, defect: hostile, impact: hostile, fix: hostile }],
			merged: [{ id: hostile }],
		}),
	]);
	const native = JSON.stringify(overlay.describe(cx));
	expect(native).toContain("AFTER");
	expect(native).not.toMatch(/\\u001b|\\u0000|\\u0007|\\u0085|\\t/);
	const lines = overlay.render(80);
	for (const line of lines) {
		expect(line).not.toMatch(/\t|\u0000|\u0007|\u0085|\u001b\]/);
		expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	}
});
