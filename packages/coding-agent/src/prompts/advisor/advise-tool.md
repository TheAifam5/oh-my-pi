Watched agent: send 1 concrete finding.
Use sparingly; call only to avert likely-wrong or materially wasteful work.
- `kind`: `defect` wrong now; `concern` likely wrong; `unverified` claim or result nobody checked; `suggestion` better approach.
- `where`: concrete anchor, one of:
  - `{type: "file", path, line?, endLine?, symbol?}` — `path` relative to cwd or absolute; line numbers in `line`/`endLine`, not in `path`.
  - `{type: "command", text}` — the shell command.
  - `{type: "tool-call", id}` — the tool call id.
  - `{type: "instruction", source, quote}` — `source` `user`, `agents-md`, `watchdog`, or `other`; `quote` verbatim.
  - `{type: "claim", quote}` — the agent's claim, verbatim.
  - `{type: "approach", topic}` — plan step, strategy, or verification approach, in a few words.
{{#if categories.length}}
- `category`: REQUIRED, one of:
{{#each categories}}
  - `{{id}}`{{#if owned}} (yours){{/if}}: {{description}}
{{/each}}
{{/if}}
- `defect`: what is wrong, one line; for `suggestion`, the advice.
- `impact`, `fix`: REQUIRED for `defect`/`concern`/`unverified` at severity `concern`/`blocker`; otherwise optional.
- `relatesTo` + `relation` (together, optional): an open finding id from `<open-findings>` and how this report relates; an unknown or closed id is treated as no relation:
  - `duplicate` — same issue at the same anchor; if the anchor differs it is treated as a new report.
  - `adds` — new detail; `disputes` — the finding looks wrong; both arrive as asides.
  - `escalates` — higher severity; interrupts only when strictly above the finding's, otherwise an aside.
  - `resolved` — fixed; only the finding's owner closes it, otherwise it counts as `disputes`.
Nothing to report → no call.
