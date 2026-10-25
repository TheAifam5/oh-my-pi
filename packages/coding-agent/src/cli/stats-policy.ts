import { Database } from "bun:sqlite";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { accountUsageKey } from "@oh-my-pi/pi-ai/auth/policy";
import { localLimitWindowResetAt, localLimitWindowStart, parseAccountLimits } from "@oh-my-pi/pi-ai/usage/limits";
import type { HeadroomPolicy, HeadroomRow } from "@oh-my-pi/omp-stats/observability-types";
import { cfgAuthAccountPolicies } from "../config/model-settings";
import { Settings } from "../config/settings";
import { configuredLimitTargets } from "../session/local-limits";
import { resolveGroupFallbackChain, resolveRolePoolGroup } from "../session/retry-fallback-groups";
import { cfgRetryFallbackChains } from "../session/settings";

export async function statsHeadroomPolicies(cwd: string): Promise<HeadroomPolicy[]> {
	return buildStatsHeadroomPolicies(await Settings.loadReadOnly({ cwd }));
}

export function buildStatsHeadroomPolicies(settings: Settings): HeadroomPolicy[] {
	const policies: HeadroomPolicy[] = configuredLimitTargets(settings).map(target => ({
		label: target.label,
		limit: target.limit,
		scopes: target.scopes,
	}));
	const pools = [
		...Object.keys(settings.getModelRoleEntries()).map(role => resolveRolePoolGroup(settings, role)),
		...Object.keys(cfgRetryFallbackChains.get(settings)).map(key => resolveGroupFallbackChain(settings, key)),
	];
	const budgets = new Set<string>();
	for (const pool of pools) {
		const spending = pool?.group.routing?.spending;
		if (!pool || spending?.policy !== "local-hard-budget" || budgets.has(spending.budget.id)) continue;
		const budget = spending.budget;
		budgets.add(budget.id);
		policies.push({
			label: `${pool.poolId}: ${budget.id}`,
			budgetId: budget.id,
			scopes: [],
			limit: {
				metric: "usd",
				max: budget.window.maxSpend,
				window: { type: "rolling", durationMs: budget.window.durationMs },
				onLimit: "skip",
			},
		});
	}
	const accountOrdinals = new Map<string, number>();
	for (const policy of cfgAuthAccountPolicies.get(settings)) {
		const ordinal = (accountOrdinals.get(policy.provider) ?? 0) + 1;
		accountOrdinals.set(policy.provider, ordinal);
		const account = accountUsageKey(policy.account);
		if (!account || !policy.limits) continue;
		for (const limit of parseAccountLimits(policy.limits, "limits").limits) {
			const label = `${policy.provider} · Account ${ordinal}: ${limit.metric}`;
			const now = Date.now();
			const snapshot: HeadroomRow = {
				label,
				metric: limit.metric,
				cap: Number(limit.max),
				used: null,
				samples: 0,
				resetAt: null,
				recoveryAt: null,
				previous: null,
				burn: [],
			};
			if ("window" in limit) {
				const start = localLimitWindowStart(limit.window, now) - (limit.window.type === "calendar" ? 1 : 0);
				snapshot.resetAt = localLimitWindowResetAt(limit.window, now) ?? null;
				let database: Database | undefined;
				try {
					database = new Database(getAgentDbPath(), { readonly: true });
					const value =
						limit.metric === "usd"
							? "cost_nanos / 1000000000.0"
							: limit.metric === "tokens"
								? "input_tokens + output_tokens"
								: "1";
					const rows = database
						.query<{ at_ms: number; value: number }, [string, string, number, number]>(
							`SELECT at_ms, ${value} AS value FROM usage_ledger WHERE provider = ? AND account = ? AND at_ms > ? AND at_ms <= ? ORDER BY at_ms`,
						)
						.all(policy.provider, account, start - (now - start), now);
					snapshot.used = 0;
					snapshot.previous = 0;
					snapshot.burn = Array.from({ length: 24 }, () => 0);
					for (const row of rows) {
						if (row.at_ms <= start) {
							snapshot.previous += row.value;
							continue;
						}
						snapshot.used += row.value;
						snapshot.samples++;
						const slot = Math.min(23, Math.floor(((row.at_ms - start) / Math.max(1, now - start)) * 24));
						snapshot.burn[slot] = (snapshot.burn[slot] ?? 0) + row.value;
						if (limit.window.type === "rolling" && snapshot.recoveryAt === null)
							snapshot.recoveryAt = row.at_ms + limit.window.durationMs;
					}
				} catch {
					/* Missing account usage remains unavailable. */
				} finally {
					database?.close();
				}
			}
			policies.push({
				label,
				limit,
				scopes: [],
				snapshot,
			});
		}
	}
	return policies;
}
