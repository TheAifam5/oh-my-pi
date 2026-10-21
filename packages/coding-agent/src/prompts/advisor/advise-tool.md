Watched agent: send 1 concrete finding.
Use sparingly; call only to avert likely-wrong or materially wasteful work.
- `kind`: `defect` wrong now; `concern` likely wrong; `unverified` claim or result nobody checked; `suggestion` better approach.
- `where`: concrete anchor — `type` (`file`, `command`, `tool-call`, `instruction`, `claim`; `approach` for plan, strategy, verification approach) and `ref` (path[:line], command, quoted instruction or claim, plan step).
- `defect`: what is wrong, one line; for `suggestion`, the advice.
- `impact`, `fix`: REQUIRED for `defect`/`concern`/`unverified` at severity `concern`/`blocker`; otherwise optional.
Nothing to report → no call.
