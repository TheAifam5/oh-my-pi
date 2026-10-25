# @oh-my-pi/omp-stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.omp/agent/sessions/`
- **SQLite aggregation**: Stats storage in `bun:sqlite`, with hourly rollups so any range queries in milliseconds
- **Live web dashboard**: Opens instantly, ingests sessions in the background (newest first) and streams progress and updates to the page
- **Incremental sync**: Only processes new/modified log entries; a watcher re-syncs transcripts as they are written

## Metrics Tracked

| Metric | Calculation |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| Cache Rate | `cache_read / (input + cache_read) * 100` |
| Cache Savings | `(uncached prompt cost - actual prompt cost) / uncached prompt cost * 100` |
| Error Rate | `count(stopReason=error) / total_calls * 100` |
| API-equivalent estimate | Sum of token usage priced with the matching public API rate card |
| Avg Latency | Mean of `duration` |
| TTFT | Mean of `ttft` (time to first token) |

Subscription-backed models use matching public API prices when an exact public model exists; these values estimate API-equivalent usage rather than the user's bill. Subscription-only models without a public price are reported as N/A and excluded from dollar totals.

## Usage

### Via CLI

```bash
# Start dashboard server (default: http://localhost:3847)
omp stats

# Custom port
omp stats --port 8080

# Print summary to console
omp stats --summary

# Output as JSON (for scripting)
omp stats --json
```

### Programmatic

```typescript
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get aggregated stats
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Overall stats with all breakdowns |
| `GET /api/stats/models` | Per-model statistics |
| `GET /api/stats/folders` | Per-folder/project statistics |
| `GET /api/stats/timeseries` | Hourly time series data |
| `GET /api/stats/observability` | Local-only headroom, findings, advisor economics, cache and served-call routing aggregates |
| `GET /api/events` | Server-sent live status: sync progress, data version, rollup backlog |
| `GET /api/status` | Current live status (same shape as the events) |
| `POST /api/sync` | Start a background sync; progress arrives on `/api/events` |

## Data Storage

- **Session logs**: `~/.omp/agent/sessions/` (JSONL files)
- **Stats database**: `~/.omp/stats.db` (SQLite)

Synchronization fetches file metadata and saved cursors in bounded batches and overlaps transcript reads, including on macOS without worker threads. Statistics and cursors commit atomically; unchanged files are skipped, and interrupted batches are retried without double-counting usage.

Full reconciliation replays still scan every transcript. Unchanged transcripts retain their indexed rows while missing or stale records and unfinished links are repaired; modified transcripts are rebuilt. Parsing discards message bodies after extracting statistics rather than retaining entire decoded transcripts.

Range queries read `message_rollup` / `tool_rollup` / `session_rollup`, maintained from the raw tables: triggers mark touched hours and transcripts dirty (from any omp process), and the dashboard re-rolls them newest-first in short transactions. Reads stay exact by aggregating the few dirty hours raw; during an initial build the header shows the indexing backlog.

## Dashboard

Pages: Overview, Models, Providers, Costs, Requests, Errors, Traces, Tools, Findings, Routing, Frustration, Projects and Gain. `1`–`6` pick the time range; `g` then a letter jumps to a page. Every page revalidates when the live data version moves, so there is no refresh button.

Overview includes cache token composition and estimated savings. Models includes latency and TTFT percentiles, timing samples, observed recovery annotations, and cache-adjusted cost per request. Providers includes current budget and limit headroom. Costs includes advisor/model economics and main/advisor/subagent spend. Findings shows a KPI row with previous-period comparisons, a scrollable latest-status ledger, a resolver funnel, severity/category mix, and a resolution-duration histogram. Routing shows completed usage-bearing calls by pool, served model, and anonymized account; it does not count selection attempts or failed calls without usage.

Filters reuse the time-range segmented control with radio-group semantics, arrow-key selection, Home/End navigation, visible focus, and wrapping labels. Provider, window, tool, project, and pool choices are visible without opening a dropdown.

All `/api/` endpoints, including event streams, require a Host matching the request URL and the dashboard's configured HTTP host and port. Any supplied Origin must match that origin; requests without Origin remain supported. Explicit non-loopback bindings support aggregate reads. Wildcard bindings accept loopback names and local interface IP addresses, not arbitrary DNS names. Reverse proxies must preserve an accepted Host and Origin; alternate proxy hostnames are not automatically trusted.

The observability endpoint and mutating API requests return HTTP 403 unless the server is bound to loopback and the request URL, Host, and any Origin match the dashboard's actual host and port. Account identities, account policy names, credential payloads, finding report text, and full session/request identifiers are not returned. Accounts use per-provider ordinal aliases. Effective local caps require launch through `omp stats`; standalone `omp-stats` shows an unavailable-configuration state. Provider-evidence account caps without readable evidence remain unavailable rather than zero.

Findings and recovery metadata are projected into the stats database after session ingestion releases its synchronization lock. Targeted syncs project only the selected transcripts. Unchanged files require no transcript reads; appended files read the new tail and bounded identity checkpoints. Checkpoints are stored as SHA-256 digests; obsolete raw-checkpoint projections are dropped on access. Pending and unreadable transcript counts are shown with findings coverage. Snapshot disappearance does not establish resolution; v1 resolution actors are unrecorded. Resolution duration measures elapsed time from the first observed open snapshot to the observed resolution, with separate reopened episodes; missing timestamps are excluded. Cost per resolved concern/blocker is an aggregate ratio, not a measured causal benefit or an exact review attribution.

Findings totals aggregate independent ledgers from indexed main and subagent sessions. Snapshots and branch ancestry are replayed separately for each transcript before totals are combined; matching finding IDs in different session files do not identify the same finding. Advisor owner labels identify category owners within those session-local ledgers. The dashboard aggregate does not change the session-local `/advisor findings` UI.

## License

MIT
