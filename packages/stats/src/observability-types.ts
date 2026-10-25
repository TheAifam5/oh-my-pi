import type { AccountLimit } from "@oh-my-pi/pi-ai/usage/limits";

export interface HeadroomPolicy {
	label: string;
	limit: AccountLimit;
	scopes: { provider?: string; model?: string; pool?: string }[];
	snapshot?: HeadroomRow;
	budgetId?: string;
}

export interface HeadroomRow {
	label: string;
	metric: string;
	used: number | null;
	cap: number;
	samples: number;
	resetAt: number | null;
	recoveryAt: number | null;
	previous: number | null;
	burn: number[];
}

export interface RoutingRow {
	pool: string;
	model: string;
	account: string;
	bucket: number;
	requests: number;
	cost: number;
	tokens: number;
}

export interface FindingSnapshot {
	turn: number;
	timestamp?: number;
	id?: string;
	parentId?: string | null;
	findings: {
		id: string;
		status: string;
		severity: string;
		category: string;
		owner?: string;
		createdTurn: number;
		resolution?: { by?: string; turn: number };
		reports?: { advisor: string }[];
	}[];
}

export interface FindingOutcomes {
	observed: number;
	open: { severity: string; category: string; owner: string; count: number }[];
	rows: { severity: string; category: string; owner: string; status: string; count: number }[];
	resolved: Record<string, number>;
	expired: number;
	reopened: number;
	turns: number[];
	durationsMs: number[];
	resolvedConcerns: number;
}

export interface ModelObservation {
	model: string;
	provider: string;
	requests: number;
	latencySamples: number;
	ttftSamples: number;
	p50Latency: number | null;
	p95Latency: number | null;
	p50Ttft: number | null;
	p95Ttft: number | null;
	errors: number;
	costPerRequest: number;
	recovered: number;
	recoverySamples: number;
}

export interface ObservabilityStats {
	headroom: HeadroomRow[];
	configurationAvailable: boolean;
	ledgerAvailable: boolean;
	routing: RoutingRow[];
	previousCalls: number;
	models: ModelObservation[];
	cache: { bucket: number; input: number; read: number; write: number; savings: number; samples: number }[];
	cacheModels: { model: string; provider: string; hitRate: number; samples: number }[];
	spend: { agent: string; cost: number; samples: number }[];
	advisors: {
		advisor: string;
		model: string;
		cost: number;
		samples: number;
		latency: number | null;
		latencySamples: number;
	}[];
	findings: FindingOutcomes;
	previousFindings: FindingOutcomes | null;
	coverage: {
		files: number;
		unreadable: number;
		snapshots: number;
		recoveryAnnotations: number;
		pendingFiles: number;
	};
}
