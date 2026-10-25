import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { localLimitWindowResetAt, localLimitWindowStart } from "@oh-my-pi/pi-ai/usage/limits";
import { getAgentDbPath, isRecord } from "@oh-my-pi/pi-utils";
import { getTimeRangeConfig } from "./aggregator";
import { currentDb, initDb } from "./db";
import type {
	FindingOutcomes,
	FindingSnapshot,
	HeadroomPolicy,
	HeadroomRow,
	ModelObservation,
	ObservabilityStats,
} from "./observability-types";
import { ensureObservabilityIndex } from "./observability-index";

let policyProvider: (() => readonly HeadroomPolicy[] | Promise<readonly HeadroomPolicy[]>) | undefined;
export function setHeadroomPolicyProvider(
	provider: () => readonly HeadroomPolicy[] | Promise<readonly HeadroomPolicy[]>,
): void {
	policyProvider = provider;
}

export function percentile(values: number[], fraction: number): number | null {
	if (!values.length) return null;
	values.sort((a, b) => a - b);
	return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
}

export function replayFindings(snapshots: FindingSnapshot[], cutoff = 0, until = Infinity): FindingOutcomes {
	const result: FindingOutcomes = {
		observed: 0,
		open: [],
		rows: [],
		resolved: {},
		expired: 0,
		reopened: 0,
		turns: [],
		durationsMs: [],
		resolvedConcerns: 0,
	};
	let previous = new Map<string, FindingSnapshot["findings"][number]>();
	let openedAt = new Map<string, number>();
	let lastTurn = -1;
	const seen = new Set<string>();
	let epoch = 0;
	const branches = new Map<
		string,
		{
			turn: number;
			findings: Map<string, FindingSnapshot["findings"][number]>;
			openedAt: Map<string, number>;
		}
	>();
	for (const snapshot of snapshots) {
		if ((snapshot.timestamp ?? 0) > until) continue;
		if (snapshot.parentId !== undefined) {
			const parent = snapshot.parentId === null ? undefined : branches.get(snapshot.parentId);
			previous = parent?.findings ?? new Map();
			lastTurn = parent?.turn ?? -1;
			openedAt = parent?.openedAt ?? new Map();
		}
		if (snapshot.turn < lastTurn) {
			epoch++;
			previous = new Map();
			openedAt = new Map();
		}
		lastTurn = snapshot.turn;
		const inRange = (snapshot.timestamp ?? 0) >= cutoff;
		const next = new Map(snapshot.findings.map(finding => [finding.id, finding]));
		const nextOpenedAt = new Map<string, number>();
		for (const finding of next.values()) {
			if (inRange) seen.add(`${epoch}:${finding.id}`);
			const old = previous.get(finding.id);
			const started = old?.status === "open" ? openedAt.get(finding.id) : snapshot.timestamp;
			if (finding.status === "open" && started !== undefined && Number.isFinite(started) && started > 0) {
				nextOpenedAt.set(finding.id, started);
			}
			if (inRange && old?.status === "open" && finding.status === "resolved") {
				const by = finding.resolution?.by;
				const actor = by === "user" || by === "agent" ? by : by ? "advisor" : "unknown";
				result.resolved[actor] = (result.resolved[actor] ?? 0) + 1;
				if (finding.resolution) result.turns.push(Math.max(0, finding.resolution.turn - finding.createdTurn));
				if (
					started !== undefined &&
					started > 0 &&
					snapshot.timestamp !== undefined &&
					Number.isFinite(snapshot.timestamp) &&
					snapshot.timestamp >= started
				) {
					result.durationsMs.push(snapshot.timestamp - started);
				}
				if (finding.severity === "concern" || finding.severity === "blocker") result.resolvedConcerns++;
			}
			if (inRange && old?.status === "open" && finding.status === "expired") result.expired++;
			if (inRange && old && old.status !== "open" && finding.status === "open") result.reopened++;
		}
		previous = next;
		openedAt = nextOpenedAt;
		if (snapshot.id) branches.set(snapshot.id, { turn: snapshot.turn, findings: next, openedAt: nextOpenedAt });
	}
	result.observed = seen.size;
	for (const finding of previous.values()) {
		const statusRow = result.rows.find(
			row =>
				row.severity === finding.severity &&
				row.category === finding.category &&
				row.owner === (finding.owner ?? "unknown") &&
				row.status === finding.status,
		);
		if (statusRow) statusRow.count++;
		else
			result.rows.push({
				severity: finding.severity,
				category: finding.category,
				owner: finding.owner ?? "unknown",
				status: finding.status,
				count: 1,
			});
		if (finding.status !== "open") continue;
		const owner = finding.owner ?? "unknown";
		const row = result.open.find(
			row => row.severity === finding.severity && row.category === finding.category && row.owner === owner,
		);
		if (row) row.count++;
		else result.open.push({ severity: finding.severity, category: finding.category, owner, count: 1 });
	}
	return result;
}

