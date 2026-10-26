import { beforeAll, describe, expect, test } from "bun:test";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import { HubPrefs, type HubPrefsField, type HubPrefsValue } from "../src/overlays/hub-prefs";
import { initTheme } from "../src/theme";

const context: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

beforeAll(async () => {
	await initTheme(false);
});

function props(prefs: HubPrefs): TspPrefsProps {
	return prefs.describe(context).p as TspPrefsProps;
}

function change(prefs: HubPrefs, item: string, value: HubPrefsValue): void {
	prefs.handleNativeEvent({ type: "change", key: "", item, value });
}

describe("HubPrefs", () => {
	test("typed controls share their writer with native changes and ANSI activation", () => {
		const applied: [string, HubPrefsValue][] = [];
		const fields: HubPrefsField[] = [
			{
				id: "switch",
				label: "Switch",
				control: { k: "switch", on: false },
				apply: value => {
					applied.push(["switch", value]);
					return undefined;
				},
			},
			{
				id: "choice",
				label: "Choice",
				control: {
					k: "choice",
					value: "a",
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
				},
				apply: value => {
					applied.push(["choice", value]);
					return undefined;
				},
			},
			{
				id: "number",
				label: "Number",
				control: { k: "number", value: 2, min: 0, max: 10 },
				apply: value => {
					applied.push(["number", value]);
					return undefined;
				},
			},
			{
				id: "text",
				label: "Text",
				control: { k: "text", value: "initial" },
				apply: value => {
					applied.push(["text", value]);
					return undefined;
				},
			},
			{
				id: "multi",
				label: "Order",
				control: {
					k: "multi",
					values: ["a", "b"],
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
					ordered: true,
				},
				apply: value => {
					applied.push(["multi", value]);
					return undefined;
				},
			},
			{
				id: "action",
				label: "Action",
				control: { k: "action", label: "Run", act: "run" },
				apply: value => {
					applied.push(["action", value]);
					return undefined;
				},
			},
		];
		const prefs = new HubPrefs(
			"Settings",
			() => fields,
			() => {},
			() => {},
		);
		prefs.handleInput("\r");
		prefs.focus("choice");
		prefs.handleInput("\r");
		change(prefs, "number", 7);
		change(prefs, "text", "replacement");
		prefs.startEditing("multi");
		prefs.handleInput("]");
		prefs.handleInput("\r");
		prefs.handleNativeEvent({ type: "action", key: "", act: "run", mods: [] });
		expect(applied).toEqual([
			["switch", true],
			["choice", "b"],
			["number", 7],
			["text", "replacement"],
			["multi", ["b", "a"]],
			["action", null],
		]);
	});

	test("invalid typed values cannot reach the writer", () => {
		const applied: HubPrefsValue[] = [];
		const fields: HubPrefsField[] = [
			{
				id: "number",
				label: "Number",
				control: { k: "number", value: 2, min: 0, max: 10 },
				apply: value => {
					applied.push(value);
					return undefined;
				},
			},
			{
				id: "multi",
				label: "Multi",
				control: { k: "multi", values: [], options: [{ value: "a", label: "A" }] },
				apply: value => {
					applied.push(value);
					return undefined;
				},
			},
		];
		const prefs = new HubPrefs(
			"Settings",
			() => fields,
			() => {},
			() => {},
		);
		for (const value of ["invalid", "   ", -1, 11, true]) change(prefs, "number", value);
		change(prefs, "multi", ["a", "a"]);
		change(prefs, "multi", ["unknown"]);
		expect(applied).toEqual([]);
		expect(props(prefs).sections?.[0]?.rows.every(row => row.warning)).toBe(true);
	});

	test("refused async saves retain draft and cursor and block duplicate submissions", async () => {
		const pending = Promise.withResolvers<string | undefined>();
		let calls = 0;
		const fields: HubPrefsField[] = [
			{
				id: "name",
				label: "Name",
				control: { k: "text", value: "old" },
				apply: () => {
					calls++;
					return pending.promise;
				},
			},
		];
		const prefs = new HubPrefs(
			"Settings",
			() => fields,
			() => {},
			() => {},
		);
		prefs.startEditing("name");
		prefs.handleNativeEvent({ type: "edit", key: "", from: 0, to: 3, len: 3, text: "draft", cursor: 2 });
		prefs.handleInput("\r");
		prefs.handleInput("\r");
		change(prefs, "name", "duplicate");
		expect(calls).toBe(1);
		pending.resolve("Name is already used");
		await pending.promise;
		await Promise.resolve();
		expect(props(prefs).editing).toMatchObject({ row: "name", draft: "draft", cursor: 2 });
		expect(props(prefs).sections?.[0]?.rows[0]?.warning).toBe("Name is already used");
	});

	test("disabled fields reject native and keyboard submissions and sanitize display strings", () => {
		let calls = 0;
		const hostile = "\x1b]0;title\x07\x1b[2Junsafe\nline";
		const fields: HubPrefsField[] = [
			{
				id: "blocked",
				label: hostile,
				disabled: hostile,
				control: { k: "text", value: hostile },
				apply: () => {
					calls++;
					return undefined;
				},
			},
		];
		const prefs = new HubPrefs(
			hostile,
			() => fields,
			() => {},
			() => {},
		);
		prefs.handleInput("\r");
		change(prefs, "blocked", "new");
		prefs.handleNativeEvent({ type: "action", key: "", act: "edit", value: "blocked", mods: [] });
		expect(calls).toBe(0);
		const described = JSON.stringify(props(prefs));
		expect(described).not.toContain("\\u001b");
		expect(described).not.toContain("\\u0007");
		expect(Bun.stripANSI(prefs.render(80).join("\n"))).toContain("unsafe line");
	});
	test("native fallback children open and commit choice drafts through the shared writer", () => {
		const applied: HubPrefsValue[] = [];
		let closed = 0;
		const prefs = new HubPrefs(
			"Settings",
			() => [
				{
					id: "choice",
					label: "Choice",
					control: {
						k: "choice",
						style: "menu",
						value: "a",
						options: [
							{ value: "a", label: "A" },
							{ value: "b", label: "B" },
						],
					},
					apply: value => {
						applied.push(value);
						return undefined;
					},
				},
			],
			() => {
				closed++;
			},
			() => {},
		);
		const fallback = { ...context, supports: () => false };
		const child = prefs.describe(fallback).c?.[0];
		if (!child || !("render" in child)) throw new Error("Expected fallback component");
		child.handleNativeEvent?.({ type: "activate", key: "", item: "choice" });
		expect(props(prefs).editing).toEqual({ row: "choice", option: "a" });
		expect(applied).toEqual([]);
		child.handleNativeEvent?.({ type: "select", key: "", item: "b" });
		expect(applied).toEqual(["b"]);
		expect(props(prefs).editing).toBeNull();
		child.handleNativeEvent?.({ type: "activate", key: "", item: "choice" });
		prefs.handleInput("\x1b");
		expect(props(prefs).editing).toBeNull();
		expect(applied).toEqual(["b"]);
		expect(closed).toBe(0);
	});

	test("menu activation and hover stage options; keyboard and pointer commit through one writer", () => {
		const applied: HubPrefsValue[] = [];
		const fields: HubPrefsField[] = [
			{
				id: "route=pool",
				label: "Route",
				control: {
					k: "choice",
					style: "menu",
					value: "a",
					options: [
						{ value: "a", label: "A" },
						{ value: "b=c", label: "B" },
						{ value: "d", label: "D" },
					],
				},
				apply: value => {
					applied.push(value);
					return undefined;
				},
			},
		];
		const prefs = new HubPrefs(
			"Settings",
			() => fields,
			() => {},
			() => {},
		);
		prefs.handleNativeEvent({ type: "activate", key: "", item: "route=pool" });
		expect(applied).toEqual([]);
		expect(props(prefs).editing).toEqual({ row: "route=pool", option: "a" });
		prefs.handleNativeEvent({ type: "select", key: "", item: "route=pool=b=c" });
		expect(props(prefs).editing?.option).toBe("b=c");
		expect(applied).toEqual([]);
		prefs.handleInput("\x1b[B");
		expect(props(prefs).editing?.option).toBe("d");
		expect(Bun.stripANSI(prefs.render(80).join("\n"))).toContain("D");
		prefs.handleInput("\r");
		expect(applied).toEqual(["d"]);
		expect(props(prefs).editing).toBeNull();
		prefs.startEditing("route=pool");
		prefs.handleInput("\x1b[B");
		prefs.handleInput("\x1b");
		expect(applied).toEqual(["d"]);
		expect(props(prefs).editing).toBeNull();
		prefs.startEditing("route=pool");
		change(prefs, "route=pool", "b=c");
		expect(applied).toEqual(["d", "b=c"]);
		expect(props(prefs).editing).toBeNull();
	});

	test("auto large choices open menus and native outside-close cancels without closing the sheet", () => {
		let calls = 0;
		let closed = 0;
		const prefs = new HubPrefs(
			"Settings",
			() => [
				{
					id: "choice",
					label: "Choice",
					control: {
						k: "choice",
						value: "0",
						options: Array.from({ length: 5 }, (_, i) => ({ value: String(i), label: String(i) })),
					},
					apply: () => {
						calls++;
						return undefined;
					},
				},
			],
			() => {
				closed++;
			},
			() => {},
		);
		prefs.startEditing("choice");
		expect(props(prefs).editing?.option).toBe("0");
		prefs.handleNativeEvent({ type: "action", key: "", act: "close", value: "choice", mods: [] });
		expect(props(prefs).editing).toBeNull();
		expect(closed).toBe(0);
		expect(calls).toBe(0);
	});

	test("refused menu saves retain the highlighted option and reject duplicate pending commits", async () => {
		const pending = Promise.withResolvers<string | undefined>();
		let calls = 0;
		const prefs = new HubPrefs(
			"Settings",
			() => [
				{
					id: "choice",
					label: "Choice",
					control: {
						k: "choice",
						style: "menu",
						value: "a",
						options: [
							{ value: "a", label: "A" },
							{ value: "b", label: "B" },
						],
					},
					apply: () => {
						calls++;
						return pending.promise;
					},
				},
			],
			() => {},
			() => {},
		);
		prefs.startEditing("choice");
		prefs.handleInput("\x1b[B");
		prefs.handleInput("\r");
		change(prefs, "choice", "a");
		prefs.handleInput("\r");
		expect(calls).toBe(1);
		pending.resolve("Refused");
		await pending.promise;
		await Promise.resolve();
		expect(props(prefs).editing).toEqual({ row: "choice", option: "b" });
		expect(Bun.stripANSI(prefs.render(80).join("\n"))).toContain("Refused");
	});

	test("ordered multi keyboard drafts publish order and option, survive refusal, and cancel", () => {
		const applied: HubPrefsValue[] = [];
		const prefs = new HubPrefs(
			"Settings",
			() => [
				{
					id: "multi",
					label: "Order",
					control: {
						k: "multi",
						ordered: true,
						values: ["a", "b"],
						options: [
							{ value: "a", label: "A" },
							{ value: "b", label: "B" },
							{ value: "c", label: "C" },
						],
					},
					apply: value => {
						applied.push(Array.isArray(value) ? [...value] : value);
						return "Refused";
					},
				},
			],
			() => {},
			() => {},
		);
		prefs.startEditing("multi");
		prefs.handleInput("]");
		expect(props(prefs).editing).toEqual({ row: "multi", option: "a" });
		expect(props(prefs).sections[0]?.rows[0]?.control).toMatchObject({ values: ["b", "a"] });
		expect(applied).toEqual([]);
		prefs.handleInput("\x1b[B");
		prefs.handleInput("\x1b[B");
		prefs.handleInput(" ");
		expect(props(prefs).editing?.option).toBe("c");
		expect(props(prefs).sections[0]?.rows[0]?.control).toMatchObject({ values: ["b", "a", "c"] });
		prefs.handleInput("\r");
		expect(applied).toEqual([["b", "a", "c"]]);
		expect(props(prefs).editing?.row).toBe("multi");
		expect(Bun.stripANSI(prefs.render(80).join("\n"))).toContain("Refused");
		change(prefs, "multi", ["c"]);
		expect(props(prefs).sections[0]?.rows[0]?.control).toMatchObject({ values: ["c"] });
		prefs.handleInput(" ");
		expect(props(prefs).sections[0]?.rows[0]?.control).toMatchObject({ values: [] });
		expect(applied).toEqual([["b", "a", "c"], ["c"]]);
		prefs.handleInput("\x1b");
		expect(props(prefs).editing).toBeNull();
		expect(props(prefs).sections[0]?.rows[0]?.control).toMatchObject({ values: ["a", "b"] });
	});
});
