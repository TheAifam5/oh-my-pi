# Auth Broker and Auth Gateway

The auth broker centralizes credential storage and OAuth refreshes. The auth gateway lets clients make provider requests without receiving provider credentials. Direct broker clients are trusted: snapshots expose OAuth access tokens and stored API keys, but never the real OAuth refresh token.

- **`omp auth-broker serve`** holds the canonical SQLite credential vault, performs OAuth refreshes, and exposes snapshot, credential, block, usage, and health APIs under `/v1`.
- **`omp auth-gateway serve`** is a forward-proxy. It accepts OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, pi-native stream, TypeSafe System One judgment, and OpenAI/OpenRouter-style image, speech, transcription, embedding, rerank, and video requests, resolves the broker-backed credential, and dispatches through `pi-ai` provider logic. Clients (containerised omp, llm-git, the macOS usage widget, …) never see the access token.
- **`omp auth-gateway stdio`** serves the same routes to its parent process as JSON lines on stdin/stdout, on the CLI's own credentials and model roles; see [stdio](#stdio).

Transport security between operator, broker, and gateway is delegated to the operator (Tailscale / Wireguard / reverse proxy + TLS). Every endpoint except `/v1/healthz` (broker) and `/healthz` (gateway) requires a bearer token by default. The gateway also answers CORS `OPTIONS` preflights without authentication; `--no-auth` disables inbound gateway authentication.

Source: `packages/ai/src/auth-broker/`, `packages/ai/src/auth-gateway/`, `packages/ai/src/auth/`, `packages/coding-agent/src/cli/auth-broker-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-stdio.ts`, `packages/coding-agent/src/session/auth-broker-config.ts`.

## Data flow

```
                ┌────────────────────────────────────────────────────────────┐
                │ broker host                                                │
                │                                                            │
  developer ──▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  laptop /      │  │  omp auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI / robomp   │  │  - holds refresh tokens  │    │  (canonical writer)│    │
                │  │  - background refresher  │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  omp auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  receives snapshot stream,   │
                │  │  /v1/usage,/v1/models    │  refreshes credentials by id │
                │  │  /v1/credentials/check   │  via the broker on expiry    │
                │  └─────────┬────────────────┘                              │
                └────────────┼───────────────────────────────────────────────┘
                             │  bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  gateway clients
                  (llm-git, macOS widget, robomp containers, IDE plugins, …)
                                │
                                ▼ provider request with broker-resolved credential
                  api.anthropic.com / api.openai.com / …
```

