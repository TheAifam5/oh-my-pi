import { type } from "@oh-my-pi/omptype";
import type { AdvisorKind, AdvisorSeverity } from "@oh-my-pi/pi-tui/chat/messages";
import { logger } from "@oh-my-pi/pi-utils";
import { type AdviseWhere, adviseWhereSchema } from "./anchor-identity";
import { normalizeAdvisorNote } from "./emission-guard";

/** How a report relates to an existing finding (`advise` `relation`). */
export const ADVISOR_RELATIONS = ["duplicate", "adds", "escalates", "disputes", "resolved"] as const;
export type AdvisorRelation = (typeof ADVISOR_RELATIONS)[number];

/** File anchor of a finding, kept host-side for the digest read gate and the changed-line check. */
export type AdvisorFileAnchor = Extract<AdviseWhere, { type: "file" }>;

/** Session entry type persisting the findings ledger. */
export const ADVISOR_FINDINGS_ENTRY_TYPE = "advisor_findings";
/** Persisted ledger format version. */
export const ADVISOR_FINDINGS_VERSION = 1;
/** Open findings untouched for this many primary turns expire. */
export const ADVISOR_FINDING_EXPIRY_TURNS = 50;
/** Most findings the ledger holds; resolved/expired findings are evicted first, then the oldest. */
export const ADVISOR_FINDINGS_CAPACITY = 256;
/** Most reports one finding keeps; beyond it the oldest report that is neither the first nor an owner's is dropped. */
export const ADVISOR_FINDING_REPORTS_CAPACITY = 16;

export type AdvisorFindingStatus = "open" | "resolved" | "expired";

/** One advisor's report on a finding. */
export interface AdvisorReport {
	advisor: string;
	kind: AdvisorKind;
	severity?: AdvisorSeverity;
	defect: string;
	impact?: string;
	fix?: string;
	relation?: AdvisorRelation;
	/** Ledger turn the report was recorded at. */
	turn: number;
	/** Whether the reporter owns the report's category. */
	owner: boolean;
	/** The report's category when it differs from its finding's (reports of a merged finding). */
	category?: string;
}

/** One finding: every report sharing a category and an anchor identity. */
export interface AdvisorFinding {
	/** `F<n>`, unique within the session. */
	id: string;
	/** Active-taxonomy category id; empty without a taxonomy. */
	category: string;
	/** Host-side anchor identity; never shown to models. */
	identity: string;
	/** Anchor display string of the first report. */
	anchor: string;
	/** Live owner advisor of the category when the finding was opened. */
	owner?: string;
	status: AdvisorFindingStatus;
	/** Highest severity across reports. */
	severity?: AdvisorSeverity;
	reports: AdvisorReport[];
	createdTurn: number;
	lastTouchedTurn: number;
	/** First report's file anchor; absent for other anchor types. */
	where?: AdvisorFileAnchor;
	/** Whether the anchored line no longer appears in the file; never resolves the finding. */
	possiblyFixed?: boolean;
	/** Whether a report on this finding already interrupted the primary. */
	interrupted?: boolean;
	/** Findings merged into this one as the same defect; reports in their categories on this anchor attach here. */
	merged?: AdvisorMergedFinding[];
}

/** A finding merged into another one. */
export interface AdvisorMergedFinding {
	id: string;
	category: string;
}

/** Persisted ledger snapshot (`advisor_findings` session entry data). */
export interface AdvisorFindingsEntry {
	v: typeof ADVISOR_FINDINGS_VERSION;
	/** Ledger turn counter. */
	turn: number;
	findings: AdvisorFinding[];
}

/** One report offered to the ledger. */
export interface AdvisorReportInput {
	advisor: string;
	category?: string;
	identity: string;
	anchor: string;
	kind: AdvisorKind;
	severity?: AdvisorSeverity;
	defect: string;
	impact?: string;
	fix?: string;
	/** The report's anchor; a file anchor is kept on a new finding. */
	where?: AdviseWhere;
	relation?: AdvisorRelation;
}

/** How the ledger recorded a report. */
export type AdvisorRecordOutcome =
	| { type: "new"; finding: AdvisorFinding; report: AdvisorReport }
	| { type: "attached"; finding: AdvisorFinding; report: AdvisorReport; escalated: boolean }
	| { type: "duplicate"; finding: AdvisorFinding };

