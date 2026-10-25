import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AdvisorFinding, AdvisorFindingsLedger } from "../advisor/findings-ledger";
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

export interface AdvisorFindingSummary {
	id: string;
	status: AdvisorFinding["status"];
	severity: NonNullable<AdvisorFinding["severity"]>;
	category: string;
	owner: string | undefined;
	anchor: string;
	reporters: string[];
	possiblyFixed: boolean;
	merged: AdvisorFinding["merged"];
	defect: string;
	resolution: AdvisorFinding["resolution"];
	reports?: AdvisorFinding["reports"];
}

export interface AdvisorFindingActionResult {
	id: string;
	result:
		| "resolved"
		| "reopened"
		| "already open"
		| "already resolved"
		| "already expired"
		| "missing"
		| "merged-into"
		| "superseded";
	mergedInto?: string;
	outcome?: Exclude<AdvisorFindingActionResult["result"], "merged-into">;
	reason: string;
}

export interface AdvisorFindingsDetails {
	findings?: AdvisorFindingSummary[];
	results?: AdvisorFindingActionResult[];
}

function summarize(ledger: AdvisorFindingsLedger, finding: AdvisorFinding, reports: boolean): AdvisorFindingSummary {
	return {
		id: finding.id,
		status: finding.status,
		severity: finding.severity ?? "nit",
		category: finding.category,
		owner: finding.owner,
		anchor: finding.anchor,
		reporters: ledger.reporters(finding),
		possiblyFixed: finding.possiblyFixed ?? false,
		merged: finding.merged,
		defect: ledger.leadReport(finding).defect,
		resolution: finding.resolution,
		...(reports ? { reports: finding.reports } : {}),
	};
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
		return cfgAdvisorEnabled.get(session.settings) && session.getAdvisorFindingsLedger
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
		const ledger = this.session.getAdvisorFindingsLedger?.();
		if (!ledger || this.session.isDisposed?.() || !cfgAdvisorEnabled.get(this.session.settings)) {
			throw new ToolError("Advisor findings are unavailable for this session.");
		}
		let details: AdvisorFindingsDetails;
		if (parsed.op === "list") {
			const status = parsed.status ?? "open";
			details = {
				findings: ledger
					.list()
					.filter(finding => status === "all" || finding.status === status)
					.map(finding => summarize(ledger, finding, false)),
			};
		} else if (parsed.op === "get") {
			if (!parsed.id || !/^F\d+$/i.test(parsed.id)) throw new ToolError("get requires a finding id (F<n>).");
			const finding = ledger.get(parsed.id.toUpperCase());
			if (!finding) throw new ToolError(`No advisor finding ${parsed.id}.`);
			details = { findings: [summarize(ledger, finding, true)] };
		} else {
			const reason = parsed.reason?.trim();
			if (!reason) throw new ToolError(`${parsed.op} requires a non-empty reason.`);
			if (!parsed.ids?.length || parsed.ids.some(id => !/^F\d+$/i.test(id))) {
				throw new ToolError(`${parsed.op} requires ids containing finding ids (F<n>).`);
			}
			const results = parsed.ids.map(rawId => {
				const id = rawId.toUpperCase();
				const finding = ledger.get(id);
				if (!finding) return { id, result: "missing", reason } satisfies AdvisorFindingActionResult;
				let outcome: Exclude<AdvisorFindingActionResult["result"], "merged-into">;
				if (parsed.op === "resolve") {
					outcome = ledger.resolve(finding.id, "agent", reason) ? "resolved" : `already ${finding.status}`;
				} else {
					const reopened = ledger.reopen(finding.id);
					outcome = reopened === "open" ? "already open" : reopened;
				}
				return id === finding.id
					? { id, result: outcome, reason }
					: ({
							id,
							result: "merged-into",
							mergedInto: finding.id,
							outcome,
							reason,
						} satisfies AdvisorFindingActionResult);
			});
			details = { results };
		}
		return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
	}
}
