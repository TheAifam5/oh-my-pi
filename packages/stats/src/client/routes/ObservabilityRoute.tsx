import type { ObservabilityStats } from "../../observability-types";
import { useQuery } from "../data/query";
import type { TimeRange } from "../types";
import { EmptyState, PageHeader, Skeleton } from "../ui";
import { AnalyticsPanels } from "./AnalyticsPanels";
import { FindingsPanel } from "./FindingsPanel";
import { RoutingPanel } from "./RoutingPanel";
import "./analytics.css";

export async function fetchObservability(range: TimeRange, signal: AbortSignal): Promise<ObservabilityStats | null> {
	const response = await fetch(`/api/stats/observability?range=${range}`, { signal });
	if (response.status === 403) return null;
	if (!response.ok) throw new Error(`Observability request failed (${response.status})`);
	return (await response.json()) as ObservabilityStats;
}

export function ObservabilityRoute({
	active,
	range,
	routing = false,
	panel,
}: {
	active: boolean;
	range: TimeRange;
	routing?: boolean;
	panel?: "headroom" | "economics" | "cache";
}) {
	const query = useQuery(["observability", range], ({ signal }) => fetchObservability(range, signal), {
		enabled: active,
		pollMs: 60000,
	});
	if (query.loading) return <Skeleton height={260} />;
	if (query.error) return <EmptyState title="Observability unavailable" hint={String(query.error)} />;
	if (query.data === null)
		return (
			<EmptyState
				title="Local-only observability"
				hint="Budget, routing, findings and advisor panels require a dashboard bound to a loopback address."
			/>
		);
	if (!query.data) return <Skeleton height={260} />;
	if (routing) return <RoutingPanel data={query.data} />;
	if (panel) return <AnalyticsPanels data={query.data} panel={panel} />;
	return (
		<div className="page">
			<PageHeader title="Findings" description="Observed advisor findings, backlog and lifecycle outcomes." />
			<FindingsPanel data={query.data} />
		</div>
	);
}