The broker is the only writer of OAuth refresh tokens. Clients (including the gateway itself) load a redacted snapshot in which every `refresh` field has been replaced with `REMOTE_REFRESH_SENTINEL`; when an access token expires the client calls `POST /v1/credential/:id/refresh` and the broker performs the refresh server-side. Credential writes through `RemoteAuthCredentialStore` await broker persistence and update its local snapshot before returning; the broker remains the authoritative writer.

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port] [--trust-proxy-headers]  # boot the broker
omp auth-broker token     [--regenerate] [--json]               # print or rotate the bearer token
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve` opens the local SQLite store at `getAgentDbPath()` and binds an HTTP listener (default `127.0.0.1:8765`). On startup a token is ensured at `<config-dir>/auth-broker.token` (mode `0600`, newly created parent directory `0700`). The background refresher runs immediately and then every `refreshIntervalMs` (default 60 s), targeting OAuth credentials whose expiry is within `refreshSkewMs` (default 5 min).
- Logs attribute requests to the socket peer address. Behind a trusted reverse proxy, pass `--trust-proxy-headers` to use `X-Forwarded-For` / `X-Real-IP` for authenticated requests; unauthorized requests are always logged with the socket peer, and paths outside the broker's routes are logged as `<unrouted>`.
- `token` prints the stored bearer or generates a new one. `--regenerate` replaces the token file; restart a running broker to load the replacement into its in-memory allow-list.
- `login [<provider>]` runs the registered sign-in flow locally (OAuth or a provider's API-key login). With no provider it shows an interactive numbered picker. With `--via=user@host` it runs `ssh -L <callback-port>:127.0.0.1:<callback-port> -o ExitOnForwardFailure=yes user@host omp auth-broker login <provider>`; the credential is written on the remote host (`--via` requires `<provider>`, and `--dry-run` applies only to this remote path). Ports are derived from the auth registry: `anthropic:54545`, `openai-codex:1455`, `google-gemini-cli:8085`, `google-antigravity:51121`, `gitlab-duo:8080`, `devin:59653`, `openrouter:54549`, `stencil:54547`. `gitlab-duo-agent` and `zai-coding-plan` use non-loopback/manual callbacks rather than the old `8080`/`9999` listeners; run those flows on the host directly. Login is driven in-process through `AuthStorage.oauth.login()`.
- `logout [<provider>]` disables the provider's active rows with cause `logged out by user`; disabled tombstones remain available through the broker API. With no argument it shows an interactive numbered picker of stored providers.
- `list` enumerates the sign-in providers returned by `getOAuthProviders()` (visible built-ins plus `registerOAuthProvider` custom providers), not the stored accounts. `--json` emits an array of `{ id, name }`.
- `import <file|dir>` imports CLIProxyAPI-style JSON credentials into the local SQLite store. Maps `type` field → omp provider (`claude → anthropic`, `codex → openai-codex`, `gemini → google-gemini-cli`, `antigravity → google-antigravity`, `gemini-cli → google-gemini-cli`).
- `migrate --from-local` uploads local SQLite credentials to the configured broker (`POST /v1/credential`). Local API keys are included by default; local OAuth rows are skipped unless `--include-oauth` is set; environment-derived API keys are skipped unless `--include-env` is set. Re-runs are idempotent against the broker snapshot.
- `status` health-pings the configured remote broker.

### Endpoints

| Method   | Path                         | Auth   | Purpose                                                            |
| -------- | ---------------------------- | ------ | ------------------------------------------------------------------ |
| `GET`    | `/v1/healthz`                | none   | Liveness + version                                                 |
| `GET`    | `/v1/snapshot`               | bearer | Redacted snapshot (refresh tokens replaced by sentinel)            |
| `GET`    | `/v1/snapshot/stream`        | bearer | SSE snapshot stream with delta events and keepalives               |
| `POST`   | `/v1/credential`             | bearer | Upsert one OAuth or API-key credential                             |
| `POST`   | `/v1/credential/:id/refresh` | bearer | Force-refresh one OAuth credential                                 |
| `POST`   | `/v1/credential/:id/disable` | bearer | Disable one credential with a recorded cause                       |
| `POST`   | `/v1/credential/:id/enabled` | bearer | Set `{ "enabled": boolean }` for one credential; 404 for unknown ids |
| `GET`    | `/v1/credentials/disabled`   | bearer | List disabled credentials; optional `provider` query filter        |
| `POST`   | `/v1/credential/:id/block`   | bearer | Upsert a provider/scope rate-limit block                           |
| `DELETE` | `/v1/credential/:id/block`   | bearer | Delete one block named by body `providerKey` and `blockScope`       |
| `DELETE` | `/v1/credential/:id/blocks`  | bearer | Delete all rate-limit blocks for a credential                      |
| `GET`    | `/v1/usage`                  | bearer | Aggregate current `UsageReport[]` across credentials               |
| `GET`    | `/v1/usage/history`          | bearer | Persisted usage history; optional `sinceMs` and `provider` filters |
| `POST`   | `/v1/usage/observed`         | bearer | Record usage observed by a broker client                           |
| `GET`    | `/v1/usage/clients`          | bearer | Summarize client-observed usage since optional `sinceMs`           |
| `POST`   | `/v1/usage/stale`            | bearer | Invalidate the broker's usage cache; optional `provider` scope     |
| `GET`    | `/v1/usage/accounts?sinceMs=` | bearer | [Fleet account usage](#fleet-account-usage) after `sinceMs`        |
| `GET`    | `/v1/cache?prefix=`          | bearer | Live [shared drain state](#shared-drain-state) rows under a prefix |
| `PUT`    | `/v1/cache/:key`             | bearer | Write or delete one shared drain state row                         |
| `DELETE` | `/v1/cache?prefix=`          | bearer | Delete the shared drain state rows under a prefix                  |

Requests use `Authorization: Bearer <token>`. The server compares against an in-memory token allow-list; the gateway’s implementation uses a timing-safe comparison.

A snapshot contains `generation`, `generatedAt`, `serverNowMs`, `refresher`
(`enabled`, `intervalMs`, `skewMs`, `nextSweepInMs`), and `credentials`.
Each credential carries its id/provider/redacted credential/`identityKey`,
`rotatesInMs`, and optional rate-limit `blocks`.

The SSE stream starts with a full `snapshot` event, followed by changed `entry`
and deleted/disabled `removed` events. The SSE event name also appears as JSON
`kind`; deltas carry `generation`, `serverNowMs`, and `refresher`, plus `entry`
or the removed `id`. Keepalives are SSE comments, not JSON events.

A client that sends `user-disabled-credentials` in the
`OMP-Auth-Broker-Capabilities` header also receives the accounts the user
disabled (`POST /v1/credential/:id/enabled` with `{"enabled": false}`), each
carrying `userDisabledAtMs`; other clients receive no entry for them. A refresh
of a disabled credential answers 404, and `GET /v1/credentials/disabled` lists
only tombstones.

Direct `POST /v1/credential/:id/refresh` forces a refresh. The
`?reason=auth-recovery` form may reuse a still-usable token that the broker
minted within the preceding five minutes, preventing repeated remints during
an upstream outage.

#### Conditional snapshot long polling

`GET /v1/snapshot?wait=<ms>` supports generation-based conditional polling.
Send the generation from a previous response in `If-None-Match`. The broker
accepts a non-negative integer generation as a bare tag, a quoted tag such as
`"42"`, or a weak quoted tag such as `W/"42"`.

`wait` is parsed as a number, truncated to whole milliseconds, and clamped to
the range 0–30,000 ms; an absent or non-numeric value behaves as `0`. The
response state machine is:

- If the tag is absent/invalid, differs from the current generation, or
  `wait <= 0`, return the current redacted snapshot immediately with `200`.
- If the tag matches and `wait > 0`, wait for the generation to change. Return
  the new snapshot with `200` when it changes, an empty `304` when the wait
  expires unchanged, or an empty `499` when the caller disconnects.

Every `200`, `304`, and `499` snapshot response carries a quoted generation
`ETag`, plus `Cache-Control: no-store` and
`Vary: OMP-Auth-Broker-Capabilities`. A disconnect response uses the generation
captured before waiting.

### Codex block-scope compatibility

Clients that understand per-meter Codex blocks send `OMP-Auth-Broker-Capabilities: codex-meter-block-scopes`. Snapshot responses then carry the canonical `chat` and `spark` scopes. Without that capability, the broker projects those rows to the legacy `shared` scope on the wire.

Local SQLite schema 8 keeps `chat` and `spark` as the canonical scopes exposed by current store APIs. It also maintains a physical `shared` compatibility mirror for pre-meter binaries that read `agent.db` directly. SQLite triggers derive that mirror's deadline and update time independently from the meter rows, and copy a legacy process's `shared` writes back to both meters. Current store APIs omit the physical mirror, so broker snapshots and model selection do not double-count it.

Clients released before this capability, including 17.1.4, receive the conservative `shared` projection until they are upgraded. Those clients are indistinguishable on the existing wire, so mixed-version deployments favor keeping a rate-limited credential blocked over allowing repeated provider requests and 429 responses.

Capability-dependent responses include `Vary: OMP-Auth-Broker-Capabilities` so intermediaries do not reuse one representation for another client. The encrypted client snapshot cache also uses a new format version: older cache files are ignored and fetched again, preventing legacy and meter-scoped representations from being mixed across client versions.

### Shared drain state

Account drain state (`drain:state:` cache rows: when a drain target drained and its billing baseline) and `/session drain` overrides (`session:drain:` rows) are shared through the broker, so every client of one broker, on any machine, keeps a drained target behind until it returns, and a return in one client reaches the others. `RemoteAuthCredentialStore` keeps a write-through copy of these rows: each write is sent to the broker in the background, and the copy is re-seeded from the broker at startup, on reconnect of the snapshot stream, on explicit snapshot refreshes, and on drain reads at most every 15 s, so another client's write or return shows up within about that interval; after failed re-seeds that interval doubles each time, up to 10 minutes. Rows a client wrote but has not delivered survive a re-seed. A row the client wrote is kept by a re-seed whose listing was taken before the broker acknowledged it. Writes are retried in order against transient failures (connection errors, timeouts, `408`, `429`, `5xx` other than `501` and `507`) with exponential backoff (500 ms up to 30 s), at most 5 attempts and 2 minutes per write; the queue holds 256 writes and drops the oldest past that. A dropped write stays in the client's copy and is sent again by the next re-seed that finds the broker missing it. The client's in-memory cache is bounded (4096 rows, 4 Mi characters, least recently used out first); a shared row the broker has not acknowledged is exempt from that eviction until it is delivered, removed, or expires, and an evicted row the broker holds returns with the next re-seed. A `507` (full prefix) is not retried: that prefix's writes stay local for 5 minutes, without holding up the other prefix. Closing the store abandons queued writes. A re-seed accepts at most 1024 rows per prefix, skips expired rows, caps lifetimes at 35 days, and reads at most a quarter more than the broker's largest possible listing (about 7 MiB). A broker that answers `404` or `501` (older brokers, a store that cannot list cache rows, or a proxy in between) turns sharing off for 10 minutes, during which the client keeps drain state in memory only, as before; it then probes again and sends the rows written meanwhile.

The routes accept only keys and prefixes under `drain:state:` and `session:drain:` and answer anything else, including a broader prefix such as `drain:`, with `403`; usage reports, session pins and stickies, and every other cache row never leave the process that wrote them. Keys are at most 512 characters without control characters, values at most 4 KiB as a JSON string, escapes included (`413`; drain rows are well under 1 KiB), and each of the two prefixes holds at most 1024 live rows (a write of a new key past that answers `507`), so one listing is at most about 5.6 MiB. `PUT` takes `{ "value", "expiresAtSec" }` in a body of at most 8 KiB, measured while it streams in; an expiry at or before the broker's clock or an empty value deletes the row outright, and later expiries are capped at 35 days. The broker sweeps expired cache rows at startup and every 10 minutes, and a write of a new key first removes the expired rows under its prefix, so short-lived rows cannot accumulate past the row cap between sweeps. Rows expire on the broker's clock while writers compute expiries on their own: a writer whose clock runs ahead makes its rows last longer, up to the 35-day cap, and a writer whose clock runs behind by more than a row's lifetime has its writes treated as deletes. When two clients write one row, the later write wins. A client whose account pool or session restriction hides an override's account stops following that override in its own process only; the shared row is deleted only by an explicit `/session drain` change.

Credential ids in drain keys are the broker's credential row ids, which every client sees in the snapshot. Direct broker clients are already trusted with OAuth access tokens and API keys, and every authorized bearer token reaches the same rows. Gateway clients never reach these routes: the gateway does not proxy `/v1/cache`, and its own broker client shares the rows on their behalf.

There is no per-client ownership of shared rows, so any holder of a broker bearer token can: fill either prefix to its 1024-row cap, after which every client's new rows under it stay local; write, overwrite, or delete any drain state row, holding an account back as drained or returning it early on every client; and write or delete a `session:drain:` override for any session id, which changes the drain order of that session on every client. An override only orders accounts: a client never serves an account outside its account pool or a session's account restriction because of it. A bearer can also read every shared row, which names session ids and broker credential ids, and can make every client fetch full listings: each re-seed of each client reads up to about 5.6 MiB per prefix. Each write of a new key also costs the broker a delete over the prefix's expired rows, at most the 1024-row cap plus the rows that expired since the previous new-key write. These levers are the documented trust model (every authorized bearer is equivalent and already holds the credentials); restrict who holds a broker token, not what a token can do.

### Fleet account usage

Observed usage a client reports to `POST /v1/usage/observed` may name the account that served it (`account`, its account usage key: API key fingerprint, else account id, email, or project id). An attributed report entry folds only one wall-clock minute of requests, and the broker merges attributed rows only within one aligned minute per install, app, provider, model, and account (at most 1440 rows per day per active account and model of a client); unattributed reports keep the older 5-minute merge and never fold into attributed rows. Brokers that predate the field ignore it, and clients that predate it are unaffected. A report carries at most 1000 entries, with install id, hostname, app, provider, and model of at most 256 characters each; every entry's amounts must be non-negative and at most 1,000,000 requests, 10^12 tokens of each kind, and 1,000,000 USD, and an `account` is 1–256 characters without control characters (`400` otherwise); a report body is at most 4 MiB, measured while it streams in. Clients split larger batches into several reports. On the broker's clock, an entry stamped more than 5 minutes ahead is recorded at the broker's now, and an attributed entry older than 35 days is dropped. Merged counters saturate at 2^53 − 1 (USD at 10^15) instead of overflowing, and totals are summed in floating point. Per install id the broker keeps at most 256 distinct accounts (usage of further accounts is not recorded), 500,000 attributed rows, and 100,000 unattributed rows; past a row cap new usage folds into the newest row of its series, keeping totals and coarsening timestamps, and usage of a new series is not recorded (logged as a warning at most every 10 minutes, naming the install id and the count, never an account). A merge never moves a row's timestamp back. Each report is written in one transaction, and its bucket lookups search indexes on every column they filter on. Attributed rows older than 35 days are pruned on the first report after the broker opens its store and then at most every 10 minutes; unattributed rows are kept, within their cap.

`GET /v1/usage/accounts?sinceMs=<epoch ms>[&provider=<id>…][&account=<key>…]` returns `{ generatedAt, sinceMs, accounts: [{ provider, account, costUsd, requests, tokens }], truncated }`: per (provider, account), the attributed usage of every client stamped after `sinceMs` (exclusive, like the local ledger; an earlier start is raised to 35 days ago), with `tokens` counting input plus output tokens. 1–64 repeated `account` parameters (required) and up to 64 `provider` parameters narrow the answer to those accounts and providers, so the grouping reads only the named accounts' rows through an index; rows come highest cost first. A minute's requests are stamped with its newest request, so a window start inside a minute counts the whole minute: totals over-count by up to a minute's usage and never miss usage in the window. At most 4096 pairs are returned, every pair a maximal filter can name, so a filtered answer is never truncated; `truncated` marks more. `sinceMs` must be a non-negative integer (`400` otherwise); a store that does not record account usage answers `501`. Timestamps are the reporting clients' clocks, so clock skew between machines shifts their usage across window boundaries by the skew.

`omp auth-gateway serve` and `omp auth-gateway stdio` backed by a broker attribute every call they observe to its account, and their [account limits](#auth-gateway) count the larger of their own `agent.db` ledger and the account's fleet-wide total, never the sum (the fleet total already includes the gateway's own reported calls). Each gateway applies its own `auth.accountPolicies` over the shared totals: this is per-client policy over shared counts, eventually consistent, with no reservation. Fleet totals are polled per limit window start (floored to the minute, at most 8 windows) at most every 15 s when a limit is checked, used for up to a minute, and a start polled up to five minutes earlier stands in for a newer one until it is polled. A cap can therefore be overshot by what the other clients spend within one observed-usage flush interval (10 s) plus one poll interval (15 s) and request latency, on top of the concurrency overshoot a single gateway already has. Polls ask only for the 64 accounts the gateway checked most recently and read at most the largest possible answer (about 6.5 MiB); an account missing from a truncated answer (logged once) counts the gateway's own ledger only. Without recent totals, or against a broker that answers `404`/`501` (off for 10 minutes, then probed again), a gateway counts its own ledger only. For a hard cap, route every client through one `omp auth-gateway serve`, whose ledger sees every call before the next is admitted. Plain `omp` sessions using a broker do not attribute their usage to an account yet, so their calls are counted in fleet totals only when they go through a gateway.

Any holder of a broker bearer token can report usage for any account, within the per-entry bounds above and as often as it likes, so it can raise an account's fleet total until every broker-backed gateway refuses that account under its limits. It can also grow the broker's `client_usage` table: the per-install caps bound each install id, but a bearer can report under any number of install ids, and only attributed rows age out (after 35 days). The cost of an account totals query grows with the rows reported for the queried accounts, and each report costs the broker one indexed lookup and one write per entry (at most 1000) inside one transaction. Reports are not tied to the install that sends them, so a bearer can also report under another client's install id: it can fill that install's account and row caps so the victim's later usage of new accounts or series is no longer recorded, and add backdated unattributed usage to the victim's series. It cannot reduce usage already recorded, push usage into future windows, or push a checked account out of a gateway's answer. As with the shared drain state, this is the documented equal-bearer trust model.

### Background refresher

`AuthBrokerRefresher` reloads active credentials before each sweep and does not overlap sweeps. Manual and background refreshes share the per-credential single-flight in `OAuthRefresher`; SQLite refresh leases also coordinate writers across processes.

- **Definitive failures**, as classified by `isDefinitiveOAuthFailure()`, disable only the credential version that failed. Compare-and-set persistence protects a credential rotated by a concurrent login/refresh; the refresher logs the result rather than disabling the row again.
- **Transient failures** (for example network timeouts) leave the credential in place for the next sweep.

The CLI broker refresh hook also handles managed `mcp_oauth:*` credentials using their stored MCP token endpoint/client metadata; it does not need to load the MCP manager.

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth] [--trust-proxy-headers] [--clients=<file>]
omp auth-gateway stdio
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
```

