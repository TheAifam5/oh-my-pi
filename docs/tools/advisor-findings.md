# advisor_findings

> List, inspect, resolve, or reopen the session's advisor findings.

## Source

- Entry: `packages/coding-agent/src/tools/advisor-findings.ts` (`AdvisorFindingsTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/advisor-findings.md`
- Finding state: `packages/coding-agent/src/session/session-advisors.ts`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

Requires enabled advisors and session finding callbacks. Disabled or disposed sessions reject calls. The tool uses `loadMode = "essential"` and `strict = false`. `list` and `get` request read approval; `resolve` and `reopen` request write approval.

## Inputs

| Field | Type | Description |
| --- | --- | --- |
| `op` | `"list" \| "get" \| "resolve" \| "reopen"` | Required operation. |
| `status` | `"open" \| "resolved" \| "expired" \| "all"` | List filter; defaults to `open`. |
| `id` | `string` | Required for `get`; finding identifier in `F<n>` form, case-insensitive. |
| `ids` | `string[]` | Required nonempty array for `resolve` and `reopen`; each identifier must use `F<n>` form. |
| `reason` | `string` | Required nonempty reason for `resolve` and `reopen`; surrounding whitespace is trimmed. |

## Outputs and State Changes

Results contain JSON text and matching structured details: `findings` for `list` and `get`, or per-identifier `results` for `resolve` and `reopen`. `get` includes every retained report. Listings include resolution author and reason.

Resolution records `by = "agent"` and the supplied reason. Resolving an already closed finding preserves its existing resolution. Reopening can return `superseded` when an open finding already covers the category and anchor. Merged aliases return `merged-into`, the canonical identifier, and the operation's outcome.

## Errors

Invalid parameters, an unknown `get` identifier, missing session callbacks, disabled advisors, or a disposed session produce a `ToolError`. Cancellation is checked before processing the call.
