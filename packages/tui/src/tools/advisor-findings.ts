import { Text } from "../components/text";
import { ansi } from "../native/describe";
import {
	PREVIEW_LIMITS,
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

function safeLines(text: string, options: RenderResultOptions): string[] {
	const lines = shortenEmbeddedPaths(replaceTabs(sanitizeText(text))).split("\n");
	const limit = options.expanded ? lines.length : PREVIEW_LIMITS.COLLAPSED_LINES;
	const visible = lines.slice(0, limit).map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
	if (lines.length > limit) visible.push(`… ${lines.length - limit} more lines`);
	return visible;
}

function resultText(result: ToolRenderResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

export const advisorFindingsToolRenderer: ToolRenderer = {
	renderCall(args, options) {
		return new Text(safeLines(`Advisor Findings ${JSON.stringify(args) ?? ""}`, options).join("\n"), 0, 0);
	},
	renderResult(result, options) {
		return new Text(safeLines(resultText(result), options).join("\n"), 0, 0);
	},
	describeCall(args, options) {
		return { head: safeLines(`Advisor Findings ${JSON.stringify(args) ?? ""}`, options).join(" ") };
	},
	describeResult(result, options) {
		return {
			body: [ansi(safeLines(resultText(result), options).join("\n"))],
			tone: result.isError ? "error" : undefined,
		};
	},
};