- `serve` requires `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) — the gateway is itself a broker client. It fetches a live snapshot, wraps it in `RemoteAuthCredentialStore`, and constructs `AuthStorage` with the configured account pool and account policies. Unlike normal client discovery, gateway startup does not use the encrypted snapshot cache. Default bind is `127.0.0.1:4000`. The gateway token is stored at `<config-dir>/auth-gateway.token` (`0600`); `--no-auth` disables the bearer check entirely. Use that flag only on trusted loopback listeners; it does not enforce a loopback bind.
- Logs attribute requests to the socket peer address. Behind a trusted reverse proxy, pass `--trust-proxy-headers` to use `X-Forwarded-For` / `X-Real-IP` for authenticated requests; unauthorized requests are always logged with the socket peer. An authenticated request that also carries the gateway token, or its own client token, in its URL or in a forwarded, logged, or identity header is rejected with `400` before any credential lookup. Each `auth-gateway request` log line carries the broker `credentialId` the request started on, and `client` for a [client token](#client-tokens).
- `token` manages the token file; `--regenerate` requires a running gateway to restart before accepting the replacement. `status` checks the local token file and an authenticated broker snapshot; it does not probe the gateway listener.
- `check` constructs its own broker-backed store and probes the credentials the gateway would use, without calling a running gateway. Without `--strict` it uses provider usage probes. `--strict` additionally tries suitable bundled chat models and can consume quota; providers with no suitable candidate (including pi-native forwarding, Bedrock, Vertex, and Cursor transports) cannot be completion-probed.

### Client tokens

`serve --clients=<file>` admits bearers besides the gateway token, each limited by the gateway itself. The file maps each client name to its token digest and limits:

```json
{
  "ci": {
    "tokenSha256": "<hex SHA-256 of the client's token>",
    "models": ["anthropic/claude-sonnet-4-5", "openai-codex/*"],
    "accounts": {
      "anthropic": ["email:ci@example.com|org:org-team"],
      "openai-codex": ["email:ci@example.com|org:ws-team"]
    }
  }
}
```

- `tokenSha256` is the hex SHA-256 of the token the client sends as `Authorization: Bearer <token>` (`printf %s "$TOKEN" | shasum -a 256`); the file never holds a raw token. A digest shared by two clients, or equal to the gateway token's, is rejected.
- `models` lists exact `provider/id` grants or `provider/*`. Absent allows every served model; `[]` allows none. A model outside the list answers `404 Unknown model` before any credential lookup, and `GET /v1/models` lists only granted models. A bare id resolves to the first served model of that id the client may call; a provider-qualified id is never reread as another provider's bare id.
- `accounts` maps a provider to the OAuth identity keys (the `identityKey` values of [account pools](#client-account-pools-routing-not-authorization), which `omp usage accounts` lists) its requests to that provider may use. Selection, refresh, usage-limit blocking and auth-recovery rotation stay inside the list, stored, runtime and environment API keys are never used, and a request fails rather than borrow another account. An empty list allows no account. When `accounts` is present it is also a provider allow-list: a provider it omits is refused like a model outside `models`, so a binding cannot be sidestepped through another provider. A `models` grant for a provider `accounts` omits rejects the file, as does a provider id with surrounding whitespace. Without `accounts`, every provider resolves credentials as for the gateway token.
- A client's conversations share one account pin per listed provider: with several accounts listed, the client's traffic stays on one of them until usage-limit blocking or auth recovery moves it, rather than spreading conversations across them. They never share retained provider state (learned fallbacks, Codex transport sessions) with another client's or with gateway-token traffic.
- `/v1/usage` and `/v1/credentials/check` cover every account the gateway holds, so client tokens get `403` there.
- The gateway token stays valid and unscoped. `--clients` cannot be combined with `--no-auth`.
- An unknown field or malformed entry rejects the whole file; `serve` fails to start on it. While serving, the file is re-read every 10 s: a removed or changed token is refused from its next request, while a request already in flight finishes, retries included, on the model and accounts it was admitted with. A changed entry starts a new account pin. A file that cannot be read or parsed refuses every client token until it is fixed, and every client starts a new account pin once it is; replace the file atomically (write a temporary file, then rename it over the original) so a reload never reads it half-written.

### stdio

`omp auth-gateway stdio` is the gateway for one trusted parent process (an editor, a terminal's git UI, a script): no listener, no token, no broker requirement. It uses the credentials, models (`models.yml` and extension providers included) and settings any other `omp` command would: the broker when one is configured, else the local store. Requests and responses are JSON lines:

```
→ {"id": 1, "path": "/v1/chat/completions", "body": {"model": "@commit,@smol", "messages": [...]}}
← {"ready": true, "version": "18.4.11"}
← {"id": 1, "status": 200, "body": {"object": "chat.completion", "choices": [...]}}
```

- The first output line is `{"ready": true, "version": …}`. `method` defaults to `POST` when the request has a `body`, else `GET`; every route in [Endpoints](#endpoints-1) except `/healthz` is served.
- Requests run concurrently and answer in completion order; `id` (string or number) matches them up. A line that is not a request answers `400` with its `id` when it had one.
- A JSON response body is embedded as JSON; a text body (the SSE of a `stream: true` request) as one string once the stream ends; anything else (audio, video) as base64 with `"encoding": "base64"`.
- `model` takes any `--model` selector: `provider/id`, a fuzzy name, a role (`@smol`), or a comma list whose first entry that resolves wins. An attempt that fails with a status above `400` (other than `499`) moves on along that model's `retry.fallbackChains`, the role's chain when the entry named a role; the response's `model` names the model that answered.
- The process serves until stdin ends, answers what is in flight, and exits.

### Endpoints

| Method | Path                    | Auth   | Purpose                                                      |
| ------ | ----------------------- | ------ | ------------------------------------------------------------ |
| `GET`  | `/healthz`              | none   | Liveness + version                                           |
| `GET`  | `/v1/usage`             | bearer | Aggregate `UsageReport[]` (proxied through `AuthStorage`)    |
| `GET`  | `/v1/models`            | bearer | Registry catalog filtered to providers with credentials |
| `GET`  | `/v1/credentials/check` | bearer | Per-credential auth health probe                             |
| `POST` | `/v1/chat/completions`  | bearer | OpenAI Chat Completions wire format                          |
| `POST` | `/v1/messages`          | bearer | Anthropic Messages wire format                               |
| `POST` | `/v1/responses`         | bearer | OpenAI Responses wire format                                 |
| `POST` | `/v1/pi/stream`         | bearer | Native `pi-ai` stream wire format                            |
| `POST` | `/v1/systemone`         | bearer | TypeSafe System One judgments (`judge` models, e.g. `typesafe/jev-latest`); `/alpha/decisions` is the OpenRouter Decisions alias |
| `POST` | `/v1/images/generations` | bearer | Image generation, OpenAI Images JSON wire; `/v1/images` is the OpenRouter alias (`image` models) |
| `POST` | `/v1/images/edits`      | bearer | Image edits: OpenAI multipart or OpenRouter JSON input images |
| `POST` | `/v1/audio/speech`      | bearer | Text-to-speech, OpenAI/OpenRouter JSON wire; answers raw audio bytes (`tts` models: `xai-tts`, `openai-speech`) |
| `POST` | `/v1/audio/transcriptions` | bearer | Speech-to-text, OpenAI multipart `file` or OpenRouter JSON `input_audio` base64 (`stt` models on `openai-transcriptions`; 25 MiB cap) |
| `POST` | `/v1/embeddings`        | bearer | Embeddings, OpenAI wire (`embedding` models on `openai-embeddings`; OpenAI + OpenRouter; 8 MiB cap) |
| `POST` | `/v1/rerank`            | bearer | Rerank, OpenRouter wire (`rerank` models on `openrouter-rerank`) |
| `POST` | `/v1/videos`            | bearer | Submit a video generation job, OpenRouter wire (`video` models on `openrouter-video`); answers `202` with gateway-rewritten polling/content URLs |
| `GET`  | `/v1/videos/:id`        | bearer | Poll a video job. `:id` is gateway-issued and stateless: it encodes provider, model, and upstream job id |
| `GET`  | `/v1/videos/:id/content` | bearer | Stream the finished video bytes with the upstream content type |

For `POST /v1/systemone`, TypeSafe models accept TypeSafe's inline `assets` form (`data_base64` only; multipart `part` assets are rejected), and every asset must be referenced in `state`, `instructions`, or `criteria`; other native APIs reject that form with `422`. The existing `images` field remains available for compatible backends and accepts inline data only, for example `images: [{type:'image',data:'<base64>',mimeType:'image/png',detail:'high'}]`; file paths are not supported. Image data must be non-empty standard base64 with valid padding and canonical trailing bits; padding may be omitted. Optional `detail` must be `auto`, `low`, `high`, or `original`. Invalid image fields, or images sent to a judge model without image input, return `422` before provider credential lookup or any upstream request; images are never silently dropped.

Image inputs to `POST /v1/images/generations` (and its `/v1/images` alias) and `POST /v1/images/edits` must contain non-empty canonical base64 data (padding may be omitted) and a syntactically valid image MIME type. Data-URL inputs reject MIME types containing `#`, which data URLs cannot carry; multipart file types may contain it, but providers that receive images as data URLs reject such inputs. After gateway bearer authentication, malformed input returns `400 invalid_request_error` before provider credential lookup or refresh. Supported image formats remain provider-specific.

The model id is read from the top-level `model` field for foreign wire formats and from the pi-native request body for `/v1/pi/stream`. It may be provider-qualified (`typesafe/jev-latest`) or bare (`jev-latest`). The gateway resolves it against the served catalog — every registry model of a kind the gateway has a route for (`chat`, `judge`, `image`, `tts`, `stt`, `embedding`, `rerank`, `video`), scoped to providers the broker holds credentials for — parses the inbound wire format, resolves the provider credential from broker-backed `AuthStorage`, dispatches through the matching `pi-ai` client (`streamSimple()` for chat, `NativeJudge` for judgments (translated to the resolved model's own judgment API, e.g. OpenAI Decisions), `generateImage` / `synthesizeSpeech` / `transcribeAudio` / `embed` / `rerank` / `submitVideo` for the modality routes), and re-encodes the result to the inbound format (SSE for streamed chat responses).

Chat routes reject non-chat models with a `400` that names the route to use instead (`Model typesafe/jev-latest is a judge model; use POST /v1/systemone`). `GET /v1/models` marks such rows with `kind` (`judge` | `image` | `tts` | `stt` | `embedding` | `rerank` | `video`); absent means chat.

The served catalog includes bundled, cached, and broker-discovered models. The gateway ignores the host's `models.yml` overrides/custom models so local base URLs, headers, and keys cannot redirect broker-backed traffic. Providers listed in `disabledProviders` of the gateway's effective settings (the same `config.yml` that supplies `auth.accountPolicies`) are neither discovered, advertised, nor routable; `serve` leaves their accounts out of `/v1/usage` and `/v1/credentials/check`, and `check` skips their credentials. The gateway rebuilds the catalog every 15 minutes and checks credential changes every 10 seconds; credential changes force online discovery. Provider-qualified IDs are unambiguous; bare IDs use the first matching registry entry. Model-list rows also include `api`, `display_name`, `input_modalities`, available `context_length`/`max_output_tokens`, and `supports_tools: false` only when the catalog explicitly says tools are unsupported.

Live OpenRouter discovery covers image and Decisions rosters, `/embeddings/models`, `/videos/models`, and rerank-flagged `/models` rows. Speech/transcription models use catalog kinds and seeds. Bundled fallbacks and `kind-apis` runner mappings are authored in `packages/catalog/src/compat/rules/providers/openrouter.kdl`. Per-search, per-second, and per-character billing have no catalog cost axis, so those rows carry zero token cost and the provider-reported `cost` in the response is authoritative.

Inference routes record observed usage against `x-omp-install-id`, `x-omp-hostname`, and `x-omp-app`; unlabeled requests fall back to the gateway host's identity. These attribution headers are not forwarded upstream. Completed non-streaming responses carry computed cost in `x-litellm-response-cost` when known; streaming chat responses send headers before usage arrives and do not include that cost header. Video cost may become available only while polling. Upstreams that report tokens only (TypeSafe) are priced from the catalog model; the response body's own `cost` field (OpenRouter shape) is only present when the upstream billed one.

TypeSafe clients using the default base-URL resolver can set `TYPESAFE_BASE_URL=http://gateway:4000` with `TYPESAFE_API_KEY=<gateway token>`. omp's catalog-backed `judge` role passes the model's explicit `baseUrl`, which takes precedence over that environment fallback; configure the TypeSafe provider's `baseUrl` and `apiKey` in `models.yml` to use the gateway. OpenAI-SDK-style clients use `http://gateway:4000/v1`.

There is no raw provider passthrough path. All supported routes go through `pi-ai` provider logic so credential-specific request shaping, OAuth refresh-on-auth-error, and provider quirks stay centralized.

`idleTimeout` on the underlying `Bun.serve` is set to `255 s` so long thinking-budget calls do not get killed by Bun’s default idle timeout.

## Usage cache: server-side 5-min jitter + client-side 15 s single-flight

Two layers cache the aggregate provider-usage report. Both are intentional and stacked.

### Server-side cache (broker `AuthStorage`)

`AuthStorage` caches successful per-credential `UsageReport`s in the broker's SQLite store with a **5-minute TTL and ±25 % jitter** to stagger upstream probes. Cached good values are retained for 24 hours after their last successful fetch (`fetchedAt`). On fetch failure, providers normally retain the last-good report and apply a short jittered cooldown (default 10 s); a provider can override this policy. Repeated failures never extend the 24-hour window: past it, the account reports no usage until a fetch succeeds. Definitive auth failures (a thrown 401/403 from the usage provider) purge stale usage, and explicit invalidation does not replay invalidated last-good data.

Constants: `USAGE_REPORT_TTL_MS = 5 * 60_000` in `packages/ai/src/auth/sqlite-credential-store.ts`; `USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000` and `USAGE_FAILURE_BACKOFF_MS = 10_000` in `packages/ai/src/auth/usage-cache.ts`. Fetch policy is in `packages/ai/src/auth/usage.ts`.

### Client-side single-flight (`RemoteAuthCredentialStore`)

When the gateway (or any other broker client) calls `fetchUsageReports()` / `getUsageReport(provider, credential)`, `RemoteAuthCredentialStore` coalesces concurrent calls into a single `GET /v1/usage` round-trip and caches the result for **15 s** in memory.

- `USAGE_CACHE_TTL_MS = 15_000` (`packages/ai/src/auth-broker/remote-store.ts`).
- A single `#usageInflight` promise is shared across all callers; a per-caller `AbortSignal` is **raced** against the shared promise, not threaded into it, so one caller’s abort never cascades into a peer’s in-flight request.
- On fetch failure the error is logged and `null` is cached for 15 s, so sequential callers do not immediately retry a failed broker. Aggregate usage returns `null`; a per-credential lookup may still use a fresh client-observed header overlay.
- Fresh provider response-header hints are overlaid on matching reports for up to 15 s.

The client window is shorter than the broker's per-credential cache and coalesces the usage lookups used by `CredentialSelector` (`packages/ai/src/auth/select.ts`) into a single broker round-trip.

## Client snapshot cache

`discoverAuthStorage()` delegates to `packages/ai/src/auth-broker/discover.ts`, which persists the initial live snapshot and later broker-sourced full snapshots to `~/.omp/cache/auth-broker-snapshot.enc` by default. The file is AES-256-GCM encrypted with SHA-256 of the resolved broker bearer token (whether from env, config, or file) and authenticated with the broker URL and cache format metadata. Changing the token or URL makes the cache unreadable. Writes are atomic with mode `0600`.

Freshness is anchored to `snapshot.generatedAt`, not local write time. Default TTL is 1 h (`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`); `0` disables cache reads and writes. A fresh cache is used immediately without a blocking revalidation or startup request budget. `RemoteAuthCredentialStore` then synchronizes through SSE/long polling in the background, so one-shot commands are not guaranteed to observe changes made after the cache was written. Revocation of the broker token surfaces through that background path rather than necessarily failing cached startup. Expired OAuth access tokens still require the broker refresh endpoint.

If the broker is down at boot and a fresh cache exists, startup succeeds from the cache. If the cache is missing, expired, corrupt, incompatible, written for another URL, or encrypted with another token, startup requires a live snapshot and fails when that fetch fails; it never silently opens the local credential store instead.

## Client account pools

Broker clients can restrict which broker credentials they see by setting `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` to a JSON file. Each key is a provider ID (or `"*"`, see below); each value is a rule for that provider's credentials:

```json
{
  "anthropic": ["email:alice@example.com|org:org-team"],
  "openai-codex": []
}
```

An array lists exact `identityKey` values from the broker snapshot protocol. `identityKey` is the token-free identity field already carried by each authenticated `/v1/snapshot` credential entry. Operator tooling should project only `provider` and `identityKey`; it must not retain or print the accompanying credential payload. A dedicated account-listing CLI is intentionally outside this routing feature's scope.

| Value | OAuth accounts visible | API keys visible |
| --- | --- | --- |
| `["id", …]` | only exact identity matches, including organization/workspace qualifiers; `[]` hides all | yes |
| `true` | all | yes |
| `false` | none | no |
| `{ "accounts"?: ["id", …], "apiKeys"?: boolean }` | `accounts` as with the array form; omitted means all | `apiKeys`; omitted means yes |

Providers without their own key follow the `"*"` rule, and with no `"*"` key they are unrestricted. `"*": false` turns the file into an allow-list: only listed providers are visible, OAuth and API keys alike. For example, this exposes one Codex account and OpenRouter API keys, and nothing else:

```json
{
  "*": false,
  "openai-codex": { "accounts": ["account:acct-123"], "apiKeys": false },
  "openrouter": true
}
```

SDK hosts can supply the same rules as `accountPool` in `discoverAuthStorage()` or `RemoteAuthCredentialStore` (a `Set` of identities, or `{ accounts?: Set, apiKeys?: boolean }`, keyed by provider or `"*"`). An explicit programmatic pool takes precedence over the environment file.

The file is parsed once when broker-backed auth storage starts. An unreadable file, malformed JSON, or invalid entry aborts initialization rather than silently broadening the pool. Full snapshots, SSE updates, refresh responses, and aggregate usage are filtered consistently. For a provider whose OAuth accounts or API keys are restricted, aggregate reports are returned only when they can be attributed to a visible OAuth identity; reports attributable only to an API key or lacking matching identity metadata fail closed. The encrypted snapshot cache remains a raw broker snapshot so trusted processes sharing that cache can apply different pools.

Where the pool applies decides what it protects:

- **Direct broker clients:** a **trusted-client routing policy, not an authorization boundary**. The client holds the broker bearer token, receives raw broker responses before applying its local view, and can call broker endpoints directly.
- **Clients of `omp auth-gateway serve`:** the pool runs inside the gateway process, and the gateway's clients hold only the gateway token. Credentials the pool hides are not in the gateway's credential view, so its routes cannot list, use, or report them. For those clients the pool is the effective boundary, provided they cannot read the gateway host's environment, the pool file, or the broker token.

Use server-side broker authorization, not account pools, when a process holding the broker token must be prevented from retrieving other credentials.

### Per-agent and per-session pools

A process-wide pool decides which accounts a client sees; a session pool narrows one session further with the same identity keys, which `omp usage accounts` lists for every OAuth account the process sees (with organization names and no tokens). Set `task.agentAccountPools` to pool a task agent by exact name ([Settings](./settings.md#providers-and-services)), pass `oauthAccountPools` to `createAgentSession()`, or call `authStorage.sessions.restrict(provider, sessionId, identityKeys)` directly. For each listed provider the session authenticates only with visible OAuth accounts in its list: selection, pins, fallback passes, and rotation stay inside it, stored, runtime, and environment API keys are never used, and a request fails rather than borrow another account when none can serve. A config key (a `models.yml` `apiKey`, often for a proxy `baseUrl`) also fails a pooled request, so no pooled OAuth token is sent to that endpoint. An empty list allows no account. A session created with `oauthAccountPools` enforces its pools on every key lookup through its model registry, whatever provider session id the lookup carries (title generation, skill compression, advisors, and subagents it spawns without their own entry); a lookup with no session id resolves under the session's own id. When it is disposed, or, when a run outlives the dispose deadline, once that run settles, it retires its pools: a lookup made afterwards straight to the auth store under one of its provider session ids (a scan job, a deferred side request, a tool holding the id) still authenticates only with that pool, and fails with an error naming the ended restriction when none of its accounts can serve. A later session that reuses such an id without pools of its own is held to the retired pool by design: it authenticates only with that pool's accounts and otherwise fails with that error. A retired pool stays until a session restricts the same id again (a revived or resumed pooled session replaces it), or until it expires 24 hours after it was retired, which leaves that id unrestricted and logs a debug record (at most once a minute, with the provider and the number of expiries, never a session id). The 24 hours are measured on a monotonic clock, so setting the system clock forward or back neither expires a retired pool early nor keeps it longer, and lookups do not extend it. A deferred lookup made after expiry runs unrestricted, so the 24 hours must exceed the longest work a session leaves behind under its ids. Only past 65,536 retired pools at once is the earliest retired one evicted early as a memory guard, which also leaves its id unrestricted and logs a warning (at most once a minute, with the number of evictions). Retired pools are process-local: they live in memory only, so other processes sharing the auth database do not see them and a restart forgets them. A security scan retires the pool it carried on its own provider session id the same way when it ends. A direct `restrict` caller passes the lease that `restrict` returned, once that session ends, to `authStorage.sessions.retire(provider, sessionId, lease)` to keep the id inside the pool the same way, or to `authStorage.sessions.unrestrict(provider, sessionId, lease)` to lift the restriction (live or retired); a lease never retires or lifts a restriction installed on the same session since. Session pools are the same trusted-client routing policy as client pools, not an authorization boundary. Saved resets about to expire are still salvaged on every account, pooled or not, because salvage serves the account that holds the reset. `authStorage.sessions.permits(provider, sessionId, credentialId)` tells whether a stored account may serve a session.

## Operator opt-in

Broker-backed credential storage is **off** unless `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in the agent's `config.yml`/`config.yaml`) is set. SDK discovery delegates through `packages/coding-agent/src/session/auth-broker-config.ts` to the shared `pi-ai` resolver and selects `RemoteAuthCredentialStore` instead of local SQLite. Runtime/config/env key overrides still participate in the normal credential ladder; selecting broker storage does not make those keys remote.

### Environment variables

| Variable                            | Purpose                                                                                                                                                                | Required when                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `OMP_AUTH_BROKER_URL`               | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`). Selecting this puts the client in broker mode — local SQLite is bypassed.                     | Any time the omp client should resolve credentials through a broker (and required by `omp auth-gateway serve`).           |
| `OMP_AUTH_BROKER_TOKEN`             | Bearer token used for every broker endpoint except `/v1/healthz`.                                                                                                      | When `OMP_AUTH_BROKER_URL` is set and no token is available from `auth.broker.token` or `<config-dir>/auth-broker.token`. |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | Freshness window for the encrypted local snapshot cache. Default `3600000` (1 h); `0` disables cache reads and writes.                                                 | Optional in broker mode.                                                                                                  |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | Path override for the encrypted local snapshot cache. Default `~/.omp/cache/auth-broker-snapshot.enc` (or XDG cache equivalent).                                       | Optional in broker mode.                                                                                                  |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | JSON file of per-provider visibility rules for broker credentials (OAuth `identityKey` lists, API-key toggle, `"*"` default for unlisted providers). Parsed once; invalid files abort initialization. | Optional in broker mode.                                                                                                  |

Resolution order in `resolveAuthBrokerConfig()`:

1. `OMP_AUTH_BROKER_URL` env (else `auth.broker.url` from `config.yml`, resolved through `resolveConfigValue`);
2. `OMP_AUTH_BROKER_TOKEN` env (else `auth.broker.token` from `config.yml`, else `<config-dir>/auth-broker.token`);
3. URL set but no token resolvable → hard error pointing at the token file path.

The gateway uses the same broker URL/token resolution and account-pool environment file. Its `serve`/`check` commands fetch a live snapshot directly, so the client snapshot-cache path/TTL variables do not affect those commands.

### `config.yml` keys

| Key                 | Default | Purpose                                                                                                                                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.broker.url`   | unset   | Same as `OMP_AUTH_BROKER_URL`; env wins. Hidden from the settings UI. Values are resolved as a literal, an environment variable name, or `!<shell command>` to use trimmed stdout. |
| `auth.broker.token` | unset   | Same as `OMP_AUTH_BROKER_TOKEN`; env wins. Values are resolved the same way.                                                                                                       |
| `auth.accountPolicies` | `[]` | Per-account routing rules: `provider`, identity selector `account` (OAuth: `email`, `accountId`, `projectId`, optional `orgId`; stored API key: `keyFingerprint`, the first 16 hex digits of the key's SHA-256), optional `name` (unique per provider, `[a-z0-9][a-z0-9_-]*`), optional `priority`, `reservePct` (0–100) and `reclaimAbovePct` (OAuth accounts only; with `reclaimAbovePct`, above the account's effective reserve and at most 100, sessions automatically pinned to a lower-priority account move back on their next request once this account has that much quota left; explicitly chosen accounts never move), and `drain: true` (one OAuth account per provider, used first until any usage window is exhausted or its plan allowance is spent; it ignores reserve and the hot-window demotion) with `returnMargin` (percent of quota left before the `reset` trigger returns it, default 5), `returnCooldownMs` (default 600000), `spend` (a list of `plan`, `credits`, `money`; `plan` is always spent, and `credits` or `money` keep the account first past a spent or exhausted plan window while its billing evidence shows prepaid credits or paid extra usage available; a stored usage-limit block, such as a provider's 429, still drains it), and `returnWhen` (one or a list of `reset`, default, when `returnMargin` is back; `credits-added`, when its credit balance grew since the first billing evidence after it drained; `money-available`, when paid extra usage became available after being exhausted or disabled; `credits-added`/`money-available` need the matching `spend` class). A drained account stays behind until a listed trigger holds; `credits-added` and `money-available` fire on their billing evidence after `returnCooldownMs` without `returnMargin`; a billing trigger with no evidence to compare (no usage ranking, or unknown billing) is logged once per provider and does not fire. When it drained and its billing baseline persist in the `agent.db` cache (expiring within the longer of a day and twice `returnCooldownMs` once no process uses them), as do `/session drain` overrides (30 days), so restarts keep them; a broker client shares both through the broker ([shared drain state](#shared-drain-state)), and keeps them in memory only against a broker without it. `spend` and `returnWhen` require `drain: true`; on a provider without a billing reader, only `plan` and `reset` apply (logged once). Whether Claude keeps serving on paid extra usage once its plan window reports exhausted is unverified: with `money` the account is still tried first, and a 429 drains it. `limits` takes a list of [local limits](./models.md#local-limits) without `id`, counting this account's calls to the provider (`usd`, `requests`, `tokens`) under its identity (API key fingerprint, else account id, email, or project id), so naming it keeps its history. OAuth accounts may also limit what the provider reports, with no `window`: `usage` (`max` a used fraction up to 1, compared with the most-used window that applies to the request, model-scoped windows of the requested model included; unmeasured usage never holds the account back; it complements `reservePct`, which only ranks an account in reserve behind its siblings), `credits` (`max` a quoted floor on the remaining credit balance), and `extra-usd` (`max` a quoted cap on reported paid extra usage); `credits` and `extra-usd` only apply once the plan allowance is spent, and then missing billing evidence holds the account back too, while an account whose usage report cannot be read is never held back by them. A provider without a usage fetcher never enforces these three. Each account is judged once per request. An account over a `skip` limit is not selected, a drain target counts as drained, a pool member `account` or pool `order` falls through, and an exclusively pinned account, or every stored account of the provider being limited, fails the request with `AccountLimitError` instead of switching or using an environment key. Usage that cannot be read refuses too. A reached `warn` limit is logged once per window. Account limits apply in the local agent, which counts calls in `agent.db`, and in `omp auth-gateway serve` and `omp auth-gateway stdio`, which enforce their own `auth.accountPolicies` limits against their own `agent.db` and answer a refused request with HTTP 429 (`stdio` first tries the selector's next candidate model). The gateway checks a limit when it selects the account and records a call when it settles, counting only calls that report usage (tokens or a cost), so `requests` misses calls an upstream answers without usage; concurrent and long-running requests can overshoot a cap by about the clients' concurrency (counts are also cached for up to 2 s). A video job counts once per gateway process, when a poll or download first sees it completed (until a job has recorded completed usage, each download costs a status call upstream before the download itself, bounded by the caller's request rate); polling and downloading a submitted job are never refused, by these limits or by the provider-reported `usage`, `credits`, and `extra-usd` limits, since it is already paid for. A poll or download is served, and its upstream call charged, by whichever account the gateway selects for it, which can differ from the account that submitted the job when accounts are limited; job ids are unsigned, so any gateway token holder can poll or download a job this gateway did not submit. A gateway limit is a shared cost cap, not an authorization boundary: every holder of a gateway bearer token is trusted to spend up to it. Counts live in each machine's `agent.db`, so a gateway and clients on other machines each count only their own calls; a broker-backed gateway also raises each count to the account's [fleet-wide total](#fleet-account-usage) from the broker (the larger of the two, never their sum), which is eventually consistent; point every client at one gateway for a hard shared cap. The gateway applies only `auth.accountPolicies`: account pins and `routing.accounts` are client-local. Project settings cannot set account limits, and a project `auth.accountPolicies` that replaces the global one keeps the global entries' limits. Only usage-limit blocks drain an account; auth and policy blocks do not. Saved resets of Claude and Codex OAuth accounts: `resetOn` (a non-empty list of `5h` and `7d`; `7d` is Claude's 7-day windows and Codex's weekly window) permits blocked-account recovery only while a listed window is exhausted, and expiry salvage only when the window it restores is listed; `autoRedeem` (`yes`, `no`, `unset`) replaces `claudeResets.autoRedeem` / `codexResets.autoRedeem` for the account ([saved reset auto-consumption](./settings.md#saved-reset-auto-consumption)). An entry matching a stored OAuth account, a name-only or drain-only one included, turns on the `retry.usageReservePct` reserve for that provider's other accounts. Entries containing only `resetOn`/`autoRedeem` besides `provider` and `account` do not enable this reserve routing; adding `name` keeps name-only routing behavior. API-key policies cannot set `resetOn` or `autoRedeem`. |
| `auth.accountPins` | `{}` | Project account pins: absolute project directory → provider id → account `name`. Sessions whose working directory is inside the project use only that account. Read from the global config, `--config` overlays, and runtime overrides; project settings cannot pin accounts. |
| `retry.usageReservePct` | `10` | Default protected remaining-quota percentage when an account has no `reservePct` override. |

An account pin is exclusive: requests use only the pinned account, never a sibling, and a blocked pinned account still sends the request so the provider's usage-limit error surfaces. Precedence: runtime `--api-key` and `models.yml` `apiKey` overrides (a warning is logged when one suppresses a pin), then the session pin (`/session pin`, kept on resume and across logins; `/session unpin` removes it), then the project pin, then a pool member's `account`, then the policies above. A pin whose account is not stored fails the session's requests with `AccountUnavailableError` (`Pinned account is unavailable for provider: <id>`) instead of using another account; resuming a session whose pinned account was removed shows a warning. A member `account` is only a preference: a blocked or unknown account falls back to normal selection, with one warning per policy change for an unknown name. Title generation follows its session's pins; background calls made without a session (commit messages, memories) and sessionless provider-key lookups (`omp token`, model discovery) ignore pins and use normal selection.

Broker connection values come from the agent's main config file, not project settings. Account policies/reserve use effective settings (including project/explicit config layers). Against a broker, `omp account reserve` and the account manager accept a reserve for a provider with no local usage reader, warning that it gives no protection until the broker reports that provider's usage (and never applies if it does not); a provider with neither a local reader nor a broker refuses it. Long-lived SDK sessions follow policy changes and can replace the credential store in place when effective broker settings change; failed changes leave the current store active.

#### How sessions choose and keep an account

When a provider has account policies, OMP ranks its accounts whenever it selects or reconsiders one (not on every request: a warm explicit pin, or a sole account, skips ranking). In order, an account loses when it is blocked (hit a limit), outside a required plan, past its renewable allowance, or inside its reserve; then Codex accounts with an untouched 5-hour window are preferred, accounts whose 5-hour window is at least 85% used fall back, accounts with a usage report beat accounts whose report could not be fetched, and only then does higher `priority` win. Ties go to the account whose quota would otherwise expire unused soonest. So `priority` orders healthy, measured accounts; it does not override reserve or the safety checks before it.

That ranking picks the account for a **new** session. A running session remembers the account it used last (its pin) and keeps it while the pin is warm, so the provider's prompt cache and signed reasoning stay valid:

- Anthropic pins go cold after an hour without a request; other providers' pins stay warm indefinitely. A cold or blocked pin re-ranks.
- A warm pin moves only away from a bad account: when the pinned account enters its reserve and another account is measured outside its own reserve, or when its allowance is spent and an unblocked sibling still has allowance.
- A warm pin does not move back when a higher-priority account recovers. New sessions use the recovered account; running ones stay where they are until one of the cases above applies.
- An account the user chose explicitly for a session is never moved by ranking or reserve. It is still skipped while blocked, after a failed token refresh, or when it fails a required plan check; the session then falls through to a sibling.
- Pins are saved with the session. A resumed session restores its pin with its original last-use time, and subagents start on their parent's pins. When a parked subagent is revived in the same session, its saved pin wins over the parent's automatic affinity; an explicit parent pin still wins, subject to the child's account pool.

### Token files

| Path                              | Owner                                                | Mode                          |
| --------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `<config-dir>/auth-broker.token`  | `omp auth-broker token` or `serve` | `0600`; new parent directory `0700` |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway token` or `serve` (serve skips it under `--no-auth`) | `0600`; new parent directory `0700` |

`<config-dir>` is `getConfigRootDir()`: `~/.omp/` by default, respecting `PI_CONFIG_DIR` and the active profile (`~/.omp/profiles/<name>/` for the default profile layout). Creating a token does not tighten permissions on an already-existing parent directory.

## Interaction with the local API-key resolution order

The broker owns credentials written on its host or uploaded through its API. The standard credential ladder in [models.md](./models.md) is preserved:

- `AuthStorage.keys.setConfig()` / `.removeConfig()` / `.clearConfig()` manage config keys. An explicit `models.yml` `apiKey` beats stored OAuth **without** overriding `--api-key`; `setConfig(..., { fallback: true })` instead ranks a default key reference below stored OAuth and `/login` keys. The gateway deliberately ignores local model-config overrides.

## See also

- [`secrets.md`](./secrets.md) — secret obfuscation around tokens that _do_ leak through (e.g. `OMP_AUTH_BROKER_TOKEN` in shell output).
- [`models.md`](./models.md) — provider auth resolution order; the broker supplies the stored-credential layers.
- [`environment-variables.md`](./environment-variables.md) — full env reference including `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`.
