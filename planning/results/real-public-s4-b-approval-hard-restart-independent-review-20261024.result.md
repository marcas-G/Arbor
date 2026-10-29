# S4-B Approval Hard-Restart — Independent Review

**Disposition: PASS — Blocking = 0.** This is a read-only source/fixture
review and light-test record. It is not a real-provider qualification or
authorization to run one.

## Reviewed identity and scope

- S4-B test/support hardening: `7f3b3b23`.
- Provider-light plan/result update: `f0e50fe7250668955d215910212947c9a3e620fe`.
- Reviewed tree HEAD: `f0e50fe7250668955d215910212947c9a3e620fe`.
- Scope: TrustedLocal P11 fixture handoff, authentic held-response decoding,
  EAP/P1 sequencing, exact restart binding, execution-wide counts, typed
  Observation, and no-workspace-mutation assertions.

## Findings

1. **P11 environment is constrained and restart-stable.** The real-provider
   fixture allowlists only `ARBOR_AUTH_TOKENS` and
   `ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE`; the auth value is fixed to the local
   test pair, and the authority source must be an absolute path inside the
   private fixture. `setupProbe` adds that source after clone and copies the
   same required environment into the environment object reused by
   `ProductionFixture.restart`. The S4 test independently checks the source
   path is inside the fixture and verifies the relevant keys and committed P1
   snapshot after restart. Restart clears only the response-gate directory.
   The response gate returns the original upstream `Response`; the bounded
   SSE decoder only inspects its captured body and rejects extra or
   non-`Get-Date` tool calls.
2. **The restart request baseline is taken before crash.** The test records
   WorkspaceWork Provider request IDs before restart, then requires the same
   set afterward and zero Provider request starts from the new daemon while
   the approval is pending.
3. **The action and receipt oracle is execution-wide.** The read-only snapshot
   checks zero ToolInvocations/ToolResults and exactly one pending EAP before
   restart, then exactly one consumed EAP, one successful ToolInvocation, and
   one ToolResult after approval. A bounded post-approval stability snapshot
   must remain identical; extra pending EAPs or tool invocations fail. The
   workspace file snapshot remains unchanged throughout.
4. **The Observation is checked as canonical Success.** The test parses the
   persisted observation, requires `_tag: Success`, `resultRef: null`, bounded
   text and truncation metadata, and a non-truncated result. The command is
   restricted to the exact `shell`/`Get-Date` call on the workspace mount.

The S4-B sequence is correct: the authentic WorkspaceWork response is held;
the exact P1 decision authority is granted; the unchanged response is released
and creates one Pending P4 EAP; P1 TrustedLocal policy is committed while that
EAP remains Pending; the daemon hard-restarts against the same DB; the same
Work/Execution/EAP/action binding remains Pending; public approval resumes that
invocation once. P1 supplies the process context and is explicitly not the EAP
source. `TrustedLocalUnconfinedV1` is fixture-only and makes no OS-sandbox
claim.

## Light validation

- Targeted response-gate and S4-B parser tests: **10 passed, 2 real S4 cases
  skipped** (the real-provider opt-in was not enabled).
- `pnpm exec tsc -p tsconfig.test.json --noEmit`: **PASS**.
- Targeted Biome on the three changed test/support files: **PASS**.
- `git diff --check 7f3b3b23^..f0e50fe7`: **PASS**.
- No daemon or real Provider was run. S4-B remains unqualified.

**Conclusion:** The reviewed test plan and assertions are suitable for a
separately authorized, at-most-one real S4-B attempt. This review itself grants
no such authorization and claims no S4-B pass.
