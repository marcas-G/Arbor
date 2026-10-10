# F23 S1–S4 Public Journey Alignment

Date: 2026-10-10

## Preserved pre-repair RED

Before this test-only repair, the public black-box was run on
`23206320983baa8f9683f1ab619df9735f90b124` with:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/capability/black-box/s1-s4-public-api.test.ts
```

Result: **1 file; 2 passed, 2 failed**. The two failures were:

- `S1/S3 creates a project and a visible first-layer responsibility tree`:
  its direct external `CreateChildWorkspace` submission returned HTTP 403,
  `authority/denied`, reason `UnsupportedOrigin:CreateChildWorkspace`.
- `S2 applies a local steer through the public command face`: its direct
  external `AssignWork` setup returned HTTP 403, `authority/denied`, reason
  `UnsupportedOrigin:AssignWork`.

The other two cases, including S1 verification/acceptance and S4 restart, passed.
These REDs showed that the fixture sent System-internal/Agent-originated
commands through the authenticated human `/commands` boundary.

## Repair scope

This repair changes only the S1–S4 public black-box test. It preserves the
external-origin deny policy and replaces the invalid setup calls with the
accepted public processes: human message → Root control action → exact human
governance/approval decision → internal consumer/Agent action → public view or
SteerWork. The test also probes direct external `CreateChildWorkspace` and
`AssignWork` rejection without observing a visible child/Work side effect.

The existing focused F23 composition test already proves raw external
`AssignWork` is rejected with HTTP 403 before facts loading, Resolver, or
Gateway; `apps/single-workspace/test/external-command-composition.test.ts`.

## Post-repair qualification

**PASS — 4/4 public-process journeys.** The final run was:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/capability/black-box/s1-s4-public-api.test.ts
```

Result: **1 file / 4 tests passed** (23.51 seconds) after the stability
follow-up below.

- S1/S3: a direct external `CreateChildWorkspace` request returns 403
  `UnsupportedOrigin:CreateChildWorkspace`; the public responsibility tree
  remains root-only. The test then submits a human message, observes the exact
  pending `gov:<FormationProposalId>:<revision>` Inbox entry, approves that
  revision with external `RecordDecision`, and waits for the asynchronous
  Formation consumer to expose the named child and its initial Work in the
  public responsibility tree.
- S2: a direct external `AssignWork` request returns 403
  `UnsupportedOrigin:AssignWork`; public Current Work remains empty. The test
  then submits a goal, observes and approves the exact CAPA Inbox reference,
  waits for the Root Agent's Work, submits public `SteerWork`, asserts the Work
  revision advances by one and remains Open, and observes the steer marker in
  the later Agent provider turn.
- The other S1 completion/acceptance and S4 restart journeys remain intact.
  After correcting the provider marker matching, the prerequisite sequence
  S1/S3 → S1 → S4 also passed **3/3**, confirming S4 was not independently
  failing; its earlier 503 followed a stalled S1 provider path.

The existing `apps/single-workspace/test/external-command-composition.test.ts`
case `rejects raw external AssignWork before loading facts, Resolver, or
Gateway` provides the focused no-Resolver/no-Gateway evidence for rejected
AssignWork. The public black-box additionally proves the rejected external
CreateChildWorkspace and AssignWork requests create no visible child or Work.

The Root fake provider selects the MAC-P1 or S2 goal marker from the latest
`role: "user"` message in that Provider request; it does not rank markers
found in serialized conversation history. After the pending formation Inbox
entry appears, the public responsibility-tree is asserted to contain exactly
the root and no child before `RecordDecision` is sent.

`pnpm exec biome check tests/capability/black-box/s1-s4-public-api.test.ts` and
`git diff --check` pass. No production source or `docs/design/**` files changed.
F23 remains open; this result qualifies the corrected S1–S4 public journey and
does not claim broader F23/runtime closure.
