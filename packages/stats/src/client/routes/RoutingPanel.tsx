import { useMemo, useState } from "react";
import type { ObservabilityStats, RoutingRow } from "../../observability-types";
import { BarList, Legend, TimeChart } from "../charts";
import { SERIES_COLORS } from "../data/colors";
import { formatCompact, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { Badge, Card, EmptyState, PageHeader, Segmented, Stat, StatGrid } from "../ui";
import { AnalyticsTable } from "./AnalyticsPanels";

function poolLabel(value: string): string {
	if (value === "(no pool)" || value === "No pool") return "No pool";
	return value
		.replace(/^role:/, "Role · ")
		.replace(/^chain:/, "Chain · ")
		.replace(/[_]/g, " ");
}

export function RoutingPanel({ data }: { data: ObservabilityStats }) {
	const [metric, setMetric] = useState<"requests" | "cost" | "tokens">("requests");
	const [dimension, setDimension] = useState<"pool" | "model" | "account">("pool");
	const [pickedPool, setPool] = useState("");
	const pools = [...new Set(data.routing.map(row => row.pool))].sort();
	const pool = pools.includes(pickedPool) ? pickedPool : "";
	const rows = useMemo(() => {
		const grouped = new Map<string, RoutingRow>();
		for (const row of data.routing) {
			if (pool && row.pool !== pool) continue;
			const key = JSON.stringify([row.pool, row.model, row.account]);
			const previous = grouped.get(key);
			grouped.set(
				key,
				previous
					? {
							...previous,
							requests: previous.requests + row.requests,
							cost: previous.cost + row.cost,
							tokens: previous.tokens + row.tokens,
						}
					: { ...row },
			);
		}
		return [...grouped.values()];
	}, [data.routing, pool]);
	const filtered = data.routing.filter(row => !pool || row.pool === pool);
	const buckets = [...new Set(filtered.map(row => row.bucket))].sort((a, b) => a - b);
	const labels = [...new Set(filtered.map(row => row[dimension]))];
	const series = labels.map((value, index) => ({
		key: value,
		label: dimension === "pool" ? poolLabel(value) : value,
		color: SERIES_COLORS[index % SERIES_COLORS.length] ?? "currentColor",
		values: buckets.map(bucket =>
			filtered
				.filter(row => row.bucket === bucket && row[dimension] === value)
				.reduce((sum, row) => sum + row[metric], 0),
		),
	}));
	const calls = data.routing.reduce((sum, row) => sum + row.requests, 0);
	const selectedTotal = rows.reduce((sum, row) => sum + row[metric], 0);
	const metricLabel = metric === "requests" ? "Calls" : metric === "cost" ? "Cost" : "Tokens";
	const display = (value: number) => (metric === "cost" ? formatEstimatedCost(value, 0) : formatCompact(value));
	const groups = [...new Set(rows.map(row => row.pool))]
		.map(name => ({
			name,
			rows: rows.filter(row => row.pool === name).sort((a, b) => b[metric] - a[metric]),
			total: rows.filter(row => row.pool === name).reduce((sum, row) => sum + row[metric], 0),
		}))
		.sort((a, b) => b.total - a.total);
	const poolCalls = new Map<string, number>();
	for (const row of data.routing) {
		poolCalls.set(row.pool, (poolCalls.get(row.pool) ?? 0) + row.requests);
	}
	const largestPool = [...poolCalls].sort((a, b) => b[1] - a[1])[0];
	return (
		<div className="page analytics-panel">
			<PageHeader
				title="Routing"
				description="Where completed usage-bearing calls were served. Local ledger, anonymous accounts."
			/>
			<StatGrid min={180}>
				<Stat
					label="Served calls"
					value={formatInteger(calls)}
					delta={{
						change: data.previousCalls ? (calls - data.previousCalls) / data.previousCalls : calls ? null : 0,
					}}
					hint="vs. previous equal period"
				/>
				<Stat label="Pools observed" value={formatInteger(pools.length)} hint="includes calls without a pool" />
				<Stat
					label="Models served"
					value={formatInteger(new Set(data.routing.map(row => row.model)).size)}
					hint="recorded serving models"
				/>
				<Stat
					label="Largest pool share"
					value={largestPool && calls ? formatPercent(largestPool[1] / calls) : "–"}
					hint={largestPool ? poolLabel(largestPool[0]) : "no served calls recorded"}
				/>
			</StatGrid>
			<Card
				title="Explore served usage"
				description="Filter a pool; the ledger and charts share the same selection."
				actions={
					<Segmented
						aria-label="Routing metric"
						value={metric}
						onChange={setMetric}
						options={[
							{ value: "requests", label: "Calls" },
							{ value: "cost", label: "Cost" },
							{ value: "tokens", label: "Tokens" },
						]}
					/>
				}
			>
				<Segmented
					aria-label="Pool"
					value={pool}
					onChange={setPool}
					options={[
						{ value: "", label: "All pools" },
						...pools.map(value => ({ value, label: poolLabel(value) })),
					]}
				/>
			</Card>
			{!rows.length ? (
				<Card title="Served usage">
					<EmptyState
						title={data.ledgerAvailable ? "No served usage in this range" : "Usage ledger unavailable"}
						hint="Choose a wider range. Older installations may not have a usage ledger."
					/>
				</Card>
			) : (
				<div className="grid grid-2 analytics-split">
					<Card
						title="Pool → model → account"
						description={`${formatInteger(rows.length)} serving combinations · aggregated across the selected period`}
						flush
					>
						<AnalyticsTable label="Pool model and anonymous account drilldown">
							<table className="table routing-ledger">
								<thead>
									<tr>
										<th scope="col">Model / account</th>
										<th scope="col">{metricLabel} / share</th>
									</tr>
								</thead>
								{groups.map(group => (
									<tbody key={group.name}>
										<tr className="routing-pool-row">
											<th scope="rowgroup" colSpan={2}>
												{poolLabel(group.name)} <span>{display(group.total)}</span>
											</th>
										</tr>
										{group.rows.map(row => (
											<tr key={JSON.stringify([row.model, row.account])}>
												<td>
													<div className="routing-model">{row.model}</div>
													<Badge>{row.account}</Badge>
												</td>
												<td className="routing-value">
													<strong>{display(row[metric])}</strong>
													<span>
														{formatPercent(selectedTotal ? row[metric] / selectedTotal : 0)} of selection
													</span>
												</td>
											</tr>
										))}
									</tbody>
								))}
							</table>
						</AnalyticsTable>
					</Card>
					<div className="stack">
						<Card
							title="Served distribution"
							description={`${display(selectedTotal)} ${metric === "cost" ? "API-equivalent" : metricLabel.toLowerCase()} in selection`}
							actions={
								<Segmented
									size="sm"
									aria-label="Routing dimension"
									value={dimension}
									onChange={setDimension}
									options={[
										{ value: "pool", label: "Pool" },
										{ value: "model", label: "Model" },
										{ value: "account", label: "Account" },
									]}
								/>
							}
						>
							<div
								role="img"
								aria-label={`${metricLabel} by ${dimension}: ${series.map(item => `${item.label}: ${display(item.values.reduce((sum, value) => sum + value, 0))}`).join("; ")}`}
							>
								<TimeChart
									buckets={buckets}
									bucketMs={buckets.length > 1 ? (buckets[1] ?? 0) - (buckets[0] ?? 0) : 3600000}
									series={series}
									height={220}
								/>
							</div>
							<Legend items={series} />
						</Card>
						<Card title={`${metricLabel} by ${dimension}`} description="Share of the filtered selection">
							<BarList
								max={selectedTotal}
								items={series.map(item => ({
									key: item.key,
									label: item.label,
									color: item.color,
									value: item.values.reduce((sum, value) => sum + value, 0),
									display: display(item.values.reduce((sum, value) => sum + value, 0)),
								}))}
							/>
						</Card>
					</div>
				</div>
			)}
			<p className="analytics-note">
				{data.ledgerAvailable ? "Local usage ledger available. " : "Local usage ledger unavailable. "}
				Serving outcomes exclude failed calls without usage and are not selection attempts or routing decisions.
				No-pool and unknown-account buckets remain separate. Account labels are anonymous ordinals; strategy inputs,
				rejected candidates and full retry paths are not recorded.
			</p>
		</div>
	);
}