function mergeFindings(target: FindingOutcomes, source: FindingOutcomes): void {
	target.observed += source.observed;
	for (const row of source.rows) {
		const existing = target.rows.find(
			item =>
				item.severity === row.severity &&
				item.category === row.category &&
				item.owner === row.owner &&
				item.status === row.status,
		);
		if (existing) existing.count += row.count;
		else target.rows.push(row);
	}
	target.durationsMs.push(...source.durationsMs);
	for (const row of source.open) {
		const existing = target.open.find(
			item => item.severity === row.severity && item.category === row.category && item.owner === row.owner,
		);
		if (existing) existing.count += row.count;
		else target.open.push(row);
	}
	target.expired += source.expired;
	target.reopened += source.reopened;
	target.turns.push(...source.turns);
	target.resolvedConcerns += source.resolvedConcerns;
	for (const [actor, count] of Object.entries(source.resolved))
		target.resolved[actor] = (target.resolved[actor] ?? 0) + count;
}

interface MessageRow {
	model: string;
	provider: string;
	duration_ms: number | null;
	ttft_ms: number | null;
	cost_total: number;
	stop_reason: string;
	agent_type: string;
	session_file: string;
}

export function headroom(
	database: Database | undefined,
	policies: readonly HeadroomPolicy[],
	now: number,
): HeadroomRow[] {
	return policies.map(policy => {
		if (policy.snapshot) return policy.snapshot;
		const { limit } = policy;
		if (!("window" in limit)) {
			return {
				label: policy.label,
				metric: limit.metric,
				cap: Number(limit.max),
				used: null,
				previous: null,
				samples: 0,
				resetAt: null,
				recoveryAt: null,
				burn: [],
			};
		}
		const start = localLimitWindowStart(limit.window, now) - (limit.window.type === "calendar" ? 1 : 0);
		const duration = now - start;
		const parameters: (string | number)[] = [];
		const clauses = policy.scopes.map(scope => {
			const terms = Object.entries(scope).map(([key, value]) => {
				parameters.push(value);
				return `${key} = ?`;
			});
			return terms.length ? `(${terms.join(" AND ")})` : "1";
		});
		const table = policy.budgetId ? "spend_ledger" : "usage_ledger";
		const filter = policy.budgetId ? "budget_id = ?" : `(${clauses.join(" OR ") || "0"})`;
		const args = policy.budgetId ? [policy.budgetId] : parameters;
		const expression =
			limit.metric === "usd"
				? "cost_nanos / 1000000000.0"
				: limit.metric === "tokens"
					? "input_tokens + output_tokens"
					: "1";
		const row: HeadroomRow = {
			label: policy.label,
			metric: limit.metric,
			cap: Number(limit.max),
			used: null,
			previous: null,
			samples: 0,
			resetAt: localLimitWindowResetAt(limit.window, now) ?? null,
			recoveryAt: null,
			burn: [],
		};
		try {
			if (!database) throw new Error("Usage ledger unavailable");
			const data = database
				.query<{ at_ms: number; value: number }, (string | number)[]>(
					`SELECT at_ms, ${expression} AS value FROM ${table} WHERE ${filter} AND at_ms > ? AND at_ms <= ? ORDER BY at_ms`,
				)
				.all(...args, start - duration, now);
			row.used = 0;
			row.previous = 0;
			row.burn = Array.from({ length: 24 }, () => 0);
			for (const item of data) {
				if (item.at_ms <= start) {
					row.previous += item.value;
					continue;
				}
				row.used += item.value;
				row.samples++;
				const slot = Math.min(23, Math.floor(((item.at_ms - start) / Math.max(1, duration)) * 24));
				row.burn[slot] = (row.burn[slot] ?? 0) + item.value;
				if (limit.window.type === "rolling" && row.recoveryAt === null)
					row.recoveryAt = item.at_ms + limit.window.durationMs;
			}
		} catch {
			/* Missing ledger tables leave usage unavailable. */
		}
		return row;
	});
}

