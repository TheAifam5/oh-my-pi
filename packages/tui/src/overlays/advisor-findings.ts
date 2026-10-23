import { SelectList } from "../components/select-list";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { matchesKey } from "../keys";
import { col, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent } from "../native/picker";
import { overlayCard } from "../native/overlay";
import { getSelectListTheme } from "../theme/theme";
import type { Component, TUI } from "../tui";
import { truncateToWidth, wrapTextWithAnsi } from "../utils";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";

export interface AdvisorFindingView {
	id: string;
	status: "open" | "resolved" | "expired";
	severity?: "nit" | "concern" | "blocker";
	category: string;
	anchor: string;
	owner?: string;
	reports: readonly {
		advisor: string;
		owner: boolean;
		category?: string;
		defect: string;
		impact?: string;
		fix?: string;
	}[];
	possiblyFixed?: boolean;
	interrupted?: boolean;
	merged?: readonly { id: string }[];
}

export interface AdvisorFindingsSource {
	getFindings: () => readonly AdvisorFindingView[];
	changeStatus: (action: "resolve" | "reopen", id: string) => string;
}

const SEVERITY = { blocker: 0, concern: 1, nit: 2 };

export class AdvisorFindingsOverlay implements Component {
	#list: SelectList;
	#findings: readonly AdvisorFindingView[] = [];
	#filter: "open" | "all";
	#message = "";
	#detailScroll = 0;

