# S4-B Public Gate and Work Identity — Independent Review

**Disposition: PASS — Blocking = 0 for the reviewed Windows target.** This is
an independent static/light-test review only. It does not qualify S4-B or
authorize a real Provider/daemon run.

## Reviewed identity

- Test-layer gate and identity fix: `b77bd07662c76a06eb88350da1cc5488885f597d`.
- Provider-light status/result update: `26ce1753812b506126be87b08f8141affc9fb2d5`.

## Findings

- The response gate first filters by the advertised `shell` tool and then
  decodes the actual upstream response body, including fragmented SSE fields.
  It holds only exactly one `shell` tool call whose `command` is `Get-Date`,
  whose `cwd` is the current workspace mount, and whose optional timeout is
  bounded. The
  TypeScript assertion aliases the same MJS decoder used by the fetch hook.
- The fetch hook inspects a clone and returns the original `Response` object
  unchanged. A request-matching but response-nonmatching body is recorded as a
  completion and passed through without `response-held`; a matching body is
  held until its exact request ID is released. The stub-fetch regression
  verifies unchanged text and tool-call response bytes and correct held-event
  correlation.
- Public admission no longer discovers the Work by matching its model-authored
  objective. The test starts from an empty Current Work, resolves the public
  Root approval, then reads the newly published `current-work.workId`. The
  held request must contain the exact `WorkAssigned(workId, workspaceId)` tool
  result and WorkspaceWork context. That request is correlated to its unique
  request-start/process evidence; the public active Execution is then checked
  against the exact Project, Workspace, `WorkEpisode`, and `episode_ref` in a
  read-only DB query before P1/EAP setup continues.
- Environment typing and validation remain aligned: the MJS selector has a
  `.d.mts` declaration, fixture environment remains allowlisted, and the P11
  authority source is required to be an absolute path inside the private
  fixture. The result record retains the prior failed S4-B attempt as a
  precondition/oracle failure and makes no S4-B PASS claim.

**Portability note (non-blocking for this Windows target):** the exact
`Get-Date` command is PowerShell-specific, while the shell executor uses Bash
on non-Windows hosts. If this opt-in real journey is expected to run on other
platforms, either guard the test as Windows-only or choose a platform-specific
read-only command that still requires P4 approval. No non-Windows qualification
is implied here.

## Light validation

- `provider-fetch-capture-hook.test.ts`: **2 passed** (stub fetch only).
- `public-s0-response-gate.test.ts`: **9 passed** (provider-light only).
- `pnpm exec tsc -p tsconfig.test.json --noEmit`: **PASS**.
- Targeted Biome on the seven changed test/support files: **PASS**.
- The prior real S4-B run remains **FAIL / not qualified**; no real Provider
  or daemon was run during this review.

No design or production source changed in the reviewed package. No S4-B
qualification or real-run authorization is granted by this review.
