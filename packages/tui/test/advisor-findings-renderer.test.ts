import { expect, test } from "bun:test";
import * as os from "node:os";
import { getThemeByName } from "../src/theme/theme";
import { advisorFindingsToolRenderer } from "../src/tools/advisor-findings";
import { TRUNCATE_LENGTHS } from "../src/render/render-utils";
import { visibleWidth } from "../src/utils";

test("findings tool sanitizes tabs, embedded home paths, and oversized lines in legacy and native result paths", async () => {
	const output = `F1\t${os.homedir()}/src/check.ts ${"x".repeat(500)}`;
	const result = { content: [{ type: "text", text: output }], isError: true };
	const options = { expanded: true, isPartial: false };
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Missing dark theme");
	const legacy = advisorFindingsToolRenderer.renderResult(result, options, theme);
	const lines = legacy?.render(120) ?? [];
	expect(lines.join("\n")).toContain("~/src/check.ts");
	expect(lines.join("\n")).not.toContain("\t");
	for (const line of lines) {
		expect(visibleWidth(line.trimEnd())).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	}
	const native = JSON.stringify(advisorFindingsToolRenderer.describeResult?.(result, options));
	expect(native).toContain("~/src/check.ts");
	expect(native).not.toContain(os.homedir());
	expect(native).not.toContain("\\t");
	expect(native).not.toContain("x".repeat(TRUNCATE_LENGTHS.LINE));
});
