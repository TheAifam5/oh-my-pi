import { prompt } from "@oh-my-pi/pi-utils";
import findingsDigestTemplate from "../prompts/advisor/findings-digest.md" with { type: "text" };
import { isApproachIdentity, parseFileAnchor } from "./anchor-identity";
import type { AdvisorFileAnchor, AdvisorFinding } from "./findings-ledger";

/** Most findings one digest lists; the rest are counted. */
export const ADVISOR_FINDINGS_DIGEST_LIMIT = 12;

const SEVERITY_ORDER = { blocker: 0, concern: 1, nit: 2 } as const;

/** What one advisor's digest may show. */
export interface FindingsDigestViewer {
	/** Whether this advisor owns `finding`; owner entries carry the changed-line hint. */
	owns: (finding: AdvisorFinding) => boolean;
	/** Whether this advisor's `read` is allowed without a prompt for the finding's anchor file. */
	canReadAnchor: (finding: AdvisorFinding) => boolean;
}

function fileAnchorDisplay(where: AdvisorFileAnchor): string {
	const parsed = parseFileAnchor(where);
	if (parsed.line === undefined) return parsed.path;
	return `${parsed.path}:${parsed.line}${parsed.endLine === undefined ? "" : `-${parsed.endLine}`}`;
}

/**
 * One advisor's digest of open findings, or undefined when none is open.
 * Entries are `F<n> <category> <severity> owner=<name> reporters=<count>`,
 * open blockers first, then concerns, then nits, newest first; at most
 * {@link ADVISOR_FINDINGS_DIGEST_LIMIT} entries, then `and N more`. A file
 * anchor's path and line follow only when `viewer.canReadAnchor` allows the
 * file; an `approach` anchor's topic follows as `approach="<topic>"`. No
 * other anchor text and no report text is included. The owner's entries add
 * `possibly-fixed` when the anchored line changed.
 */
export function renderFindingsDigest(
	findings: readonly AdvisorFinding[],
	viewer: FindingsDigestViewer,
): string | undefined {
	const open = findings
		.filter(finding => finding.status === "open")
		.map((finding, index) => ({ finding, index }))
		.sort(
			(a, b) =>
				SEVERITY_ORDER[a.finding.severity ?? "nit"] - SEVERITY_ORDER[b.finding.severity ?? "nit"] ||
				b.finding.createdTurn - a.finding.createdTurn ||
				b.index - a.index,
		)
		.map(item => item.finding);
	if (open.length === 0) return undefined;
	const entries = open.slice(0, ADVISOR_FINDINGS_DIGEST_LIMIT).map(finding => {
		let entry = `${finding.id} ${finding.category || "-"} ${finding.severity ?? "nit"} owner=${finding.owner ?? "-"} reporters=${new Set(finding.reports.map(report => report.advisor)).size}`;
		if (finding.where && viewer.canReadAnchor(finding)) entry += ` at ${fileAnchorDisplay(finding.where)}`;
		else if (!finding.where && isApproachIdentity(finding.identity)) {
			entry += ` approach=${JSON.stringify(finding.anchor.trim().replace(/\s+/g, " "))}`;
		}
		if (finding.possiblyFixed && viewer.owns(finding)) entry += " possibly-fixed";
		return entry;
	});
	return prompt.render(findingsDigestTemplate, {
		entries,
		more: Math.max(0, open.length - ADVISOR_FINDINGS_DIGEST_LIMIT),
	});
}
