import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AdvisorFindingActionResult, AdvisorFindingSummary } from "../session/session-advisors";
import { cfgAdvisorEnabled } from "../advisor/settings";
import description from "../prompts/tools/advisor-findings.md" with { type: "text" };
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

const schema = type({
	op: "'list' | 'get' | 'resolve' | 'reopen'",
	"status?": "'open' | 'resolved' | 'expired' | 'all'",
	"id?": "string",
	"ids?": "string[]",
	"reason?": "string",
});

export type AdvisorFindingsParams = typeof schema.infer;

export interface AdvisorFindingsDetails {
	findings?: AdvisorFindingSummary[];
	results?: AdvisorFindingActionResult[];
}

export class AdvisorFindingsTool implements AgentTool<typeof schema, AdvisorFindingsDetails> {
	readonly name = "advisor_findings";
	readonly label = "Advisor Findings";
	readonly replay = "unsafe" as const;
	readonly approval = (args: unknown): ToolApprovalDecision =>
		args !== null && typeof args === "object" && "op" in args && (args.op === "list" || args.op === "get")
			? "read"
			: "write";
	readonly description = description;
	readonly parameters = schema;
	readonly strict = false;
	readonly loadMode = "essential" as const;
	readonly summary = "List, inspect, resolve, or reopen advisor findings";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): AdvisorFindingsTool | null {
		return cfgAdvisorEnabled.get(session.settings) && session.listAdvisorFindings
			? new AdvisorFindingsTool(session)
			: null;
	}

	async execute(
		_id: string,
		params: AdvisorFindingsParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AdvisorFindingsDetails>> {
		throwIfAborted(signal);
		const parsed = schema(params);
		if (parsed instanceof type.errors) throw new ToolError(parsed.summary);
		const { listAdvisorFindings, getAdvisorFinding, resolveAdvisorFindings, reopenAdvisorFindings } = this.session;
		if (
			!listAdvisorFindings ||
			!getAdvisorFinding ||
			!resolveAdvisorFindings ||
			!reopenAdvisorFindings ||
			this.session.isDisposed?.() ||
			!cfgAdvisorEnabled.get(this.session.settings)
		) {
			throw new ToolError("Advisor findings are unavailable for this session.");
		}
		let details: AdvisorFindingsDetails;
		if (parsed.op === "list") {
			const status = parsed.status ?? "open";
			details = {
				findings: listAdvisorFindings(status),
			};
		} else if (parsed.op === "get") {
			if (!parsed.id || !/^F\d+$/i.test(parsed.id)) throw new ToolError("get requires a finding id (F<n>).");
			const finding = getAdvisorFinding(parsed.id.toUpperCase());
			if (!finding) throw new ToolError(`No advisor finding ${parsed.id}.`);
			details = { findings: [finding] };
		} else {
			const reason = parsed.reason?.trim();
			if (!reason) throw new ToolError(`${parsed.op} requires a non-empty reason.`);
			if (!parsed.ids?.length || parsed.ids.some(id => !/^F\d+$/i.test(id))) {
				throw new ToolError(`${parsed.op} requires ids containing finding ids (F<n>).`);
			}
			details = {
				results:
					parsed.op === "resolve"
						? resolveAdvisorFindings(parsed.ids, { by: "agent", reason })
						: reopenAdvisorFindings(parsed.ids, { by: "agent", reason }),
			};
		}
		return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
	}
}