	constructor(
		readonly ui: Pick<TUI, "requestRender" | "terminal">,
		readonly source: AdvisorFindingsSource,
		readonly onClose: () => void,
		filter: "open" | "all" = "open",
	) {
		this.#filter = filter;
		this.#list = new SelectList([], 8, getSelectListTheme(), { search: "never" });
		this.#list.onCancel = onClose;
		this.#list.onSelectionChange = () => {
			this.#detailScroll = 0;
		};
		this.#refresh();
	}

	#refresh(): void {
		this.#findings = this.source
			.getFindings()
			.filter(finding => this.#filter === "all" || finding.status === "open")
			.sort(
				(a, b) =>
					Number(b.status === "open") - Number(a.status === "open") ||
					SEVERITY[a.severity ?? "nit"] - SEVERITY[b.severity ?? "nit"],
			);
		this.#list.setItems(
			this.#findings.map(finding => ({
				value: finding.id,
				label: sanitizeDisplayLine(
					`${finding.id} [${finding.status}] ${finding.severity ?? "nit"} ${finding.category || "-"} at ${finding.anchor} owner=${finding.owner ?? "-"} reporters=${new Set(finding.reports.map(report => report.advisor)).size}`,
				),
			})),
		);
	}

	#details(): string[] {
		const selected = this.#list.getSelectedItem()?.value;
		const finding = this.#findings.find(entry => entry.id === selected);
		if (!finding) return [this.#filter === "all" ? "No advisor findings." : "No open advisor findings."];
		const lead = finding.reports.find(report => report.owner && report.category === undefined) ?? finding.reports[0];
		return [
			`${finding.id} [${finding.status}] ${finding.severity ?? "nit"}`,
			`Category: ${finding.category || "-"}`,
			`Anchor: ${finding.anchor}`,
			`Owner: ${finding.owner ?? "-"}`,
			`Defect: ${lead?.defect ?? "-"}`,
			`Impact: ${lead?.impact ?? "-"}`,
			`Fix: ${lead?.fix ?? "-"}`,
			`Reporters: ${[...new Set(finding.reports.map(report => report.advisor))].join(", ") || "-"}`,
			`Flags: ${[finding.possiblyFixed ? "possibly-fixed" : "", finding.interrupted ? "interrupted" : ""].filter(Boolean).join(", ") || "-"}`,
			`Merged ids: ${finding.merged?.map(entry => entry.id).join(", ") || "-"}`,
		].flatMap(line => sanitizeDisplayText(line).split(/\r?\n/));
	}

	#action(action: string, value?: string): boolean {
		if (action === "close") this.onClose();
		else if (action === "filter" || action === "tab") {
			if (value !== undefined && value !== "open" && value !== "all") return false;
			this.#filter = value ?? (this.#filter === "open" ? "all" : "open");
			this.#detailScroll = 0;
			this.#message = "";
		} else if (action === "resolve" || action === "reopen") {
			const selected = this.#list.getSelectedItem()?.value;
			if (selected) this.#message = sanitizeDisplayLine(this.source.changeStatus(action, selected));
			this.#detailScroll = 0;
		} else return false;
		this.#refresh();
		this.ui.requestRender();
		return true;
	}

	setFilter(filter: "open" | "all"): void {
		this.#action("tab", filter);
	}

	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	describe(cx: DescribeContext): NativeNode {
		this.#refresh();
		const preview = this.#details().map(line => text(line));
		if (!cx.supports("picker")) {
			return overlayCard("omp.advisor.findings", "Advisor findings", [
				text(`Filter: ${this.#filter} · f open/all · r resolve · o reopen · esc close`),
				this.#list,
				col(preview),
				text(this.#message),
			]);
		}
		return picker(
			{
				title: "Advisor findings",
				noun: "findings",
				size: "lg",
				query: null,
				tabs: [
					{ id: "open", label: "Open" },
					{ id: "all", label: "All" },
				],
				tab: this.#filter,
				items: this.#findings.map(finding => ({
					id: finding.id,
					label: sanitizeDisplayLine(finding.id),
					detail: sanitizeDisplayLine(`${finding.category || "-"} at ${finding.anchor}`),
					facts: {
						status: finding.status,
						severity: finding.severity ?? "nit",
						owner: sanitizeDisplayLine(finding.owner ?? "-"),
						reporters: new Set(finding.reports.map(report => report.advisor)).size,
					},
				})),
				columns: [
					{ id: "status", head: "Status" },
					{ id: "severity", head: "Severity" },
					{ id: "owner", head: "Owner" },
					{ id: "reporters", head: "Reporters", format: "num" },
				],
				selected: this.#list.getSelectedItem()?.value ?? null,
				preview: "side",
				empty: this.#filter === "all" ? "No advisor findings." : "No open advisor findings.",
				message: this.#message || undefined,
				actions: [
					pickerAction("resolve", "Resolve", "r", { disabled: this.#list.getSelectedItem() ? undefined : true }),
					pickerAction("reopen", "Reopen", "o", { disabled: this.#list.getSelectedItem() ? undefined : true }),
					pickerAction("filter", "Show all", "f", { on: this.#filter === "all" }),
					CLOSE_ACTION,
				],
			},
			preview,
		);
	}

	handleNativeEvent(event: NativeUiEvent): boolean {
		const action = pickerEvent(event);
		if (!action) return false;
		if (action.kind === "action") return this.#action(action.act, action.value);
		this.#refresh();
		if (!this.#findings.some(finding => finding.id === action.item)) return false;
		this.#list.setSelectedValue(action.item);
		this.#detailScroll = 0;
		this.ui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		this.#refresh();
		if (matchesKey(data, "escape")) this.#action("close");
		else if (data === "f") this.#action("filter");
		else if (data === "r") this.#action("resolve");
		else if (data === "o") this.#action("reopen");
		else if (matchesKey(data, "pageDown")) this.#detailScroll += 5;
		else if (matchesKey(data, "pageUp")) this.#detailScroll = Math.max(0, this.#detailScroll - 5);
		else this.#list.handleInput(data);
		this.ui.requestRender();
	}

	render(width: number): string[] {
		this.#refresh();
		if (width < 5) return [truncateToWidth("Advisor findings", width)];
		const height = Math.max(12, this.ui.terminal.rows - 2);
		this.#list.setMaxVisible(Math.max(1, Math.min(8, Math.floor(height / 3))));
		const list = this.#list.render(width - 4);
		const details = this.#details().flatMap(line => wrapTextWithAnsi(line, width - 4));
		const budget = Math.max(1, height - list.length - 7);
		this.#detailScroll = Math.min(this.#detailScroll, Math.max(0, details.length - budget));
		return [
			topBorder(width, "Advisor findings"),
			row(
				truncateToWidth(`Filter: ${this.#filter} · f open/all · r resolve · o reopen · esc close`, width - 4),
				width,
			),
			...list.map(line => row(truncateToWidth(line, width - 4), width)),
			divider(width),
			...details
				.slice(this.#detailScroll, this.#detailScroll + budget)
				.map(line => row(truncateToWidth(line, width - 4), width)),
			row(truncateToWidth(this.#message || "↑/↓ findings · PgUp/PgDn preview", width - 4), width),
			bottomBorder(width),
		];
	}

	invalidate(): void {
		this.#list.invalidate();
	}
}
