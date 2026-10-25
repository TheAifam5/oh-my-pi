import "./findings.css";
import type { FindingOutcomes, ObservabilityStats } from "../../observability-types";
import { Chart, Legend } from "../charts";
import { SERIES_COLORS } from "../data/colors";
import { formatInteger } from "../data/formatters";
import { Badge, Card, EmptyState, Stat, StatGrid, Table } from "../ui";

const SEVERITIES = ["blocker", "concern", "nit", "unknown"];
const SEVERITY_COLORS = ["var(--bad)", "var(--warn)", SERIES_COLORS[0] ?? "currentColor", "var(--ink-3)"];

function title(value: string): string {
	if (!value || value === "unknown") return "Unspecified";
	return value
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, character => character.toUpperCase())
		.replace(/\bUi\b/g, "UI");
}

function resolutionDuration(value: number | null): string {
	if (value === null) return "–";
	const seconds = Math.round(value / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function median(values: readonly number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? (sorted[index] ?? null) : ((sorted[index - 1] ?? 0) + (sorted[index] ?? 0)) / 2;
}

function totalResolved(findings: FindingOutcomes): number {
	return Object.values(findings.resolved).reduce((sum, count) => sum + count, 0);
}

function delta(
	value: number,
	previous: number | null,
	good: "up" | "down" = "up",
): { change: number | null; good: "up" | "down" } | undefined {
	return previous === null ? undefined : { change: previous > 0 ? (value - previous) / previous : null, good };
}

export function FindingsPanel({ data }: { data: ObservabilityStats }) {
	const findings = data.findings;
	const previous = data.previousFindings;
	const open = findings.open.reduce((sum, row) => sum + row.count, 0);
	const resolved = totalResolved(findings);
	const duration = median(findings.durationsMs);
	const categories = [...new Set(findings.open.map(row => row.category))].sort();
	const severitySeries = SEVERITIES.map((severity, index) => ({
		key: severity,
		label: title(severity),
		color: SEVERITY_COLORS[index] ?? "currentColor",
		values: categories.map(category =>
			findings.open
				.filter(row => row.category === category && row.severity === severity)
				.reduce((sum, row) => sum + row.count, 0),
		),
	}));
	const categoryTotals = categories.map((_, index) =>
		severitySeries.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
	);
	const largestCategory = Math.max(1, ...categoryTotals);
	const actors = ["user", "agent", "advisor", "unknown"];
	const actorLabels = ["User", "Agent", "Advisor", "Unrecorded"];
	const outcomes = actors.map(actor => findings.resolved[actor] ?? 0);
	const histogramLabels = ["< 1m", "1–5m", "5–30m", "30m–2h", "2h+"];
	const histogram = [0, 0, 0, 0, 0];
	for (const value of findings.durationsMs) {
		const index = value < 60000 ? 0 : value < 300000 ? 1 : value < 1800000 ? 2 : value < 7200000 ? 3 : 4;
		histogram[index] = (histogram[index] ?? 0) + 1;
	}
	return (
		<div className="stack findings-panel">
			<StatGrid min={180}>
				<Stat
					label="Open backlog"
					value={formatInteger(open)}
					delta={delta(open, previous ? previous.open.reduce((sum, row) => sum + row.count, 0) : null, "down")}
					hint="at the end of the period"
				/>
				<Stat
					label="Resolved"
					value={formatInteger(resolved)}
					delta={delta(resolved, previous ? totalResolved(previous) : null)}
					hint="observed open → resolved"
				/>
				<Stat
					label="Expired"
					value={formatInteger(findings.expired)}
					delta={delta(findings.expired, previous?.expired ?? null, "down")}
					hint="not accepted or resolved"
				/>
				<Stat
					label="Median time to resolve"
					value={resolutionDuration(duration)}
					delta={
						duration === null
							? undefined
							: delta(duration, previous ? median(previous.durationsMs) : null, "down")
					}
					hint={`${findings.durationsMs.length} timestamped resolutions · ${findings.reopened} reopened`}
				/>
			</StatGrid>
			<p className="micro dim">
				Compared with the preceding equal-length period. {data.coverage.files} transcripts indexed ·{" "}
				{data.coverage.pendingFiles} awaiting indexing · {data.coverage.unreadable} unreadable. Snapshots record
				observed transitions; missing snapshots and disappearing findings do not establish resolution. v1 resolver
				is unrecorded.
			</p>
			{!data.coverage.snapshots ? (
				<EmptyState
					title="No findings recorded in this range"
					hint="Choose a wider range. Findings appear after their persisted snapshots are indexed."
				/>
			) : (
				<div className="grid grid-2 findings-split">
					<Card
						title="Findings ledger"
						description={`${formatInteger(open)} open · grouped by severity, owner, category and latest status`}
						flush
					>
						<div className="findings-table" tabIndex={0} role="region" aria-label="Findings by latest status">
							<Table
								rows={[...findings.rows].sort(
									(a, b) =>
										SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.count - a.count,
								)}
								rowKey={row => JSON.stringify([row.owner, row.category, row.severity, row.status])}
								columns={[
									{
										key: "severity",
										header: "Severity",
										render: row => (
											<Badge
												tone={
													row.severity === "blocker"
														? "bad"
														: row.severity === "concern"
															? "warn"
															: "neutral"
												}
											>
												{title(row.severity)}
											</Badge>
										),
									},
									{ key: "category", header: "Category", render: row => title(row.category) },
									{ key: "owner", header: "Owner", render: row => title(row.owner) },
									{
										key: "status",
										header: "Status",
										render: row => (
											<Badge
												tone={
													row.status === "resolved" ? "ok" : row.status === "open" ? "accent" : "neutral"
												}
											>
												{title(row.status)}
											</Badge>
										),
									},
									{
										key: "count",
										header: "Findings",
										align: "right",
										sort: row => row.count,
										render: row => formatInteger(row.count),
									},
								]}
							/>
						</div>
					</Card>
					<div className="stack findings-charts">
						<Card
							title="Resolution funnel"
							description="Observed resolution transitions, split by recorded resolver; reopened findings can resolve again."
						>
							<div className="findings-funnel">
								<div className="findings-funnel-total">
									<span>Resolved transitions</span>
									<strong>{formatInteger(resolved)}</strong>
								</div>
								<ol className="findings-actors" aria-label="Resolution actors">
									{actors.map((actor, index) => (
										<li key={actor}>
											<div className="findings-actor-label">
												<span>{actorLabels[index]}</span>
												<strong>{formatInteger(outcomes[index] ?? 0)}</strong>
											</div>
											<div className="findings-actor-track" aria-hidden="true">
												<div
													style={{
														width: `${resolved ? ((outcomes[index] ?? 0) / resolved) * 100 : 0}%`,
														background: SERIES_COLORS[index],
													}}
												/>
											</div>
										</li>
									))}
								</ol>
								<p className="micro dim">
									{formatInteger(open)} still open · {formatInteger(findings.expired)} expired, not resolved
								</p>
							</div>
						</Card>
						<Card title="Severity by category" description="Open backlog, stacked by severity">
							<ul className="findings-category-bars" aria-label="Open severity and category mix">
								{categories.map((category, index) => (
									<li key={category}>
										<div className="findings-category-label">
											<span>{title(category)}</span>
											<strong>{formatInteger(categoryTotals[index] ?? 0)}</strong>
										</div>
										<div
											className="findings-category-track"
											role="img"
											aria-label={`${title(category)}: ${severitySeries.map(series => `${series.label}: ${series.values[index] ?? 0}`).join("; ")}`}
										>
											{severitySeries.map(series => (
												<span
													key={series.key}
													style={{
														width: `${((series.values[index] ?? 0) / largestCategory) * 100}%`,
														background: series.color,
													}}
												/>
											))}
										</div>
									</li>
								))}
							</ul>
							<Legend items={severitySeries} />
						</Card>
						<Card
							title="Time to resolve"
							description={`${findings.durationsMs.length} resolutions timed from first observed open snapshot; ${findings.turns.length} have turn evidence.`}
						>
							<div
								role="img"
								aria-label={`Observed resolution duration histogram: ${histogramLabels.map((label, index) => `${label}: ${histogram[index] ?? 0}`).join("; ")}`}
							>
								<Chart
									height={180}
									slots={histogram.length}
									tickLabel={index => histogramLabels[index] ?? ""}
									series={[
										{
											key: "duration",
											label: "Resolved findings",
											color: SERIES_COLORS[2] ?? "currentColor",
											values: histogram,
										},
									]}
								/>
							</div>
						</Card>
					</div>
				</div>
			)}
		</div>
	);
}
