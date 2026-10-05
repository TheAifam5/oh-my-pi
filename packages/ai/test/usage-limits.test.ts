import { describe, expect, it } from "bun:test";
import {
	localLimitCap,
	localLimitWindowResetAt,
	localLimitWindowStart,
	parseLocalLimit,
} from "@oh-my-pi/pi-ai/usage/limits";

const at = (month: number, day: number, hour = 0) => new Date(2026, month - 1, day, hour).getTime();

describe("local limits", () => {
	it.each([
		["day", at(10, 7, 15), at(10, 7), at(10, 8)],
		["week from a Wednesday", at(10, 7, 15), at(10, 5), at(10, 12)],
		["week from a Sunday", at(10, 11, 23), at(10, 5), at(10, 12)],
		["month", at(10, 31, 9), at(10, 1), at(11, 1)],
	] as const)("bounds a calendar %s window in local time", (name, now, start, reset) => {
		const window = { type: "calendar", period: name.split(" ")[0] as "day" | "week" | "month" } as const;
		expect(localLimitWindowStart(window, now)).toBe(start);
		expect(localLimitWindowResetAt(window, now)).toBe(reset);
	});

	it("counts a rolling window back from now and never resets it", () => {
		const window = { type: "rolling", durationMs: 3_600_000 } as const;
		expect(localLimitWindowStart(window, 10_000_000)).toBe(6_400_000);
		expect(localLimitWindowResetAt(window, 10_000_000)).toBeUndefined();
	});

	it("parses a limit with skip as the default action and caps usd in nano-USD", () => {
		const { limit, issues } = parseLocalLimit(
			{ metric: "usd", max: "5.5", window: { type: "calendar", period: "day" } },
			"limits",
		);
		expect(issues).toEqual([]);
		expect(limit?.onLimit).toBe("skip");
		expect(localLimitCap(limit!)).toBe(5_500_000_000n);
	});

	it("rejects a numeric usd amount, a string count, an overlong window, and unknown fields", () => {
		expect(
			parseLocalLimit({ metric: "usd", max: 5, window: { type: "calendar", period: "day" } }, "l").issues,
		).toEqual([{ path: "l.max", message: 'must be a positive quoted decimal amount, such as "5.00"' }]);
		expect(
			parseLocalLimit(
				{ metric: "requests", max: "5", window: { type: "rolling", durationMs: 400 * 86_400_000 }, extra: 1 },
				"l",
			).issues.map(issue => issue.path),
		).toEqual(["l", "l.max", "l.window.durationMs"]);
	});
});
