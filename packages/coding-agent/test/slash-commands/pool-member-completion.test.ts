import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildModelSelectorCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const settings = Settings.isolated({
	modelRoles: {
		security: {
			strategy: "priority",
			strategyOptions: { order: ["mythos", "flash", "next"] },
			models: {
				mythos: { model: "anthropic/claude-sonnet-4-5", defaultEffort: "low" },
				flash: { model: "google/gemini-2.5-flash" },
				next: { model: "openai/gpt-4o-mini" },
			},
		},
	},
	modelGroups: {
		grp: {
			strategy: "priority",
			strategyOptions: { order: ["x", "next"] },
			models: { x: { model: "google/gemini-2.5-flash" }, next: { model: "openai/gpt-4o-mini" } },
		},
	},
});
const complete = buildModelSelectorCompletions({ ctx: { settings } } as TuiSlashCommandRuntime);

function values(query: string): string[] {
	return complete(query)?.map(item => item.value) ?? [];
}

describe("pool member selector completion", () => {
	it("completes role names after @", () => {
		expect(values("@sec")).toEqual(["@security "]);
	});
	it("completes role members and the reserved next operation", () => {
		expect(values("@security/")).toEqual(["@security/mythos ", "@security/flash ", "@security/next "]);
		expect(values("@security/my")).toEqual(["@security/mythos "]);
		expect(complete("@security/next")?.[0]?.description).toBe("Next eligible pool member");
	});
	it("completes group names after +", () => {
		expect(values("+")).toEqual(["+grp/"]);
	});
	it("completes group members including a literal next member", () => {
		expect(values("+grp/")).toEqual(["+grp/x ", "+grp/next "]);
	});
	it("preserves an effort suffix after a member or next operation", () => {
		expect(values("@security/my:high")).toEqual(["@security/mythos:high "]);
		expect(values("@security/n:low")).toEqual(["@security/next:low "]);
		expect(values("+grp/x:auto")).toEqual(["+grp/x:auto "]);
		expect(values("@security/mythos:h")).toEqual(["@security/mythos:high "]);
		expect(values("@security/next:l")).toEqual(["@security/next:low "]);
		expect(values("+grp/x:a")).toEqual(["+grp/x:auto "]);
	});
	it("does not invent members for unknown pools", () => {
		expect(complete("@missing/")).toBeNull();
		expect(complete("+missing/")).toBeNull();
	});
});
