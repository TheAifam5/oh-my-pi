import type { ReactNode } from "react";
import type { ObservabilityStats } from "../../observability-types";
import { BarList, Legend, TimeChart } from "../charts";
import { SERIES_COLORS } from "../data/colors";
import { formatCompact, formatDurationMs, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { Badge, Card, EmptyState, LabelCell, MeterCell, Stat, StatGrid, Table } from "../ui";

const cost = (value: number) => formatEstimatedCost(value, 0);
const color = (index: number) => SERIES_COLORS[index % SERIES_COLORS.length] ?? "currentColor";
const label = (value: string) =>
	value
		.replace(/[_-]/g, " ")
		.replace(/\bui\b/gi, "UI")
		.replace(/\b\w/g, character => character.toUpperCase())
		.replace(/\bAnd\b/g, "and");

function recoveryTime(timestamp: number): string {
	const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function capacityLabel(value: string): string {
	return value
		.replace(/\/(Account \d+): [^:]+:/, " · $1 · ")
		.replace(/\b(\d+)h\b/g, "$1-hour")
		.replace(/\b(\d+)d\b/g, "$1-day")
		.replace(/:/g, " · ")
		.replace(/_/g, " ");
}

export function AnalyticsTable({ children, label: name }: { children: ReactNode; label: string }) {
	return (
		<div className="analytics-table" role="region" aria-label={name} tabIndex={0}>
			{children}
		</div>
	);
}

export function AnalyticsPanels({
	data,
	panel,
}: {
	data: ObservabilityStats;
	panel: "cache" | "headroom" | "economics";
}) {
	if (panel === "headroom") return <HeadroomPanel data={data} />;
	if (panel === "economics") return <EconomicsPanel data={data} />;
	return <CachePanel data={data} />;
}

function CachePanel({ data }: { data: ObservabilityStats }) {
	const totals = data.cache.reduce(
		(sum, row) => ({
			input: sum.input + row.input,
			read: sum.read + row.read,
			write: sum.write + row.write,
			savings: sum.savings + row.savings,
			samples: sum.samples + row.samples,
		}),
		{ input: 0, read: 0, write: 0, savings: 0, samples: 0 },
	);
	const tokens = totals.input + totals.read + totals.write;
	const series = (["input", "read", "write"] as const).map(key => ({
		key,
		label: key === "input" ? "Uncached input" : key === "read" ? "Cache reads" : "Cache writes",
		kind: "bars" as const,
		color:
			key === "input"
				? (SERIES_COLORS[5] ?? "currentColor")
				: key === "read"
					? "var(--chart-primary)"
					: (SERIES_COLORS[3] ?? "currentColor"),
		values: data.cache.map(row => row[key]),
	}));
	return (
		<section className="stack analytics-panel" aria-label="Cache savings">
			<div className="analytics-heading">
				<h2>Cache savings</h2>
				<p>Input reuse and public-price savings across the selected period.</p>
			</div>
			<StatGrid min={170}>
				<Stat
					label="Estimated savings"
					value={cost(totals.savings)}
					hint={`${formatInteger(totals.samples)} transcript requests · priced input baselines only`}
				/>
			</StatGrid>
			<div className="grid grid-2 analytics-split">
				<Card
					title="Cache efficiency by model"
					description="Cache reads ÷ (uncached input + cache reads)"
					className="analytics-fit"
					flush
				>
					<AnalyticsTable label="Model cache efficiency">
						<Table
							rows={data.cacheModels}
							rowKey={row => `${row.provider}/${row.model}`}
							initialSort={{ key: "rate", dir: "desc" }}
							columns={[
								{
									key: "model",
									header: "Model",
									render: row => (
										<LabelCell
											primary={row.model}
											secondary={`${row.provider} · ${formatInteger(row.samples)} requests`}
										/>
									),
								},
								{
									key: "rate",
									header: "Hit rate",
									align: "right",
									sort: row => row.hitRate,
									render: row => (
										<MeterCell
											value={row.hitRate}
											max={1}
											display={formatPercent(row.hitRate)}
											color="var(--ok)"
										/>
									),
								},
							]}
						/>
					</AnalyticsTable>
				</Card>
				<Card
					title="Input token composition"
					description={`${formatCompact(tokens)} tokens · ${formatCompact(totals.input)} uncached`}
				>
					{data.cache.length ? (
						<div className="stack">
							<div
								role="img"
								aria-label={`Input tokens: ${formatInteger(totals.input)} uncached, ${formatInteger(totals.read)} cache reads, ${formatInteger(totals.write)} cache writes`}
							>
								<TimeChart
									buckets={data.cache.map(row => row.bucket)}
									bucketMs={
										data.cache.length > 1
											? (data.cache[1]?.bucket ?? 0) - (data.cache[0]?.bucket ?? 0)
											: 3600000
									}
									series={series}
									height={220}
								/>
							</div>
							<Legend items={series} />
						</div>
					) : (
						<EmptyState title="No cache observations in this range" />
					)}
				</Card>
			</div>
			<p className="analytics-note">
				Savings compare public-price uncached input with observed input and cache cost; unpriced baselines are
				excluded. Model hit rates use the same definition as Overview: cache reads ÷ (uncached input + reads). Cache
				writes are shown separately in the composition chart.
			</p>
		</section>
	);
}

function HeadroomPanel({ data }: { data: ObservabilityStats }) {
	const caps = data.headroom.filter(row => row.metric !== "quota fraction");
	const known = caps.filter(row => row.used !== null);
	const exhausted = known.filter(row => (row.used ?? 0) >= row.cap).length;
	const warning = known.filter(
		row => row.cap > 0 && (row.used ?? 0) / row.cap >= 0.8 && (row.used ?? 0) < row.cap,
	).length;
	return (
		<section className="stack analytics-panel" aria-label="Budget and limit headroom">
			<div className="analytics-heading">
				<h2>Budget and limit headroom</h2>
				<p>Configured local limits and budgets. Subscription quotas remain in Subscription windows above.</p>
			</div>
			{!data.configurationAvailable ? (
				<Card title="Current policy">
					<EmptyState
						title="Effective configuration unavailable"
						hint="Launch through omp stats to expose current settings. Standalone stats does not infer configuration."
					/>
				</Card>
			) : !caps.length ? (
				<Card title="Local caps">
					<EmptyState
						title="No configured local caps"
						hint="No effective local limits or budgets are configured. Subscription quotas are shown in Subscription windows above."
					/>
				</Card>
			) : (
				<>
					<StatGrid min={170}>
						<Stat
							label="Configured local caps"
							value={formatInteger(caps.length)}
							hint="overlapping scopes, not additive"
						/>
						<Stat label="At capacity" value={formatInteger(exhausted)} hint="usage has reached the cap" />
						<Stat label="Approaching cap" value={formatInteger(warning)} hint="80% or more used" />
						<Stat
							label="Usage unavailable"
							value={formatInteger(caps.length - known.length)}
							hint="ledger evidence missing"
						/>
					</StatGrid>
					<Card
						title="Capacity ledger"
						description="Current local caps and next recovery"
						className="analytics-fit"
						flush
					>
						<AnalyticsTable label="Budget and limit capacity">
							<Table
								rows={caps}
								rowKey={row => row.label}
								columns={[
									{
										key: "label",
										header: "Scope",
										wrap: true,
										render: row => (
											<LabelCell primary={capacityLabel(row.label)} secondary={label(row.metric)} />
										),
									},
									{
										key: "used",
										header: "Capacity / recovery",
										wrap: true,
										render: row =>
											row.used === null ? (
												<Badge>Unavailable ledger</Badge>
											) : (
												<div className="capacity-state">
													<MeterCell
														value={row.used}
														max={row.cap}
														display={`${formatPercent(row.cap > 0 ? row.used / row.cap : 1, 0)} used`}
														color={
															row.used >= row.cap
																? "var(--bad)"
																: row.used >= row.cap * 0.8
																	? "var(--warn)"
																	: "var(--ok)"
														}
													/>
													<span>
														{formatCompact(row.used)} of {formatCompact(row.cap)} {row.metric}
													</span>
													<span>
														{row.resetAt
															? `Resets in ${recoveryTime(row.resetAt)}`
															: row.recoveryAt
																? `Usage ages out in ${recoveryTime(row.recoveryAt)}`
																: "No usage awaiting expiry"}
													</span>
												</div>
											),
									},
								]}
							/>
						</AnalyticsTable>
					</Card>
				</>
			)}
			<p className="analytics-note">
				Current configuration, not historical policy. Calendar windows use local time; rolling windows never reset.
				Budgets may overlap and must not be summed.
			</p>
		</section>
	);
}

function EconomicsPanel({ data }: { data: ObservabilityStats }) {
	const advisorCost = data.advisors.reduce((sum, row) => sum + row.cost, 0);
	const requests = data.advisors.reduce((sum, row) => sum + row.samples, 0);
	const spend = data.spend.reduce((sum, row) => sum + row.cost, 0);
	return (
		<section className="stack analytics-panel" aria-label="Advisor economics">
			<div className="analytics-heading">
				<h2>Advisor economics</h2>
				<p>Observed review work, finding yield and agent spend.</p>
			</div>
			<StatGrid min={170}>
				<Stat
					label="Advisor cost"
					value={cost(advisorCost)}
					hint={`${formatInteger(requests)} transcript requests`}
				/>
				<Stat
					label="Findings observed"
					value={formatInteger(data.findings.observed)}
					hint="not attributed to individual reviews"
				/>
				<Stat
					label="Resolved concerns / blockers"
					value={formatInteger(data.findings.resolvedConcerns)}
					hint="observed resolution transitions"
				/>
				<Stat
					label="Cost per resolution"
					value={data.findings.resolvedConcerns ? cost(advisorCost / data.findings.resolvedConcerns) : "–"}
					hint="aggregate ratio, not causal benefit"
				/>
			</StatGrid>
			<div className="grid grid-2 analytics-split">
				<Card title="Advisor and model ledger" description="Request latency excludes queue time" flush>
					{data.advisors.length ? (
						<AnalyticsTable label="Advisor costs and latency">
							<Table
								rows={data.advisors}
								rowKey={row => `${row.advisor}/${row.model}`}
								initialSort={{ key: "cost", dir: "desc" }}
								columns={[
									{
										key: "advisor",
										header: "Advisor / model",
										render: row => <LabelCell primary={label(row.advisor)} secondary={row.model} />,
									},
									{
										key: "cost",
										header: "Cost",
										align: "right",
										sort: row => row.cost,
										render: row => cost(row.cost),
									},
									{
										key: "latency",
										header: "Mean latency",
										align: "right",
										render: row => (
											<LabelCell
												primary={formatDurationMs(row.latency)}
												secondary={`${formatInteger(row.latencySamples)} timed`}
											/>
										),
									},
									{
										key: "samples",
										header: "Requests",
										align: "right",
										sort: row => row.samples,
										render: row => formatInteger(row.samples),
									},
								]}
							/>
						</AnalyticsTable>
					) : (
						<EmptyState title="No advisor transcripts in this range" />
					)}
				</Card>
				<div className="stack">
					<Card title="Agent spend split" description={`${cost(spend)} total · API-equivalent transcript cost`}>
						{data.spend.length ? (
							<BarList
								max={spend}
								items={data.spend.map((row, index) => ({
									key: row.agent,
									label: label(row.agent),
									value: row.cost,
									display: `${cost(row.cost)} · ${formatPercent(spend ? row.cost / spend : 0)}`,
									color: color(index),
								}))}
							/>
						) : (
							<EmptyState title="No agent spend recorded" />
						)}
					</Card>
					<Card title="Request coverage" description="Primary, advisor and subagent transcript samples">
						{data.spend.length ? (
							<BarList
								items={data.spend.map((row, index) => ({
									key: row.agent,
									label: label(row.agent),
									value: row.samples,
									display: `${formatInteger(row.samples)} requests`,
									color: color(index),
								}))}
							/>
						) : (
							<EmptyState title="No transcript requests recorded" />
						)}
					</Card>
				</div>
			</div>
			<p className="analytics-note">
				Findings and costs cannot be joined to individual reviews. Requests are not review counts; yield includes
				all observed findings. Previous-period advisor spend is not recorded.
			</p>
		</section>
	);
}
