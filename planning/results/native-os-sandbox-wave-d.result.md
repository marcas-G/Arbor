# Native OS Sandbox V21 — Wave D implementation result

Status: **implemented with one public-view contract dependency unresolved**.

The Wave D worktree contains these implementation commits:

- `6f8fc142` — fixed 30-second queue claim TTL, 100-item batch cap, and safe
  finite UTC expiry arithmetic; invalid TTL/overflow fails before mutation.
- `abd7c210` — P4 typed provider-unavailable ExpectedFailure metadata and strict
  P40 codec/read port; P9 atomically writes fact/queue/wake plus the exact
  `SandboxUnavailableV1` P3 action disposition and Step cursor transition under
  one transaction/fence. P10 Attention requires that disposition.
- `afe3a0e6`, `abb52544` — Wave C canonical result codec and exact receipt/result
  join ports, cherry-picked without conflict.
- `c607bfcb` — joined-result Workspace Detail summary/preconditions, exact
  transient P4-to-P9 HTTP 503, derived `SandboxPolicyDecisionRequired`
  Attention, safe Web rendering, and P4 policy-required park/P2 pre-dispatch
  scan. A policy-required P4 action remains the same Pending/NotAdmitted action;
  P2 releases/does not acquire a lease until a committed decision can resume it.

The P4 interruption is an internal nonterminal result only: it creates no P40
ExpectedFailure, Observation, P9 unavailable fact, or effect admission. The
provider-unavailable path remains a separate admitted-but-NoEffect P4
ExpectedFailure; restart reuses its typed P40 evidence and P9 fact instead of
reprobing. RecoveryBinding is strictly decoded and matched to the original P3
action before either view bridge is allowed to expose an outcome.

Focused verification on `c607bfcb`:

- Vitest: 8 files, 112 tests passed. Coverage includes P4 P40 codec/read,
  no-policy park before admission, P2 no-lease startup scan, P9 fact plus P3
  terminal disposition/restart gate, P10 queue/rebuild/NeedsDecision Attention,
  exact 503 Problem fields/order, Workspace Detail DTO, and OS/TrustedLocal Web
  rendering.
- `git diff --check`: passed; changed-file Biome check: passed.
- Focused package builds pass except the pre-existing Wave C/P5 authority-loader
  integration: `apps/single-workspace/src/sandbox-policy-issuer-config.ts`
  still constructs the old issuer-only snapshot, while the accepted V21 type
  now requires the full authority bundle/provider registry fields. This file is
  Wave C-owned; Wave D did not fabricate a bundle or fallback values.

Remaining accepted-contract dependency: when an active pending invocation has
never had a committed policy, the public `SandboxPolicyStatusViewV1` requires a
specific OsEnforced or TrustedLocal variant, but the existing Workspace Detail
request contains no selection and the pending P4 source does not identify that
variant. Wave D therefore exposes the derived `SandboxPolicyDecisionRequired`
Attention and omits `sandboxPolicy` rather than inventing a provider/boundary.
This requires the owning Wave C authority/selection source or manual governance
clarification before claiming the entire public NeedsDecision summary contract
closed. The existing human decision command's final event/wake composition is
also awaiting the Wave C handler landing.
