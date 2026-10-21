# P10 → P1 ProviderTurnId Codec Gap — RED Evidence

Status: **RED / manual governance required; no ProviderTurn decoder workaround applied**

## Reproduction

The production-process regression is exercised through the existing P38 public
fixture in
`tests/functional/process/p38-executable-approval-public.functional.test.ts`.
The public Agent/Provider sequence reaches three requests:

1. Root receives `assign_work` and the fake Provider returns the typed action.
2. Root receives the `WorkAssigned` text response.
3. Workspace receives a `shell` ToolCall with `claim_completion` available.

The process then fails while the public `workspace-detail` projection asks the
P4 `SandboxPolicyRequirementReadPort` for a pre-intent source. The exact error
is:

```text
PersistenceCorruption
repository = ToolObservationEvidenceStore
operation = sandbox-policy-requirement-read
reason = pre-intent P3 source contains malformed ProviderTurnId
```

The public Inbox contains only the original HumanConversation entry; the exact
Executable approval is not admitted. The original public P38 approval case
and the new P10 pre-intent public case both reproduce the same blocker before
CandidateRead/P1/resolution. This is expected RED evidence; it is not a pass
for the intended pre-intent flow.

## Commands and results

The process fixture requires Web static output in a fresh worktree. After
`pnpm --filter @arbor/web build` and `pnpm build`, the targeted reproduction
was run as:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p38-executable-approval-public.functional.test.ts -t "approves over the public API"
```

Result: **1 failed / 14 skipped**, 94.97s. The failure trace reports
`providerCalls=3` and the `assign_work`, text, and `shell` tool sequence above.
The relevant daemon error is the malformed ProviderTurnId source rejection.

The additional pre-intent public scenario was run with:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p38-executable-approval-public.functional.test.ts -t "pre-intent CandidateRead"
```

Result: **1 failed / 14 skipped**, 95.53s. It stops in the shared P38 setup at
`waitForExecutableApproval`; the source decoder crash prevents the exact
approval Inbox entry from appearing.

The initial run before building Web static output returned 503 at readiness
because `apps/web/dist/index.html` was absent. That setup failure is not the
RED evidence above; rebuilding Web allowed the daemon to start and exposed the
ProviderTurnId failure.

## Source and storage evidence

- `packages/domain/src/ids.ts` accepts `ProviderTurnId` only as `ptn_` plus a
  UUIDv7.
- `packages/agent-runtime/src/model-decision.ts` constructs ordinary turns as
  `ptn_${executionId}_${turn}` and repairs as
  `ptn_${executionId}_${turn}_r${repairAttempt}`, then casts them to the
  branded type. Other constructors in `model-decision.ts`,
  `agent-loop-actions.ts`, `agent-loop-step-completion.ts`,
  `compaction-coordinator.ts`, and `conversation-checkpoint-compaction.ts`
  derive compact/Native/checkpoint/overflow ProviderTurn IDs from Execution,
  step/turn, and context epoch/overflow ordinal.
- DID v1.23 OVS-1…OVS-7 / §9.11A and P3/08 require the P20 provider-turn chain
  to retain stable `Inference`, `OverflowCompaction`, and
  `OverflowReplacement` IDs and exact predecessor links. Migration 0020 stores
  exact IDs with a UNIQUE constraint and step/ordinal/role primary key.
- SQLite `provider_turns.provider_turn_id`,
  `agent_loop_steps.provider_turn_id`, and
  `agent_loop_step_provider_turns.provider_turn_id` are TEXT identity fields;
  current schema has no UUIDv7-only check or rewrite migration.
- P3 ProviderContext/Manifest/ProviderResult, ModelOutput source refs, P3
  Action/RecoveryBinding, P20 links, and recovery comparisons retain exact
  ProviderTurn strings. Legacy adoption also reads persisted ProviderTurn
  evidence; it does not authorize changing historical identities.
- Application `BlockedActionRef` result receipts and the related
  external-command action-reference codec decode `providerTurnId` through the
  strict UUIDv7-only `id("ProviderTurnId")` rule. A compatibility fix must
  include exact replay of historical composite-ID Blocked receipts and the
  accepted external action-reference shape.
- Existing public `ConversationStreamEvent` frames expose the ProviderTurn ID
  on `started`, `delta`, and optional `reset` events. In contrast, the
  accepted P1 pre-intent proof is an internal in-memory tuple, not a P1 command
  field, persisted result field, receipt field, or semantic-fingerprint input.
- The accepted P4/06 pre-intent proof requires the exact source
  `providerTurnId: ProviderTurnId`; the implementation plan requires current
  branded decoder validation. The current implementation's strict parse is
  therefore consistent with the accepted plan but incompatible with current
  runtime writes.

## Disposition

Do not relax the source reader to arbitrary strings or silently cast around
the failure. Draft the closed-format governance question in
`planning/proposals/P10-P1-provider-turn-id-codec-gap-draft.md`. The proposed
choice compares (A) formalizing the current deterministic composite families
with a closed versioned codec and preserving UUIDv7 historical reads against
(B) moving every new write to UUIDv7 and keeping recognized composites
read-only legacy. The draft recommends A because persisted recovery and P20
chain identity already depend on deterministic current constructors; manual
governance must accept the exact codec and compatibility scope.

No `docs/design/**`, P9 semantics, SQLite migration, receipt, external P1
payload/fingerprint, or persisted ProviderTurn row was changed. The
pre-intent CandidateRead → P1 → approval → P4 intent qualification remains
open until the source-identity gap is resolved and its accepted landing is
reviewed.