export interface AdvisorFindingsLedgerOptions {
	/** Live owner advisor of a category; undefined when the category has none. */
	ownerOf?: (category: string) => string | undefined;
	/** Called after every state change. */
	onChange?: () => void;
}

const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };

function severityRank(severity: AdvisorSeverity | undefined): number {
	return SEVERITY_RANK[severity ?? "nit"];
}

function sameName(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function reportText(report: { defect: string; impact?: string; fix?: string }): string {
	return [report.defect, report.impact ?? "", report.fix ?? ""].map(normalizeAdvisorNote).join("\n");
}

/**
 * Session-level record of advisor findings: the single owner of report
 * dedupe and of which reports open a new finding. A finding's identity is its
 * category plus its anchor identity; reports on an open finding attach to it.
 */
export class AdvisorFindingsLedger {
	#findings: AdvisorFinding[] = [];
	#byKey = new Map<string, AdvisorFinding>();
	#nextId = 1;
	#turn = 0;
	readonly #ownerOf: (category: string) => string | undefined;
	readonly #onChange: (() => void) | undefined;

	constructor(options: AdvisorFindingsLedgerOptions = {}) {
		this.#ownerOf = options.ownerOf ?? (() => undefined);
		this.#onChange = options.onChange;
	}

	/** Current ledger turn (primary turns completed while the ledger was live). */
	get turn(): number {
		return this.#turn;
	}

	/** Every finding, oldest first. */
	list(): readonly AdvisorFinding[] {
		return this.#findings;
	}

	/** The finding with `id`, or the finding it was merged into. */
	get(id: string): AdvisorFinding | undefined {
		return (
			this.#findings.find(finding => finding.id === id) ??
			this.#findings.find(finding => finding.merged?.some(merged => merged.id === id))
		);
	}

	/** Open findings sharing anchor identity `identity`, oldest first. */
	openAt(identity: string): AdvisorFinding[] {
		return this.#findings.filter(finding => finding.status === "open" && finding.identity === identity);
	}

	/** The open finding with this category and anchor identity. */
	findOpen(category: string | undefined, identity: string): AdvisorFinding | undefined {
		return this.#byKey.get(findingKey(category, identity));
	}

	/**
	 * Record one report. A report matching an open finding attaches to it
	 * (`escalated` when its severity exceeds the finding's); one repeating a
	 * report already on the finding at no higher severity is a duplicate and
	 * only adds its advisor as a reporter. Anything else opens a new finding.
	 */
	record(input: AdvisorReportInput): AdvisorRecordOutcome {
		const category = input.category ?? "";
		const existing = this.findOpen(category, input.identity);
		if (existing) {
			let touched = existing.lastTouchedTurn !== this.#turn;
			existing.lastTouchedTurn = this.#turn;
			const rank = severityRank(input.severity);
			const escalated = rank > severityRank(existing.severity);
			const text = reportText(input);
			if (!escalated && existing.reports.some(report => reportText(report) === text)) {
				if (!existing.reports.some(report => report.advisor === input.advisor)) {
					this.#attach(existing, this.#report(input, existing));
					touched = true;
				}
				if (touched) this.#changed();
				return { type: "duplicate", finding: existing };
			}
			const report = this.#report(input, existing);
			this.#attach(existing, report);
			if (escalated) existing.severity = input.severity;
			this.#changed();
			return { type: "attached", finding: existing, report, escalated };
		}
		const finding: AdvisorFinding = {
			id: `F${this.#nextId++}`,
			category,
			identity: input.identity,
			anchor: input.anchor,
			owner: category ? this.#ownerOf(category) : undefined,
			status: "open",
			severity: input.severity,
			reports: [],
			createdTurn: this.#turn,
			lastTouchedTurn: this.#turn,
		};
		if (input.where?.type === "file") finding.where = input.where;
		const report = this.#report(input, finding);
		finding.reports.push(report);
		this.#findings.push(finding);
		this.#byKey.set(findingKey(category, input.identity), finding);
		this.#evict();
		this.#changed();
		return { type: "new", finding, report };
	}

	/**
	 * Record a report that names `finding` through a relation. It joins the
	 * finding as a report (`escalated` when its severity exceeds the
	 * finding's). `duplicate` is the relation `duplicate` repeating the lead
	 * report's text, or any relation other than `resolved` repeating a report
	 * already on the finding at no higher severity; it only adds its advisor
	 * as a reporter. A `resolved` report always joins.
	 */
	recordRelated(
		finding: AdvisorFinding,
		input: AdvisorReportInput & { relation: AdvisorRelation },
	): AdvisorRecordOutcome {
		let touched = finding.lastTouchedTurn !== this.#turn;
		finding.lastTouchedTurn = this.#turn;
		const escalated = severityRank(input.severity) > severityRank(finding.severity);
		const text = reportText(input);
		const repeated =
			input.relation === "duplicate"
				? reportText(this.leadReport(finding)) === text
				: input.relation !== "resolved" && finding.reports.some(report => reportText(report) === text);
		if (!escalated && repeated) {
			if (!finding.reports.some(report => report.advisor === input.advisor)) {
				this.#attach(finding, this.#report(input, finding));
				touched = true;
			}
			if (touched) this.#changed();
			return { type: "duplicate", finding };
		}
		const report = this.#report(input, finding);
		this.#attach(finding, report);
		if (escalated) finding.severity = input.severity;
		this.#changed();
		return { type: "attached", finding, report, escalated };
	}

	/** The finding's first owner report in its own category, else its first report. */
	leadReport(finding: AdvisorFinding): AdvisorReport {
		return finding.reports.find(report => report.owner && report.category === undefined) ?? finding.reports[0]!;
	}

	/** Whether `advisor` owns `finding` (its recorded owner, else its category's live owner). */
	isOwner(finding: AdvisorFinding, advisor: string): boolean {
		return sameName(advisor, finding.owner ?? (finding.category ? this.#ownerOf(finding.category) : undefined));
	}

	/** Close an open finding as resolved. Returns whether it was open. */
	resolve(id: string): boolean {
		const finding = this.get(id);
		if (!finding || finding.status !== "open") return false;
		finding.status = "resolved";
		finding.lastTouchedTurn = this.#turn;
		this.#unindex(finding);
		this.#changed();
		return true;
	}

	/**
	 * Reopen a resolved or expired finding. `superseded` when an open finding
	 * already holds its category and anchor identity.
	 */
	reopen(id: string): "reopened" | "open" | "missing" | "superseded" {
		const finding = this.get(id);
		if (!finding) return "missing";
		if (finding.status === "open") return "open";
		if (findingKeys(finding).some(key => this.#byKey.has(key))) return "superseded";
		finding.status = "open";
		finding.lastTouchedTurn = this.#turn;
		this.#index(finding);
		this.#changed();
		return "reopened";
	}

	/**
	 * Merge open finding `absorbed` into open finding `lead` as the same
	 * defect: every report of `absorbed` joins `lead` (none is dropped), the
	 * severity is the higher one, and `absorbed`'s id and category alias
	 * `lead`. Returns whether the merge happened.
	 */
	merge(lead: AdvisorFinding, absorbed: AdvisorFinding): boolean {
		if (lead === absorbed || lead.status !== "open" || absorbed.status !== "open") return false;
		if (!this.#findings.includes(lead) || !this.#findings.includes(absorbed)) return false;
		for (const report of absorbed.reports) {
			if (report.category === undefined && absorbed.category !== lead.category) report.category = absorbed.category;
			lead.reports.push(report);
		}
		if (severityRank(absorbed.severity) > severityRank(lead.severity)) lead.severity = absorbed.severity;
		if (absorbed.interrupted) lead.interrupted = true;
		lead.merged = [
			...(lead.merged ?? []),
			{ id: absorbed.id, category: absorbed.category },
			...(absorbed.merged ?? []),
		];
		lead.lastTouchedTurn = this.#turn;
		this.#remove(absorbed);
		this.#index(lead);
		this.#changed();
		return true;
	}

	/** Set whether a finding's anchored line looks changed. */
	setPossiblyFixed(finding: AdvisorFinding, possiblyFixed: boolean): void {
		if ((finding.possiblyFixed ?? false) === possiblyFixed) return;
		if (possiblyFixed) finding.possiblyFixed = true;
		else delete finding.possiblyFixed;
		this.#changed();
	}

	/** Remove a report that will never be delivered; a finding left without reports is removed. */
	withdraw(finding: AdvisorFinding, report: AdvisorReport): void {
		const index = finding.reports.indexOf(report);
		if (index === -1) return;
		finding.reports.splice(index, 1);
		if (finding.reports.length === 0) {
			this.#remove(finding);
		} else {
			let severity: AdvisorSeverity | undefined;
			for (const r of finding.reports) if (severityRank(r.severity) > severityRank(severity)) severity = r.severity;
			finding.severity = severity;
		}
		this.#changed();
	}

	/** Raise a recorded report's severity in place, lifting the finding's severity with it. */
	raiseReport(finding: AdvisorFinding, report: AdvisorReport, severity: AdvisorSeverity | undefined): void {
		if (severityRank(severity) <= severityRank(report.severity)) return;
		report.severity = severity;
		if (severityRank(severity) > severityRank(finding.severity)) finding.severity = severity;
		finding.lastTouchedTurn = this.#turn;
		this.#changed();
	}

	/** Record that a report on `id` interrupted the primary. */
	markInterrupted(id: string): void {
		const finding = this.get(id);
		if (!finding || finding.interrupted) return;
		finding.interrupted = true;
		this.#changed();
	}

	/** Advisors that reported `finding`, owner first, each once. */
	reporters(finding: AdvisorFinding): string[] {
		const names: string[] = [];
		for (const report of finding.reports) if (!names.includes(report.advisor)) names.push(report.advisor);
		const ownerIndex = names.findIndex(name => sameName(name, finding.owner));
		if (ownerIndex > 0) names.unshift(...names.splice(ownerIndex, 1));
		return names;
	}

	/** Advance one primary turn; open findings untouched for {@link ADVISOR_FINDING_EXPIRY_TURNS} expire. */
	advanceTurn(): void {
		this.#turn++;
		let expired = false;
		for (const finding of this.#findings) {
			if (finding.status !== "open") continue;
			if (this.#turn - finding.lastTouchedTurn < ADVISOR_FINDING_EXPIRY_TURNS) continue;
			finding.status = "expired";
			this.#unindex(finding);
			expired = true;
		}
		if (expired) this.#changed();
	}

	/** Keep only open findings at severity concern or blocker. */
	compact(): void {
		const kept = this.#findings.filter(
			finding => finding.status === "open" && severityRank(finding.severity) >= SEVERITY_RANK.concern,
		);
		if (kept.length === this.#findings.length) return;
		this.#setFindings(kept);
		this.#changed();
	}

	/** Drop every finding and reset the turn counter. */
	clear(): void {
		this.#setFindings([]);
		this.#nextId = 1;
		this.#turn = 0;
	}

	/** The persisted snapshot. */
	toEntry(): AdvisorFindingsEntry {
		return { v: ADVISOR_FINDINGS_VERSION, turn: this.#turn, findings: this.#findings };
	}

	/**
	 * Replace the ledger with a persisted snapshot. Malformed findings are
	 * skipped; a snapshot with another version is ignored with a warning and
	 * leaves the ledger empty.
	 */
	load(data: unknown): void {
		this.clear();
		const version = typeof data === "object" && data !== null && "v" in data ? data.v : undefined;
		if (version !== ADVISOR_FINDINGS_VERSION) {
			if (data !== undefined) {
				logger.warn("Ignoring advisor findings ledger with an unsupported version", { version });
			}
			return;
		}
		const entry = findingsEntryShape(data);
		if (entry instanceof type.errors) {
			logger.warn("Ignoring malformed advisor findings ledger", { error: entry.summary });
			return;
		}
		const findings = entry.findings.flatMap(raw => {
			const finding = findingSchema(raw);
			return finding instanceof type.errors || finding.reports.length === 0 ? [] : [finding as AdvisorFinding];
		});
		this.#setFindings(findings);
		this.#turn = Math.max(0, entry.turn ?? 0);
		for (const finding of findings) {
			for (const { id } of [finding, ...(finding.merged ?? [])]) {
				const n = Number(id.slice(1));
				if (n >= this.#nextId) this.#nextId = n + 1;
			}
		}
	}

	#report(input: AdvisorReportInput, finding: AdvisorFinding): AdvisorReport {
		const category = input.category ?? "";
		const own = category === finding.category;
		const report: AdvisorReport = {
			advisor: input.advisor,
			kind: input.kind,
			defect: input.defect,
			turn: this.#turn,
			owner: sameName(
				input.advisor,
				own && finding.owner !== undefined ? finding.owner : category ? this.#ownerOf(category) : undefined,
			),
		};
		if (!own) report.category = category;
		if (input.severity) report.severity = input.severity;
		if (input.impact !== undefined) report.impact = input.impact;
		if (input.fix !== undefined) report.fix = input.fix;
		if (input.relation !== undefined) report.relation = input.relation;
		return report;
	}

	/**
	 * Append `report`. The cap applies per report category, so reports merged
	 * in from another finding never count against the lead's own: past it, the
	 * oldest report of that category that is neither its first nor an owner's
	 * is dropped.
	 */
	#attach(finding: AdvisorFinding, report: AdvisorReport): void {
		finding.reports.push(report);
		const peers = finding.reports.filter(r => r.category === report.category);
		if (peers.length <= ADVISOR_FINDING_REPORTS_CAPACITY) return;
		const dropped = peers.find((r, i) => i > 0 && !r.owner) ?? peers[1]!;
		finding.reports.splice(finding.reports.indexOf(dropped), 1);
	}

	#setFindings(findings: AdvisorFinding[]): void {
		this.#findings = findings;
		this.#byKey.clear();
		for (const finding of findings) if (finding.status === "open") this.#index(finding);
	}

	#index(finding: AdvisorFinding): void {
		for (const key of findingKeys(finding)) this.#byKey.set(key, finding);
	}

	#unindex(finding: AdvisorFinding): void {
		for (const key of findingKeys(finding)) if (this.#byKey.get(key) === finding) this.#byKey.delete(key);
	}

	#remove(finding: AdvisorFinding): void {
		const index = this.#findings.indexOf(finding);
		if (index !== -1) this.#findings.splice(index, 1);
		this.#unindex(finding);
	}

	#evict(): void {
		while (this.#findings.length > ADVISOR_FINDINGS_CAPACITY) {
			const closed = this.#findings.find(finding => finding.status !== "open");
			this.#remove(closed ?? this.#findings[0]!);
		}
	}

	#changed(): void {
		this.#onChange?.();
	}
}

function findingKey(category: string | undefined, identity: string): string {
	return `${category ?? ""}\n${identity}`;
}

/** Every ledger key `finding` answers for: its own category and those of findings merged into it. */
function findingKeys(finding: AdvisorFinding): string[] {
	return [
		findingKey(finding.category, finding.identity),
		...(finding.merged ?? []).map(merged => findingKey(merged.category, finding.identity)),
	];
}

const severitySchema = type("'nit' | 'concern' | 'blocker' | undefined");

const reportSchema = type({
	advisor: "string",
	kind: "'defect' | 'concern' | 'unverified' | 'suggestion'",
	"severity?": severitySchema,
	defect: "string",
	"impact?": "string | undefined",
	"fix?": "string | undefined",
	"relation?": type.enumerated(...ADVISOR_RELATIONS).or("undefined"),
	turn: "number.integer",
	owner: "boolean",
	"category?": "string | undefined",
});

const findingSchema = type({
	id: /^F\d+$/,
	category: "string",
	identity: "string",
	anchor: "string",
	"owner?": "string | undefined",
	status: "'open' | 'resolved' | 'expired'",
	"severity?": severitySchema,
	reports: reportSchema.array(),
	createdTurn: "number.integer",
	lastTouchedTurn: "number.integer",
	"where?": adviseWhereSchema.or("undefined"),
	"possiblyFixed?": "boolean | undefined",
	"interrupted?": "boolean | undefined",
	"merged?": type({ id: /^F\d+$/, category: "string" })
		.array()
		.or("undefined"),
});

const findingsEntryShape = type({
	v: "number",
	"turn?": "number.integer",
	findings: "unknown[]",
});
