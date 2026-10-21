import type { AdvisorFinding } from "../../advisor";
import type { AgentSession } from "../../session/agent-session";

export const ADVISOR_FINDINGS_USAGE = "Usage: /advisor findings [open|all] | resolve F<n> | reopen F<n>";

function formatFinding(finding: AdvisorFinding): string {
	const reporters = [...new Set(finding.reports.map(report => report.advisor))];
	const lead = finding.reports.find(report => report.owner && report.category === undefined) ?? finding.reports[0];
	const head = [
		finding.id,
		`[${finding.status}]`,
		finding.severity ?? "nit",
		finding.category || "-",
		`at ${finding.anchor}`,
		`owner=${finding.owner ?? "-"}`,
		`reporters=${reporters.join(", ")}`,
	];
	if (finding.possiblyFixed) head.push("possibly-fixed");
	if (finding.merged?.length) head.push(`merged=${finding.merged.map(merged => merged.id).join(", ")}`);
	return lead ? `${head.join(" ")}\n  ${lead.defect}` : head.join(" ");
}

/**
 * Reply of `/advisor findings <args>`: `open` (default) or `all` lists the
 * session's advisor findings with their lead report; `resolve F<n>` and
 * `reopen F<n>` change one finding's status and persist the ledger.
 */
export function runAdvisorFindingsCommand(session: AgentSession, args: string): string {
	const [verb = "open", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	const action = verb.toLowerCase();
	if (action === "open" || action === "all") {
		if (id !== undefined) return ADVISOR_FINDINGS_USAGE;
		const findings = session.getAdvisorFindings().filter(finding => action === "all" || finding.status === "open");
		if (findings.length === 0) return action === "all" ? "No advisor findings." : "No open advisor findings.";
		return findings.map(formatFinding).join("\n");
	}
	if ((action !== "resolve" && action !== "reopen") || !id || extra.length > 0 || !/^F\d+$/i.test(id)) {
		return ADVISOR_FINDINGS_USAGE;
	}
	const requested = `F${id.slice(1)}`;
	if (action === "resolve") {
		const { result, finding } = session.resolveAdvisorFinding(requested);
		if (!finding) return `No advisor finding ${requested}.`;
		const merged = finding.id === requested ? "" : ` (${requested} was merged into it)`;
		return result === "resolved"
			? `Resolved ${finding.id}${merged}.`
			: `${finding.id}${merged} is already ${finding.status}.`;
	}
	const { result, finding } = session.reopenAdvisorFinding(requested);
	if (!finding) return `No advisor finding ${requested}.`;
	const merged = finding.id === requested ? "" : ` (${requested} was merged into it)`;
	switch (result) {
		case "reopened":
			return `Reopened ${finding.id}${merged}.`;
		case "superseded":
			return `${finding.id}${merged} not reopened: an open finding already covers its category and anchor.`;
		default:
			return `${finding.id}${merged} is already open.`;
	}
}