export async function getObservabilityStats(range: string | null): Promise<ObservabilityStats> {
	await initDb();
	const database = currentDb();
	if (!database) throw new Error("Stats database unavailable");
	const now = Date.now();
	const config = getTimeRangeConfig(range);
	const cutoff = config.cutoff ?? 0;
	const policies = (await policyProvider?.()) ?? [];
	const bucketMs = Math.max(3600000, config.bucketMs);
	const result: ObservabilityStats = {
		headroom: [],
		configurationAvailable: Boolean(policyProvider),
		ledgerAvailable: false,
		routing: [],
		previousCalls: 0,
		models: [],
		cache: [],
		cacheModels: [],
		spend: [],
		advisors: [],
		findings: replayFindings([]),
		previousFindings: cutoff > 0 ? replayFindings([]) : null,
		coverage: { files: 0, unreadable: 0, snapshots: 0, recoveryAnnotations: 0, pendingFiles: 0 },
	};
	result.headroom = headroom(undefined, policies, now);
	let ledger: Database | undefined;
	try {
		ledger = new Database(getAgentDbPath(), { readonly: true });
		result.routing = ledger
			.query<
				{
					pool: string;
					model: string;
					account: string;
					bucket: number;
					requests: number;
					cost: number;
					tokens: number;
				},
				[number, number]
			>(
				`SELECT COALESCE(pool, 'No pool') AS pool, provider || '/' || model AS model, CASE WHEN account IS NULL THEN 'Unknown account' ELSE 'Account ' || DENSE_RANK() OVER (ORDER BY provider, account) END AS account, CAST(at_ms / ? AS INTEGER) * ${bucketMs} AS bucket, COUNT(*) AS requests, SUM(cost_nanos / 1000000000.0) AS cost, SUM(input_tokens + output_tokens) AS tokens FROM usage_ledger WHERE at_ms > ? AND at_ms <= ${now} GROUP BY pool, provider, model, usage_ledger.account, bucket ORDER BY bucket`,
			)
			.all(bucketMs, cutoff);
		result.ledgerAvailable = true;
		result.previousCalls =
			ledger
				.query<{ count: number }, [number, number]>(
					"SELECT COUNT(*) AS count FROM usage_ledger WHERE at_ms > ? AND at_ms <= ?",
				)
				.get(cutoff - (now - cutoff), cutoff)?.count ?? 0;
		result.headroom = headroom(ledger, policies, now);
		try {
			const quotas = ledger
				.query<
					{ provider: string; ordinal: number; limit_id: string; used_fraction: number; resets_at: number | null },
					[]
				>(
					"SELECT h.provider, DENSE_RANK() OVER (ORDER BY h.provider, h.account_key) AS ordinal, h.limit_id, h.used_fraction, h.resets_at FROM usage_history h JOIN (SELECT provider, account_key, limit_id, MAX(recorded_at) AS latest FROM usage_history GROUP BY provider, account_key, limit_id) k ON h.provider = k.provider AND h.account_key = k.account_key AND h.limit_id = k.limit_id AND h.recorded_at = k.latest WHERE h.used_fraction IS NOT NULL",
				)
				.all();
			for (const quota of quotas) {
				result.headroom.push({
					label: `${quota.provider}/Account ${quota.ordinal}: ${quota.limit_id}`,
					metric: "quota fraction",
					used: quota.used_fraction,
					cap: 1,
					samples: 1,
					resetAt: quota.resets_at,
					recoveryAt: null,
					previous: null,
					burn: [],
				});
			}
		} catch {
			/* Provider quota history is absent in older databases. */
		}
	} catch {
		/* Older installations may not have a usage ledger. */
	} finally {
		ledger?.close();
	}
	const messages = database
		.query<MessageRow, [number]>(
			"SELECT model, provider, duration AS duration_ms, ttft AS ttft_ms, cost_total, stop_reason, agent_type, session_file FROM messages WHERE timestamp > ?",
		)
		.all(cutoff);
	const groups = new Map<string, MessageRow[]>();
	for (const row of messages) {
		const key = JSON.stringify([row.provider, row.model]);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
		const agent = row.agent_type ?? "main";
		let spend = result.spend.find(item => item.agent === agent);
		if (!spend) {
			spend = { agent, cost: 0, samples: 0 };
			result.spend.push(spend);
		}
		spend.cost += row.cost_total;
		spend.samples++;
		if (agent === "advisor") {
			const advisor = basename(row.session_file).replace(/^__advisor\.?|\.jsonl$/g, "") || "default";
			let item = result.advisors.find(
				item => item.advisor === advisor && item.model === `${row.provider}/${row.model}`,
			);
			if (!item) {
				item = {
					advisor,
					model: `${row.provider}/${row.model}`,
					cost: 0,
					samples: 0,
					latency: null,
					latencySamples: 0,
				};
				result.advisors.push(item);
			}
			item.cost += row.cost_total;
			item.samples++;
			if (row.duration_ms !== null) {
				item.latency = ((item.latency ?? 0) * item.latencySamples + row.duration_ms) / (item.latencySamples + 1);
				item.latencySamples++;
			}
		}
	}
	for (const rows of groups.values()) {
		const first = rows[0];
		if (!first) continue;
		const durations = rows.flatMap(row => (row.duration_ms === null ? [] : [row.duration_ms]));
		const ttfts = rows.flatMap(row => (row.ttft_ms === null ? [] : [row.ttft_ms]));
		result.models.push({
			model: first.model,
			provider: first.provider,
			requests: rows.length,
			latencySamples: durations.length,
			ttftSamples: ttfts.length,
			p50Latency: percentile(durations, 0.5),
			p95Latency: percentile(durations, 0.95),
			p50Ttft: percentile(ttfts, 0.5),
			p95Ttft: percentile(ttfts, 0.95),
			errors: rows.filter(row => row.stop_reason === "error").length,
			costPerRequest: rows.reduce((sum, row) => sum + row.cost_total, 0) / rows.length,
			recovered: 0,
			recoverySamples: 0,
		});
	}
	result.cache = database
		.query<ObservabilityStats["cache"][number], [number, number]>(
			`SELECT CAST(timestamp / ? AS INTEGER) * ${bucketMs} AS bucket, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS read, SUM(cache_write_tokens) AS write, TOTAL(CASE WHEN cost_no_cache_input > 0 THEN cost_no_cache_input - cost_input - cost_cache_read - cost_cache_write ELSE 0 END) AS savings, COUNT(*) AS samples FROM messages WHERE timestamp > ? GROUP BY bucket ORDER BY bucket`,
		)
		.all(bucketMs, cutoff);
	result.cacheModels = database
		.query<ObservabilityStats["cacheModels"][number], [number]>(
			"SELECT model, provider, COALESCE(1.0 * SUM(cache_read_tokens) / NULLIF(SUM(input_tokens + cache_read_tokens), 0), 0) AS hitRate, COUNT(*) AS samples FROM messages WHERE timestamp > ? GROUP BY provider, model",
		)
		.all(cutoff);
	ensureObservabilityIndex(database);
	result.coverage.pendingFiles =
		database
			.query<{ count: number }, []>(
				"SELECT COUNT(*) AS count FROM file_offsets f LEFT JOIN observability_index_v4 o ON f.session_file = o.session_file WHERE o.session_file IS NULL OR f.last_modified != o.last_modified OR f.offset != o.source_offset",
			)
			.get()?.count ?? 0;
	const files = database
		.query<{ session_file: string; entries: string; unreadable: number }, []>(
			"SELECT session_file, entries, unreadable FROM observability_index_v4",
		)
		.all();
	for (const file of files) {
		const snapshots: FindingSnapshot[] = [];
		try {
			if (file.unreadable) throw new Error("Transcript unavailable");
			for (const line of file.entries.split("\n")) {
				if (!line.includes("advisor_findings") && !line.includes("retryRecovery")) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (!isRecord(entry)) continue;
				if (
					entry.customType === "advisor_findings" &&
					isRecord(entry.data) &&
					Array.isArray(entry.data.findings) &&
					typeof entry.data.turn === "number"
				) {
					const data = entry.data;
					const findings: FindingSnapshot["findings"] = [];
					for (const value of entry.data.findings) {
						if (
							!isRecord(value) ||
							typeof value.id !== "string" ||
							typeof value.status !== "string" ||
							typeof value.category !== "string" ||
							typeof value.createdTurn !== "number"
						)
							continue;
						const resolution =
							isRecord(value.resolution) && typeof value.resolution.turn === "number"
								? {
										turn: value.resolution.turn,
										by: typeof value.resolution.by === "string" ? value.resolution.by : undefined,
									}
								: undefined;
						findings.push({
							id: value.id,
							status: value.status,
							severity: typeof value.severity === "string" ? value.severity : "unknown",
							category: value.category,
							owner:
								typeof value.owner === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value.owner)
									? value.owner
									: "unknown",
							createdTurn: value.createdTurn,
							resolution,
						});
					}
					const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : 0;
					snapshots.push({
						turn: data.turn as number,
						timestamp,
						findings,
						id: typeof entry.id === "string" ? entry.id : undefined,
						parentId:
							typeof entry.parentId === "string" ? entry.parentId : entry.parentId === null ? null : undefined,
					});
				}
				if (isRecord(entry.message) && isRecord(entry.message.retryRecovery)) {
					const message = entry.message;
					if (typeof message.timestamp !== "number" || message.timestamp < cutoff) continue;
					const model: ModelObservation | undefined = result.models.find(
						row => row.model === message.model && row.provider === message.provider,
					);
					if (model) {
						model.recoverySamples++;
						if (entry.message.retryRecovery.status === "recovered") model.recovered++;
						result.coverage.recoveryAnnotations++;
					}
				}
			}
			result.coverage.files++;
		} catch {
			result.coverage.unreadable++;
		}
		result.coverage.snapshots += snapshots.length;
		mergeFindings(result.findings, replayFindings(snapshots, cutoff, now));
		if (result.previousFindings)
			mergeFindings(result.previousFindings, replayFindings(snapshots, cutoff - (now - cutoff), cutoff));
	}
	return result;
}
