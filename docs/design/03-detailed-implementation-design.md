# Arbor Detailed Implementation Design

**Version:** 1.52\
**Status:** TOP-LEVEL ARCHITECTURE FROZEN — Minimal Architecture Convergence accepted; MAC-P1 authorized\
**Supersedes:** v1.51\
**Date:** 2026-10-18\
**Depends on:** `Arbor System Design Specification v1.19`

**Governance changes (v1.51 → v1.52): F23 P6 operator rebuild and v1 route-command qualification**

- The accepted P6 UnboundLegacy package has no v1 canonical Work-owner or
  Workspace-Parent mutation command. Only the command-level owner/Parent route
  move, old/new recipient command journey, and its command/process crash
  qualification are N/A for v1. This does **not** make the same-key
  same-transaction route helper, current-route human visibility, or future
  command rejection constraints N/A. Any separately governed future command
  that changes recipient must update canonical route and Inbox key in one P1
  transaction, retain old/new current-route authorization, and use the ordinary
  P1 `TerminalRejected(AuthorityDenied)`/zero-canonical-mutation path if that
  atomic move cannot commit. P8's frozen old Verification owner snapshot and
  successor-current-owner behavior are unchanged.
- Production P6 Inbox rebuild is required, not N/A. The operator-only offline
  `p6:inbox-rebuild` CLI targets only the exact current schema-48 database while
  the daemon is stopped and under the existing P39 `MaintenanceExclusive`
  permit. It invokes the existing `rebuildUnboundLegacyInboxProjections`
  helper through one `TransactionPort` transaction on the same P39 primary
  SqlClient connection; no second connection, online service, Agent/Web/model
  tool or P10 Attention source is added. Its `--p39-sidecar` is the P39
  blocker-report SQLite and is distinct from its protected JSONL `--manifest`.
  The bounded P39 `openSync(..., "wx", 0o600)` sidecar-file creation and SQLite
  schema initialization precede permit acquisition; the `wx` winner/loser
  operation is not the P39 maintenance lock. If RuntimeShared blocks the
  permit, P39 infrastructure artifacts may remain, but the primary, JSONL
  manifest and P6 rows are untouched. Same-connection transaction, idempotent
  current-route rebuild, manifest audit, and crash/restart reconciliation are
  required qualifications.
- Accepted token
  `ACCEPT_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_AND_V1_ROUTE_MOVE_NA`,
  proposal raw SHA-256
  `B6A542973768D1C0D7C8ACB644988D1C957B7020F73206C335D73FF7FE0C833E`,
  accepted 2026-10-18. Acceptance/landing record:
  `planning/results/F23-P6-operator-rebuild-and-route-move-na-acceptance-and-landing.record.md`;
  independent post-landing review is pending. The distinct implementation
  authorization token
  `AUTHORIZE_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_IMPLEMENTATION` has **not**
  been granted; no production implementation, migration, or preserved/online
  database operation is authorized by this landing.

**Governance changes (v1.50 → v1.51): AH19 Conversation owner × P17 Job authority reconciliation**

- **Work pre-checkpoint frontier:** before the first typed
  `CompactionCheckpoint`, select the latest 64 persisted Session Timeline
  rows by Session-local sequence. The selected row window is the considered
  `inputFrontier`, not proof of representation or checkpoint coverage. Apply
  existing P3 projector branches/filters without refilling skipped rows from
  older history. Current input and canonical C0/C1 facts are pinned outside the
  row cap. Once a checkpoint exists, the active frontier is that exact
  checkpoint sequence plus every unsummarized typed entry after it, without
  the pre-checkpoint cap. Coverage can claim only content actually represented
  by the existing projector.
- **Conversation checkpoint owner:** exact `RootWorkspaceId` owns one v1
  conversation stream across immutable HumanMessages, ResponseJobs, Attempts,
  Executions and response episodes. HumanMessage contributes only exact
  identity/owner/order/body; legacy lifecycle, claim and response columns are
  not runtime or checkpoint truth. Coverage is the contiguous FIFO prefix
  where the exact Job is `Answered` and its unique Attempt plus terminal
  ConversationResponseEpisode Execution prove the same `(messageId, attemptNo,
  executionId)` successful response with
  `Completed(ConversationResponseProduced(messageId))`. The current raw input
  is pinned once from immutable HumanMessage body only for the exact
  `Running` Job, active Attempt, Episode Execution and lease; it remains
  uncovered until the Job is Answered.
  Any earlier non-Answered, malformed or other-episode Running Job blocks
  later coverage. Work Session history/checkpoints are excluded. ProviderNative
  reuse requires exact complete binding fingerprint; otherwise portable
  Summary is rebuilt from retained HumanMessage sources paired with their
  authoritative Answered Job response bodies. Messages and live checkpoint
  evidence remain durable; restart resumes the same response episode and does
  not replay settled work.
- **Physical boundary:** the Conversation owner state/table/port, message
  ordering-key implementation, migration ID and initialization are TBD for
  separately authorized implementation. No old Workspace Session checkpoint
  is backfilled as Conversation ownership. P2 does not select storage shape in
  this landing; P4 is unaffected.
- Work package token `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`,
  proposal raw SHA-256
  `4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`;
  Conversation package token `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`,
  proposal raw SHA-256
  `9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
  Both accepted 2026-10-17. Their P17 authority reconciliation is accepted
  under `RECONCILE_AH19_CONVERSATION_OWNER_WITH_P17_JOB_AUTHORITY`, proposal
  raw SHA-256
  `92EF668AFFBE3A5D1C651107C33006C7CB987E7021FFFC02037B3603FD276B75`, on
  2026-10-18. Acceptance/landing record:
  `planning/results/AH19-conversation-owner-p17-authority-reconciliation-acceptance-and-landing.record.md`;
  independent post-landing review remains pending.

**Governance changes (v1.48 → v1.49): AH14 legacy adoption evidence Attention**

- P9 recognizes only the fixed `LegacyActionDispositionUnproven` case: a
  uniquely bound legacy successful Provider result and decoded action list
  have at least one action without provable durable disposition. It fails
  closed before ProviderResultAvailable adoption, action/output replay, or
  canonical mutation. P9 stores the canonical evidence fingerprint with one
  immutable `LegacyAdoptionEvidenceEscalated` fact/event under the current
  lease; a later resolution requires exact evidence for the complete original
  decoded action set and binds to the original fingerprint.
- P10 exposes exactly `LegacyAdoptionEvidenceInsufficient` at
  `ActionRequired`, targeting the exact Execution Workspace, with a bounded
  safe summary and `attentionFactId` deduplication. It validates failure and
  resolution event envelopes field-by-field against permanent P9 facts before
  atomically applying markers and offset. Rebuild recreates unresolved markers
  from P9 facts after source-event pruning; evidence-proven resolution removes
  only the matching marker. No manual dismissal or timeout exists.
- P1 owns shared transaction/storage contracts. P4 `06` is reference-only for
  existing exact same-action P4 terminal evidence; no P4 semantics change.
  Migration ID, exact DDL and initialization are not fixed or reserved here;
  implementation and migration qualification require separate authorization.
  Accepted token
  `ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`, proposal raw
  SHA-256
  `71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`,
  accepted 2026-10-17. Decision/landing record:
  `planning/results/AH14-legacy-action-disposition-attention-acceptance-and-landing.record.md`;
  independent post-landing review:
  `planning/results/AH14-legacy-action-disposition-attention-landing.review.md`.

**Governance changes (v1.47 → v1.48): P8 stable evidence time and conclusion snapshot**

- `RecordVerificationEvidence.recordedAt` is the Runtime-selected first
  durable P9 ActionIntent `updatedAt`. Retries and owner-generation takeover
  reuse it; P9 preserves it while Pending and fails closed if its first-intent
  meaning cannot be proven. The model cannot author it.
- New P8 conclusions durably preserve the immutable mission and complete
  ordered criterion-result snapshot. Ordinary `ConcludeVerification` writes
  the same canonical snapshot/status/reason/verdict/summary binding to its
  row, v2 event and v2 result/receipt; v1 history remains strict and
  read-only. The G5 `RetryVerification` orphan branch retains its outer v1
  receipt and ID bindings, while its row/event carry the exact
  `Unknown`/`Orphaned`/`NotApplicableOrphaned`/empty-results exception.
- Snapshot status is exactly `Pending`, `Available`,
  `NotApplicableOrphaned`, or `UnavailableLegacy`. Existing open-row migration
  proof uses only a strictly decoded and identity-associated
  `verifications.mission_snapshot`; `missionDigest` cannot reconstruct it.
  Existing concluded rows become `UnavailableLegacy` without inferred
  criterion results.
- Migration ID, exact DDL and initialization remain TBD for separately
  authorized implementation. No migration is reserved, registered or
  executable under this design landing. Acceptance token
  `ACCEPT_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT`, proposal raw
  SHA-256
  `B0C532FF66697CE1FB06B93CDE477B1A833FC310D360D48513E341D54F1FAD56`,
  accepted 2026-10-17. Decision/landing record:
  `planning/results/VCS-verification-evidence-time-and-criteria-snapshot-acceptance-and-landing.record.md`;
  independent post-landing review:
  `planning/results/VCS-verification-evidence-time-and-criteria-snapshot-landing.review.md`.

**Governance changes (v1.46 → v1.47): F23 P6 UnboundLegacy current-route Inbox mechanics**

- The accepted P6 package reuses the existing `Governance` Inbox kind and
  stable `retry-verification-unbound:<commandId>` key, with typed
  `RetryVerificationUnboundLegacy` content reconstructed from the immutable
  P1 disposition (`commandId`, project, source Work/Verification,
  `UnboundLegacy`, `OriginEvidenceIncomplete`, `created_at`). It adds no Inbox
  kind, Message, approval, Agent instruction, wake, command or P10 Attention
  source. Reads are human-only and do not consume/clear the entry.
- Recipient is current-route derived from canonical Work/Workspace governance
  facts on every admission/query/rebuild and passes the unchanged P8 current
  authenticated-human authorization. Root Work uses current Root-local human
  governance; child Work uses its exact current direct Parent Workspace.
- A same-key owner/Parent route move is atomic with the canonical owner change
  in the existing P1 command transaction. It preserves Inbox `created_at`,
  increments revision and updates `updated_at` once; no-op reconciliation
  changes neither. If atomic movement is unavailable, the existing Gateway
  persists its ordinary `TerminalRejected(AuthorityDenied)` receipt/attempt
  and commits no canonical Work/Workspace/Event/Inbox/disposition mutation.
  Same-CommandId replay returns that receipt; a different CommandId rejects
  independently. No pre-Gateway rejection or asynchronous route-reconcile
  fact/window is introduced.
- P1 `04` adds source Work/Verification to the disposition contract and owns
  the physical Inbox row representation. The P1 database route columns,
  initial revision seed, and migration ID/name remain an implementation
  package TBD; no DDL, migration registration/execution, online database
  upgrade, or production implementation is authorized by this design landing.
- Accepted token `ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`,
  proposal raw SHA-256
  `798C2CB2782E4D8FF1064CE1065E12B09A318565997EF1160460B478CFA48FDF`,
  accepted 2026-10-17. Decision/landing record:
  `planning/results/F23-P6-unbound-legacy-inbox-mechanics-acceptance-and-landing.record.md`;
  post-landing consistency review:
  `planning/results/F23-P6-unbound-legacy-inbox-mechanics-landing.review.md`.

**Governance changes (v1.45 → v1.46): F23 / P8 permanent RetryVerification replay origin**

- The accepted scope narrows P8 exact replay to a currently authorized exact
  retry: every replay re-runs P12 actor/project/source visibility and exact
  current Root-local or direct-Parent human governance. Revoked/changed-owner
  authorization or different actor/project/source returns the generic Resolver
  denial before Gateway and reads no receipt. A same-CommandId/same-source
  changed summary, expected revision or successor ID reaches Gateway, whose
  existing full tuple compare alone returns `IdempotencyConflict` before JSON
  decoding. DID §4.1B, P1 `01`/`03`, and the Gateway `BEGIN IMMEDIATE` receipt
  linearization point remain unchanged.
- P8 records one immutable `retry_verification_origins` fact for successful
  handoff, with only CommandId, ProjectId, original actor, source Work and
  Verification, successor Verification and verifier Execution, and creation
  time. It stores no payload, summary, fingerprint, schema/algorithm version
  or receipt. The fact has the same retention lifetime as its permanent
  Command receipt and is independent of Domain Event pruning. If its
  replay-only authority reaches Gateway but the receipt is absent, the existing
  safe `PersistenceCorruption<"CommandStore">` boundary returns with no handler
  or writes.
- Historical origins are backfilled only from a strict successful P8 receipt,
  the exact retained conclusion/start Event pair, and canonical successor /
  verifier-binding facts. Unprovable recognized successes preserve their
  receipts, receive immutable `UnboundLegacy` disposition, and admit one
  human-only, queryable P6 Governance Inbox item; replay is generic-denied.
  The item-specific P6 key/recipient/query/consumption/rebuild mechanism is
  separately gated by P6 owner acceptance. This is not a P10 Attention source,
  not an Agent instruction, and not an automatic retry.
- P1 `04` reserves an ordered origin/disposition migration, ID/name **TBD**;
  no migration is registered or executable under this design landing. Its
  atomicity, immutable FK/uniqueness, repeat-upgrade, retention and evidence-
  gated backfill rules are owned by the accepted P1/P8 sections. Production
  code, DDL activation and test implementation remain separately authorized.
- Acceptance basis: token
  `ACCEPT_F23_P8_PERMANENT_REPLAY_ORIGIN_AND_LEGACY_DISPOSITION`, fixed
  proposal SHA-256
  `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`;
  decision record `planning/results/F23-retry-verification-permanent-replay-governance-acceptance-and-landing.md`;
  post-landing consistency review
  `planning/results/F23-retry-verification-permanent-replay-design-landing.review.md`.

**Governance changes (v1.44 → v1.45): P41/0041 fact-key nullability amendment**

- P41's accepted physical amendment declares the immutable P9 fact identifier
  `attention_fact_id` as `TEXT NOT NULL PRIMARY KEY`. This makes SQLite enforce
  the already-defined fact identity on ordinary rowid tables; P41 logical
  behavior, keys, event/recovery semantics, and P10 projection remain
  unchanged. Migration 0041 remains gated on the qualified 0036→0040 prefix,
  creates empty tables without backfill, and is not registered or activated.
  Accepted amendment proposal SHA-256:
  `BE7E9CC9F3528ADBA90EF67615FE1C24E92B5FE751782151882ACAA4531E2BC9`;
  acceptance record:
  `planning/results/P41-0041-nullable-primary-key-amendment-acceptance-and-landing.md`;
  independent post-landing review:
  `planning/results/P41-0041-nullable-primary-key-amendment-postreview.md`.

**Governance changes (v1.43 → v1.44): combined accepted owner landing**

- RAI-DG-01 holds the exact EGP Work `(WorkId, WorkRevision)` after a
  Work-bound `Interrupted(RuntimeSafetyStop)`, a closed P9 recovery-blocking
  source, or `OutcomeUnknown(ReconciliationRequired(nonempty refs))`. Only
  authorized revision-advancing Steer makes the old revision stale. P2 owns
  the canonical gate/query and commit-time admission recheck; P7 excludes the
  exact revision in its single classifier; P9 owns immutable source identity;
  P10 filters active Attention by the canonical current revision. No gate
  table, WorkWait, lifecycle state, or projection-ACK authority is added.
  Accepted package SHA-256:
  `0CEB2DAA2E6128F86CBD1CAA185B9847EAAB240360011F94425E0856F39AA106`;
  record `planning/results/RAI-DG-01-governance-acceptance-and-landing.md`.
- P15 `RenameProject` and `CloseProject` accept only the exact authenticated
  local-human External route with exact P15 `ProjectGovernanceAuthority`;
  model/Agent origin is denied even if a grant exists. Creation, selected
  project resource provenance, lifecycle and closure semantics are unchanged.
- A WorkEpisode may settle `Completed(Blocked)` only with exact terminal
  denied-action evidence and an explicit bounded help request. The Work stays
  Open; the current `WorkBlocker` ledger drives Action Required, Work Detail
  and (for child Work) one direct-Parent Inbox entry. Exact successful-action
  resolution or authorized Work revision/terminal transition closes the
  blocker; ordinary Manual wait and Plan status do not. No automatic retry or
  Verification/Acceptance implication is introduced.
- P39 adds only schema-39 `DeniedUnbound` recovery-binding provenance for a
  terminal no-effect Denied invocation with no proven invocation binding; it
  cannot gain a binding/effect/replay path or P40 observation. Existing P40
  evidence-bearing branches remain unchanged.
- P8 exposes one authenticated-human `RetryVerification` command. It
  atomically concludes the exact old Open Verification as `Unknown(Orphaned)`
  and creates one successor plus durable spawn intent; exact replay reuses
  preallocated IDs. Root Work requires authenticated local-human governance;
  child Work requires its exact Parent Workspace human. Attention remains
  derived and only clears after the existing freshness barrier. No automatic
  retry loop or verifier authority expansion is introduced.
- The reconciled P13 catalog has 28 required production command descriptors
  plus the optional `ResolveControlApproval` descriptor (29 total when
  available), Human-actionable count 15 and Agent-originated count 12.
  Proposal-specific postimage hashes are not asserted for the combined tree;
  the combined owner hashes, source package digests, technical rebase proof,
  and separate postreview are recorded in
  `planning/results/2026-10-12-combined-governance-landing-manifest.md`.
- This is a design landing only. It does not register or activate migrations,
  upgrade an existing database, publish, or claim implementation evidence.

**Integration reconciliation (2026-10-10):** This version combines two separately
accepted owner amendments that each landed from DID v1.34 as v1.35 in isolated
trees: FT-DG-01 functional resource admission and F23 exact-tuple receipt
integrity. Their clauses below are additive and retain their accepted semantics;
the reconciliation changes no selector, receipt precedence, schema, persistence,
or recovery rule. The isolated landing digests describe their original owner
blobs, not this integrated blob; the combined digest is recorded in
`planning/results/F21-F23-isolated-integration.result.md`.

**Owns:** 可编码 ADT/API 语义、Effect A/E/R、Command/Event、Failure、Invariant enforcement、Ports、transaction/fencing、Model Context、Persistence、Package DAG、phase-scoped closure 与技术基线

**Does not own:** P1–P8/G1–G8、S1–S4 行为正文、顶层领域/Runtime 语义；若实现发现这些语义需要改变，必须回到上游文档修订
**Scope:** 将已冻结的系统级设计落实为可实现且可测试的契约。v1.4 是 governance patch：闭合 P0 planning 审阅发现的 DG-01…DG-06，不改变 C1–C10 / X1–X11 的语义结论；v1.5 闭合 P1 pre-implementation 审阅发现的 P1-DG-01…05 与 P1-DG-10，P1+ 的 exact DDL、逐 Command payload/signature、Prompt 正文与经验参数仍按 phase-scoped closure 管理。

**Accepted owner amendment (source DID v1.34 → v1.35): FT-DG-01 functional resource admission**

- CreateProject's external Handler schema is v2 while the server-selected
  external wire codec remains v1. Root resource input is the closed
  Profile(ref, version) | ConversationOnly selector; client paths are rejected.
- The authenticated wire-v1 → exact Actor/Principal → Resolver → Gateway tuple
  order in §4.1B is unchanged. No receipt pre-read or old-schema v1 replay is
  added. Historical v1 receipts are preserve-only; matching a v1 CommandId
  with a v2 candidate fails closed by the existing tuple rule.
- The Profile registry is an immutable, host-owned startup snapshot. The P1
  handler consults its pure in-memory lookup only after Gateway finds no
  receipt. It constructs the canonical FileTree boundary and writes it with
  Project/Workspace/Session in the existing command transaction. Filesystem
  resolution/ownership activation remains post-commit and reads the persisted
  Workspace boundary.
- ProjectCreated stays EventVersion 1 with its existing payload; OPEN-1
  Profile-source audit, OPEN-2 legacy same-ID retry expectations, and OPEN-3
  post-commit durable-attention semantics remain open.
- Proposal content SHA-256:
  `274885C110E3B277753B49F6BAD023619ADFCF52D866CC86F01F27F7FDA85DD0`.
  This is a functional-scope landing, not full FT-DG-01 closure.

**Governance changes (v1.31 → v1.32): FT-DG-02 — Completed Work public view**

- P10 owns an additive, read-only `work-detail` View over the exact
  `{ projectId, workspaceId, workId }` identity, with typed request/response,
  canonical-source binding, and a shared typed NotFound/404 for absent and
  cross-project/workspace targets.
- P13 renders the added frozen view; the current inventory and rendering
  count is ten. Historical v1.13/v1.15 nine-view statements remain governance
  history and are superseded for the current contract by this amendment.
- Verification/Acceptance/Work lifecycle ownership is unchanged. No command,
  event, DDL, migration, transport route, authority, or package-DAG change.
- Accepted proposal SHA-256:
  `6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`;
  supplemental decision date 2026-10-08; landing package SHA-256:
  `266884FC5B8858CA631DC87EFA1EA29B6BFD7265FB93C324F0A5F65FF8C68433`.
  Decision/landing audit:
  `planning/results/FT-DG-02-governance-acceptance-and-landing.review.md`.

**Governance changes (v1.32 → v1.33): AH10 direct-child AssignWork receipt binding**

- DID §6A.16 freezes the typed target/authority evidence and receipt-first
  recovery contract for direct-child AssignWork. System Design §4.11 remains
  the single semantic owner.
- §5.3 adds `AssignWorkTargetBindingEscalated`; §7.2 adds the scoped placement,
  binding, and recovery-attention ports. §9.3/§9.9 freeze additive migration
  0033 and the same-transaction binding, exact authority validation, optional
  ActionApproval consumption, and durable failure-fact/event contracts.
- P1 `07` owns the narrowly scoped old-Committed receipt exception; P9 `07`
  owns the immutable failure fact and recovery order; P10 `02`/`07` own the
  accepted projection and qualification. P4 `03` owns the Command-boundary
  approval-consumption adapter contract.
- Accepted proposal SHA-256:
  `E71285B4908DE221D10A3AA7720DEB74ABDFBD99992640AD6152F534666B0DD9`.
  Decision and landing file audit:
  `planning/results/AH10-direct-child-assign-work-target-binding-governance.md`.

**Governance changes (v1.33 → v1.34): FT-DG-03 external command runtime codec**

- DID §4.1B freezes strict external wire v1 decoding, the authenticated
  Actor/Principal and Resolver visibility gate before Gateway entry, and the
  separation between codec version, Handler receipt schema, and fingerprint
  algorithm version.
- External codec failures use a non-reflecting `InvalidCommandPayload`
  transport Problem and never enter CommandRejection, a receipt, or an Event.
  Typed internal submissions use the same registered semantic validator.
- The P1 Gateway receipt tuple comparison remains inside `BEGIN IMMEDIATE`
  and receipt-first relative to its final exact authority check. No new SQL,
  raw-payload storage, or F23 migration is introduced.
- Accepted proposal `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`, SHA-256
  `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`;
  decision and landing record:
  `planning/results/FT-DG-03-governance-acceptance-and-landing.md`.
- Design acceptance and landing do not authorize runtime implementation.
  AH10 §6A.16, migration 0033, §9.9, and P1 `07`'s sole direct-child
  AssignWork exception remain unchanged.

**Accepted owner amendment (source DID v1.34 → v1.35): F23 exact-tuple receipt integrity and
receipt-first prior-consumer decode**

- P1 `01`/`02`/`03` now freeze strict Committed-result and
  `CommandRejection` runtime decoding only after the existing in-transaction
  `(fingerprint, Handler.schemaVersion, fingerprint algorithm version)` tuple
  exactly matches. A mismatch remains `IdempotencyConflict` before reading or
  disclosing either JSON field. Missing decoder/schema, invalid JSON or
  wrong-shape data is `PersistenceCorruption<"CommandStore">`: no receipt
  repair, handler, canonical/Event write, `CommandAttempt` or semantic
  rejection; rollback remains in the existing `BEGIN IMMEDIATE` transaction.
  External transport uses its existing safe, non-retryable
  `persistence/corruption` Problem. No tuple, SQL, DDL or migration change.
- P1 `07` specifies trusted CommandType/Handler-schema decoder selection for
  direct prior-receipt consumers without claiming Gateway tuple comparison.
  The exact direct-child AssignWork exception continues to require the full
  accepted binding proof and never replays a handler.
- P9 `07` owns the specific corruption disposition inside that direct-child
  proof: raw JSON syntax corruption retains an internal corruption
  classification and records the existing `ReceiptMismatch` durable fact/event
  before returning `AgentActionRecoveryBlocked`; parseable wrong-shape results
  and structural binding/effect mismatches retain the existing P9 failure-code
  paths. Ordinary non-direct-child prior-consumer corruption remains an
  operational failure and does not create an AssignWork binding fact. P9's
  existing fact identity, atomic write, deduplication and crash recovery are
  unchanged.
- This F23 amendment adds no generic P10 Attention source or observable
  diagnostic/logging port. The existing AssignWork-binding P9→P10
  `Action Required` projection is unchanged; the separately accepted P7
  Deliver route is defined by the DID v1.37 amendment below.
- Landing basis: fixed candidate proposal SHA-256
  `70D55E2AD117D28522297B7BF55EC8AD479CA1BFEEF4025AEA7F1901793DD1A7`;
  independent proposal review Blocking = 0; user standing authorization for
  high-confidence design landing. Audit and owner file hashes:
  `planning/results/F23-exact-tuple-receipt-integrity-design-landing.md`.
- This owner-document landing is not implementation/crash qualification.
  The real CommandStore writer transaction and P9 pre/post-commit crash matrix,
  an operator-visible diagnostic sink, and cross-schema-version prior replay
  remain explicit OPEN qualifications.

**Accepted owner amendment (source DID v1.36 → v1.37): AH10 DeliverMessage
generation fence and legacy replay**

- The exact accepted route is AgentAction.Deliver → `DeliverMessage` CommandType,
  Handler `schemaVersion="1"`, through the existing CommandGateway/P1
  generation-scoped CommandId and receipt-first contract. Ordinary SendMessage
  v1 remains unchanged; no External-origin route is added.
- P7 `02` owns the DeliverMessage request/result, canonical Deliverable
  ownership/direct-parent checks, MessageSent(v1) Deliver payload, Inbox
  summary, same-transaction Message/Event/Inbox/receipt, and MessageSent-only
  ChildDelivered wake source. P2 `03` confirms this is an existing
  NormalExecutionMutation fenced in the Gateway transaction; no fence class
  changes.
- P1 `07` owns the trusted action route and the narrow pre-Gateway
  DeliverMessage receipt-absent exact-proof exception. P9 `07` owns the
  immutable `DeliverReplayEscalated` fact/event, exact legacy/receipt mismatch
  priority, and RecoveryBlocked behavior. P10 `02`/`07` own the
  ActionRequired projection and qualification. The v1.37 migration statement
  is superseded by the accepted v1.38 storage correction below: Deliver fact
  and source-specific Attention marker are assigned to proposed migration
  0037 after P36 integration. MessageSent EventVersion remains 1 and the
  generic SendMessage receipt schema remains unchanged.
- Accepted proposal SHA-256:
  `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`.
  The user delegated governance authority; independent proposal review
  Blocking = 0. Acceptance record:
  `planning/results/AH10-deliver-generation-fence-governance.decision.md`.
  Owner landing hashes and self-consistency audit:
  `planning/results/AH10-deliver-generation-fence-design-landing.md`.
- Design acceptance/landing does not authorize runtime implementation. The
  strict Command/receipt unit seam, P9/P10 failure/rebuild behavior, and real
  two-daemon crash/restart matrix remain implementation qualifications before
  AH10 can close.

**Accepted owner addendum (DID v1.37 → v1.38): AH10 Deliver P10 source storage and migration order**

- Deliver replay failure remains a P9 immutable fact/event projected by P10 as
  `DeliverReplayFailure`; its visible fields, summary, target and
  `attentionFactId` identity are unchanged. P10 now owns a separate
  `deliver_replay_attention_rows` marker relation FK-bound to the P9 fact;
  AssignWork's existing source/failure/FK projection table and rows remain
  unchanged.
- The accepted/planned migration prefix is 0034 P10 Attention, 0035 F21,
  0036 AH7/P36, then proposed 0037 Deliver P9 fact + P10 marker. The integrated
  tree at the time of this v1.38 addendum ended at P35/user_version 35. In the
  current governance baseline, P36/P37/P38 owner contracts are integrated;
  real migration implementation/registration remains unintegrated. P37 is
  ordered after P36 and MUST NOT be implemented, installed or released
  independently; v35 upgrades must apply P36 before P37.
- P10's project/event consumer inserts the Deliver marker with its own P1
  event offset in one transaction. Its full rebuild atomically resets P10
  source rows, snapshots and seeds current P9 Deliver facts, and rewinds the
  P1 offset, then replays retained events. No MessageSent/Event v1, ordinary
  SendMessage, P1/P2/P7 behavior, F21 refusal semantics, or P36 contract
  changes.
- Accepted addendum SHA-256:
  `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`;
  separate acceptance record:
  `planning/results/AH10-deliver-p10-storage-addendum-governance-decision.md`.
  This is a design landing only; runtime implementation remains separately
  gated. Owner hashes are recorded in
  `planning/results/AH10-deliver-p10-storage-addendum-design-landing.md`.

**Accepted owner amendment (DID v1.38 → v1.39): EA-DG-01 Executable approval issuance/decision/resume**

- P4's new-write outcome for an approval-required Executable intent is the
  nonterminal `ApprovalRequired` handoff. Historical P4
  `Denied(ApprovalRequired)` rows remain terminal read/replay evidence and are
  never promoted into Pending approvals.
- P1/P6/P10/P12/P17 bind issuance, exact human decision, Inbox and same-
  Execution wake; P3 keeps the same Provider result, AgentLoopStep,
  LogicalActionId and ToolInvocationId. MAC `02`/index owns the shared
  ActionApproval lifecycle including `Cancelled`, while Control and
  Executable routes remain distinct.
- Migration 0038 is forward-only after unchanged 0032, integrated P36
  migration 0036 and AH10 Deliver migration 0037. It leaves all earlier
  migration bodies and checksums unchanged and preserves route-specific
  uniqueness and legacy binding provenance.
- Fixed proposal SHA-256:
  `E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
  accepted by `planning/results/EA-DG-01-governance-acceptance.md`.
  Owner hashes are recorded in
  `planning/results/EA-DG-01-contract-landing.result.md`.
- This acceptance and landing authorize design contracts only. Runtime,
  database migration execution, tests and release qualification remain gated.

**Accepted owner amendment (DID v1.39 → v1.40): AH7-DG-02 Reconcilable reality proof and P39 physical contract**

- Exact unrestricted `shell@3` is `NonIdempotent`; exact historical `shell@2`
  is preserved and is never reclassified. Only a constrained, version/hash-
  bound tool with stable effect identity, authoritative proof source, and
  stale-attempt finality may be `Reconcilable`.
- P4 owns the P39 immutable RecoveryBinding, effect-attempt ledger, append-only
  reconciliation facts and selected-fact terminal settlement. P3 owns trusted
  ProviderTurn/Step/LogicalAction/callRef identity and exact ToolResult,
  Observation/Action/cursor convergence. P9 owns the existing
  `ReconciliationEscalated` source; P10 owns its ActionRequired projection and
  rebuild within the accepted event-retention horizon.
- P39 is the forward-only `0039_ah7_reconciliation_attempts` schema contract.
  It follows owner contracts P36→P37→P38; those owner contracts are integrated
  in this design baseline, but their migration implementation/registration is
  not. P39 must not be implemented or released alone.
- A mandatory P39 migration preflight refuses affected active P36
  `NotAdmitted` databases before pending P37/P38/P39 DDL and writes an immutable
  operator report to an explicitly selected SQLite sidecar. The primary DB
  remains unchanged and that DB cohort remains isolated pending future
  governance. Windows/local-FS durability, actual Node SQLite VFS/OS/hardware
  qualification, network/unknown-filesystem refusal, and report recovery are
  release gates; design acceptance is not deployment qualification.
- Accepted logical proposal SHA-256:
  `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
  accepted physical supplement SHA-256:
  `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
  Acceptance/review and final owner hashes:
  `planning/results/AH7-DG-02-P39-design-landing.result.md`.
- This is an owner-contract landing only; it authorizes no production code,
  migration implementation, tests, real reconciliation claim, or Windows
  release.

**Accepted owner amendment (DID v1.40 → v1.41): AH7-DG-01 terminal Observation replay and P39 compatibility**

- P4 persists each new terminal Success/ExpectedFailure/Interrupted/
  OutcomeUnknown/RuntimeFailure settlement with the exact first-returned
  bounded `CanonicalToolObservation`, version, inline UTF-8 JSON bytes and
  SHA-256. The shared v1 envelope has a 16,384-byte cap and preserves first-
  write `text`/`truncated`, cause, ordered refs and Artifact identity. P4
  Artifact/raw result refs are not Observation storage.
- The accepted P39 compatibility addendum makes `ReconciledNoEffect` the sixth
  v1 evidence-bearing branch. Its P39 row remains `MayHaveStarted`,
  `settlement_provenance='Reconciliation'`, `recovery_binding_state='Bound'`,
  and retains the exact immutable same-invocation/same-attempt selected
  `NotOccurred` fact. P40 atomically adds the same versioned bounded
  Observation; it also verifies the settlement/reason/fact refs and separates
  the NULL P39 proof-fact `result_ref` from the non-NULL P4 ArtifactRef and P3
  payload hash. P39 proof/fact, selected fact and Artifact semantics are not
  mutated or aliased.
- DG03 `Denied/NotAdmitted` remains the no-effect exception with its closed
  `NoEffectDenialCode` and version-1 deterministic projection; all P40
  evidence fields and `result_ref` are NULL. It is not mapped to
  ExpectedFailure. CAPA approval consume and all `SideEffectSemantics` rules
  are unchanged.
- Before any P4 terminal evidence read, including a same-invocation CAS loser,
  P4 proves the full current unexpired Worker lease. A valid fence returns
  only the canonical P4 winner or blocks on missing/conflicting evidence;
  stale generation is ownership loss with no winner read/projection or
  replay-evidence Attention. P3 keeps the existing exact source formula and
  atomic ToolResult/Observation/Action/cursor projection.
- A P39-only database at `user_version=39` is maintenance-only: no Agent/P4
  Runtime startup or release until cumulative P40 migration reaches 40. P40
  follows the complete P36→P37→P38→P39→P40 prefix; the serialized cross-process
  migration runner, prefix integration, P39 sidecar/Windows durability and
  runtime/migration implementation remain qualification gates.
- Accepted hashes: DG01 logical
  `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`, P40
  physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`,
  P39/P40 compatibility addendum
  `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`, and
  matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.
  Acceptance is recorded in
  `planning/results/AH7-DG-01-P39-P40-compatibility-addendum-acceptance.record.md`.
- Owner-contract landing only: no production code, migration execution,
  qualification, release or AH7 phase closure is authorized.

**Accepted owner amendment (DID v1.41 → v1.42): AH10 Submitted DecisionEpisode binding failure / P41**

- For an exact non-legacy DecisionEpisode whose Submitted DecisionRequest
  Workspace or settled Provider result Manifest does not match the authoritative
  Execution/AgentLoopStep binding, P3 fails closed before new Provider/action/
  Command/Observation or ordinary settlement. P9 records one immutable
  `SubmittedDecisionBindingEscalated(v1)` fact/event and recovery returns
  `RecoveryBlocked`; P10 exposes one `ActionRequired` row at
  `executions.workspace_id`. No `Failed` settlement, source repair, replay,
  dismissal or new permission/Command is introduced.
- The existing authorized StopExecution is the sole v1 release path for the
  blocked active slot. Under the full current unexpired lease and only when the
  unresolved P4 side-effect gate is clear, Recovery/Application composition
  coordinates the P9 fact store and P3 StepStore in one TransactionScope.
  Stop-first atomically writes the fact/event and P3 early settlement using
  `TerminalRejected(StopRequestedAfterSubmittedBindingFailure)`,
  `SkippedEarlySettlement`, and
  `SettlementProposed(Interrupted(StopRequested))`. Fact-first remains blocked
  until Stop. P2 RecoveryController settles only the persisted proposal;
  Attention remains. P3 has no P9 implementation dependency.
- P9 recovery also audits already-settled `Failed` DecisionEpisode rows whose
  exact Step remains `ActionsInProgress` with a Pending
  `select_current_work` Action. It records audit-only Attention, using the
  specific still-provable binding mismatch or
  `SettledExecutionWithPendingDecisionAction`; it never resurrects or rewrites
  old Execution/Step/Action/Command/Work/receipt facts. Same-tuple duplicate
  fact writers serialize to one immutable fact/event.
- P10's source is included in `02`/`05`/`07`. P10 `04` owns full rebuild:
  source-marker reset, one consistent P9 fact snapshot/marker seed, and P1
  offset rewind to `floor - 1` commit in one `BEGIN IMMEDIATE`/
  `TransactionScope`. The P9 fact's event id and P10 marker have no FK to
  prunable `domain_events`; the marker is FK-bound to its P9 fact. Pruned-event
  rebuild, duplicate consumption, both crash boundaries and fact/rebuild
  concurrency are required qualifications.
- P41 / migration `0041` is strictly conditional on integration and required
  qualification of P36/0036 → P37/0037 → P38/0038 → P39/0039 → P40/0040 as one
  cumulative prefix. It cannot be registered, implemented, run or released
  independently, and cannot rewrite any 0036–0040 body/checksum/number. The
  target is DID v1.42 after the unified DID v1.41 P36–P40 landing. Only the
  accepted binding, Stop/fact, orphan-audit and P10 rebuild semantics change.
- Accepted fixed-proposal SHA-256 over LF bytes:
  `10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`.
  Governance acceptance/landing audit:
  `planning/results/AH10-submitted-decision-binding-P41-governance-acceptance-and-landing.md`.
  This is design-only; it does not authorize migration implementation,
  production changes, tests or runtime qualification.

**Accepted owner addendum (DID v1.42 → v1.43): AH10 DeliverReplay durable outbox and attempt-fair Attention poll**

- Accepted fixed package is v5 base SHA-256
  `5AAA2CD1FC00DFA729730E36FF13BAD7038496985D57500FD841B210E76F8B2F` plus
  v6 addendum SHA-256
  `8E6F47EF5933B6241B5E02E43821B6B816F705A9840AAA62FDFD318283004AF4`.
  Its independent review is Blocking=0 (Nonblocking=2); decision, review and
  owner hashes are recorded in
  `planning/results/AH10-deliver-event-pruning-v6-governance-acceptance-and-landing.md`.
- P9 `DeliverReplayEscalated(v1)` facts keep a unique durable event-ID audit
  identity without a permanent FK to prunable `domain_events`; P9 writes the
  fact/event/pending-outbox row atomically. P10 marker creation precedes
  queue ACK; P1 raw EventId looks up P9 before type/version/payload decode.
  Deliver source-integrity errors are typed fail-closed, with no ordinary
  poison DLQ or offset advancement. Ordinary non-Deliver poison behavior is
  unchanged.
- One P1/P9/P10 poll `BEGIN IMMEDIATE` owns current offset, raw event batch,
  P9 witnesses, classification, projection, outbox marker/ACK and offset
  update; pruning, P9 insertion and P10 rebuild serialize on the same SQLite
  writer boundary. A valid global dispatcher lease yields non-mutating
  `NoClaim`; persisted attempt-fair ordering and bounded retry backoff keep
  healthy due Projects progressing without promising completion for a
  repeatedly crashing Project.
- P12 adds a deployment-pinned DeliverReplay capacity artifact/assessor for
  same-window queue INSERT/ACK rates, backoff/fairness, preflight/full lock
  duration, SQLite/P9 writer waits and rebuild. Existing four-dimension
  `assessStorage`, Postgres trigger mapping and HealthPort readiness are
  unchanged. The two review Nonblockings are preserved in the decision record
  and are not expanded into new semantics by this landing.
- This is a design landing only. Migration 0037 implementation/registration,
  tests, deployment and P37/AH10 qualification remain separately gated after
  P36; no 0034–0036 migration body or checksum changes.

### FT-DG-02 current P10/P13 view contract

The current P10 view inventory includes the read-only `work-detail` view in
addition to the previously documented views. The current P13 frozen view
rendering count is ten. This current count supersedes nine-view counts in the
historical v1.13/v1.15 governance entries below; those entries remain history.
P10 `01`/`05`/`07` and P13 `00`/`03`/`06` own the exact inventory, DTO,
binding, rendering, and acceptance details.

**Governance changes (v1.30 → v1.31): Minimal Architecture Convergence**

- MAC-D1: `WorkPlan` is superseded as core Domain vocabulary by
  Runtime/Cognition-owned `LocalPlan`, still exact-bound to WorkId +
  WorkRevision and recoverable across Executions, with zero authority edges.
- MAC-D2: active new-write `SpecialistSpec/SpecialistSettled` semantics are
  superseded. Optional future subagent collaboration is a route of the common
  ActionCall protocol and child Execution; historical rows/aliases remain
  replay-only until MAC-P4 migration.
- MAC-D3: Model output exposes one ActionCall contract resolved through exact
  TurnProfile registration. Existing executable/control handlers remain
  route-specific implementations under a common authorization/approval
  facade.
- MAC-D4: exact executable/control approval records implement one
  `ActionApproval` semantic ADT. Physical tables may remain behind adapters
  until MAC-P4; no steady-state dual-write convergence is permitted.
- MAC-D5: `WorkspaceKnowledgeView` is a rebuildable projection of accepted and
  canonical sources. Existing `MemoryId`/unprovisioned KnowledgeQueryPort are
  not implementation evidence.
- MAC-D6: Root conversation work initiation is MAC-P1; placement/formation is
  MAC-P2; Dependency/Deliverable is hidden until MAC-P3 full closure; optional
  subagent collaboration is MAC-P4.
- MAC-D7: asynchronous consumers expose durable fulfillment separately from
  governance/decision and final result. Formation is the first required
  implementation.
- MAC-D8: Application/consumer/recovery signatures use narrow typed error
  unions and persist retry/block/attention outcomes; log-and-continue is not a
  semantic failure strategy.
- MAC-D9: active runtime compatibility branches move behind
  migration/archive/recovery adapters; new turns never advertise legacy
  names/vocabularies.
- MAC-D10: source-marker architecture tests are insufficient phase evidence;
  each MAC phase requires executable black-box, fault/restart and real-provider
  proof.

Accepted proposal SHA-256:
`44B549EA81E21B3D4BE5D545EA446B544D50CCA0061C83E6FC40CDC2ADCCA932`.
Implementation contracts under `docs/design/implementation/MAC/**` are FROZEN.
MAC-P1 implementation is authorized by
`ACCEPT_MINIMAL_ARCHITECTURE_CONVERGENCE`; MAC-P2…P4 remain phase-gated by the
accepted contract index.

**Governance changes (v1.27 → v1.28):**（Execution Episode / Goal / Plan，
EGP-1…EGP-10）

- `ExecutionFocus` and the Work/Coordination dichotomy are superseded for new
  writes by exact `ExecutionEpisodeBinding` variants: Work, ConversationResponse,
  Inbox and Decision.
- Work remains the long-lived Goal/lifecycle authority. An optional Plan is
  mutable progress state maintained through `update_plan`; it cannot perform
  tools, grant authority, claim completion, verify, accept or complete Work.
- Agent Runtime has one loop. Binding-specific Context and tool surfaces are
  resolved before a Turn; the loop does not branch on a Coordination mode.
- Conversation binds MessageId + ResponseJob revision; Work binds WorkId +
  WorkRevision; Inbox and Decision bind their own durable identifiers.
- Scheduler ambiguity becomes an exact WorkSelectionDecisionRequest and
  DecisionEpisode. Deterministic workflow consumers remain model-free.
- `CoordinationCompleted` and generic `QueryCompleted` are superseded by exact
  episode results. Binding/result mismatch is rejected mechanically.
- migration 0024 adds episode kind/ref/revision while retaining legacy focus
  columns as read-only migration evidence. Ambiguous active legacy
  Coordination fails closed; no text inference is permitted.
- new TurnProfiles are episode-derived. `WorkspaceCoordination` and
  `workspace-coordination-context-v1` are historical aliases only and cannot
  be materialized for a new ProviderTurn.

Accepted proposal SHA-256:
`66D64809ED103194417BCA29FB0165657AC884EA0A3E0FDC5E5468E03E821C69`.
Migration 0024 and implementation Waves A–E are authorized by
`ACCEPT_EXECUTION_EPISODE_GOAL_PLAN_CONVERGENCE`.

**Governance changes (v1.28 → v1.29):**（Root Conversation Action
Capability，CRAC-1…CRAC-5）

- `RootConversation` replaces the response-only profile. It remains bound to
  one exact ConversationResponseEpisode and uses the common Agent Loop.
- Its executable-tool surface is empty. Its v1 control-tool surface is the
  exact stable identity `core.control.propose-workspace` only.
- The output contract admits ordinary text or provider-neutral typed tool
  invocation. `decodeTurn` remains generic; ControlToolRegistry alone maps the
  invocation to `AgentAction.ProposeChildWorkspace`.
- The handler persists a Pending FormationProposal only. Human
  RecordDecision and the formation consumer retain approval and creation
  authority. Proposal persistence and `gov:<proposalId>:<revision>` human
  Inbox admission are one transaction; Governance entries are excluded from
  Agent Session input promotion.
- ProviderTurn/ControlResult history is re-injected only when its durable
  source identity belongs to the same conversation execution; unrelated Work
  timeline entries remain excluded.
- migration 0027 backfills the Governance Inbox for pre-CRAC Pending
  proposals; migration 0028 consumes stale actionable rows for already-settled
  proposals. Current proposal/Queue writes and decision consumption are
  atomic and replay-safe.

Accepted proposal SHA-256:
`DEBD13AAB34B7556B221F12B647360E945F95F5D89BD0B03287963DB22B917A8`.
Implementation is authorized by `ACCEPT_ROOT_CONVERSATION_ACTION_CAPABILITY`.

**Governance changes (v1.29 → v1.30):**（Control Action Permission &
Approval，CAPA-1…CAPA-7）

- PermissionGrant v2 binds subject, stable capability, target, validity window
  and revision. Migration revokes unbound legacy grants; no compatibility
  default grants authority.
- Agent Runtime projects generic AgentAction into one exact action digest and
  asks the ControlActionAuthorizer before any handler effect.
- The decision ADT is `Authorized | Denied | ApprovalRequired`. Denied becomes
  a typed model-visible ControlResult; ApprovalRequired leaves canonical state
  unchanged and releases only the lease.
- `control_action_approvals` persists exact Execution/action/target/
  ControlBasis/expiry and single-consumption state.
- ResolveControlApproval is human-actionable and consumes the exact Queue item.
  Approved and Rejected both wake the same active Execution; AgentLoopStep
  replays the settled ProviderTurn without a second inference for the action.
- Approval consumption follows the idempotent canonical handler attempt;
  command replay closes crash windows without duplicate mutation.
- Workspace policy owns `Deny | Ask | AllowWithinGrant`; default sensitive
  controls (`assign_work`, `spawn_specialist`) ask. Sandbox and ToolRuntime
  approval remain independent enforcement boundaries.

Accepted proposal SHA-256:
`74C0A20BCED0C7800B2EB21933967810AAB73423132D9FE06E86A7E56EA26FB9`.
Implementation is authorized by
`ACCEPT_CONTROL_ACTION_PERMISSION_APPROVAL_ARCHITECTURE`.

**Implementation closure record (2026-10-03):** migration 0025 removes
`executions.focus_kind/focus_work_id`; migration 0026 removes
`agent_execution_state.focus_json` and stores exact `episode_json`. The current
composition baseline is 26. Pre-0024 decoding remains compatibility-only;
current admission, Agent Runtime, Model Context and settlement production are
episode-derived and fail closed on `LegacyAmbiguousEpisode`.

**Governance changes (v1.21 → v1.22):**（Session / Context Runtime
Convergence，SCRC-1…SCRC-12）

- SCRC-1/2/12: Session becomes an append-only typed Timeline; active model
  context is a lossy projection. Canonical control state remains outside the
  Session and is freshly captured/reinjected.
- SCRC-3/4: `PortableInputItem` supersedes `PortableMessage` as the universal
  request carrier. ToolCall/ToolResult and ControlResult preserve stable
  `callRef`, status, ObservationRef and ArtifactRef.
- SCRC-5/6: Inbox input is delivered exactly once through source-key,
  transactionally convergent Session promotion. Steer and Queue use distinct
  safe-boundary semantics.
- SCRC-7: each sampling request captures one immutable `AgentStepContext`,
  persisted by reference/fingerprint in the Manifest; effect admission still
  fresh-checks authority and ControlBasis.
- SCRC-8/9: `NeedsCompaction` drives an explicit Compaction ProviderTurn inside
  the Agent Loop. Summary and binding-bound ProviderNative implementations
  atomically advance ContextEpoch and resume the same pending logical step.
- SCRC-10: budget evidence is layered: observed provider usage, model/provider
  estimator, adapter estimator, then conservative chars/4 fallback. One
  overflow-triggered compact/retry is allowed only before durable output/effect.
- SCRC-11: permission is never reconstructed from Session, summary, checkpoint
  or model text; parent-distributed capability and execution-time authority
  remain authoritative.

The accepted proposal is fixed by SHA-256
`200D9EE0F252915F1816C57FC5FEE470E77D7FB924A95A7474E03DF68BFAFD05`.
This landing freezes contracts only; migration 0019 and production
implementation require separate authorization.

**Governance changes (v1.22 → v1.23):**（OVS-1…OVS-7）

- A logical AgentLoopStep may own one bounded overflow ProviderTurn chain while
  retaining its `(executionId, logicalStepNo, repairAttempt)` identity.
- Chain roles are `Inference | OverflowCompaction | OverflowReplacement`;
  v1 admits only `overflowOrdinal = 0`.
- The original ContextLimitExceeded Turn remains immutable and terminal; the
  replacement uses a new ProviderTurn/Manifest after atomic checkpoint/epoch.
- Overflow ordinal is distinct from output-contract repairAttempt. Recovery is
  allowed only before durable assistant/tool/control output or external effect;
  a second overflow is terminal.

Accepted proposal SHA-256:
`09EE81EFAD5583585F7E8885E3647451C06F15F46F0CC40203158531A124E538`.
Migration 0020 and implementation are authorized within SCRC-007/008.

**Governance changes (v1.23 → v1.24):**（CDRC-1…CDRC-10）

- HumanMessage content/idempotency is separated from a new durable
  ConversationResponseJob state machine and append-only ConversationAttempt
  ledger. Legacy Pending/Claimed/attempt columns cease to be scheduling truth.
- Conversation Job states are Queued, Running, RetryScheduled,
  NeedsAttention, Answered and Cancelled; one Job owns at most one running
  attempt and one authoritative response.
- transport retry, model-output repair and conversation retry have distinct
  versioned budgets. Settlement is classified before the conversation policy
  chooses answer, durable delay, attention or cancellation.
- Session projection returns Ready or Blocked and admits only the maximal
  causally closed frontier. Adapter validation rejects dangling call pairs
  before sending Provider bytes.
- recoverable pause/reconciliation/approval/compaction resumes the same
  Attempt/Execution. A new attempt is permitted only after a terminal,
  explicitly retryable classification and durable eligibility decision.
- TurnProfileResolver replaces includeTools/includeControlTools and binds the
  exact purpose-eligible tool identities/output contract/context policy for one
  turn. Runtime authority/freshness checks remain mandatory.
- durable failure fingerprints, deterministic backoff, explicit Resume/Cancel
  commands and a ResolvedModelBinding-scoped deployment breaker close request
  storms across both one message and many messages.

Accepted proposal SHA-256:
`66FF684CFD71A76C20A6FA32B30C1413BED85F34A694DE06301B122366C121B2`.
P17 implementation contracts under
`docs/design/implementation/P17-conversation-delivery-runtime/**` are FROZEN;
implementation and migration 0021 are AUTHORIZED by the accepted governance
token `ACCEPT_CONVERSATION_DELIVERY_RUNTIME_CONVERGENCE`.

**Governance changes (v1.24 → v1.25):**（Execution Workspace Binding，
EWB-1…EWB-10）

- A filesystem `ResourceAddress` remains an environment/authority identity and
  is never interpreted as a sandbox-relative tool path.
- Every executable turn has a deterministic logical mount namespace. The
  primary admitted filesystem resource is exposed as mount `workspace`; the
  binding retains the source address, canonical region, access mode and the
  captured ResourceBoundary/Environment basis.
- Model-facing filesystem tools address `{ mount, path }`. `path` is a
  normalized workspace-relative path; host absolute paths and `..` escape are
  invalid. The model never supplies a host path as authority evidence.
- Sandbox adapters own source-resource → execution-path materialization. Tool
  Runtime resolves a target through the opened mount; executors never strip a
  host prefix or reconstruct a mount.
- Existing-target resolution performs lexical and realpath confinement.
  New-file resolution additionally confines the nearest existing ancestor, so
  symlink/junction escape remains impossible.
- The primary writable coding resource is a managed GitWorktree. Local trusted
  execution may bind it directly; hardened providers mount it into an isolated
  `/workspace`-like root. Provider choice cannot change tool semantics.
- `read/list/patch/shell` version 2 consume logical targets. `patch@2` supports
  idempotent file creation as well as existing-file update. Version 1 remains
  auditable but is not model-visible for new turns and is never reinterpreted.
- Ordinary invalid/missing/unmapped filesystem targets are terminal
  `ExpectedFailure` observations. Genuine executor/process defects and
  ambiguous effects remain in the P9 crash/reconciliation protocol.
- Tool identity is resolved from the exact model-visible catalog/profile; the
  executable handler must not hard-code a version.
- A mount binding is reconstructed only when its captured boundary/environment
  basis is still fresh. Drift fails closed; permission and ownership are always
  rechecked before effect admission.

Manual governance accepted the mount-relative design and implementation on
2026-10-02 by the instruction `执行`, following the complete design explanation
in the governing thread. This authorizes the owning-contract landing and the
EWB implementation. `DOGFOOD-DG-03` closes only after mechanical tests and the
isolated release-validation Work prove the path.

**Governance changes (v1.25 → v1.26):**（Verification Delivery Convergence，
VDC-1…VDC-8）

- `Completed(CompletionClaimed)` emits the exact top-level
  `{ executionId, workId, workRevision, claimRef, settlement }` trigger. Old
  nested events reconcile from the durable Execution Work binding; consumer
  offsets are never reset to repair historical delivery.
- Evidence kind `ToolObservation` is identified by the durable pair
  `(ToolInvocationId, ToolResult.observationRef)`, plus its exact
  `(executionId, callRef)` binding. A model selects evidence meaning but never
  authors source identity.
- Normal Verifier conclusions carry model-authored summary content. Runtime
  persists the bytes through BlobStore and produces `summaryRef`; the
  concluded Verification and `VerificationConcluded` event durably retain that
  ref. `Unknown(Orphaned)` summary content is authored by the authorized human:
  Root-local governance for Root Work or the exact Parent Workspace human for
  child Work, under the accepted P8 `RetryVerification` contract.
- A child `initialWork`, when present, carries a complete explicit
  VerificationMission in its Parent-approved proposal. Runtime does not
  synthesize a placeholder mission from objective text. A proposal without an
  initialWork remains valid.
- Model-facing `AssignWork` binds `predecessorWorkId` from the current parent
  Work execution when one exists (otherwise null); the model supplies the
  human-readable `reason`. Runtime validates the target Workspace and parent
  authority before command submission.
- A producer CompletionClaim registers a `VerificationChanged(workId, revision)`
  wait. Verification conclusion releases it; a producer Work is not re-run
  while its claim awaits verification.
- StartVerification and deterministic verifier spawn are production-wired;
  crash/replay reuses the preallocated Verification and verifier Execution ids.
- Verification Pass remains distinct from Parent Acceptance and Work
  completion. CompleteWork revalidates the exact Work/Verification/Acceptance
  revision triple.

Manual governance accepted VDC-1…VDC-8 by the user instruction `完成这些` on
2026-10-02. The current dogfood Work is the live qualification path.

**Governance changes (v1.26 → v1.27):**（Verifier Execution Settlement，
VES-1…VES-6）

- `CompletedResult` gains
  `VerificationConcluded { verificationId, verdict }`, used only by an
  exact-bound Verifier Execution after its canonical conclusion command has
  committed.
- This Execution result is not the Verification aggregate/event, not Parent
  Acceptance and not Work completion.
- The model-facing conclusion action performs summary Blob persistence and
  byte verification, commits `ConcludeVerification`, delivers the idempotent
  Verification wake, and only then proposes the Completed settlement.
- Blob-before-command may leave an orphan Blob. Command-before-wake and
  wake-before-settlement crash windows replay the same command receipt and
  idempotent wake before settling the same durable Execution.
- `ExecutionSettled(VerificationConcluded)` is not a CompletionClaim trigger;
  Verification Consumer must ignore it.
- A verifier that settles without a committed conclusion remains an orphan
  candidate exactly as before. Concluded Verifications are outside the orphan
  scan; historical Failed/Interrupted verifier Executions are immutable.

Manual governance accepted the fixed proposal by token
`ACCEPT_VERIFIER_EXECUTION_SETTLEMENT` on 2026-10-02. Accepted proposal
SHA-256:
`1D66E7A53134FE2494EA9077DA36D361CEA2B1C8ED1996321C521108460E88BD`.
Implementation is authorized within this exact scope.

**Governance changes (v1.3 → v1.4):**

- DG-01: `Dependency` producer expressed as `ProducerBinding` ADT; an undefined producer-binding term was removed.
- DG-02: `ExpectedDeliverable` + deterministic matcher frozen; `Deliverable` gains `kind` and role-tagged artifacts.
- DG-03: explicit `projectPolicyRevision` / `workspacePolicyRevision` distinct from aggregate `revision`.
- DG-04: `PermissionGrantId` prefix `pgr_` added to Appendix A.
- DG-05: `AgentBinding` split into `ResponsibilityBoundAgentBinding` / `ExecutionBoundAgentBinding`; Workspace constrained.
- DG-06: canonical architecture-test location `tests/architecture/**`.

**Governance changes (v1.4 → v1.5):**

- P1-DG-01: parameterized `CommandResolution<Result, Rejection>`; Application-owned `CommandRejection = DomainError | FencingRejected | ExecutionStopping` (§6A.15).
- P1-DG-02: single-transaction command resolution; `commands.resolution = Committed | TerminalRejected` only; `CommandAttempt` is a non-authoritative operational trace (§9.9).
- P1-DG-03: idempotency identity unified on `semantic_request_fingerprint` + `schema_version` + `fingerprint_algorithm_version`; concrete algorithm is a P1 phase contract (§4.1, §9.9).
- P1-DG-04: authoritative fence validation separated from stop/quiescence admission; `FencingRejected` is only for invalid ownership/fence; stop admission returns Application `ExecutionStopping` (§9.7, §11).
- P1-DG-05: `CreateProject` single-transaction bootstrap contract; no Session Domain Event (§4.1, §12.11).
- P1-DG-10: `TransactionPort` / `CommandStore` / `DomainEventJournal` classified as Persistence ports (Appendix B aligned to §7.2).

**Governance changes (v1.5 → v1.6):**

- D1: §0A.1 `AssignWork` signature marked illustrative; `CommandRejection` gains `WorkspaceNotFound`; the normative `AssignWork` rejection set is frozen in §6A.15.
- D2: §6A.15 notes the P0 `CommandResolution<R>` artifact is superseded by the parameterized form; P1 owns the evolution.
- D3: resource-region physical encoding assigned to the P1 phase contract (overlap semantics stay in the domain function).
- D4: `CreateChildWorkspace` ownership moved to P1 (§11).
- D5: Appendix C version reconciled to v1.6.
- D6: P1 phase-contract location `docs/design/implementation/P1/**` added to §13.

**Governance changes (v1.6 → v1.7):**

- G1: internal runtime commands are **not** exempt from authority; P2 introduces Application-level
  trusted, **command-specific** `VerifiedRuntimeCommandAuthority` variants for `AdmitExecution` /
  `StopExecution` / `SettleExecution`, exact-binding `commandId`, `semanticRequestFingerprint`,
  `projectId`, command kind, target and submission origin. `ExecutionOrigin` settlement must pass
  authoritative fencing; `RecoveryController` settlement uses recovery authority. Execution-originated
  mutations are split into `NormalExecutionMutation` vs `QuiescenceControlMutation` (`SettleExecution`
  on the `ExecutionOrigin` path is a quiescence-control mutation, admissible after `stopRequestedAt != null`)
  (§4.1, §3.4, §9.7, §12.3, §12.10).
- G2: `RecordEnvironmentChange` ownership moves to **P11**; P2 only consumes environment
  revision/change facts (§4.3, §11, §12.10).
- G3: **P2** owns `ExecutionScheduler`, durable `WorkWait` registration/clear, timer/wake mechanics and
  lost-wake-up protection; **P7** owns full Work runnability/dependency reevaluation. Source phases
  (Dependency / Inbox / Verification / Environment / …) own wake-signal production; P2 owns the durable
  wait and generic wake/timer machinery (§8.16, §8.18A, §11).
- G4: **P2** freezes a minimal `ExecutionDriverPort` + `Fake Driver` and owns execution-wide Runtime
  Safety / control gating; **P3** provides the real Agent loop and must report activity to the P2-owned
  gate at each new ProviderTurn / ToolInvocation / Specialist action boundary and obtain a
  continue/stop decision (exact Port shape is a P2 contract) (§7.2, §8.16A, §10.6, §11, Appendix B).
- G5: `AdmitExecution` supports `WorkspaceMain` and `ExecutionBound`; `ExecutionBound` admission
  atomically creates Execution + `ExecutionScoped` Session; all IDs are caller-preallocated. P2 owns
  generic `ExecutionBound` admission; higher-level feature phases own spawn semantics (e.g. P6
  delegation, P8 Execution-bound Verifier). P2 adds no specialist concurrency limit
  (§3.4, §1.7, §9.6, §11).

**Governance changes (v1.7 → v1.8):**

- G1: tool-invocation authority is **not** resolved by P4. The Authority Resolver
  (PermissionGrant / Parent / User governance) stays deferred; P4 receives a
  trusted `InvocationAuthority` fact and performs deterministic exact-match plus
  capability-ceiling checks only (§7.6, §6A.7, §11).
- G2: **Exact-Intent Approval** is a P4-owned record/port with atomic
  single-consumption semantics; producing an approval remains the deferred
  resolver's job (§7.6, §11).
- G3: **P4** owns `SandboxPort` + a minimal local executor; **P11** owns
  worktree/resource isolation and advanced sandboxing (§11).
- G4: tool **Resource Admission is validate-only** (`ResourceOwnership ⊆
  ResourceBoundary`); ownership changes remain governance Commands
  (application-owned `UpdateResourceBoundary`) (§7.6, §1.5, §11).
- G5: the minimal `read` / `patch` / `shell` tools are **versioned P4 contract
  artifacts** with eval; P11 owns environment/git-specific behavior (§11).
- G6: exact tool parameter/result schemas and the shell policy enforcement
  mechanism are **phase-scoped contract** (P4), not implementation choice; only
  backend/limits/numeric thresholds are implementation/empirical (§13).

**Governance changes (v1.13 → v1.14):**（P12 design-closure 治理裁决 GQ1–GQ8）

- G1 (GQ1): **Plugin SDK / SPI 归 P12**。P12 owns `PluginId` / `PluginVersion` /
  `PluginSdkApiVersion` 与对外 compatibility policy（versioned SPI、deprecation、
  breaking-change 规则）。Project / 第三方 tool 采用 **explicit registration** +
  content/version-bound trust；**project-local 不自动可信**（注册是治理事实，
  capability ceiling / sandbox / ResourceBoundary 语义不变）。
- G2 (GQ2): **Authority Resolver production plane 归 P12**。Authority Resolver 是
  **pure / deterministic authority-decision 边界**，只**产出**既有 exact-bound trusted
  authority facts（`VerifiedCommandAuthority` / `VerifiedRuntimeCommandAuthority` /
  `InvocationAuthority`）。它 **MUST NOT**：invoke `CommandGateway`、mutate canonical
  state、consume `InvocationApproval`、或 execute tools；canonical mutation 仍只经
  `CommandGateway`。同步修 `SecretStorePort`：opaque `SecretRef` / `SecretMaterial`、
  typed failures、P12 adapter；明文 secret 禁止进入 prompt / session / event / log /
  artifact。
- G3 (GQ3): **§7.6 为权威**。`ToolCatalogPort` 必须能 resolve **model-facing
  `ToolDefinition`**（真实 description / schema / version）；P3/P4 的 refs-only 收窄与
  model-context compiler 占位符是 inherited defect，随 P12 修复；同时保持
  model-context 不依赖 tool-runtime implementation。
- G4 (GQ4): **operational Observability / Health / Usage plane 归 P12**。Metrics / logs /
  traces / health projections 是 **derived operational state**，**MUST NOT** 成为
  canonical Execution / ProviderTurn / ToolInvocation / Command / DomainEventJournal 事实的
  权威替代。Usage 必须从真实事实（ProviderAttempt / ToolInvocation / Execution）派生；
  **unknown cost 必须保持 Unknown / None，永不表示为 `0`**；pricing 必须 versioned。
- G5 (GQ5): **SQLite 保持默认**。P12 必须产出 `StorageScaleAssessment`；只有无法满足
  declared operating envelope 才实现 PostgreSQL。P12 owns `DurabilityEnvelope` /
  backup-restore / RPO-RTO / restore drill；P9 仍 owns runtime fault hardening。
- G6 (GQ6): **Remote Worker 受支持，但 canonical control plane 保持 single-writer**。
  remote worker 禁止直连/直写 canonical DB，只经 authenticated versioned transport 调
  control plane。新增 `WorkerId` + `WorkerIncarnationId`；**不引入 distributed
  consensus / multi-writer control plane**。语义澄清：**"Worker-originated durable
  write"** 指由 **authenticated worker 请求**、由 **control plane 通过权威
  Application/Runtime ports 提交**的 mutation；**不**意味着 worker 进程拥有或直接使用
  canonical DB connection。Remote Worker **MUST NOT** 直接写 canonical SQLite /
  PostgreSQL state。
- G7 (GQ7): **P12 必须补齐 §8.16A 已冻结的全部六维 Runtime Safety**；数值阈值可配置。
  P2 不 reopen，P12 做 cross-phase closure。**P12 不得关闭，直到每个 §8.16A 维度都
  mechanically evidenced**：`observation source` / `state semantics` / `reset semantics` /
  `evaluation rule` / `configurable threshold / policy` / `violation action` /
  `restart / durability behavior` / `tests`。
- G8 (GQ8): **不创建空壳 `verification-runtime`**；修正 §10.1 / §10.4.1 physical
  package catalog。Verification 继续由 `domain` / `application` + generic
  `ExecutionBound` runtime 实现。

**P12 completion blockers（v1.14，关闭前必须保持显式）**：

```text
1. region-encoding correctness fix
2. ToolCatalogPort inherited contract correction
3. full §8.16A Runtime Safety closure
4. Authority Resolver production plane
5. SecretStorePort / SecretRef + real adapter
6. observability / health / usage plane
7. StorageScaleAssessment + DurabilityEnvelope
8. Remote Worker transport / identity boundary
9. Plugin SDK / compatibility / trust model
```

**P12 phase state（v1.14）**：

```text
P12 design closure COMPLETE
P12 planning COMPLETE
P12 implementation COMPLETE; P12 FORMALLY CLOSED
```

**Governance changes (v1.15 → v1.16):**（P14 design-closure 治理裁决 GQ-A–F）

- G-A: **新增 `SubmitHumanMessage` human-facing Application Command**
  （Authenticated Human → Root Workspace；payload {messageId,
  targetWorkspaceId, bodyRef}；principal 来自 authenticated External
  context，payload 不自报 sender；caller-preallocated id；durable/
  idempotent；不修改 Work；无 Steer 语义）。**不扩展 `SendMessage` origin**
  ——`SendMessage` 保持 P6 冻结的 Workspace→Workspace 通信（sender 由
  authority fact 绑定，Query/Reply/Report/DecisionRequest/Deliver 的
  parent/ancestor/correlation 规则不受污染）。配套新增独立事件
  **`HumanMessageSubmitted`**（不硬套 `MessageSent`——其 payload 语义是
  workspace sender，硬套 human 会伪造 senderWorkspaceId）。
  **Recorded supersession (TR-A)**：P6 冻结的 `InboxEntry`/`InboxArrival`
  kind 封闭集扩展 `HumanConversation`（P14 拥有；语义 = chat 对话轮，
  ≠ `HumanInput` steer 专属）；api-contracts `InboxEntryKind` 随扩；
  P6 其余语义不 reopen。
  **Recorded supersession (TR-B)**：P13 `02` §2 Human-actionable 集合
  7 → 8（+`SubmitHumanMessage`）；P13 `06` EC-6 与 Web v1 §9 不变量 2 的
  "七"随本 TR 更新；EC-8 语义核心（`SendMessage` 永不进 chat 面）重申不变
  （矩阵演进机制即 P13 `02` U-2）。
- G-B: **对话轮执行复用既有 `WorkspaceMain + ExecutionFocus=Coordination`
  语义**（Domain 已冻结 `ExecutionFocus = Work | Coordination` 与
  `Completed(QueryCompleted)`）：SubmitHumanMessage → durable human
  message + Root Inbox → deterministic conversation trigger →
  scheduler/Application admission → `AdmitExecution(WorkspaceMain,
  focus=Coordination)` → 既有 P2/P3/agent/provider 链 →
  `SettleExecution(Completed(QueryCompleted))` → transcript projection。
  **不发明 conversational/synthetic Work**。**浏览器不得为聊天直连
  external `AdmitExecution`**（P13 `02` U-3 的 UI 面不推翻；P14 关闭的是
  server-side conversation admission wiring）。one-active-main 下 human
  message durable pending、不开第二 main、不打断、settle 后串行调度；
  立即干预仍走冻结的 SteerWork/StopExecution——chat 无 interrupt 语义。
- G-C: **transcript read model 升级**（呈现 Human turn：messageId/
  bounded body/occurredAt；Assistant turn：executionId 关联/bounded body/
  occurredAt）。WS→invalidate、`/views` 权威；v1 无 provider token
  streaming、无 message 专用流式 transport、浏览器不拼 delta。
- G-D: **对话权限 root-workspace-only**：Authenticated Human ↔ Root
  Workspace；child = read-only transcript + SteerWork；不得绕开
  Responsibility Tree / parent coordination。
- G-E: **对话轮 = bounded execution**：1 accepted HumanMessage → 1
  bounded Coordination Execution → 1 user-visible response episode
  （execution 内可多 ProviderTurn/ToolInvocation）；跨轮连续性 =
  same Root Workspace + same WorkspacePrimary Session + different
  executions（Session = cognition continuity；Execution = bounded
  episode）。phase contract 冻结 pending 消费/claim 顺序、crash/replay
  exact-once logical response、message↔execution↔response correlation、
  one-active-main 排队。
- G-F: **UI 落位**：Root Workspace 对话 tab（transcript + composer）+
  Overview "与 Arbor 对话" deep-link（
  `/p/:projectId/workspace/:rootWorkspaceId/conversation`）；child 保持
  read-only；不建 `/chat` 独立产品域。

**Governance changes (v1.16 → v1.17):**（D-1 Product UI Contract Closure，TR-WPU-A–D）

- **TR-WPU-A — presentation-only supersession:** P13 的 `paper/leaf/serif` 全局
  视觉和 3px shape 限制由 Web Product UI design system 取代：modern minimal
  light、white/warm-neutral surfaces、Arbor Green 主品牌强调、sans UI/body、mono
  仅 technical metadata、serif 仅限可选品牌/展示、新 spacing/radius/density；参考图的
  蓝色不构成品牌主色要求。保留 named-token discipline、semantic status colors、无 dark
  mode/新 icon library 的约束。**不改** API、command/event、auth、WS invalidation、
  server SSoT、authority 或任何 P13/P14 backend boundary。
- **TR-WPU-B — responsibility hierarchy read carrier:** `TreeViewNode` additive
  carries `parentWorkspaceId: WorkspaceId | null` from canonical
  `Workspace.parentWorkspaceId`; no `depth` field is added. Projection must mechanically
  reject zero/multiple root, dangling parent, or cycle before traversal; it preserves
  root-first deterministic preorder. Browser uses only the server edge and must not infer or
  repair a parent. This does not alter canonical hierarchy semantics or mutations.
- **TR-WPU-C — Work revision carrier:** `CurrentWorkSummary.revision: WorkRevision`
  is copied exactly from canonical `Work.revision` in current-work, workspace-detail and Tree
  current-work projections. A present Tree `currentWork` includes frozen `status` and
  `revision`; absent work omits `currentWork` at the wire boundary (no null/dummy shape).
  Future SteerWork affordances bind only `expectedWorkRevision = server supplied revision`;
  they never fall back to `0` or maintain a UI revision.
- **TR-WPU-D — Verification frozen-target carrier and Workbench IA:** selected
  `VerificationView` pairs its `verificationId` with server-projected
  `targetWorkRevision: WorkRevision`, copied from the frozen canonical Verification identity.
  Any future AcceptWorkOutcome affordance requires exact equality of selected work ID,
  verification ID and target revision; no mutation semantics change. The canonical project
  landing is `/p/:projectId` Root Workbench (Tree + Root Conversation);
  `/p/:projectId/tree` remains Tree Focus and
  `/p/:projectId/workspace/:rootWorkspaceId/conversation` remains the root deep-link mirror.
  No `/chat` or `/workbench` route, and root-only composer/child read-only rules remain.

This is an additive read-model/presentation adoption, **not** a reopened P13/P14 backend phase:
no command semantics, event semantics, DDL, authority, transport protocol, System Design, or
G2–G5 product-domain gap is changed.

**Governance changes (v1.20 → v1.21):** (Agent Loop terminology and
implementation authorization, 2026-09-30)

- **ALS-N1 — terminology-only successor.** The durable per-iteration record
  called `AgentTurn` in the immutable reviewed proposal and v1.20 decision is
  renamed **`AgentLoopStep`** in current contracts and implementation. The
  overall runtime algorithm/component remains `AgentLoop`; `ProviderTurn`
  remains one logical model decision; `ProviderAttempt` remains one transport
  attempt. This removes the collision between conversation/model/runtime uses
  of “turn” without changing AHT-1…AHT-8 semantics, state transitions, DDL or
  acceptance obligations.
- **ALS-I1 — implementation authorized.** The user explicitly authorized
  execution after accepting the `AgentLoopStep` name. Authorized scope:
  migration `0017_agent_loop_step_handoff`, ports/stores, atomic Provider
  success, idempotent sourced Session writes, AgentLoop integration, legacy
  adoption, recovery and AH1–AH14 tests. The preserved dogfood database remains
  read-only until the equivalent fixture and migration verification pass; this
  authorization does not permit speculative direct repair.
- **ALS-I2 — migration executability correction.** Migration 0017 enforces the
  sourced-Session all-null/all-present invariant by transactionally rebuilding
  `session_entries` with a table `CHECK`, rather than `CREATE TRIGGER` bodies
  that the existing semicolon-splitting migration runner cannot parse. The
  unique source index and observable invariant are unchanged; this is a
  mechanism correction proven by the first red migration test.

**Governance changes (v1.19 → v1.20):** (Provider Result Handoff / Durable
AgentLoopStep Adoption; decision record:
`planning/proposals/provider-result-handoff-governance-decision.md`)

- **AHT-1 — durable handoff replaces process-local progress.** Add a persisted
  `AgentLoopStepRecord`, keyed by `(executionId, logicalStepNo, repairAttempt)`,
  between Provider result settlement and Session/action/Execution settlement.
  Provider Runtime still owns Provider calls; Agent Runtime owns result
  consumption and action progression; Execution Runtime owns lease/fencing and
  canonical settlement. Lease loss stops a writer but never erases business
  progress (`P3 08`).
- **AHT-2 — complete Provider success converges locally.** A complete successful
  canonical event sequence is a replayable durable result. New success writes
  atomically settle ProviderAttempt + ProviderTurn. Legacy complete success
  evidence is locally completed before P9 retry eligibility; the same
  ProviderTurn is never requested again (`P3 08` §5, `P9 07` §2).
- **AHT-3 — Session and action handoff are idempotent.** Session entries gain a
  stable source key/content hash. ModelOutput append and
  `ProviderResultAvailable → OutputAccepted` share a fenced transaction.
  `AgentLoopStepActionRecord` persists only logical identity/disposition/result
  references; it does **not** persist the v1.18 process-local `AgentAction` ADT
  (`P2 02`/`04`, `P3 08` §§6–7).
- **AHT-4 — logical Agent identity is distinct from Application Command
  identity.** `LogicalActionId`/`LogicalSettlementId` identify Agent semantics.
  Each lease generation submits a distinct deterministic `CommandId`; that
  Command remains immutable and terminal under the existing P1 rules. A later
  owner may create a new generation-scoped Command only after querying the
  logical ledger and existing receipts (`P1 07`).
- **AHT-5 — unresolved side effects are a hard gate.** An action in
  `ReconciliationPending` cannot reach `StepEffectsCommitted`, a next model
  turn, or ordinary Completed/Interrupted/Failed. It may only reconcile,
  produce durable Attention, or use the existing
  `OutcomeUnknown(ReconciliationRequired)` exit (`P3 08` §7).
- **AHT-6 — successor identity is committed before handoff.** Repair and normal
  next-turn predecessors persist exactly one complete successor identity.
  Recovery uses idempotent `ensureSuccessor`; it never recomputes the decision,
  consumes budget twice, or creates a second ProviderTurn (`P3 08` §8).
- **AHT-7 — legacy adoption is evidence-gated.** Migration `0017_agent_loop_step_handoff`
  may synthesize AgentLoopStep only from unique, consistent evidence. The
  DOGFOOD-DG-01 equivalent no-action fixture is authorized to adopt at
  `ProviderResultAvailable`; ambiguous repair/action/effect evidence produces
  durable Attention and no replay (`P9 07` §3).
- **AHT-8 — authorization boundary.** v1.20 authorizes design-contract landing
  only. It does not authorize migration execution, recovery implementation,
  mutation of the preserved failure database, or automatic closure of
  DOGFOOD-DG-01 before owning-contract landing and consistency audit. Those
  design steps now resolve the design question; implementation remains gated.

**Governance changes (v1.18 → v1.19):** (Agent Control Implementation
Authorization — D9 of the `52-migration-and-implementation-dag.md` sequencing)

- **ACR-6 — flip the three v1.18 implementation holds to AUTHORIZED.**
  Appendix C `Agent control implementation authorization`, `S01 qualification
  authorization`, and `Wave 2 implementation authorization` become
  AUTHORIZED. Architecture rulings ACR-1…ACR-5 are unchanged: `AgentAction`
  remains an internal transient ADT (never a wire/output contract, never
  persisted), `decodeTurn` stays narrow, and `ControlToolRegistry` remains
  the agent-runtime-owned control identity/codec/route boundary.
- **Authorization evidence (D1–D8 readiness).** D1 internal action contract
  and D3 registry boundary contracts exist (`49-internal-agent-action-contract.md`,
  `50-control-tool-runtime-boundary.md`, `51-agent-control-module-map.md`);
  D4/D5 route integration is proven live by the I0 skeleton (Wait and
  SendMessage control routes through the adopted boundary) and by the L3
  real-provider capability baselines of 2026-09-28 (DeepSeek deepseek-flash:
  executable tool route selects, executes, and settles durably; control
  route reaches a durable Wait; basic conversation and multi-root memory
  pass the three-run stability oracle). D8 (S01 qualification design) is
  adopted as the redefined Control/Executable Route Qualification below.
- **ACR-7 — S01 is Control/Executable Route Qualification.** S01 is no
  longer "make a model emit a valid canonical AgentDirective." The
  qualification face is the five-element definition in
  `52-migration-and-implementation-dag.md` §S01 redefinition (executable
  route, control route, failure route, audit route, no-directive
  compatibility), carried mechanically by the L3 capability suites
  (`tests/capability/real-provider/**` + `scripts/testing/run-capability.mjs`
  three-run stability oracle). Qualification must never use the legacy
  universal `arbor_directive` representation as a pass condition.
- **ACR-8 — historical field-source gating (superseded by v1.26).**
  At the v1.19 checkpoint the four downstream mappings
  (AssignWork.Provenance; ToolObservation identity G-V2-2;
  ConcludeVerification.summaryRef G-V2-3; initialWork VerificationMission
  G-V2-4) gated only their consuming paths. The manually accepted v1.26
  VDC-1…VDC-8 contract above subsequently CLOSED all four mappings and
  supersedes this checkpoint status. B10 is no longer
  `BLOCKED_BY_DESIGN_GAP`; repeatable L3 qualification is authorized.
- **Wave 2 scope.** Wave 2 is the module map of
  `51-agent-control-module-map.md` sequenced by the dependency DAG of
  `52-migration-and-implementation-dag.md`; it adds no new package or
  dependency edge (v1.18 §10.4.1 unchanged).

**Governance changes (v1.17 → v1.18):** (Agent Control Representation Adoption)

- **ACR-1 — supersede the universal AgentDirective wire/output contract.**
  The requirement that every model turn decode into the versioned canonical
  `AgentDirective` union is superseded. `agent-directive-v1` and the proposed
  `agent-directive-v2` are not the universal model-facing control contract.
  Per-tool model-facing schemas remain distinct from Arbor's internal control
  semantics.
- **ACR-2 — freeze the two invocation routes.**
  Model-facing tool calls decode to provider-neutral typed invocations.
  Executable invocations route to the existing P4 `ToolRuntime`.
  Control-tool invocations route through the Agent Runtime
  `ControlToolRegistry`, which validates the registered model-facing control
  representation and constructs an internal `AgentAction`; shared
  Agent Runtime policy then routes the action to its owning Application
  command/settlement boundary.
- **ACR-3 — bound `AgentAction`.**
  `AgentAction` is an in-process typed ADT for control routing only. It is not a
  provider/model schema, Output Contract, canonical wire value, Domain Event,
  Application Command DTO, or persisted record. Trusted identity, authority,
  execution bindings, revisions, and other Runtime facts are supplied by the
  trusted invocation context and owning Application boundary, never by the
  model-authored action payload.
- **ACR-4 — narrow `decodeTurn`.**
  `decodeTurn` translates normalized provider events into ModelOutput content
  and provider-neutral typed invocations, preserving provider-call correlation
  and rejecting malformed/incomplete event assembly. It does not classify a
  call as an Arbor control action, decode control semantics, construct
  `AgentAction`, or produce a universal `AgentDirective`.
- **ACR-5 — retain historical records; do not authorize implementation.**
  The existing `agent-directive-v1`/v2 proposals and review documents remain
  unchanged as evolution records. Old persisted output-contract references and
  action-kind summaries remain historical metadata; this ruling requires no
  payload migration. This governance adoption does **not** authorize Control
  Tool schemas/registry implementation, S01 qualification, or Wave 2 work.

**Supersession register:**

| Former source | v1.18 disposition |
|---|---|
| v1.17 §7.6: `AgentDirective` is the control-command bridge and `InvokeTool` is the P3→P4 representation | Superseded only as the model/runtime representation. Application commands, P4 `ToolRuntime`, authority, admission, persistence, and effect semantics remain. |
| v1.17 §8.15: one universal `AgentDirective` union lists every model control action | Superseded. Tool Surface carries per-tool definitions; independent bounded Output Contracts remain. Phase action meanings are unchanged. |
| v1.17 §8.3: Output Contract is a Model Context surface | The surface remains. Its scope is clarified: independent bounded structured output protocols only; per-tool control schemas belong to Tool Surface. |
| v1.17 §8.19: every effectful `AgentDirective` payload carries `decisionBasisManifestId` | Superseded. Manifest/ControlBasis association is trusted Runtime context; it is not model-authored payload or a field on `AgentAction`. |
| v1.17 §§10.6/11/15 and Appendix B: AgentRuntime decodes and dispatches `AgentDirective` | Superseded only for the decode/dispatch bridge. Generic `ToolInvocation` routing, P2 control ownership, P3 loop behavior, safety/freshness, and existing Application/settlement semantics remain under ACR-2–ACR-4. |
| P3 `01` §3, `02` §6, `03` §§2–4, `06` §4: universal directive decoding and `decisionBasisManifestId` payload binding | Superseded as identified in the P3 index. Provider, Model Context, loop, safety, repair, freshness, and settlement contracts remain otherwise in force. |
| P4 `00-contract-index.md`: `AgentDirective.InvokeTool` is the executable-tool bridge | Superseded as identified in the P4 index. The P4 executable ToolRuntime contract is unchanged. |

The v1.9/v1.10 governance-history entries that expanded the semantic action
vocabulary remain historical phase-owned behavior names. They do not establish
or restore a model-facing universal wire union. The
`planning/tool-surface-review/` v1/v2 analyses remain unmodified historical
records and are not a second frozen design source.

**Governance changes (v1.14 → v1.15):**（P13 design-closure 治理裁决 GQ1–GQ4）

- G1 (GQ1): **新增 P13 — Product Web Client phase**（§11）。P13 是 post-core
  product-surface phase：P0–P12 的 SYSTEM IMPLEMENTATION COMPLETE 不作废；
  P13 不改任何已冻结的 domain/runtime/projection/transport 语义，只新增
  浏览器客户端呈现层。技术基线扩展（§14.1）：`apps/web` 前端应用采用
  Vite + React（TypeScript/ESM）；Vite/React 及相关前端依赖在 P13 contract/
  lockfile 中 exact pin，升级走单独变更验收。
- G2 (GQ2): **P13 v1 = 观测 + 已冻结的 human governance 操作**。9 个 frozen
  views 全部呈现 + WS invalidation/refetch；命令暴露以 P13 合同冻结的
  `Command → UI exposure policy` 矩阵为准（Human-actionable / System-internal /
  Agent-originated / Recovery-only），P13 只主动暴露 Human-actionable。
  **`SelectCurrentWork` 不得做成人工选择控件**：selection decision 属 scheduler
  evaluator，UI 只能呈现 current/runnable/selection 状态；human force-select
  若未来需要，必须单独治理语义闭合。chat-first 主 Workspace 对话面 defer 到
  P14+；`SendMessage` 在人→Main Agent 端到端语义冻结前不得由 P13 解释实现。
- G3 (GQ3): **视觉语言继承旧 console 的 paper/leaf/serif 植物学纸面原则**，
  不复制旧 CSS 架构；P13 冻结一套小型 design token system
  （paper/ink/leaf/branch/attention/danger/muted、typography、spacing 等），
  组件一律从 tokens 构建。
- G4 (GQ4): **`apps/web` 边界冻结**：开发态 Vite dev server + `/views` /
  `/commands` / WS proxy；生产态 Vite build → static dist，由
  `apps/single-workspace` production daemon 同源托管 static assets + API + WS。
  依赖边界：允许 `apps/web → packages/api-contracts` 与 frontend libraries；
  禁止 `apps/web → domain / application / projection-runtime / adapters/*`。
  P13 UI 角色冻结为 **Projection Renderer + Command Initiator**，不得成为
  Domain Interpreter / Authority Resolver / Workflow Engine。WS 只用于
  invalidation/refetch；浏览器不得据事件自行维护第二套 canonical/projection
  state。Search 保持 out-of-v1，不因 UI 便利自行实现新查询语义。

**Governance changes (v1.12 → v1.13):**（P10 design-closure 治理裁决 GQ1–GQ7）

- G1 (GQ1): **视图清单权威归 System Design §12/§13.9 全量 inventory**；本设计 §11 P10
  旧九词仅为不完整摘要（当前清单见本文件上方 FT-DG-02 amendment）。Search / Workspace Summary / Project Overview / Inbox 视图
  均归 P10；`WorkspaceStatus` 标签映射表按 SD 原有 labels 冻结（P10 契约落地），
  不发明新标签。
- G2 (GQ2): **`EffectiveFacts` 是唯一的 shared canonical-state-derived
  projection**：P10 owns definition / materialization / freshness / query；
  P3（Context cognition）只消费，不再另行派生。
- G3 (GQ3): **Attention read-model 契约归 P10**：source→severity→target→
  parent/human bubbling→dedup→read-model。上游各 phase 只产事实（事件/派生条件）；
  Attention 永不自动执行 canonical mutation。
- G4 (GQ4): **External Human/Parent Stop 的 authority resolver 归 P12**。P10 只
  暴露 stop request / control surface；P2 consumes/validates trusted Stop
  authority（运行时语义不变）。P2 `01` §"lands with the governance phase
  (P6/P10)" 的 ownership 表述按本条作 inherited clarification——resolver 语义
  自 P6/P10 收敛为 P12，P6/P10 不实现 resolver。
- G5 (GQ5): **Projection freshness 契约**：monotonic watermark（sequence 水位）
  + observable lag（读取时携带投影水位与 canonical lastSequence 之差）+
  explicit `FreshnessRequirement` / minimum-watermark barrier；**不提供隐式
  Read-Your-Writes guarantee**。stale 恢复沿 §5.4 retry/catch-up/rebuild。
- G6 (GQ6): **P10/P12 交付边界**：P10 owns programmatic projection/query +
  UI-facing view semantics；P12 owns HTTP/WebSocket/CLI/web shell/auth/
  deployment transport。P12 不重新解释 view semantics（transport 只呈现）。
- G7 (GQ7): **`HumanInterventionApplied` 成为 durable audit/governance 事实**：
  payload 冻结 `{ actor, targetWorkspaceId, summaryRef, occurredAt, kind }`；
  由 human-originated canonical command 在成功 mutation 的**同一 semantic
  transaction** 中发射（SteerWork / StopExecution / Critical-Steer 路径；
  P6 `WorkSteered` 路径作为 inherited evolution 补发，不 reopen P6）。P10 只消费。
  同时补录 P6 遗留偏差：`WorkSteered` 事件载荷按 P6 `04` §2 冻结形状
  `{ workId, fromRevision, toRevision, severity }` 落地（events.ts 空壳为
  实现偏差，随本条修复）。
- G8 (P7-GAP-01): P10 将 vacant-workspace silent-wait 实现为
  **canonical-state-derived Attention view**（`WaitingOnVacantProducer`：
  `dependencies(Unsatisfied ∧ WorkspaceBound) × works(无 Open Work ∧ ¬Retired)`），
  零 runtime mutation——处置事实仍是治理命令（S3 步骤 12）。

**Governance changes (v1.11 → v1.12):**（P9 收敛对账，小型治理变更）

- G1 (P9 closure reconciliation): §5.3 事件目录新增 `ReconciliationEscalated`
  {executionId, invocationRefsFingerprint, refs}——P9 恢复升级的 durable Attention
  事实承载（P9 `01` §1.2 / `04` §1 冻结面的正式目录化；dedup key =
  executionId + invocationRefs fingerprint）。
- G2 (recorded corrections, no semantic change): (a) P9-011 修复 generic
  `rebuildProjection` 的 exclusive-floor 重放缺陷（reset 目标 floor → floor-1），
  属对 P1 `05` §6 全量重放语义的实现回归修正，回归覆盖 RB-4 + P1-008；
  (b) `ProviderTurnStore` 恢复面扩展（`findUnsettledByProject` / `failTurn`）
  记录于 P9 `04`（P3 `06` 语义不变，仅恢复读路径）。

**Governance changes (v1.10 → v1.11):**（P8 design-closure 治理裁决 GQ1–GQ8）

- G1 (GQ2): **`VerificationMission.criteria` 结构化**为
  `{ criterionId, requirement, required: boolean }[]`（替代裸 `string[]`），修复 P0
  冻结类型无法表达 SD §9.6 required/optional 语义的上游缺陷。聚合语义随本条冻结：
  任一 required FAIL → FAIL；无 required FAIL 但存在 required 未决 → UNKNOWN；
  全部 required PASS → PASS；optional 单独不阻塞 PASS（透明展示）。P0 Schema、
  P1 `AssignWork` 载荷、P6 placeholder mission 按 inherited evolution 同步演化
  （必要时正式 migration；v1.10 migration-7 先例）。
- G2 (GQ5/GQ6): **WakeCondition `VerificationChanged` 改为 work-level 形状**
  `{ workId, targetWorkRevision }`（不再绑定 VerificationId；与 DependencyChanged
  同构）。任意 verdict 的结论都触发 `VerificationChanged`（含 PASS——质量等待的
  唯一表达通道）；FAIL/UNKNOWN 额外触发 `VerificationReturned`（WakeReason 路由）。
  **同一 `(workId, targetWorkRevision)` 至多一个 Open Verification**；历史
  concluded Verification 不受此限。
- G3 (GQ4): **`WorkOutcomeAccepted` 之后由 deterministic consumer 经
  `CommandGateway` 执行 `CompleteWork`**——Acceptance 是 Parent/User 的语义决定，
  CompleteWork 是机械 canonical mutation；consumer 提交时必须重新验证 exact
  WorkRevision / Verification / Acceptance 绑定（不因事件已发生而豁免 precondition）。
- G4 (GQ7): **Verifier owning workspace = StartVerification 时目标 Work 的 owning
  Workspace snapshot**。此后 Workspace retirement/move 不自动 abort 或 retarget：
  允许自然结论；无法继续时可 Unknown/Attention 结论。新 Verification 使用当前 owner。
- G5 (GQ8): **孤儿 Open Verification 的再驱动**：允许显式 re-Start，但必须先将旧
  Open Verification 以 `Unknown`（conclusionReason `Orphaned`）结论，再以新
  VerificationId 启动；禁止 silent automatic restart 与 identity reuse。
- G6 (GQ1): **P14 Query/Inspection Program 归 P8**：read-only program contract +
  version/hash/eval 一并冻结；P10/P12 只消费，不重新定义。

**Governance changes (v1.9 → v1.10):**（P7 design-closure 治理裁决 GQ1–GQ7）

- G1 (GQ1): §4.2 Coordination 组正式化 `WithdrawDependency` /
  `MarkDependencyUnfulfillable` / `ReviseDependencyContract`（§12.11 状态机操作
  的命令化）；§12.10 补三行（store 均为 DependencyRepository，pipeline 均为
  application）；§5.3 新增 `DependencyContractRevised` 事件（§4.2、§5.3、§12.10、§12.11）。
- G2 (GQ2): **`Deliver` 是独立 communication/orchestration primitive，不是新的
  canonical Deliverable command。** 分工冻结：`ProduceDeliverable` 创建 Deliverable
  （结果事实）；`Deliver` 投递既有 Deliverable（child→parent 方向的正式交付行为）；
  `SatisfyDependency` 变更 Dependency 状态。Message kind 集合扩展 `Deliver`
  （P7 起五 kind；`Report ≠ Deliverable` 维持）；AgentDirective 词表扩展 `Deliver`
  （§8.15）；成功 Inbox delivery 触发 `ChildDelivered` wake（§8.18）。正交性显式化
  （并入的原 GQ5）：satisfaction 是 structural 匹配，与 Verification/质量判定正交
  （质量门在 P8 的 Verification→Acceptance 链；SD §3.7）。
- G3 (GQ3): **runnability classification 是权威**（single authority）。
  `RunnableWorkSource` 的 classify 是 Work 是否 runnable 的唯一判定；
  `active WorkWait` 与 `unresolved blocking Dependency` 均不得被 classify 为
  Runnable。blocking Dependency := Unsatisfied Dependency 且 consumer Work 存在
  引用 `DependencyChanged(该依赖)` 的 active WorkWait（等待仍是认知决定）。
  scheduler `decide()` 不再承担隐藏 blocking 判定（§8.18A 的 runnable 输入
  语义由 classify 保证）；P5/P6 既有实现作为 inherited evolution 对齐本裁决。
- G4 (GQ4): §5.3 新增 `DeadlockAttentionRequested` 事件（承载 SD 不变量 42/A3 的
  Attention 事实）；deadlock 检测是确定性领域逻辑（§7.1），**不产生任何自动
  lifecycle mutation**（解除依赖/改合同仍是治理命令）。
- G5 (GQ6): AnyProducer 自动满足采用 **event-driven P7 coordinator**：
  `DeliverableProduced` 事件驱动 + project-scoped candidate lookup +
  deterministic structural matcher + 提交 `SatisfyDependency` Command。
  candidate lookup 的实现形态（扫描/索引）是 implementation choice，
  **不得把 Project full scan 冻结为合同**。
- G6 (GQ7): §8.15 AgentDirective 词表扩展 `ProduceDeliverable` /
  `SatisfyDependency`。定义 exact-bound `SatisfyDependencyAuthority`：来源为
  `ConsumerExecution`（consumer Work 所在 Workspace 的执行）或 `P7 coordinator`；
  Agent/Coordinator 只能**请求** satisfaction，最终 matcher 始终 authoritative；
  自动路径与 agent 路径必须共用同一个 `SatisfyDependency` Command（单一命令面）。

**Governance changes (v1.8 → v1.9):**

- G1: the **P5 deliverable** is a minimal runnable `apps/*` composition root plus
  a deterministic end-to-end acceptance suite; it is not test-harness-only, but
  a full production daemon/CLI is not required (§11 P5).
- G2: **P5 provides a provisional single-workspace implementation of the existing
  P2 `RunnableWorkSource` port** (current / open Work only); it does not define
  global Work runnability. **P7** later supersedes it with a dependency-aware
  implementation (§11 P5/P7).
- G3: `ProposeChildWorkspace` / `SpawnSpecialist` / `DeclareDependency` are **not**
  minimally implemented in P5; they return a non-fatal, model-visible
  **`DirectiveUnsupported` directive execution result** — part of the directive
  execution result / model-visible observation vocabulary, **not** an
  `AgentDirective`, `DomainError`, `CommandRejection`, or Execution failure. The
  owning phases implement them (§8.15, §11 P5).
- G4: `CompletionClaim` only durably settles the Execution as
  `Completed(CompletionClaimed)`; the Work remains `Open`. No Verification stub
  and no `CompleteWork` in P5; **P8** owns the Verification → Acceptance →
  CompleteWork chain (§6A.6, §11 P5).
- G5: P5 owns only the **representative restart-continuity acceptance proof**
  (dispose and reconstruct the runtime against the same durable state and
  continue the same Work/Session); **P2 owns the recovery mechanism** and
  **P9 owns systematic recovery hardening** (§11 P5/P9).
- G6: a **deterministic Fake Provider** is sufficient for the P5 phase gate;
  real-provider dogfooding is optional and must not gate CI or P5 completion
  (§11 P5).
- G7: P5 includes **one full vertical-slice acceptance story** spanning
  admission → driver → tool → observation → yield → wake → continuation →
  CompletionClaim → restart, while the Work remains `Open` (§11 P5).

`Problem & Goals` and `Scenarios` are unchanged.

---

## 0. 文档定位与冻结规则

Arbor 的系统级语义由 `Arbor System Design Specification v1.4` 拥有。本文不重新讨论问题定义、G1–G8、S1–S4，也不在实现层静默修改顶层领域语义；本文只回答如何把这些系统约束落实为可编码、可持久、可并发验证和可恢复的实现契约：

1. 哪些对象是长期 Identity，哪些只是 Value Object / Runtime Record / Projection；
2. 哪些状态必须成为 Canonical Truth，哪些只能是认知状态或 UI 投影；
3. 哪些 mutation 通过 Domain Command，哪些属于 Runtime Operational State；
4. 哪些 Invariant 由纯函数、Command Handler、数据库事务、Runtime、Sandbox 或 Projection 强制；
5. Agent 的 Prompt / Instruction / Context / Tool / Skill 如何被工程化，而不是散落在代码和字符串中；
6. SQLite、Repository、Event Journal、Lease/Fencing 与 Recovery 如何闭环；
7. TypeScript / Effect monorepo 如何通过依赖方向强制架构，而不是只靠文档约定；
8. 开发阶段如何从纯 Domain Kernel 逐步形成长期、多 Workspace、可验证、可恢复的 Agent 系统。

### 0.0.1 文档解耦规则

```text
Problem & Goals
→ owns WHY / WHAT

Scenarios
→ owns observable workflow

System Design
→ owns domain/runtime/invariant semantics

Detailed Implementation Design
→ owns executable contracts and mechanism
```

DID 可以把系统概念细化为 Value Object、Runtime Record、Port、schema、package 或 transaction protocol，但不得仅因实现便利创造新的顶层业务真相。若某个实现约束证明系统语义不可实现，应以失败测试、并发/恢复反例或接口断点为证据回到 System Design 修订。

### 0.1 冻结规则与 Closure 规则

从 v1.1 起遵循以下规则：

- 不再因为实现便利随意增加顶层 Domain Entity；
- 新概念首先判断属于 Domain、Runtime、Projection、Model Context 还是 Adapter；
- 硬 Invariant 不得仅由 Prompt 或 LLM 自觉保证；
- Canonical mutation 必须进入正式 Application / Runtime mutation path；
- Prompt / Model Context 的变化视为行为代码变化，需要版本、Provenance 与回归测试；
- 实现阶段若发现设计不成立，必须以失败测试、并发冲突、恢复失败或接口断点为依据修改，而不是因为“代码写起来麻烦”就改变边界；
- **顶层架构冻结，Pre-implementation Closure 继续开放**：凡是现在可以通过推理确定、且会显著影响接口/状态/一致性的二级问题，应在编码前继续闭合；只有需要真实模型评测、性能测量或运行证据的问题才允许显式延后。

### 0.2 三层真相模型

Arbor 最终采用三层信息结构：

```text
Canonical Truth
    Project / Workspace / Work / Responsibility
    Permission / Dependency / Deliverable / Verification
                ↓
Cognitive State
    Session / Checkpoint / Recent Frontier / Mode
    Active Skills / Working Plan / OutcomeGap
                ↓
Model-visible Projection
    Instructions / Context Fragments / Tools / Skills
    Output Contract / Continuation
```

其中：

- **Canonical Truth** 只能通过正式 mutation path 改变；
- **Cognitive State** 可以错误、压缩、重建和被新证据纠正；
- **Model-visible Projection** 是某一 Provider Turn 对前两层的有限投影，不具有反向修改 Canonical Truth 的权力。

### 0.3 Pre-implementation Closure 判定规则

实现前的未决问题按两问处理：

```text
Q1. Can this uncertainty be removed by reasoning now?
Q2. Will the choice materially constrain later interfaces/state/consistency?
```

若两者均为 Yes，则必须在编码前闭合；若必须依赖真实实现、模型行为或性能数据，则只冻结：

```text
mechanism
configuration boundary
measurement method
replacement boundary
```

而不伪造“最佳参数”。因此 v1.1 的 `FROZEN` 只表示：Domain/Runtime/Model Context/Persistence/Package 的顶层边界不再随意推翻；状态转移真值表、精确 Command/Port contract、Prompt 正文和性能默认值仍可在 Closure 阶段继续收敛。

### 0.4 Effect 是架构承载体，不只是异步工具

Arbor 的 TypeScript 实现以 Effect 的三参数模型作为 Application/Runtime contract 的直接表达：

```text
Effect<A, E, R>

A = successful result
E = expected typed failures the caller may handle
R = exact capabilities/services required to run the computation
```

因此：

```text
Domain/Application result semantics → A
Error Algebra                     → E
Ports / dependency requirements  → R
Adapters / construction graph     → Layer
```

Effect 的 Error channel 与 Requirement channel 都属于 Arbor 的正式架构，不允许退化为 `Effect<A, Error, AppEnv>`。

---

# DID-0 — Effect Execution Contract & Dependency Model

## 0A.1 统一函数契约

Arbor 的 effectful API 统一采用：

```text
Effect<A, E, R>
```

其中：

- `A` 只表达该操作成功完成时的结果；
- `E` 只表达调用方可以合理预期和处理的 typed failure；
- `R` 只表达该 computation 真正需要的 capability/service；
- defect / invariant violation 不塞入 `E`；
- interruption / cancellation 不伪装成普通 `CancelledError`；
- 正常业务替代结果优先使用 `A` 中的 ADT，而不是滥用 Error channel。

示例语义：

```text
AssignWork
→ Effect<
    AssignWorkReceipt,
    WorkspaceNotFound
      | ProjectClosed
      | AuthorityDenied
      | ResponsibilityViolation
      | RevisionConflict,
    WorkspaceRepository
      | WorkRepository
      | TransactionPort
      | DomainEventJournal
      | Clock
  >
```

该 block 只是 `Effect<A,E,R>` 形状的**示例**，不是 normative error contract。
`AssignWork` 的规范 rejection set 由 §6A.15 冻结：

```text
AssignWork rejection =
    DomainError.AuthorityDenied
  | DomainError.RevisionConflict
  | DomainError.TerminalLifecycleMutation   // Project Closed 或 Workspace Retired
  | CommandRejection.WorkspaceNotFound      // handler 加载时检测
```

本示例中的 `ProjectClosed` / `ResponsibilityViolation` 不再是独立 tag：
`ProjectClosed` → `TerminalLifecycleMutation(entity = Project)`；
`ResponsibilityViolation` → `AuthorityDenied(reason)`。

## 0A.2 Domain 中的 Effect

Domain 不依赖 infrastructure service，但可以使用 Effect 统一错误组合：

```text
Pure total function
→ A

Pure transition with expected domain rejection
→ Effect<A, DomainError, never>
```

因此 Domain 的关键边界不是“能不能 import Effect”，而是：

```text
Domain R = never
```

Domain 允许 `Schema / Brand / Option / Either / Data / Match / Effect<A,E,never>` 等纯建模能力；禁止 `Context.Service / Layer / SQL / HTTP / filesystem / Provider / runtime Clock service` 等 infrastructure requirement。

## 0A.3 Port = Effect Service

Infrastructure / runtime capability 通过 Effect service 暴露。Port interface 必须语义化，不能泄漏具体 Adapter：

```text
WorkspaceRepository.get(...)
→ Effect<Workspace, WorkspaceRepositoryError>
```

而不是：

```text
WorkspaceRepository.get(...)
→ Effect<Workspace, SqliteError, SqlClient>
```

底层 `SqlClient` 是 `WorkspaceRepositoryLive` 的构造依赖，不是 Port 调用者依赖。

## 0A.4 Layer 负责依赖构造

Service 的实现依赖在 `Layer` 构造阶段解决：

```text
SqliteClient Layer
        ↓
WorkspaceRepositoryLive
WorkRepositoryLive
TransactionPortLive
        ↓
Application/Runtime
```

Composition Root 负责最终提供完整 Layer graph。业务函数不接收 global `AppContext`，也不通过 constructor 参数手工层层传 repository/provider/tool。

## 0A.5 Requirement channel 必须精确

禁止：

```text
Effect<A, E, ArborServices>
```

其中 `ArborServices` 是所有 service 的万能集合。

每个 computation 的 `R` 必须由真实调用自然推导，只包含实际需要的 service。`R` 中意外出现 `SqlClient`、具体 Provider Adapter、SQLite implementation 等，应视为 architecture leak。

## 0A.6 Error channel 也用于架构审计

Application / Runtime public boundary 不允许出现：

```text
SqliteError
NodeFsError
OpenAISdkError
raw HttpError
```

底层实现错误必须在语义边界翻译成当前层的 typed error。`E` 中出现 adapter-specific error 表示抽象泄漏。

## 0A.7 Effect 编码规则

正式工程规则：

1. Expected/recoverable failure → typed `E`；
2. Impossible state / invariant violation → defect / `Cause`；
3. Stop/cancellation → interruption；
4. Normal alternatives → success ADT；
5. Port 使用 Effect service；Adapter 通过 Layer 提供；
6. Service implementation dependency 在 Layer construction 时解决，不泄漏到 Port 方法的 `R`；
7. 禁止 global AppEnv / Service Locator；
8. `R` 保持最小、精确；
9. 底层 implementation error 必须 map 成上层 semantic error；
10. Domain transition 的 infrastructure requirement 永远为 `never`；
11. 恢复优先使用窄的 tagged-error 处理，而不是无差别 catch-all；
12. `E` 与 `R` 的异常扩张纳入 architecture test / review。

---

# 1. DID-1 — Domain Object Classification & Aggregate Boundary

## 1.1 对象分类总表

| 对象 | 分类 | 核心语义 |
|---|---|---|
| `Project` | Aggregate Root | 项目最高治理、配置和 Environment 边界 |
| `Workspace` | Aggregate Root | 长期 Responsibility Identity；责任树节点 |
| `Work` | Aggregate Root | 一个阶段性、可验收的 outcome requirement |
| `Execution` | Aggregate Root / Runtime Domain | 一次可恢复、可 fencing 的执行 episode |
| `Session` | Runtime Aggregate Root | 长期认知连续性，而非业务权威状态 |
| `Verification` | Aggregate Root | 独立 Agentic Verification unit |
| `Dependency` | Aggregate Root | Consumer Work 对 Expected Deliverable 的正式等待 |
| `Deliverable` | Durable Entity | Work 产生的正式、版本稳定、可消费结果 |
| `ProducerBinding` | Value Object / ADT | Dependency 允许的生产者范围（AnyProducer / WorkspaceBound / WorkBound） |
| `ExpectedDeliverable` | Value Object | Dependency 的版本化结果 contract（kind + required artifact roles） |
| `DeliverableKind` | Branded String Value | Deliverable 的结果类型 |
| `ArtifactRole` | Branded String Value | Deliverable artifact 的角色 |
| `DeliverableMatchView` | Derived View | deterministic matcher 的输入视图 |
| `Message` | Durable Communication Record | 需要人/Agent 认知消费的通信 |
| `Acceptance` | Durable Record | Parent/User 对某 Work revision + Verification 的接受 |
| `Artifact` | Durable Entity | 不可变/版本化的具体 payload 引用 |
| `Decision` | Durable Entity | 正式治理/设计决策，可 supersede |
| `PermissionGrant` | Durable Entity | scope、issuer、lifetime 明确的权限授予 |
| `ResourceOwnershipClaim` | Durable Record | Workspace 对 canonical backing resource 的正式 write ownership |
| `ResponsibilityDefinition` | Value Object | Workspace 长期语义契约 |
| `ResourceBoundary` | Value Object | Responsibility 在现实资源上的可执行投影 |
| `ResourceAddress` | Value Object / ADT | Environment-facing 资源地址，不直接用于最终 overlap 判定 |
| `CanonicalResourceRegion` | Value Object | resolver 后的 backing resource space + normalized region；ownership overlap 的比较对象 |
| `VerificationMission` | Value Object | Verification 的目标、criteria 与风险要求；criteria 结构化 `{criterionId, requirement, required}[]`（v1.11 G1） |
| `ResponsibilityBoundAgentBinding` | Value Object | Workspace 的长期执行配置 |
| `ExecutionBoundAgentBinding` | Value Object | Execution-scoped 临时角色配置 |
| `AgentBinding` | Umbrella Vocabulary | 上述两类的联合术语，不是 Workspace 字段类型 |
| `AgentProfile` | Reusable configuration | 默认 HOW，不定义长期 WHAT |
| `EffectiveFacts` | Projection | Canonical State + Curated Knowledge 的当前投影 |
| `Inbox` | Projection | 尚未被认知消费的重要输入集合 |
| `WorkspaceStatus` | Projection | 从 Work / Execution / Dependency 等事实派生 |
| `AgentExecutionState` | Runtime Record | 当前 Execution 的 mode、skills、turn 等控制状态 |

## 1.2 Project 与 Workspace Tree

`Project` 与 `Workspace` 均为独立 Aggregate Root。Project 不保存整棵 Workspace 对象图。

```text
Project P1
└── Root Workspace R
    ├── Workspace A
    │   └── Workspace A1
    └── Workspace B
```

Canonical relation：

```text
Workspace.projectId
Workspace.parentWorkspaceId
```

规则：

- 每个 Project 恰好一个 Root Workspace；
- Root 仍然是普通 Workspace，不引入 `RootWorkspace` 子类型；
- `parentWorkspaceId` 创建后 immutable；
- 不提供普通 `ReparentWorkspace`；
- Children/Subtree 是 query/projection，不保存 `childrenIds[]` 双向真相；
- Workspace Tree 不跨 Project。

因此：

```text
Identity != Location
Workspace tree grows by child creation, not reparent mutation.
```

## 1.3 Workspace / Work / Execution

三个对象独立持久：

```text
Workspace 1 ── N Work
Work      1 ── N Execution
```

`Workspace` 只保存少量当前组织引用：

```text
workspaceId
projectId
parentWorkspaceId
responsibilityDefinition
resourceBoundary
agentBinding
primarySessionId
currentWorkId?
lifecycle: Active | Retired
```

`Work` 维护自身生命周期：

```text
Open | Completed | Cancelled
```

`Current / Pending` 不存入 Work。它由以下事实推导：

```text
Open + workspace.currentWorkId == work.id → Current
Open + workspace.currentWorkId != work.id → Pending
```

`Execution` 是短期可恢复执行 episode。Execution outcome 与 Work lifecycle 分离：

```text
Execution Completed != Work Completed
Execution Failed    != Work Cancelled
```

## 1.4 Current Work 选择修订

早期 `PromoteWork` 要求 Workspace 只有在 `currentWorkId == None` 时才能选择 Work。审计后修订为：

```text
SelectCurrentWork
```

允许：

```text
W1(Current, Open, blocked)
↓
W2(Open, runnable)
↓
currentWorkId = W2
W1 自动退回 Pending projection
```

硬约束仍然是：

```text
CurrentWorkId <= 1
```

`SelectCurrentWork` 只在存在 `WorkspaceExecution(focus = Work(oldCurrentWork))` 的 Active Main Execution 时禁止；`focus = Coordination` 的 Active Main Execution 可以在校验候选 Work 后提交 `SelectCurrentWork`。

## 1.4A Workspace Lifecycle / Retirement / Lineage

```text
WorkspaceLifecycle = Active | Retired
```

`Retired` terminal。禁止 `ReparentWorkspace / MoveWorkspace / mutate-parent MergeWorkspace`。跨责任树的组织调整采用 **replacement, not relocation**：创建 Successor Workspace/subtree，显式迁移责任对应的新 Work、Context references、Resource Ownership 与 Dependency，再 bottom-up Retire 旧 subtree。

`RetireWorkspace` 前置条件：

```text
workspace != Root
workspace.lifecycle == Active
no Active Main Execution
currentWorkId == None
no Open Work
no Active Child Workspace
no active ResourceOwnershipClaim
no unresolved incoming Dependency whose ProducerBinding is
  WorkspaceBound(thisWorkspace) or WorkBound(a Work owned by thisWorkspace)
  (unless resolved/replaced in the same governance change)
```

Retired Workspace 不得 AssignWork、AdmitExecution、CreateChildWorkspace 或修改 Responsibility。`Work.workspaceId` immutable；未完成事项迁移时在 Successor 创建新的 Work，并通过 Provenance 指向被替代 Work，而不是移动原 Work。Session/Memory/Decision/Artifact 的 ownership 也不改写，只通过 bootstrap/reference 派生新的 successor cognition。

组织 lineage 使用普通 durable record：

```text
WorkspaceLineage {
  predecessorWorkspaceId
  successorWorkspaceId
  relation: Supersede | Split | Merge | ResponsibilityTransfer
  decisionId
  recordedAt
}
```

Lineage 不是 Aggregate Root。

## 1.5 ResponsibilityDefinition、ResourceBoundary 与 Resource Ownership

Workspace 的语义契约：

```text
ResponsibilityDefinition
├── purpose
├── ownedResponsibilities
├── obligations
├── includes
├── excludes
└── interfaces
```

它回答：

> 这个 Workspace 为什么长期存在、负责什么、不负责什么、对外提供什么边界。

`ResourceBoundary` 独立存在，回答：

> 当前 Responsibility 在 Project Environment 中允许读取、写入或消费哪些现实资源。

二者以及正式 write ownership 的关系：

```text
ResponsibilityDefinition
    semantic contract
          ↓
ResourceBoundary
    allowed executable scope
          ↓
ResourceAddress[]
          ↓ ProjectEnvironment resolver
CanonicalResourceRegion[]
          ↓ ownership validation
ResourceOwnershipClaim[]
```

三者不得合并：

```text
ResourceBoundary      = 这个责任允许作用到哪里
ResourceOwnershipClaim= 哪些 canonical region 当前由它正式拥有 write ownership
Permission            = 这一次具体动作是否被授权
```

### ResourceAddress ADT

第一版至少允许用可扩展 ADT 表达：

```text
ResourceAddress
├── FileTree(...)
├── GitWorktree(...)
├── DatabaseNamespace(...)
└── ExternalResource(...)
```

`ResourceAddress` 是语义/环境地址，不直接作为 uniqueness key。不同地址可能 alias 到同一个现实资源，例如 Git Worktree 最终落到某个 filesystem subtree。

因此 `ProjectEnvironmentPort` 必须提供确定性的 resolve/canonicalize boundary：

```text
ResourceAddress
        ↓ resolve
CanonicalResourceRegion {
  resourceSpaceId
  normalizedRegion
}
```

`contains(a,b)` 与 `overlaps(a,b)` 定义在同一 `resourceSpaceId` 下的 `CanonicalResourceRegion` 上；跨 resource space 默认不 overlap，除非 Environment resolver 明确把二者归一到同一 backing space。

核心规则：

- Semantic boundary guides；Resource boundary enforces；
- Responsibility change 可以导致 ResourceBoundary 变化；
- ResourceBoundary 因目录、worktree、数据库 namespace 等环境映射变化时可以独立更新；
- Read visibility 可以重叠；
- formal write ownership 默认不重叠；
- ownership enforcement 比较 canonical backing resource，而不是原始 path/string；
- Permission 不能扩大 ResourceBoundary，也不能覆盖 write ownership invariant；
- `ResourceOwnershipClaim` 是 durable record，不升级为新的 Aggregate Root。

Resource resolution 可能访问 filesystem/worktree/mount/external namespace，因此不得在 SQLite write transaction 内执行慢 I/O。第一版 enforcement 语义冻结为：

```text
resolve/canonicalize ResourceAddress outside write transaction
→ CanonicalResourceRegion[] + observedEnvironmentRevision

BEGIN IMMEDIATE
→ verify observedEnvironmentRevision is still current
→ load potentially conflicting ownership claims
→ deterministic overlaps()
→ insert/update claims with resolvedAtEnvironmentRevision
→ COMMIT
```

若 Environment revision 已变化，返回 `ResourceResolutionStale` 并重新 resolve；不得用旧 mapping 提交 ownership。具体索引、query 优化与 DDL 留给 P1 exact schema closure。


## 1.6 Agent 不作为长期 Domain Entity

Arbor v1 不存在 `AgentId` 和独立长期 `Agent` Aggregate。

```text
Workspace = long-lived responsible identity
Agent     = runtime execution role
```

长期 Agent 连续性来自：

```text
WorkspaceId
+ ResponsibilityDefinition
+ ResponsibilityBoundAgentBinding
+ Primary Session
+ Workspace Memory
```

`AgentBinding` 是 umbrella vocabulary，分两类：

```text
ResponsibilityBoundAgentBinding
    → Workspace
    → long-lived session / memory

ExecutionBoundAgentBinding
    → Execution
    → temporary mission
```

`Workspace.agentBinding` 的类型是 `ResponsibilityBoundAgentBinding`；
`ExecutionBoundAgentBinding` 只属于 Execution-scoped 临时 context，不得存入 Workspace。

`AgentProfile` 定义默认 HOW；`ResponsibilityDefinition` 定义 WHAT。Profile 不成为责任或权限来源。

## 1.7 Session

`Session` 是独立 Runtime Aggregate Root，用于持久化认知连续性，而不是业务真相。

```text
SessionBinding
├── WorkspacePrimary(workspaceId)
└── ExecutionScoped(executionId)
```

长期 Workspace 当前只引用一个 `primarySessionId`，历史 Session 可以保留并被 supersede。Workspace 主 Execution admission 时必须 snapshot 当前 `primarySessionId` 为 `execution.sessionId`；该 Execution 后续始终写同一 Session。`ReplacePrimarySession` 只影响未来 Execution，并要求当前不存在 Active Main Execution。

Session 保存：

- cognitive history references；
- `ContextEpoch`；
- checkpoint；
- provider continuation metadata；
- model/output continuation state。

Session 不保存：

- Responsibility canonical truth；
- Current Work canonical truth；
- Permission；
- Dependency 状态；
- Verification verdict；
- Resource ownership。

长期认知结构：

```text
Checkpoint + Recent Frontier
```

Session 的 provider-neutral typed Timeline：

```text
SessionItem =
  UserMessage(source, contentRef, trust)
| AssistantMessage(providerTurnId, contentRef, finishReason)
| ToolCall(providerTurnId, callRef, toolRef, argumentsRef)
| ToolResult(callRef, invocationId?, status, observationRef,
             modelOutputRef, artifactRefs[])
| ControlResult(callRef, actionKind, disposition,
                canonicalRefs[], observationRef)
| ContextUpdate(sourceRef, revision, Full | Replace | Revoke, contentRef)
| CompactionCheckpoint(fromEpoch, toEpoch, Summary | ProviderNative,
                       summaryRef?, opaqueItemRef?, bindingFingerprint?,
                       retainedFrontier)
| AttachmentRef(ref, mediaType, trust, disclosure)
```

`SessionItem` 是 Runtime contract，不是 Domain Aggregate。`sourceRef + item type`
幂等；同 source、不同 content hash 是 invariant conflict。Streaming delta 仍为
transient，只有 completed typed item 进入 Timeline。`ContextUpdate` 记录模型投影的
supersession，不成为 canonical authority。

## 1.8 Dependency / Deliverable / Message

三者严格分开：

```text
Message     = communication
Deliverable = formal result
Dependency  = unmet result requirement
```

`Dependency` canonical consumer 是 `Work`，而不是模糊的 Workspace→Workspace 关系。Lifecycle 为 `Unsatisfied | Satisfied | Withdrawn | Unfulfillable`；后三者 terminal：

```text
Dependency
├── dependencyId
├── consumerWorkId
├── producerBinding: ProducerBinding
├── revision: DependencyRevision
├── expectedDeliverable: ExpectedDeliverable
├── state: Unsatisfied | Satisfied | Withdrawn | Unfulfillable
├── satisfiedByDeliverableId?
└── satisfiedAtDependencyRevision?
```

`ProducerBinding` 只有三种，表达“这个需求允许由谁提供”：

```text
ProducerBinding
├── AnyProducer
├── WorkspaceBound(workspaceId)
└── WorkBound(workId)
```

`ExpectedDeliverable` 表达“需要提供什么东西”，不包含 producer：

```text
ExpectedDeliverable
├── kind: DeliverableKind
└── requiredArtifactRoles: readonly ArtifactRole[]
```

`DeliverableKind` 与 `ArtifactRole` 是 branded string value（不是 Entity ID）。

`Deliverable` 必须关联：

```text
Deliverable
├── deliverableId
├── sourceWorkId
├── sourceWorkRevision: WorkRevision
├── kind: DeliverableKind
└── artifacts: readonly { role: ArtifactRole, artifactId: ArtifactId }[]
```

Dependency satisfaction 是 deterministic structural matching。matcher 的输入被显式冻结，避免 Domain 函数自行访问 Repository：

```text
DeliverableMatchView
├── deliverableId
├── sourceWorkId
├── sourceWorkspaceId
├── kind
└── artifactRoles: ReadonlySet<ArtifactRole>

matchesExpectedDeliverable(
  producerBinding,
  expectedDeliverable,
  candidate: DeliverableMatchView
) -> boolean
```

算法固定为：

```text
1. producerBinding 匹配 candidate 来源
   AnyProducer            → true
   WorkspaceBound(ws)     → candidate.sourceWorkspaceId == ws
   WorkBound(work)        → candidate.sourceWorkId == work
2. candidate.kind == expected.kind
3. expected.requiredArtifactRoles 中每个 role 都在 candidate.artifactRoles 中
4. 三项全部成立 → true；否则 false
```

matcher 返回 false 时 `SatisfyDependency` 被拒绝，Dependency 状态不变。

P0 不引入 metadata query DSL、regex predicate、semantic similarity、LLM matcher 或 arbitrary JSON predicate；以后需要时以新的设计变更增加。

`Dependency` 的 `expectedDeliverable` 随 Dependency revision 形成明确 contract。`SatisfyDependency` 必须绑定当前 `targetDependencyRevision`，并同时读取 `producerBinding` 与 `expectedDeliverable`；已满足记录 immutable，后续 contract 改变应形成新的 revision/Dependency，而不是静默重解释旧 satisfaction。

旧 Work revision 的 Deliverable 不因 Work 后续 refine 自动满足新 revision 的 requirement。

`Message` 只用于需要认知处理的 Query / Reply / Report / DecisionRequest / HumanInput 等通信，不作为 universal system envelope。`Inbox` 是未消费输入的 projection。

**Deliver primitive（v1.10 G2）**：`Deliver` 是独立 communication/orchestration
primitive，不是新的 canonical Deliverable command。分工冻结：

```text
ProduceDeliverable  创建 Deliverable（结果事实，绑定 source Work revision）
Deliver             投递既有 Deliverable（child → parent 方向的正式交付行为）
SatisfyDependency   变更 Dependency 状态（structural matcher 始终 authoritative）
```

- Message kind 集合自 P7 起扩展 `Deliver`（`Report ≠ Deliverable` 维持）；
  Deliver 消息引用既有 deliverableId，成功 Inbox delivery 触发 `ChildDelivered` wake。
- satisfaction 是 structural 匹配，与 Verification/质量判定正交（质量门在 P8 的
  Verification → Acceptance 链）。

---

# 2. DID-2 — Identity Model

## 2.1 Typed IDs

所有独立持久 Identity 使用强类型 ID：

```text
ProjectId
WorkspaceId
WorkId
ExecutionId
SessionId
VerificationId
DependencyId
DeliverableId
MessageId
ArtifactId
DecisionId
PermissionGrantId
AcceptanceId
EvidenceId
MemoryId
CommandId
EventId
ProviderTurnId
ToolInvocationId
LogicalActionId
LogicalSettlementId
WorkerId
WorkerIncarnationId
PluginId
```

明确不存在：

```text
AgentId
RootWorkspaceId
PrimarySessionId
```

Root/Primary 是关系角色，不是新实体类型。

`PluginVersion` / `PluginSdkApiVersion` 是 branded version 值，不是 entity ID。

`AgentLoopStepIdentity` 是 `(ExecutionId, logicalStepNo, repairAttempt)` 复合身份，
不是新增全局 entity ID。`LogicalActionId` / `LogicalSettlementId` 是稳定派生的
runtime semantic identity；它们不替代 `CommandId`。

## 2.2 ID 规则

- 底层采用 UUIDv7 类可时间排序随机标识；
- deterministic runtime semantic identities（`LogicalActionId` /
  `LogicalSettlementId`）例外：使用版本化 canonical serialization + SHA-256
  派生，并保留 Appendix A prefix；
- 增加 `prj_ / ws_ / wrk_ / exe_ / ses_ ...` prefix 便于运行时校验和调试；
- TypeScript 使用 nominal/branded type，运行时使用 Schema codec；
- ID 不编码名称、父子路径、业务 location 或 sequence；
- Entity state evolution 不改变 Identity；
- Human-friendly `W-42` 等仅是 projection/display code。

核心：

```text
Identity != Name != Location != Order
```

## 2.3 Event ordering 与 local ordinal

`EventId` 与 `EventSequence` 分离。Event Journal 使用 Project-local sequence 或 journal partition sequence，不依赖 UUID / timestamp 作为严格顺序。

局部概念使用 scoped ordinal：

```text
ContextEpochNumber
LeaseGeneration
ResponsibilityRevision
ResourceBoundaryRevision
ArtifactRevision
WorkRevision
DependencyRevision
```

`WorkRevision` 是 `Work` identity 内部单调递增的 semantic revision：Work 创建时从初始 revision 开始，`RefineWork` / semantic `SteerWork` 使其递增；`Deliverable.sourceWorkRevision`、`Verification.targetWorkRevision`、`Acceptance.targetWorkRevision` 都用它绑定具体 Work version。`DependencyRevision` 同理用于 `Dependency.revision` / `targetDependencyRevision` / `satisfiedAtDependencyRevision`。

`WorkRevision` / `DependencyRevision` 是 scoped ordinal / branded value，**不是** Entity Identity：不加入 §2.1 Typed IDs，也不加 prefix。

不为每个内部 record 无限制创造全局 UUID。

---

# 3. DID-3 — Core Aggregate State Model

## 3.1 Project

核心字段：

```text
ProjectId
name
rootWorkspaceId
projectPolicy
projectPolicyRevision
default configuration
environmentRef
lifecycle: Open | Closed
revision
```

`revision` 是 Aggregate optimistic-concurrency revision：Project 的每次 canonical mutation 都递增。`projectPolicyRevision` 只在 `projectPolicy` 语义发生变化时递增；`UpdateProjectPolicy` 同时递增二者。

关键 Invariant：

- 一个 Project 恰好一个 Root Workspace；
- Project Closed 后不再 admission 新自主 Execution；
- Project Policy 构成下级 capability/policy ceiling。

## 3.2 Workspace

核心字段：

```text
WorkspaceId
ProjectId
ParentWorkspaceId?
name
ResponsibilityDefinition
ResponsibilityRevision
ResourceBoundary
ResourceBoundaryRevision
ResponsibilityBoundAgentBinding
PrimarySessionId
CurrentWorkId?
WorkspacePolicy
workspacePolicyRevision
revision
```

`revision` 是 Aggregate optimistic-concurrency revision：Workspace 的每次 canonical mutation 都递增。`workspacePolicyRevision` 只在 `WorkspacePolicy` 语义发生变化时递增；`UpdateWorkspacePolicy` 同时递增二者，而 `SelectCurrentWork` / `ReplacePrimarySession` 等只递增 aggregate `revision`。

关键 Invariant：

- Parent immutable；
- 最多一个 Current Work；
- Current Work 必须属于本 Workspace；
- Responsibility/ResourceBoundary 变化 revision++；
- Primary Session 必须是 `WorkspacePrimary` binding；
- `ReplacePrimarySession` 要求不存在 Active Main Execution；replacement 不改变已 admission Execution 的 `sessionId`。

## 3.3 Work

核心字段：

```text
WorkId
ProjectId
WorkspaceId
Objective
Why
Constraints
CompletionExpectation
VerificationMission
Provenance
Lifecycle
revision
```

生命周期：

```text
Open → Completed
Open → Cancelled
```

Completed / Cancelled 默认 terminal。

Producer 不得自行削弱 Objective / CompletionExpectation / required VerificationMission。

## 3.4 Execution

Execution Binding：

```text
WorkspaceExecution {
  workspaceId
  focus: Work(workId) | Coordination
}

ExecutionBoundAgentBinding {
  parentExecutionId?
  mission
}
```

Workspace 可以因 Query / Decision / Human Input 等 coordination input 被唤醒，因此 Workspace Execution 不强制存在 WorkId。

### Admission-time fixed binding

Execution admission 时固定：

```text
executionId
projectId
binding
sessionId
admittedAt
settlement?: ExecutionSettlement
```

- `WorkspaceExecution` snapshot 当前 Workspace `primarySessionId`；
- `ExecutionBoundAgentBinding` 绑定其 `ExecutionScoped` Session；
- `execution.sessionId` admission 后 immutable；
- Primary Session replacement 不改变任何已 admission Execution。

Admission 支持两类 binding（P2）：

```text
WorkspaceMain   : binding = WorkspaceExecution
                  snapshot workspace.primarySessionId
ExecutionBound  : binding = ExecutionBoundAgentBinding
                  admission 在同一事务内原子创建 Execution + ExecutionScoped Session
```

- 所有 ID（`executionId`、`sessionId` 等）由 caller preallocate；handler 不生成 ID。
- 只有 `WorkspaceMain` 受 one-active-main 约束；P2 不新增 specialist concurrency limit。
- P2 owns **generic** `ExecutionBound` admission（durable Execution + `ExecutionScoped` Session）；
  spawn / delegation 语义由 higher-level feature phases 拥有（P6 delegation、P8 Execution-bound
  Verifier 等）。

### ExecutionSettlement 是 sum type

Execution settlement 必须同时表达 technical outcome 与与之匹配的 semantic terminal result，但实现上使用 discriminated union，禁止任意 `outcome × result` 笛卡尔积：

```text
ExecutionSettlement
├── Completed(CompletedResult)
│   ├── Yielded(reason, waitSpec)
│   ├── CompletionClaimed
│   ├── VerificationConcluded(verificationId, verdict)
│   └── Blocked(BlockedWorkEpisode)  // exact Work Episode only
├── Interrupted(InterruptedResult)
│   └── StopRequested / other controlled interruption
├── Failed(ExecutionFailure)
└── OutcomeUnknown(ReconciliationRequired)
```

关键约束：

- `CompletionClaimed` 必须持久携带足够的 claim/reference 与 target Work revision，使 event replay 可以可靠触发后续 Verification；
- `VerificationConcluded` 只表示该 Verifier Execution 已提交 canonical conclusion；它不得表达 Parent Acceptance 或 Work Completed，也不得进入 CompletionClaim consumer；
- `Blocked` 只表示精确 Work Episode 已到达稳定的人类/Parent 输入边界，不改变 Work lifecycle；其 exact denial evidence、wait request 和 WorkBlocker 同事务合同由 P2 `01` 拥有，不蕴含 Verification、Acceptance 或 Work completion；
- 新写 settlement 必须匹配 exact `ExecutionEpisodeBinding`；历史 `CoordinationCompleted` / `QueryCompleted` 仅供 migration/decoder audit；
- Worker crash、lease expiry 或旧 Worker resurrection **本身不直接 settle Execution**；Recovery 可以继续同一 durable Execution；
- `OutcomeUnknown` 表示存在未解决的现实副作用歧义，reconciliation 前禁止盲目 replay；
- `Completed != Work Completed`，`Failed != Work Cancelled`。

Execution admission 与 Worker lease acquisition 分离：

```text
Admit durable Execution
↓
Dispatch Worker
↓
Worker acquires lease
↓
execute
```

### Stop / Quiescence

`StopExecution` 提交后立即关闭该 Execution 的新 ProviderTurn、ToolInvocation、Execution-originated canonical Command 与 Specialist spawn admission。已经 in-flight 的 ToolInvocation 按 SideEffectSemantics cancel/reconcile；只要仍存在 unresolved side-effectful ToolInvocation，Execution 就不得 settle 为普通 Completed/Interrupted/Failed，只能继续 reconcile 或 `OutcomeUnknown(ReconciliationRequired(invocationRefs))`。`CancelWork` 与 Stop 分离：Work 可先成为 Cancelled，相关 Execution 随后完成 quiescence。

Execution-originated canonical mutation 按 stop admission 分为两类（P2 冻结）：

```text
NormalExecutionMutation
  = 新的 ProviderTurn / ToolInvocation / Execution-originated canonical Command /
    Specialist spawn 的 admission
  = stopRequestedAt != null 后禁止 → CommandRejection.ExecutionStopping

QuiescenceControlMutation
  = 推进 quiescence 所必需的控制 mutation，至少包括 ExecutionOrigin 路径的 SettleExecution
    与 stop 后的 reconciliation
  = stopRequestedAt != null 后仍允许
```

- 该二分**只分类 Execution-originated mutation**；`AdmitExecution`、`StopExecution` 与
  `RecoveryController` 的 settlement 不强行归入该二分。
- `QuiescenceControlMutation` 仍必须通过 authoritative fencing；旧 Worker 不得 settlement。
- 一个 generation 仍有效的合法 Worker 仅因 stop 被拒绝时返回 `ExecutionStopping`，不得返回
  `FencingRejected`（与 §9.7 一致）。
- execution-wide Runtime Safety Envelope 由 P2 enforcement（§8.16A）；P3 只提供 turn/tool
  activity observations。



## 3.5 Verification

Verification 保存：

```text
VerificationId
WorkId
TargetWorkRevision
MissionSnapshot
TargetDeliverables
TargetArtifactVersions
TargetEnvironmentRevision?
EnvironmentSnapshotRef?
EvidenceRefs
VerificationExecutionIds
Verdict?: Pass | Fail | Unknown
```

规则：

- concluded verdict immutable；
- 重新验证创建新 Verification；
- Producer、Verifier、Acceptance 三层分离；
- Verifier 默认只读 Producer formal output；
- Verification 绑定具体 Work/Deliverable/Artifact 版本。


## 3.6 Acceptance / Deliverable / Dependency revision binding

`Acceptance` 落实为：

```text
Acceptance
├── workId
├── targetWorkRevision
├── verificationId
├── actor
└── acceptedAt
```

`CompleteWork` 必须在同一 semantic decision 中验证：

```text
work.lifecycle == Open
AND verification.workId == work.id
AND verification.targetWorkRevision == work.revision
AND verification.verdict == Pass
AND acceptance.workId == work.id
AND acceptance.targetWorkRevision == work.revision
AND acceptance.verificationId == verification.id
```

Work refine 后，旧 Verification / Acceptance 记录仍保留，但自动变为“不适用于当前 revision”，不得被复用完成新 revision。

`Deliverable.sourceWorkRevision`（`WorkRevision`）与 `Dependency.targetDependencyRevision`（`DependencyRevision`）形成消费链：

```text
Work revision (WorkRevision)
→ Deliverable(sourceWorkRevision: WorkRevision)
→ SatisfyDependency(targetDependencyRevision: DependencyRevision)
```

`SatisfyDependency` 用 `producerBinding` + `expectedDeliverable` 对 `DeliverableMatchView` 做 deterministic structural matching（见 §1.8）。不新增独立 `OutputContract` Domain Entity；ExpectedDeliverable 仍是 Dependency 内的版本化 contract。

## 3.7 Runtime Supporting Records

以下对象不作为富 Aggregate：

```text
AgentExecutionState
AgentLoopStepRecord
AgentLoopStepActionRecord
ProviderTurn
ToolInvocation
CommandAttempt
CommandReceipt
SessionEntry
MessageConsumption
EvidenceRecord
DomainEvent
UsageRecord
```

其中 `AgentExecutionState` 保存当前 episode 的控制状态：

```text
executionId
focus
wakeReason
currentMode
activeSkillRefs[]
turnNo
recentDirectiveRefs[]
recentActionFingerprints[]
updatedAt
```

它与 Workspace/Session 分离：

```text
Workspace            = long-lived responsibility state
Session              = long-lived cognitive continuity
AgentExecutionState  = current episode control state
AgentLoopStepRecord      = durable Provider-result/action/settlement handoff state
AgentStepContext         = immutable per-sampling snapshot carried by ModelContextManifest
```

`AgentLoopStepRecord` 与 action ledger 的完整 ADT、状态机和恢复不变量由 P3 `08`
冻结。它们是 durable runtime records，不是 Aggregate、Domain Event 或模型输出
wire contract。特别地，v1.18 的 process-local `AgentAction` 仍不得持久化；恢复通过
固定 Provider 结果 + pinned decoder 重建 typed invocation，并用 stored hash/ledger
校验。

`AgentStepContext` 不新增 Aggregate 或独立 table；Manifest 持久化其 control refs/
revisions、input frontier、effective tool catalog、ResolvedModelBinding 与 budget basis
的 fingerprint。它只保证一次 sampling request 的一致视图，不能作为后续 Tool/
Control effect 的授权缓存。

---

# 4. DID-4 — Command Model

## 4.1 Command logical request / attempt / receipt

```text
Command = immutable logical request to change canonical state
Event   = committed domain fact after successful canonical change
```

### CommandEnvelope

领域意图使用：

```text
CommandEnvelope<C>
├── commandId
├── projectId
├── actor              // declared actor
├── issuedAt
├── causationRef?
├── correlationRef?
└── payload
```

`CommandId` 是 **immutable logical request identity**。系统同时计算稳定 `semanticRequestFingerprint`（至少覆盖 commandType、projectId、declared actor、schemaVersion 与 semantic payload）：

```text
same CommandId + same semanticRequestFingerprint
→ same logical request

same CommandId + different semanticRequestFingerprint
→ IdempotencyConflict
```

修改 expected revision、target revision、scope、actor intent 或其他语义 payload 后，已经是新的 logical request，必须使用新的 CommandId。

`semanticRequestFingerprint` 的**具体 canonical serialization 与 hash 算法**在 P1 phase contract 冻结，并随 `fingerprint_algorithm_version` 持久化；P0 的 32-bit FNV-1a 是 interim，不是冻结算法。持久化列名统一为 `semantic_request_fingerprint`。

### CommandSubmissionContext

`CommandEnvelope` 不承载可信执行来源。Runtime 额外提供不可由模型/调用 payload 伪造的 authenticated context：

```text
CommandSubmissionContext
├── External {
│     principal
│   }
├── ExecutionOrigin {
│     principal
│     executionId
│     fencingGeneration
│   }
└── System {
      principal
      causationRef
    }
```

Declared Actor 与 authenticated principal 分开验证。Execution-originated mutation 的 fencing token 来自 Runtime context，不来自模型输出。

### Runtime authority facts (P2)

Internal runtime commands **不豁免** authority。`CommandGateway` 对每个 command 要求一个
Application-level trusted authority fact；P1 `01` §2A 的 `VerifiedCommandAuthority` 是其第一个
实例。P2 使用 **command-specific** 变体，而不是泛化的 System / Execution 类别：

```text
VerifiedRuntimeCommandAuthority
├── AdmitExecutionAuthority {
│     submissionOrigin: System | External
│     principal, commandId, semanticRequestFingerprint, projectId,
│     commandKind, workspaceId, bindingKind }
├── StopExecutionAuthority {
│     submissionOrigin: External | System | ExecutionOrigin
│     principal, commandId, semanticRequestFingerprint, projectId,
│     commandKind, executionId }
└── SettleExecutionAuthority {
│     submissionOrigin: ExecutionOrigin | RecoveryController
│     principal, commandId, semanticRequestFingerprint, projectId,
│     commandKind, executionId, fencingGeneration? }
```

- exact-bind 至少覆盖 `commandId`、`semanticRequestFingerprint`、`projectId`、command kind、
  target 与 submission origin；mismatch → `DomainError.AuthorityDenied`。
- `ExecutionOrigin` 的 settlement **必须**通过 authoritative fencing；`RecoveryController` 的
  settlement 使用 recovery authority（不携带 worker fencing generation）。
- 这些 fact 由 Runtime 产生，是 trusted input，不得由模型输出或 CommandEnvelope payload 构造。
- Authority **不进入** `semanticRequestFingerprint`。
- PermissionGrant / Parent / User governance 的 Authority Resolver 仍是后续 phase；runtime fact
  只做 deterministic exact-match。
- `CommandRejection` 仍为 `DomainError | FencingRejected | ExecutionStopping | WorkspaceNotFound`。

### CommandAttempt

同一 logical Command 可以存在多个 operational attempt：

```text
Command cmd_1
├── Attempt #1 → RetryableOperationalFailure
├── Attempt #2 → RetryableOperationalFailure
└── Attempt #3 → Committed
```

Attempt 使用 `(commandId, attemptNo)` local ordinal，不创建新的全局 Entity identity。

允许 same CommandId retry 的前提是**语义请求完全未变**。例如 transient persistence unavailability / lock contention 可以新建 attempt；如果 caller 必须 reload state 并修改 payload/precondition 才能继续，则创建新的 logical Command。

### CommandReceipt / Resolution

Authoritative resolution：

```text
CommandResolution
├── Committed(result)
└── TerminalRejected(typedError)
```

`CommandReceipt` 是该 resolution 的稳定外部/内部表示，不是 Domain Event。

规则：

- semantic rejection（如 AuthorityDenied、WorkNotOpen、显式 expected revision mismatch）可成为 durable `TerminalRejected`；
- terminal rejection 不产生 Domain Event，因为 Domain truth 未变化；
- transport / transient persistence failure 不产生 authoritative Resolution；调用方使用同一 CommandId 重试，可产生新的 attempt；
- `FencingRejected` 对该 Execution-originated logical Command 是 terminal；旧 Worker 不得普通 retry；
- 对 Agent action/settlement，`FencingRejected` 只终止该 `CommandId`。P1 `07`
  冻结更外层身份：`LogicalActionId` / `LogicalSettlementId` 保持稳定，而新租约
  generation 在读取 ledger/receipt 并确认仍 eligible 后创建**新的** deterministic
  `CommandId`。这不是 same-Command retry，也不改变 terminal receipt；
- 同一 CommandId 一旦进入 Committed 或 TerminalRejected，后续同 payload retry 直接返回已存在 Receipt；
- Command 不按 CRUD setter 设计，而按领域意图设计。


## 4.1A GovernanceChangeSet / coupled governance mutation

Public API 仍使用语义 Command，不暴露万能 patch command。`ChangeResponsibility` 等 Command 在 Application 内部可以计算 `GovernanceMutationPlan`，并在一个 semantic transaction 中同时更新：

```text
ResponsibilityDefinition + revision
ResourceBoundary + revision + basisResponsibilityRevision
ResourceOwnershipClaim set
relevant Workspace policy facts
Domain Events
```

每个 committed state 必须满足：

```text
ResourceOwnershipClaim ⊆ ResourceBoundary
ResourceBoundary.basisResponsibilityRevision == Workspace.responsibilityRevision
```

禁止依赖“先改 Responsibility、下一条命令再改 Boundary”的危险中间状态。

## 4.1B External Command Decode and Receipt Ordering

External HTTP, WebSocket, CLI, and future external submissions share one
Application/Composition boundary. The shell authenticates the caller and hands
the Composition root the raw bounded JSON envelope, authenticated `Principal`,
submission context, and correlation information. A shell never casts JSON to a
trusted `CommandEnvelope` and never performs a receipt lookup.

The first external wire contract is fixed at v1 and carries no caller-supplied
wire version field. Keep these values separate:

| Contract value | Owner and use | Persistence |
|---|---|---|
| `externalWireCodecVersion = 1` | Server-selected strict codec for the registered `commandType` | Not in envelope, fingerprint, or SQL |
| `CommandHandler.schemaVersion` / `commands.schema_version` | Registered Handler's semantic Command/receipt schema and JSON decode key | Existing receipt column and P1 fingerprint input |
| `fingerprint_algorithm_version = 1` | P1 canonical serialization and SHA-256 algorithm version | Existing receipt column |

Internal schema implementation changes alone do not alter the wire-v1
semantic receipt identity. A change to semantic payload or result/error
contract follows the existing Handler schema-version and receipt compatibility
rules; it is not inferred from the wire codec version.

The external path is ordered as follows:

```text
authenticate Principal and establish External submission context
  → bounded strict wire-v1 envelope + registered closed payload codec
  → validate CommandId / ProjectId / declared Actor syntax and payload IDs
  → derive registered Handler.schemaVersion and current P1 semantic fingerprint
  → require external declared Actor == authenticated Principal exactly
  → Composition loads current canonical facts / active Grants and runs P12 Resolver
      denied: return the existing authority Problem; disclose no receipt
  → CommandGateway begins its existing BEGIN IMMEDIATE transaction
      → read receipt by CommandId
      → exact (fingerprint, Handler schemaVersion, algorithm version): return it
      → any tuple mismatch: IdempotencyConflict; preserve the stored receipt
      → if absent: current fence/stop/authority/precondition/handler/write path
```

There is no receipt read outside the Gateway transaction. External Resolver
visibility is required even for a retry; the Gateway's receipt lookup remains
first inside its transaction and before its final exact authority check, per
P1 `01` §3 and `03` §3.1. `BEGIN IMMEDIATE` remains the only receipt
linearization point. A same-tuple concurrent loser returns the committed
winner; a different tuple cannot overwrite it. Canonical preconditions and
the Gateway's final exact-authority check remain authoritative for mutation.

The Application owns `ExternalCommandDecoder` and
`CommandInputContractRegistry`: the decoder accepts bounded raw JSON plus a
`commandType` and returns a typed semantic envelope or safe codec issues; the
registry contains exactly one closed input descriptor and origin policy per
command in the current 28-required-command production registry, plus the
optional `ResolveControlApproval` descriptor when its store is composed.
`RetryVerification` is external only through its exact authenticated-human
governance route; it carries no client authority or BlobRef. Shells retain raw
`unknown` only until decoding and do not cast to a trusted envelope or use Web
form schemas as a server guarantee. The new DeliverMessage descriptor is the
closed P7 payload at wire codec v1, with External origin denied; typed
ExecutionOrigin submissions use the same semantic validator. Its registered
Handler/result `schemaVersion="1"` is independent from the wire version.
Codec validity grants no authority; P13's UI exposure classification remains
separate. Handler factories for
`ReviseDependencyContract`, `WithdrawDependency`,
`MarkDependencyUnfulfillable`, `RegisterProjectTool`, `CreateWorktree`, and
`RetireWorktree` are factory-only and are not current `RegisteredCommandType`
members or codec descriptors. A future composition registration requires an
accepted registry/codec scope update before reachability. A descriptor cannot
construct or accept AH10 `AssignWorkCommandEvidence` or
`AssignWorkControlAuthorizationEvidence`.

The accepted AH10 Deliver P10 storage amendment adds only the source-specific
P10 projection relation described in §9.3. It does not alter the
CommandGateway receipt tuple/order, external wire codec, DeliverMessage
Handler schema, `MessageSent(v1)`, or ordinary `SendMessage` receipt semantics.

All codecs reject unknown fields at every object depth and enforce the owning
payload's primitive, finite/integer/range, enum/tag, array-member, and branded
ID rules. Shared Domain `ID_SCHEMAS` may be reused after the runtime boundary
has decoded the value. A registered descriptor also validates typed
System/ExecutionOrigin/Recovery-origin submissions before Resolver/Gateway;
an internal validator failure is a typed contract defect/Attention with no
receipt or domain write.

External decode failure returns the transport-only `Problem` DTO:

```ts
{
  code: "InvalidCommandPayload",
  category: "validation",
  message: "Command payload is invalid",
  correlationId: string | null,
  retryDisposition: "non-retryable",
  safeDetails: {
    commandType?: RegisteredCommandType,
    issues: ReadonlyArray<{
      path: ReadonlyArray<KnownFieldPathSegment | "<unknown-field>">,
      rule: "required" | "type" | "format" | "range" | "enum"
          | "unknown-field" | "unsupported-command"
    }>
  }
}
```

Only a server-owned registered command name may appear in
`safeDetails.commandType`. Unknown command values use a static
`["commandType"]` path and do not appear in the response or diagnostics.
Unknown property paths end with the fixed `"<unknown-field>"` marker; caller
property names and values, body fragments, credentials, paths, artifact
content, and exception text are never reflected. Issue ordering is stable.
The existing transport Problem adapter maps malformed/unsupported input to
HTTP 400. This DTO is not a `CommandRejection`, `TerminalRejected`, receipt,
Event, or retryable attempt.

No raw request body, wire version, new receipt comparator, or FT-DG-03 SQL
migration is introduced. Historical malformed CommandIds are preserved
read-only and are non-replayable; reject them before receipt lookup. A
historical receipt whose payload fails the current codec is likewise not
looked up or disclosed. With a valid current payload, stored Handler schema or
fingerprint algorithm mismatch uses the existing exact P1 tuple rule and
returns `IdempotencyConflict`; no historical comparator or row rewrite is
added. Only an exact tuple is decoded through the Application-owned strict
receipt decoder registered for the exact current `(commandType,
Handler.schemaVersion)`. Every current one of the 28 required registered command
handlers must have a Committed-result decoder; TerminalRejected uses the
exhaustive Application `CommandRejection` decoder. Missing version/descriptor,
invalid JSON, wrong shape or unknown rejection member fails as the existing
non-retryable `PersistenceCorruption<"CommandStore">`, never as a semantic
rejection. The result decoder follows the owning result DTO, not a DomainEvent
schema or TypeScript cast. Raw JSON is not reflected or repaired; the existing
Gateway transaction rolls back and writes no Command/attempt/Event or canonical
effect. P1 `01` §3A/`03` §3.1 define the strict shape and rollback contract;
the existing external transport maps it to the safe non-retryable
`persistence/corruption` Problem. No new generic P10 Attention source is
implied.

Recovery's direct prior-receipt consumers are a separate Application route,
not a second Gateway or a candidate-tuple comparison. They select a decoder
from the trusted runtime action CommandType and registered Handler schema,
after prior CommandId/Project identity validation. The direct-child AssignWork
route still requires the full P1 `07`/SD §4.11 binding proof. For a syntax-
corrupt direct-child prior Committed receipt, P9 `07` records the existing
`ReceiptMismatch` failure fact/event and returns
`AgentActionRecoveryBlocked`, retaining only an internal safe
`PersistenceCorruption` classification; no handler replay, new Command, row
repair, Observation or Applied transition is allowed. A2 result-shape failure
and B binding/effect mismatch retain the existing P9 failure-code path.
Non-direct-child prior-consumer corruption remains an operational failure and
does not create a P9 AssignWork fact. `AgentActionRecoveryBlocked` carries no
decoder cause. This clause asserts no current observable logging/diagnostic
sink; a new operator-visible sink remains independently open. The existing P9
fact identity/atomic transaction/crash behavior and P10 AH10 projection remain
unchanged.

This contract does not alter the accepted AH10 direct-child AssignWork
exception: its internal Control route remains external-origin denied; trusted
target/Grant-or-ActionApproval evidence cannot be constructed from JSON. The
binding, same-transaction approval consumption, Work/Event/receipt atomicity,
migration 0033, and P1 `07` proof-complete recovery exception remain governed
by SD §4.11, DID §6A.16/§9.3/§9.9, P4 `03`, and P9/P10 owners. F23 adds no
bypass, codec-generated authority, receipt pre-read, SQL, or alternate
AssignWork recovery path.

For the existing CreateProject payload owner and the FT-DG-01 v2 bootstrap
extension, see §4.1C. This does not change §4.1B's receipt visibility or tuple
ordering.

## 4.1C CreateProject v2 host resource admission (FT-DG-01 functional scope)

CreateProject's current external wire codec remains server-selected v1. Its
registered Handler semantic schema changes to v2; these are different version
axes as defined in §4.1B. P1 `01` owns the closed v2 payload and schema.

```ts
type ResourceSelection =
  | { readonly _tag: "Profile";
      readonly resourceProfileRef: ResourceProfileRef;
      readonly version: ResourceProfileVersion }
  | { readonly _tag: "ConversationOnly" };
```

The v2 root Workspace payload carries ResourceSelection, not
ResourceBoundary.addresses. It rejects absolute paths, raw ResourceBoundary
fields, and mixed selector/address inputs through the registered strict codec.
Invalid shapes use the existing non-reflecting InvalidCommandPayload Problem
and HTTP 400; they do not reach Resolver, Gateway, receipt lookup, or writes.
The semantic fingerprint includes the full selector/ref/version and all other
CreateProject v2 fields, but never re-resolves the current host path into the
same request identity.

The existing P1 transaction and event sequence remains:

```text
Project + Root Workspace + WorkspacePrimary Session + ProjectCreated(v1)
  + WorkspaceCreated(v1) + Committed receipt
```

After the Gateway's in-transaction receipt tuple check proves the CommandId is
absent, the CreateProject handler may query P1's ProjectResourceProfilePort.
This port exposes a deterministic in-memory view of the immutable P12 host
startup registry; it does no filesystem I/O and has no TransactionScope.
Profile(ref, version) maps to exactly one host-canonical FileTree address;
ConversationOnly maps to an empty boundary. An unknown/expired ref produces
the P1 ProjectResourceUnavailable terminal rejection, without Project,
Workspace, Session, Domain Event, or ownership claim. The typed result must map
to the existing non-disclosing TerminalRejected receipt view (rejection tag
only, no path/ref/filesystem detail); it is not a transport Problem. The
CommandGateway preserves the existing terminal-receipt/attempt semantics.

The host Profile is not authority and does not change Resolver behavior. The
resolver remains pure and runs before Gateway as required by §4.1B. In
particular, Profile lookup is not a Composition pre-read and cannot make an
existing receipt depend on current host configuration.

After a successful commit, Application ownership activation re-reads the
persisted root Workspace ResourceBoundary. The existing ProjectEnvironmentPort
and OwnershipWriteService resolve/record that exact boundary outside
BEGIN IMMEDIATE. If the path is gone or resolves to a different canonical
region, activation fails closed without switching to another Profile/path; an
exact receipt retry or restart retries convergence from the same durable
Workspace boundary. The command remains Committed and is never reported as
rolled back. This deterministic activation is a consequence of the committed
CreateProject governance command, not a separate client resource-admission or
GitWorktree command.

Existing v1 Projects, Workspace boundaries, receipts, and ProjectCreated
events remain untouched. A v1 raw-address request that fails the current v2
codec is rejected before Resolver/Gateway. A valid current v2 candidate whose
CommandId collides with a stored v1 receipt follows §4.1B's schema/fingerprint
tuple mismatch and returns non-disclosing IdempotencyConflict; no historical
decoder or stored-schema comparison is permitted. This is preserve-only, not a
successful old v1 same-ID replay.

F21 browser qualification remains pending until its positive browser journey
and public raw-path/ref negative cases pass in the default functional suite.
Profile-source audit (OPEN-1), old v1 same-ID success (OPEN-2), and durable
public Attention for post-commit activation failure (OPEN-3) are not closed by
this functional-scope contract.

## 4.2 Public / Governance Commands

### Project

```text
CreateProject
UpdateProjectPolicy
RenameProject
CloseProject
```

### Workspace / Governance

```text
CreateChildWorkspace
ChangeResponsibility
UpdateResourceBoundary
UpdateWorkspacePolicy
ReplacePrimarySession
```

### Work

```text
AssignWork
SelectCurrentWork
RefineWork
CompleteWork
CancelWork
SteerWork
```

### Coordination

```text
DeclareDependency
SatisfyDependency
ProduceDeliverable
WithdrawDependency
MarkDependencyUnfulfillable
ReviseDependencyContract
SendMessage
DeliverMessage
```

### Verification / Acceptance

```text
StartVerification
RecordVerificationEvidence
ConcludeVerification
AcceptWorkOutcome
```

### Permission / Decision

```text
GrantPermission
RevokePermission
RecordDecision
```

## 4.3 Internal Runtime Commands

对外不必暴露，但仍进入 Application mutation pipeline：

```text
AdmitExecution
SettleExecution
StopExecution
```

这些 mutation 会改变未来系统行为或产生 Domain Event，因此不应作为裸 Repository update。

`RecordEnvironmentChange` 由 **P11** 拥有（Environment 语义）；P2 只消费 environment
revision / change facts，不实现该 command。

## 4.4 Domain Semantic Mutation 与 Runtime Operational Mutation

规则修订为：

```text
Domain/Governance semantic mutation
→ Application Command Pipeline

Runtime operational mutation
→ owning Runtime Port
```

Runtime operational examples：

```text
Lease heartbeat
Session entry append
Provider turn trace
Tool invocation trace
Consumer offset
Projection update
```

但 Execution admission/settlement、Primary Session replacement、Environment change 等影响未来行为的变化仍使用 internal Command。

---

# 5. DID-5 — Domain Events & Consumers

## 5.1 Event pipeline

```text
Command
↓
Authority / Preconditions / Invariants
↓
DB Transaction
├── Canonical State
├── Command Result
└── Domain Event Journal
↓
COMMIT
↓
Event Dispatcher
├── Scheduler Consumer
├── Coordination Consumer
├── Projection Consumer
├── Context/Knowledge Consumer
└── Operations Consumer
```

核心：

```text
Events notify; Canonical State decides.
Consumers react; Commands mutate.
At-least-once + Idempotency.
```

## 5.2 Event Envelope

```text
DomainEvent<E>
├── eventId
├── projectId
├── sequence
├── eventType
├── eventVersion
├── occurredAt
├── aggregateRef
├── actor
├── causedByCommandId?
├── causedByEventId?
├── correlationRef?
└── payload
```

Event payload 只描述有意义的 change fact，不复制完整 Aggregate snapshot。

## 5.3 核心 Event Catalog

```text
ProjectCreated
ProjectPolicyChanged
ProjectClosed

WorkspaceCreated
ResponsibilityChanged
ResourceBoundaryChanged
ResourceOwnershipChanged
WorkspacePolicyChanged
WorkspaceRetired
WorkspaceLineageRecorded
PrimarySessionReplaced

WorkAssigned
CurrentWorkChanged
WorkRefined
WorkCompleted
WorkCancelled
WorkSteered

DependencyDeclared
DependencySatisfied
DependencyWithdrawn
DependencyMarkedUnfulfillable
DependencyContractRevised
DeliverableProduced
MessageSent
DeadlockAttentionRequested

VerificationStarted
VerificationConcluded
WorkOutcomeAccepted

ExecutionAdmitted
ExecutionStopRequested
ExecutionSettled

PermissionChanged
DecisionRecorded
ExecutableApprovalRequested
ExecutableApprovalResolved
ReconciliationEscalated
AssignWorkTargetBindingEscalated
DeliverReplayEscalated
ToolObservationReplayEvidenceEscalated
SubmittedDecisionBindingEscalated
EnvironmentChanged
HumanInterventionApplied        # v1.13 G7: {actor, targetWorkspaceId, summaryRef, occurredAt, kind}
```

`MessageSent` remains EventVersion 1. Its `Deliver` payload is the P7 v1
shape `{messageId, kind:"Deliver", sender, recipient, deliverableId,
correlationId, causationId}`; non-Deliver payloads are unchanged. The AH10
`DeliverMessage` route adds no MessageSent version or wake event. It adds the
P9-owned `DeliverReplayEscalated(v1)` fact event for an unprovable legacy or
receipt-bound handover; P10 consumes it as `DeliverReplayFailure` Attention.

AH7-DG-01 adds `ToolObservationReplayEvidenceEscalated(v1)` for a valid-fence
terminal Observation evidence failure. Payload is exactly
`{attentionFactId, executionId, targetWorkspaceId, logicalActionId,
providerTurnId, callRef, invocationId, failureCode}`; its envelope uses the
Execution project, target Workspace aggregate, `logicalActionId` correlation,
`system:recovery` actor and no Command cause. It contains no Observation,
tool arguments/output, Artifact body, path or raw exception. P9 commits the
immutable fact+event atomically; P10 owns the marker/read-model projection.
This event is distinct from `ReconciliationEscalated`: absent replay evidence
does not claim an unresolved external effect.

P41 adds `SubmittedDecisionBindingEscalated(v1)` for the exact immutable P9
fact keyed by `(executionId, logicalStepNo, repairAttempt, logicalActionId)`.
Its payload is exactly `{attentionFactId, executionId, workspaceId,
logicalStepNo, repairAttempt, providerTurnId, logicalActionId, failureCode}`;
the authoritative Execution Workspace is the aggregate/Attention target and
the LogicalActionId is the correlation. `caused_by_command_id` is the unique
original Committed `SelectCurrentWork` CommandId when present, otherwise null.
The closed failure codes are `DecisionRequestWorkspaceMismatch`,
`StepManifestMismatch`, and `SettledExecutionWithPendingDecisionAction`. It
contains no candidate Work list,
model text, corrupt opaque value, or parser/database details. The event id is
stored as an audit identifier on the P9 fact, not as a foreign key to the
prunable event journal.

EA-DG-01 adds `ExecutableApprovalRequested(v1)` and
`ExecutableApprovalResolved(v1)` as durable wake facts. Requested carries the
approval/route/Workspace/Execution/LogicalAction/ToolInvocation identity,
request revision, expiry and action digest; it does not copy tool arguments or
make the approval contents instructions. Resolved carries approval/route/
Workspace/Execution identity, resulting revision and one of
`Approved | Rejected | Expired | Cancelled`; the event envelope carries the
authenticated decision actor when present. The approval row, exact P6 Inbox
admission/consumption and corresponding event are written in the same
transaction. P17 resumes only the bound Execution from the durable resolved
fact/list and never starts a new ProviderTurn.

The EventVersion-1 payloads are:

```ts
ExecutableApprovalRequested = {
  approvalId, routeKind: "Executable", workspaceId, executionId,
  logicalActionId, toolInvocationId, revision, expiresAt, actionDigest
}

ExecutableApprovalResolved = {
  approvalId, routeKind: "Executable", workspaceId, executionId,
  logicalActionId, toolInvocationId, revision,
  resolution: "Approved" | "Rejected" | "Expired" | "Cancelled",
  reasonCode?
}
```

Raw arguments, secret values and model-written summaries are not copied into
the event. The exact binding remains in the route-specific ActionApproval row;
`Resolved` is the durable P2/P17 wake fact.

高频 Provider Turn、Tool Invocation、Lease Renew、stream delta 不进入 Project Domain Event Journal，而进入 Execution Trace / Runtime Records。

## 5.4 Consumer 规则

- Consumer 使用 at-least-once delivery；
- Consumer 不直接绕过 Command Handler 修改 Domain；
- Event→Command 使用 deterministic CommandId，保证重投幂等；
- Projection failure 不回滚 Domain transaction；
- Projection/Context stale 通过 retry/catch-up/rebuild 恢复；
- Event 不自动等于“启动 Agent”，只触发 runnable reevaluation。

---

# 6. DID-6 — System Invariant Enforcement Map

## 6.1 六层 Enforcement

| Layer | 责任 |
|---|---|
| L1 `Domain Pure Logic` | 单 Aggregate 内部合法性、ADT、terminal transition |
| L2 `Command Handler / Application` | 跨 Aggregate、Authority、业务前置条件 |
| L3 `Persistence / Transaction` | 并发唯一性、幂等、CAS、fencing、原子性 |
| L4 `Runtime Coordination` | Scheduler、Lease、Recovery、external-effect lifecycle |
| L5 `Tool/Sandbox` | 对现实资源的物理限制 |
| L6 `Projection/Diagnostics` | Deadlock、Attention、Human override propagation 等可推导事实 |

硬规则：

```text
Hard invariant != Prompt instruction
```

## 6.2 Enforcement Matrix

| Invariant | L1 | L2 | L3 | L4 | L5 | L6 |
|---|---:|---:|---:|---:|---:|---:|
| Parent immutable | ✓ | ✓ |  |  |  |  |
| Workspace Tree 同 Project |  | ✓ | ✓ |  |  |  |
| CurrentWork <= 1 | ✓ | ✓ | ✓ |  |  |  |
| Active Main Execution <= 1 |  |  | **✓** | ✓ |  |  |
| Write ownership 不重叠 |  | ✓ | ✓ |  | **✓** |  |
| Parent/Sibling authority |  | **✓** |  |  |  |  |
| Work terminal lifecycle | **✓** | ✓ |  |  |  |  |
| Verification + Acceptance before Complete |  | **✓** |  |  |  |  |
| Producer/Verifier 隔离 |  | ✓ |  | ✓ | **✓** |  |
| Session cognition-only | schema | ✓ |  |  |  |  |
| Dependency satisfaction immutable | ✓ | ✓ |  |  |  |  |
| Deadlock attention |  |  |  |  |  | **✓** |
| Command idempotency |  | ✓ | **✓** |  |  |  |
| State + Event atomic |  |  | **✓** |  |  |  |
| Consumer idempotency |  |  |  | **✓** |  |  |
| Lease fencing |  |  | **✓** | **✓** |  |  |
| Tool authority chain |  | ✓ |  | **✓** | **✓** |  |
| OutcomeUnknown reconcile |  |  |  | **✓** |  |  |
| Human override propagation |  |  |  |  |  | **✓** |
| Verification version binding | ✓ | ✓ |  |  |  |  |

## 6.3 Fencing 范围与原子性

Fencing 不只保护 `Execution` row，而保护所有 Worker-originated durable write：

```text
Execution semantic mutation
Session append
ProviderTurn settlement
ToolInvocation settlement
Agent-produced canonical command
```

所有此类 durable mutation 都携带：

```text
executionId + fencingGeneration
```

但语义分两层：

```text
CommandGateway / Runtime pre-check
→ 只用于快速失败

authoritative fence validation
→ 必须在 canonical mutation 的 SAME transaction 内完成
```

对于 Execution-originated semantic command，至少以下动作处于同一事务一致性快照/提交边界：

```text
fence validation
+ canonical reads used by decision
+ authority/precondition evaluation inputs
+ canonical writes
+ Command resolution
+ Domain Event append
```

Adapter 可以通过 transaction-scoped connection 或带 generation 条件的 CAS/UPDATE 实现，但不能采用“事务外检查 fence → 事务内盲写”的 TOCTOU 模式。

旧 Worker 即使恢复也不能污染当前现实状态。`FencingRejected` 是 persistence enforcement 的权威拒绝；该 Worker 必须停止 durable mutation。


## 6.4 LLM 与 Runtime 的职责边界

```text
LLM judges semantics.
Runtime guarantees invariants.
DB enforces structural concurrency truth.
Sandbox enforces physical boundaries.
```

LLM 可以参与 Responsibility Formation、Work planning、semantic conflict detection、Verification investigation、Memory extraction；但不能成为 parent immutability、permission ceiling、lease、command idempotency、state+event atomicity 的最终 enforcement point。

---

# 6A. Pre-implementation Closure — Error Algebra & Failure Semantics

## 6A.1 Error、Outcome、Control Flow、Unknown 必须分开

Arbor 将“不正常”严格区分为：

| 类别 | 语义 | 典型例子 | Effect 表达 |
|---|---|---|---|
| Normal Alternative | 合法替代结果 | Verification.Unknown、Tool ExpectedFailure | `A` 中 ADT |
| Blocked / Deferred | 当前不能继续但系统未坏 | unresolved Dependency、GovernanceBlocked | `A` 中 control result / Yield |
| Rejection | 请求与 Canonical State/Authority 不兼容 | WorkNotOpen、AuthorityDenied | typed `E` |
| Conflict | stale/concurrent attempt 失效 | RevisionConflict、FencingRejected | typed `E` |
| Operational Failure | 外部设施失败 | ProviderUnavailable | typed `E` |
| Ambiguous Outcome | 外部副作用是否发生未知 | Tool OutcomeUnknown | settlement/state，不是 generic error |
| Defect | 理论不可能状态/程序 bug | invariant violation | defect / Cause |
| Interruption | 明确取消/停止 | StopExecution、shutdown | interruption |

核心规则：

```text
Normal outcome != Error
Blocked        != Failed
Execution fail != Work cancellation
```

## 6A.2 不存在万能 `ArborError`

Package/API 内部使用 narrow tagged error algebra。函数签名应精确反映调用方可处理的失败，不允许把所有错误压成：

```text
Effect<A, Error>
```

或者：

```text
{ success: false, message: string }
```

外部 API 可以统一映射成 presentation `Problem` DTO，但这不改变内部 typed error。

## 6A.3 FailureDisposition

Runtime 对 typed error 的处理通过独立纯分类得到，而不是把 `retryable: true` 写死在每个 Error 上：

```text
FailureDisposition
├── ReturnToCaller
├── RetrySameLogicalCommand
├── RetryWithBackoff
├── WaitForStateChange
├── ReconcileBeforeRetry
├── SettleExecutionFailed
├── SettleExecutionOutcomeUnknown
└── EscalateAttention
```

同一个错误在不同 operation context 下可以产生不同 disposition。

## 6A.4 Persistence translation

SQLite / SQL implementation errors 不越过 Adapter boundary。典型映射：

```text
partial unique violation on active main execution
→ ActiveExecutionConflict

CAS affectedRows = 0
→ RevisionConflict

lease generation mismatch
→ FencingRejected

DB unavailable / I/O failure
→ PersistenceUnavailable
```

内部 row decode 出现违反当前 schema 且不存在合法 migration 路径的 impossible state，应视为 corruption/defect，而不是普通 DomainError。

## 6A.5 Conflict 语义

必须区分 **operational contention** 与 **semantic stale precondition**。

### Operational contention

例如：

```text
temporary DB lock / busy
transient transaction abort
persistence temporarily unavailable
```

如果 logical payload 与它依赖的语义前提没有改变，可以：

```text
same CommandId
→ new CommandAttempt
```

Runtime 只在确认 attempt 等价时进行 bounded retry/backoff。

### Semantic stale precondition

若 Command payload 明确携带：

```text
expectedRevision = 17
```

而 canonical state 已经是：

```text
actualRevision = 18
```

则这是该 logical request 的 `RevisionConflict`。若 caller 必须 reload / re-evaluate 并把 expected revision 改成 18，payload 已变化，因此：

```text
old CommandId
→ TerminalRejected(RevisionConflict)

re-evaluated request
→ new CommandId
```

`FencingRejected` 更严格：它表示提交者已经失去 execution ownership，该 Execution-originated logical Command terminal，旧 Worker 禁止普通 retry。

同时区分：

```text
LeaseLost       = worker/runtime 的本地所有权知识
FencingRejected = persistence enforcement 给出的权威拒绝
```

Lease loss / fencing rejection 都不自动让 Work 失败或取消；Worker crash/lease expiry 也不直接决定 durable Execution settlement。


## 6A.6 Execution Settlement

Execution 不再只保存四值 outcome，而保存合法 sum type：

```text
ExecutionSettlement
├── Completed(CompletedResult)
│   ├── Yielded
│   ├── CompletionClaimed
│   ├── VerificationConcluded
│   └── Blocked (exact Work Episode only)
├── Interrupted(InterruptedResult)
├── Failed(ExecutionFailure)
└── OutcomeUnknown(ReconciliationRequired)
```

精确定义：

- `Completed(...)`：episode 正常到达稳定边界；new-write result 必须符合 exact EGP `ExecutionEpisodeBinding`。Work Episode may report `Blocked` only with the exact denial/request contract in P2 `01`; historical `CoordinationCompleted` / `QueryCompleted` are decoder/audit-only；
- `Interrupted(...)`：外部控制明确提前结束，并且不存在 unresolved ambiguous side effect；
- `Failed(...)`：当前 episode 无法继续，正常恢复策略已耗尽或错误不可恢复；
- `OutcomeUnknown(...)`：存在外部副作用可能已经发生但系统无法确定，必须先 reconciliation。

关键规则：

```text
Execution Completed != Work Completed
Execution Failed    != Work Cancelled
technical outcome   != semantic terminal result
```

Worker crash、daemon crash、lease expiry 本身不直接产生 settlement；Recovery 根据 durable trace、lease 与 external-effect settlement 决定继续同一 Execution、settle 或产生后续动作。

`CompletionClaimed` settlement 必须能够 durable 地驱动：

```text
ExecutionSettled(CompletionClaimed)
→ event consumer
→ deterministic StartVerification CommandId
→ StartVerification
```

consumer 不直接绕过 Command Handler 创建 Verification。


## 6A.7 Tool failure model

```text
ToolInvocationSettlement
├── Success
├── ExpectedFailure
├── Denied(reasonCode: NoEffectDenialCode; P36 only with NotAdmitted)
├── Interrupted
├── OutcomeUnknown
├── ReconciledNoEffect(reconciliationFactRef, reasonCode)
└── RuntimeFailure
```

P36 `Denied/NotAdmitted` remains the durable no-effect result with closed
`NoEffectDenialCode` and its version-1 deterministic projection. P40 preserves
it with `result_ref` and all three P40 evidence columns NULL; it is not an
Observation-envelope tag and must not be mapped to ExpectedFailure.

P4 replay evidence corruption is a typed operational failure, not a new
settlement or side-effect tag:

```ts
type ToolObservationReplayEvidenceFailureCode =
  | "Missing" | "UnsupportedVersion" | "Malformed" | "HashMismatch"
  | "SettlementMismatch" | "IntentMismatch" | "ResultRefMismatch"
  | "UnexpectedResultRef";

type ToolObservationReplayEvidenceFailure = {
  readonly _tag: "ToolObservationReplayEvidenceFailure";
  readonly failureCode: ToolObservationReplayEvidenceFailureCode;
};
```

The failure carries no raw JSON, Observation, output, Artifact body, parser/OS
text or arbitrary cause. A valid current fence maps it to the existing
RecoveryBlocked/P9/P10 path; stale fencing remains ownership loss only.

`pytest failed`、`git conflict`、shell exit 1 等通常是模型需要认知的 `ExpectedFailure Observation`，不应导致 Agent fiber 失败。

ToolDefinition 必须声明：

```text
SideEffectSemantics
├── ReadOnly
├── Idempotent
├── Reconcilable
└── NonIdempotent
```

Retry rule：

```text
ReadOnly      → transient retry allowed
Idempotent    → same invocation key replay allowed
Reconcilable  → unknown 时先 reconcile 再决定 replay
NonIdempotent → ambiguity 时禁止自动 replay
```

For recovery of `MayHaveStarted`, a P4-owned versioned profile binds the exact
tool definition, effect attempt/key, RecoveryBinding and authoritative reality
source. Its closed outcomes are `NotOccurred`, `Occurred`, and `StillUnknown`;
absence of a local result or an eventually-consistent negative query is not
proof. `StillUnknown` never admits a replay. `Occurred` settles only with a
reconstructable canonical result. Only authoritative, final `NotOccurred` may
permit at most one exact-invocation replay after fresh authority, approval,
resource, stop and full lease-fence revalidation. Stop blocks new admission but
does not block accounting for known in-flight facts under the current fence.
Terminal reconciliation-produced Success/ExpectedFailure/ReconciledNoEffect
selects exactly one immutable fact for the same invocation and attempt; late
contradictory evidence is append-only and does not rewrite terminal P4/P3 state.

Authority/Permission denial 在 ToolRuntime 内是 rejection，但应投影成模型可理解的 `ToolInvocationDenied` Observation，而不是崩溃 Execution。

Approval-required Executable invocation has a separate nonterminal
`ApprovalRequired` ActionResult/Execution handoff. It is not a
`CanonicalToolObservation`, a `ToolInvocationSettlement`, or a P4 no-effect
Denied result. New writes MUST keep the same AgentLoopStep action Pending and
the cursor fixed until an exact approval decision/expiry/cancellation is
resolved. The old P4 `Denied(ApprovalRequired)` reason remains accepted only
by persisted-row decoding and terminal replay; migration MUST NOT reinterpret
or backfill it as a human approval request. On Approve the same invocation
re-enters P4; Reject/Expire produce a terminal no-effect Denied result, while
Stop produces Interrupted. Current authority, resource, ControlBasis, stop,
and lease checks still apply after any approval.

> **P4（DID v1.8 G1/G4）：** tool authority 是 trusted `InvocationAuthority`
> fact，不由 ToolRuntime 解析 PermissionGrant / Parent / User；Resource
> Admission 只做 validate-only（`ResourceOwnership ⊆ ResourceBoundary`），
> 不获取/释放 ownership。见 §7.6 与 §11 P4。

## 6A.8 Provider failure model

至少区分：

```text
RateLimited
ProviderUnavailable
AuthenticationFailed
RequestRejected
StreamInterrupted
ProtocolViolation
```

`ModelOutputContractViolation` 不属于 Provider transport failure，而属于 Model Context / Agent Runtime：请求已经成功，只是模型输出不符合当前 Output Contract。允许 bounded repair；repair policy 耗尽后才 settle Execution Failed。

## 6A.9 ProviderTurn 与 ProviderAttempt

逻辑一次模型决策是 `ProviderTurn`，固定一份 `ModelContextManifest` 与 OutputContract；transport retry 是该 Turn 下的多个 `ProviderAttempt`：

```text
ProviderTurn T17
├── Attempt #1 → transient network failure
└── Attempt #2 → success
```

`ProviderAttempt` 使用 Turn-local ordinal，不需要新的全局 Entity ID。Provider retry 不得被误记为 Agent 多思考了一轮。

## 6A.10 Model Context control results

`prepareTurn()` 的 success/control ADT：

```text
TurnPreparation
= Ready(PreparedModelTurn)
| NeedsCompaction(CompactionRequest)
| GovernanceBlocked(GovernanceIssue)
```

其中 `NeedsCompaction` 与 `GovernanceBlocked` 都是合法 control result，属于 `A`。

`ContextUnsatisfiable` 不属于该 ADT，而属于 typed `E`：Mandatory/Pinned context 在当前允许模型策略下无法合法构造。

因此语义合同为：

```text
prepareTurn(...)
→ Effect<
    TurnPreparation,
    ContextUnsatisfiable | <narrow translated operational failures>,
    ModelContextRequirements
  >
```

具体 port failure 继续按 A/E/R 原则保留窄的 semantic error，不合并成万能 `ContextPreparationError`。

Instruction conflict 也不天然是 Error：可由 Authority/Scope/Composition 确定性消解的冲突是 Resolver 正常工作；只有无法消解的同级 canonical conflict 才形成 `GovernanceBlocked`。


## 6A.11 Verification 与 Waiting

`Verification.Unknown` 永远是合法 Verdict，不是 Error；unresolved Dependency / pending Decision / Human approval 也不是 Work failure。

```text
blocked
→ Work remains Open
→ current Execution yields/settles
→ future event wakes Workspace
```

## 6A.12 Error translation boundary

低层错误跨语义边界前必须翻译：

```text
SQLite / SDK / OS error
↓ adapter translation
Persistence / Provider / Tool semantic error
↓ runtime handling
Agent-facing Observation / Application error
↓ API mapping
Problem DTO
```

Agent 与用户不看到 SQL、SDK object、raw stack、secret；Operations 保留完整 Effect Cause、correlation、Execution/Turn/Invocation references。

## 6A.13 Domain Event 与 Failure

Command terminal rejection 不是 Domain Event，因为 Domain truth 未变化；但它可以是 durable `CommandReceipt(TerminalRejected)`，用于保证同一 logical request 的稳定 resolution。Execution 真正 settle 后产生 `ExecutionSettled`。Domain Event Journal 不是错误日志。

## 6A.14 Error 不直接改变 Work lifecycle

ProviderUnavailable、WorkerCrash、ToolRuntimeFailure、ContextUnsatisfiable、ExecutionFailed 都不能自动将 Work 改为 Cancelled。Work Cancelled 只来自正式治理意图。

## 6A.15 Failure algebra layering

三类 failure 必须分开，且各有归属：

```text
1) DomainError — pure domain transition 的 expected rejection。
   Domain 不得依赖 Application 的任何 rejection 类型。
   DomainError =
     IdempotencyConflict | AuthorityDenied | RevisionConflict | WorkNotOpen |
     TerminalLifecycleMutation | RetirePreconditionFailed |
     ActiveExecutionConflict | VerificationAcceptanceMismatch |
     DependencyNotSatisfiable | PermissionRevoked

2) CommandRejection (Application-owned)
   = CommandResolution.TerminalRejected 的 payload
   = DomainError | FencingRejected | ExecutionStopping | WorkspaceNotFound
     - FencingRejected: ownership/fence 无效。
     - ExecutionStopping: fence 仍有效，但 stopRequestedAt != null，
       禁止新的 execution-originated mutation。
     - WorkspaceNotFound: handler 加载目标 Workspace 时不存在。
       (ExecutionStopRequested 仍是既有 Domain Event / stop-request fact
        名称，不新增 DomainError tag。)

3) OperationalFailure — 非 authoritative、非 terminal；不进入
   CommandResolution；不冻结为顶层单一 closed union，由 owning layer
   按 phase 细化（如 PersistenceUnavailable / transport / transient）。
```

`CommandResolution` 是参数化 ADT：

```text
CommandResolution<Result, Rejection> =
    Committed(Result)
  | TerminalRejected(Rejection)

Domain 内部：CommandResolution<R, DomainError>
Application boundary：CommandResolution<R, CommandRejection>
```

规则：

```text
FencingRejected 属于 Application CommandRejection，不是 DomainError。
OperationalFailure 不产生 authoritative resolution，可 retry。
```

P0 的 `CommandResolution<R>`（`TerminalRejected(DomainError)`）是 v1.5 前的
artifact，已被本节的参数化 `CommandResolution<Result, Rejection>` 取代；
P1 负责演进该 artifact。

## 6A.16 AssignWork target binding and committed-receipt recovery

For a new direct-child AssignWork, Runtime resolves the exact opaque
`targetWorkspaceRef` from current PlacementContext and carries the typed
resolution plus exact CAPA authorization evidence unchanged through the
ControlAction handler into the Command Gateway. In one `TransactionScope`, the
Gateway re-reads and validates the current Parent Workspace/Work and target,
project and direct-parent edge, Active target lifecycle, resolved target
revision, pinned source-action identity, and the exact PermissionGrant or
ActionApproval row. A stale selector/revision, retired or foreign target,
revoked/expired/mismatched Grant, stale/mismatched approval, or source-action
mismatch is rejected before canonical Work mutation.

Successful resolution writes the child Work, `WorkAssigned` event, Committed
Command receipt, and exactly one immutable `AssignWorkTargetBinding` in that
same transaction. The binding carries the original opaque selector and
encoding version, canonical target and observed revisions, project and Parent
identities, Work and provenance, typed authority snapshot, and exact
`ExecutionId`, `ProviderTurnId`, `LogicalActionId`, and `callRef`. The target
must match the receipt, Work row, and event. The binding is trusted resolution
evidence and is excluded from `semanticRequestFingerprint`; it is never
constructed from model arguments except for retaining the exact selector.

For a prior Committed receipt belonging to the same pinned AssignWork
LogicalAction, recovery requires the binding keyed by that exact CommandId and
validates it against the action, authority, receipt, Work/provenance, event,
project, and direct-parent relation. It does not re-resolve the selector,
re-authorize, consume approval again, issue a new Command, or repeat Provider
inference. A fully matching binding converges the existing Action and its
single sourced Observation. A missing, duplicate, malformed, conflicting,
foreign, or mismatched binding/effect (including an old unbound Committed
receipt) leaves the Action Pending and emits no Observation; P9 records its
durable immutable failure fact/event and stops recovery. No backfill, inferred
child, or canonical repair is permitted. The failure projects through the P10
owner contract. This is the only exception to P1 `07`'s generic prior-
Committed receipt convergence rule; FencingRejected takeover remains
unchanged.

The exact typed authority variant is either the commit-checked
PermissionGrant evidence or the exact Approved ActionApproval evidence.
ActionApproval validation and single consumption are atomic with canonical
handler resolution; a pre-handler FencingRejected/ExecutionStopping result
does not consume it. On replay an ActionApproval must be Consumed by the
original CommandId at exactly the next revision and retain its exact immutable
action/target/ControlBasis facts. Grant revocation/expiry after commit does not
retarget or invalidate the effect. CAPA and ResourceBoundary authority are not
widened.

The target Workspace must be Active at initial Command commit. A later Retired
lifecycle preserves proof-complete replay; a target already Retired at commit
is rejected. The binding is not a stable-reference hash contract; replay must
not enumerate historical `wref_` revisions.

The process-local trusted evidence is ports-owned and is passed unchanged
through ControlAction → AssignWork handler → Command Gateway:

```ts
type AssignWorkControlAuthorizationEvidence =
  | {
      readonly _tag: "PermissionGrant";
      readonly permissionGrantId: PermissionGrantId;
      readonly permissionGrantRevision: number;
      readonly projectId: ProjectId;
      readonly subjectKind: "WorkspaceAgent" | "Execution";
      readonly subjectRef: string;
      readonly capability: "core.control.assign-work";
      readonly targetRef: WorkspaceRef;
      readonly validFrom: Instant;
      readonly expiresAt: Instant | null;
      readonly actionDigest: Sha256;
      readonly controlBasisDigest: Sha256;
    }
  | {
      readonly _tag: "ActionApproval";
      readonly approvalId: ActionApprovalId;
      readonly approvalRevision: number;
      readonly projectId: ProjectId;
      readonly workspaceId: WorkspaceId;
      readonly executionId: ExecutionId;
      readonly stableActionId: "core.control.assign-work";
      readonly actionDigest: Sha256;
      readonly targetRef: WorkspaceRef;
      readonly controlBasisDigest: Sha256;
      readonly expiresAt: Instant;
    };

type AssignWorkTargetBinding = {
  readonly schemaVersion: 1;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: LogicalActionId;
  readonly callRef: CallRef;
  readonly parentWorkspaceId: WorkspaceId;
  readonly parentWorkId: WorkId;
  readonly parentWorkRevisionAtCommand: number;
  readonly targetWorkspaceRef: WorkspaceRef;
  readonly targetRefEncodingVersion: number;
  readonly parentWorkspaceRevisionAtCommand: number;
  readonly targetWorkspaceRevisionAtResolution: number;
  readonly targetWorkspaceId: WorkspaceId;
  readonly targetLifecycleAtCommit: "Active";
  readonly workId: WorkId;
  readonly predecessorWorkId: WorkId;
  readonly workProvenanceJson: string;
  readonly authority: AssignWorkControlAuthorizationEvidence;
  readonly authorityCheckedAt: Instant;
};

type ResolvedChildPlacementRef = {
  readonly _tag: "ResolvedChildPlacementRef";
  readonly projectId: ProjectId;
  readonly targetWorkspaceId: WorkspaceId;
  readonly targetWorkspaceRevision: number;
  readonly refEncodingVersion: 1;
};
```

`WorkspacePlacementPort.resolveChildRef(rootWorkspaceId, ref)` returns
`Option<ResolvedChildPlacementRef>`; the port alone constructs the typed
result. `rootWorkspaceId` is the current Execution Workspace and direct Parent,
which may be non-root in the Project tree. The handler retains the exact
original selector and passes it plus the resolved value, Parent/current-Work
identities, and typed authorization as trusted `AssignWorkCommandEvidence`.
The gateway re-reads the parent, its current Work, and target in the Command
transaction, checks direct-parent/project/lifecycle/revision, and captures
Parent and Work revisions at that boundary.

`AssignWorkTargetBindingRepository.findByCommandId(commandId)` and
`insert(binding)` require the existing `TransactionScope`. `RecoveryAttentionFactStore`
provides `recordAssignWorkBindingFailure(fact)` and
`findAssignWorkBindingFailure(attentionFactId)` under the same scope; record
atomically appends the dedicated event and immutable P9 fact, and returns an
existing row only for the exact same identity tuple. The same P9-owned port
also provides `recordDeliverReplayFailure(fact)`,
`findDeliverReplayFailure(attentionFactId)`, and
`findDeliverReplayFailureByEventId(eventId)`,
`listDeliverReplayFailures(projectId)`, `listPendingDeliverReplayAttention(projectId,limit)`,
and `acknowledgePendingDeliverReplayAttention(attentionFactId)` for the
accepted AH10 Deliver route;
these methods use the separate `deliver_replay_attention_facts` relation,
and `deliver_replay_attention_pending` outbox. They retain the same
transaction-scoped append/dedup/error guarantees, and do not
alter the existing AssignWork fact identity or schema. They return the existing
`RecoveryAttentionFactStore` repository/journal errors and typed
`RecoveryAttentionFactInvariantConflict`; no generic Attention port or new
store error union is introduced.
The same P9-owned port provides
`recordSubmittedDecisionBindingFailure(fact)`,
`findSubmittedDecisionBindingFailure(attentionFactId)`, and
`listSubmittedDecisionBindingFailures(projectId)` by exact
`(executionId, logicalStepNo, repairAttempt, logicalActionId)` identity. Fact
and event share the caller's `TransactionScope`; same-tuple retry returns the
immutable winner and a conflicting payload fails closed. P3 returns only a
typed mismatch classification and pure Stop-close plan through
provider-neutral ports; it has no P9 implementation dependency. The P9
Recovery/Application coordinator owns a cross-store transaction when it also
applies that plan through `AgentLoopStepStore`.

---

# 7. DID-7 — Ports / Runtime Interfaces

## 7.1 Port 原则

Port 在实现层正式建模为 Effect service；`R` channel 是依赖契约的一部分，而不是隐藏实现细节。Port 只用于隔离：

> 调用方需要一种能力，但不应该知道能力如何实现。

确定性领域逻辑如 `AuthorityEvaluator`、`RunnableEvaluator`、`DeadlockAnalyzer` 不因为“像服务”就必须成为 Infrastructure Port。

## 7.2 Port Catalog

### Persistence

```text
ProjectRepository
WorkspaceRepository
WorkRepository
ExecutionRepository
SessionRepository
AgentLoopStepStore
ProviderTurnStore
VerificationRepository
DependencyRepository
DeliverableRepository
AcceptanceRepository
DecisionRepository
PermissionGrantRepository
ControlApprovalStore
AssignWorkTargetBindingRepository
RecoveryAttentionFactStore
ResourceOwnershipRepository
ArtifactMetadataRepository
MessageStore
CommandStore
TransactionPort
DomainEventJournal
```

### Runtime / External capability

```text
ProviderPort
ToolRuntimePort
ProjectEnvironmentPort
SandboxPort
WorkerDispatchPort
ExecutionDriverPort
BlobStorePort
KnowledgeQueryPort
KnowledgeStorePort
ProjectionQueryPort
ModelCapabilityPort
AgentContextSourcePort
ToolCatalogPort
WorkspacePlacementPort
SecretStorePort
HealthPort
Clock
IdGenerator
```

The accepted AH10 Deliver P10 marker is a source-specific P10 projection
relation over P9-owned facts, not a new generic port. Existing transaction,
event-consumer, projection-query and rebuild boundaries remain in force.

`InputPromotionService` 是 Application/Runtime orchestration service，不是
infrastructure Port。它使用 `TransactionPort + SessionRepository +
InboxProjectionStore` 在同一事务中完成 sourced Session append 与 Inbox consumed。

> **P12 TR-6 propagation (P12 `04` §2.1; DID v1.14 G4).** `HealthPort` is an
> explicit P12 catalog addition (declared in `packages/ports`; implemented by the
> `observability` module). It is a catalog addition only: it changes no existing
> port's semantics and adds no physical package or dependency edge (DID §10.4.1
> unchanged). Recorded here as the owning frozen catalog surface; see `P12 00`
> TR-6.

## 7.3 Repository API follows Invariants, not CRUD

明确禁止通用：

```text
Repository<T> {
  findById
  save
  delete
}
```

关键 Repository 直接编码并发语义。

`ExecutionRepository` 示例：

```text
tryAdmitMainExecution(...)
tryAcquireLease(executionId, workerId)
renewLease(executionId, workerId, generation, expiry)
settleIfCurrentLease(...)
findExpiredActiveExecutions(...)
findUnsettledExecutions(...)
```

Execution admission 与 lease acquisition 分开，满足：

```text
Durable Admission
↓
Worker Dispatch
↓
Lease Acquisition
```

## 7.4 TransactionPort 与 transaction propagation

Semantic Command 的权威 resolution 必须建立在一个 transaction scope 上。语义合同：

```text
TransactionPort
creates ONE semantic transaction scope

within that scope:
  all participating Repository reads/writes
  authoritative fencing validation
  Command resolution
  DomainEventJournal append

observe/write through
the same transactional database session
```

因此禁止：

```text
TransactionPort.transact(...)
  ├── WorkspaceRepository → connection A
  ├── WorkRepository      → connection B
  └── DomainEventJournal  → connection C
```

即使 API 表面被 `transact()` 包裹，只要各 Repository 自行取得独立 connection，就不满足 Arbor transaction semantics。

具体实现可以选择：

```text
TransactionScope service
fiber-local transaction context
adapter-managed scoped connection
```

v1.2 不冻结具体机制，只冻结“一个 semantic command = 一个共享事务数据库会话”的可观察保证。

### Successful mutation

```text
BEGIN
→ load/register logical Command
→ validate authoritative fence if ExecutionOrigin
→ load canonical state
→ authority / preconditions / invariants
→ apply domain transition
→ write canonical state
→ resolve Command = Committed
→ append Domain Events
COMMIT
```

Canonical state、Committed Receipt 与 Domain Events 原子提交。

### Terminal rejection

若 authority/precondition/revision/fencing evaluation 得到 terminal semantic rejection：

```text
BEGIN
→ read consistent canonical state
→ evaluate terminal rejection
→ resolve Command = TerminalRejected
COMMIT
```

不产生 Domain Event，但同一 `CommandId + semanticRequestFingerprint` 后续 retry 必须稳定返回该 Receipt。

### Retryable operational failure

若失败发生在 logical request 尚未被 authoritative resolve 的 operational layer：

```text
ROLLBACK semantic transaction
→ no authoritative CommandReceipt is committed
→ record CommandAttempt outcome
→ bounded retry may create next attempt
```

并发重复 attempt 最终只能有一个 authoritative resolution；其它 attempt 必须在提交前/提交冲突后重新读取 `CommandReceipt`。


## 7.5 ProviderPort

AgentRuntime 只看：

```text
ProviderPort.runTurn(
  PortableModelRequest,
  ProviderExecutionContext
)
→ Stream<CanonicalProviderEvent>
```

ProviderRuntime 负责：transport、auth、stream、timeout、safe retry、protocol normalization、usage extraction。

Model Context 负责 semantic compilation；ProviderRuntime 不重写 Arbor instruction 语义。

`PortableModelRequest` 使用 provider-neutral typed input：

```text
PortableInputItem =
  Message
| ToolCall
| ToolResult
| ContextUpdate
| CompactionCheckpoint
| AttachmentRef

PortableModelRequest.operationKind =
  Inference | CompactionSummary | CompactionNative
```

Adapter 必须无损保存 Tool call/result correlation。不能支持某个 Item 或 operation
时返回 typed capability incompatibility，不得静默文本化。`CompactionNative` 使用
现有 `CanonicalProviderEvent.ContinuationState(stateRef)` 承载 opaque result ref，
不扩展 CanonicalProviderEvent ADT。

Provider wire stream、durable Session facts 与下一轮 provider request 是三个不同
边界：adapter 只把 stream 组装为完整 `CanonicalProviderEvent`；Session 只保存 typed
ToolCall/ToolResult/ControlResult 事实；Model Context 是唯一编译
`PortableModelRequest` 的语义入口；ProtocolAdapter 是唯一把 portable request 渲染为
provider messages 的入口。发送前必须校验每个 `callRef` 恰有一个 Call 和一个 Result，
Result 不得先于 Call，同批 Call 在 provider wire 上必须先完整出现再出现对应 Result。
已知不合法的序列在本地作为 typed ProtocolViolation 拒绝，禁止发给 provider。

## 7.6 ToolCatalogPort 与 ToolRuntimePort

Tool metadata 与 Tool invocation ownership 分离。

### ToolCatalogPort

Model Context 只需要当前可见 action vocabulary 的 metadata：

```text
ToolDefinition
Schema
model-facing description
capability metadata
SideEffectSemantics
version/hash
```

因此通过 `ToolCatalogPort` 查询，不依赖 `tool-runtime` implementation。

v1.14 (G3): `ToolCatalogPort` 必须能 resolve **model-facing `ToolDefinition`**（真实
`description` / `schema` / `version`），而不是仅返回 `ToolDefinitionRef`。P3/P4 的
refs-only 收窄与 model-context compiler 占位符（`schemaJson:"{}"` / `description:name`）
是 inherited defect，随 P12 修复（P12 completion blocker）。model-context 仍不得依赖
`tool-runtime` implementation；schema/description 经 `ports` 契约解析。

### ToolRuntimePort

AgentRuntime 只看：

```text
invoke(ToolIntent, ToolExecutionContext)
→ CanonicalToolObservation | ApprovalRequired(ResolvedExecutableIntent)
```

The `E` side also includes the closed
`ToolObservationReplayEvidenceFailureCode` above. It is not encoded as a
`CanonicalToolObservation`, `ExpectedFailure`, `Denied` or `OutcomeUnknown`
settlement.

For a new approval-required Executable action with no approved exact record,
P4 returns `ApprovalRequired` with the P4-resolved, trusted tool/version,
normalized intent, target resource IDs, current ControlBasis and
ToolInvocationId. It does not persist a ToolInvocation intent/settlement,
write a terminal `Denied(ApprovalRequired)`, or call Sandbox/Executor. The
Application combines this handoff with the P3 AgentLoopStep/LogicalAction
identity, calls the pure P12 resolver and atomically issues the Pending
Executable ActionApproval plus Inbox entry. An existing matching Pending
record returns the same pause; an exact Approved record resumes P4 with its
stored expiry/revision. Control ActionApproval remains a separate route.

ToolRuntime 内部负责：

```text
Resource resolution
Authority / Permission re-check
Admission
Sandbox
Invocation persistence
Executor
Settlement
Observation normalization
```

`ToolCatalogPort` 决定“有哪些定义可以被 ModelContext 选择”；ModelContext 决定某个 Turn 暴露哪些 Tool；ToolRuntime 决定实际 invocation 是否被授权。

```text
Catalogued Tool
!= Visible Tool
!= Authorized Tool Invocation
```

Model-facing Tool invocation 分为两个互斥的语义路由：

```text
Executable Tool
  → executable definition / ToolIntent
  → ToolRuntimePort

Control Tool
  → Agent Runtime ControlToolRegistry codec
  → in-process AgentAction
  → shared Agent Runtime policy
  → owning Application command / execution-settlement boundary
```

`ToolCatalogPort` remains the source for executable P4 tool definitions.
`ControlToolRegistry` 是 `agent-runtime` 的 control-tool identity/codec/
AgentAction-construction 边界；它向 Model Context 提供 data-only definition
projection。Composition Root 将两类 definition projection 一并接入 Model
Context，`model-context` 不依赖 `agent-runtime`、`tool-runtime` 或其 handlers。
一个 request 中的 model-facing tool identity 必须唯一对应一条语义路由；
歧义注册不得暴露给模型，未知调用不得降级成另一条路由。

Control Tool 的 Runtime identity 与 model-facing function name 必须分离：
`stableId + version + implementationHash` 是 registry、authority、manifest、handler
和 replay identity；`modelName` 只是当前 provider request 的函数名。模型不需要感知
Arbor 的产品/包名。一个 Turn 中 `modelName` 唯一；冲突使 TurnProfile 不可编译，而不以
产品前缀消歧。历史 alias 仅由其记录的旧 Manifest 用于 replay，新 Turn 只公开当前
无品牌 action vocabulary。provider output 必须按该 Turn 的 alias binding 先解析为
stable identity，不能以函数名推断授权。

Executable Tool 继续使用 P4 `ToolRuntime` 的 authority、resource admission、
sandbox、invocation persistence/reconciliation 与 observation 语义。Control
Tool 不经 executable `ToolRuntime`；其可见性不产生 authority，canonical
mutation 仍只由 Application/Domain 与现有 execution-settlement owner 决定。
这条路由 supersedes universal `AgentDirective` output bridge，而不改变
P1/P4/P6/P7/P8 已冻结的 command、authority、lifecycle 与 verification 语义。

所有 decoded executable/control invocation 必须携带 provider-neutral `callRef`。
ToolRuntime/Control policy 产生完整 settlement/observation；Agent Runtime 负责将其
作为 sourced `ToolResult`/`ControlResult` 写入 Session。ToolRuntime 不直接写
Session，也不从 Session 恢复 authority。Tool settlement 已存在而 Session Result
缺失时，按 invocation/resultRef 幂等补写；dangling ToolCall 必须恢复为真实结果或
明确的 Interrupted/OutcomeUnknown，禁止无配对文本。

P4 tool-invocation boundaries（DID v1.8 G1–G5）：

- ToolRuntime **不**解析 PermissionGrant / Parent / User authority；它接收 trusted
  `InvocationAuthority` fact，只做 deterministic exact-match + capability-ceiling 校验。
- Exact-Intent Approval 是 P4-owned record，被恰好一个匹配的 invocation 原子消费；
  approval 的生产仍属 deferred resolver。
- Resource Admission 只做 validate-only（`ResourceOwnership ⊆ ResourceBoundary`）；
  ownership 变更属于 governance Command，不是 tool side effect。
- P4 owns `SandboxPort` + minimal local executor；P11 owns worktree/resource isolation
  与 advanced sandbox。
- minimal `read` / `patch` / `shell` tools 是 versioned P4 contract artifacts；
  精确 parameter/result schema 与 shell policy enforcement 机制是 phase-scoped contract。


## 7.7 Effect Service / Layer Contract

所有 Runtime / Infrastructure Port 使用 Effect service 暴露；具体实现通过 `Layer` 提供。规则：

```text
Port API
    must expose semantic A/E
    must not expose adapter implementation dependency

Live Layer
    may require SqlClient / fs / SDK / config / secret store
    resolves implementation dependencies during construction
```

因此：

```text
ModelContext.prepareTurn
```

的 `R` 应只出现 `AgentContextSourcePort | KnowledgeQueryPort | ModelCapabilityPort | ...`，不能出现 SQLite client 或具体 Provider SDK。

同理，一个 Application command handler 的 `R` 只包含该 command 实际使用的 repositories/transaction/clock/event services，不允许为了方便统一扩大成 `ArborServices`。

`E` 与 `R` 都纳入 architecture review：

```text
implementation-specific E → abstraction leak
unexpected concrete R     → dependency leak
```

## 7.8 Blob / Artifact 分离

`BlobStorePort` 只负责内容字节：

```text
put
get
stream
```

`ArtifactMetadataRepository` 负责 Control DB metadata。`ArtifactService` 在内部协调二者，避免 `artifact-local` adapter 直接访问 SQLite。

## 7.9 SecretStorePort

Project Policy、ResponsibilityBoundAgentBinding / ExecutionBoundAgentBinding、EnvironmentRef 中只保存 `SecretRef`，不保存明文 credential。

Provider/Tool Runtime 在执行边界通过 `SecretStorePort` 解析 credential；Agent 默认不看到 raw secret。

v1.14 (G2): `SecretStorePort` 以 opaque `SecretRef`（引用）与 `SecretMaterial`（解析结果）
为类型；`resolve` 必须携带 typed failure（缺失 / 不可访问 / 过期不得静默）。adapter 归 P12。
明文 secret **禁止**进入 prompt / session entry / domain event / log / artifact（任何 durable
或可观测面）；违规视为 invariant 破坏。

---

# 8. DID-7A — Model Context Control Plane

## 8.1 定位

Arbor 不把 Prompt 视为几个字符串模板，而把模型可见上下文作为独立控制平面：

```text
Model Context = Agent Control Plane
```

Agent 行为由以下共同决定：

```text
Model
+ Instruction Programs
+ Context Projection
+ Tool Surface
+ Skills
+ Output Contract
+ Runtime Constraints
```

`AgentRuntime` 是执行该控制平面的 Loop Orchestrator，而不是 Prompt/Context/Tool Policy 的 God Service。

## 8.2 Model Turn Pipeline

```text
Execution + pending safe-boundary input
↓
durable Input Promotion
↓
capture AgentStepContext once
├── binding
├── canonical control refs/revisions
├── session / epoch / input frontier
├── cognitive mode / environment
├── effective tool catalog / available skills
├── ResolvedModelBinding fingerprint
└── budget evidence basis
↓
Instruction Resolution
↓
Context Projector
├── retained canonical snapshot/deltas
├── latest completed checkpoint
└── recent typed Session frontier
↓
Context Planning / Retrieval / Budget Evidence
↓
ModelContextPlan
├── Instructions
├── Context
├── Tools
├── Skills
├── Output Contract
└── Continuation
↓
Model-family Compiler
↓
PreparedModelTurn
├── PortableModelRequest
└── ModelContextManifest
↓
ProviderPort
```

`prepareTurn()` 的 `A` 返回：

```text
Ready(PreparedModelTurn)
| NeedsCompaction(CompactionRequest)
| GovernanceBlocked(GovernanceIssue)
```

`ContextUnsatisfiable` 属于 typed `E`，不属于 success/control ADT。并非每一个 Execution step 都需要 LLM 调用。

`ContextProjector` 不消费 Inbox、不执行副作用、不调用 Provider。Promotion、Tool
settlement 与 Compaction 各自在 owning Runtime durable 完成后，Projector 只读取
已经提交的 typed result。相同 `(sessionId, contextEpoch, inputFrontier,
stepContextFingerprint)` 必须产生可重复验证的 Manifest。

## 8.3 六类 Model Context Surface

| Surface | 作用 |
|---|---|
| Instruction | 模型应该怎样行为 |
| Context | 模型当前应该知道什么事实 |
| Tool Surface | 当前可见的、各自有定义与 schema 的 executable/control tools |
| Skill | 按需加载的专业工作流 |
| Output Contract | 当前 Turn 适用的独立 bounded structured-output 协议；不再枚举 universal Agent control-action union |
| Continuation | 如何维持跨 Turn 认知连续性 |

Prompt/Instruction guides；Runtime/Sandbox enforces。

Control actions 的模型-facing representation 属于 per-tool Tool Surface。
`agent-directive-v1` / proposed `agent-directive-v2` 不再是 universal
Output Contract。Compaction 等已有独立 Output Contract 不受此 supersession
影响。

## 8.4 Prompt Program Families

Arbor v1 预置 14 类 Prompt Program：

```text
P1  Base Agent Protocol
P2  Responsibility-bound Agent Protocol
P3  Execution-bound Agent Protocol
P4  Work Execution Program
P5  Responsibility Formation Program
P6  Communication / Coordination Program
P7  Cognitive Mode Programs
P8  Skill Selection / Skill Execution Program
P9  Verification Program
P10 Workspace Bootstrap / Handoff Program
P11 Continuation / Resume Program
P12 Compaction Program
P13 Human Interaction / Steer Program
P14 Query / Inspection Program   # v1.11 G6: owned by P8 (read-only contract; P10/P12 consume only)
```

此外还有 6 类动态 Model Context Surface：

```text
S1 Model-family Instructions
S2 Permission / Sandbox Instructions
S3 Project / Workspace / Work scoped instructions
S4 Tool Definitions
S5 Environment Context
S6 User / Parent current input
```

## 8.4A Information Trust Metadata

所有可进入 Model Context 或 Memory Candidate 的 fragment 都保留正交元数据：

```text
provenanceKind:
  CanonicalInternal | AuthenticatedHuman | AuthenticatedAgent |
  ToolObservation | ExternalRetrieved | ImportedArtifact | ModelDerived

instructionCapability:
  CanonicalInstruction | InstructionCandidate | DataOnly

epistemicStatus:
  Established | Supported | Unverified | Conflicting | Derived
```

Runtime 编译出的 canonical governance/control 才能标为 `CanonicalInstruction`。ExternalRetrieved、ToolObservation、ImportedArtifact、普通 Child Message 与 ModelDerived 默认 `DataOnly`；它们的文本不能自行提升 authority。Memory promotion 必须保留 Provenance，并通过 persistence-eligibility/merge policy；模型文本中的“请永久记住”不构成持久化授权。

## 8.5 InstructionFragment

Instruction 不是 `{id, text}`，而是结构化资产：

```text
InstructionFragment
├── identity / revision / hash
├── semanticKind
├── source
├── scope
├── authorityRole
├── strength: Hard | Soft
├── compositionMode
├── activationCondition
├── lifetime
├── cacheClass
├── budgetClass
├── modelCompatibility
└── contentRef
```

核心原则：

```text
Instruction precedence != prompt text order
```

## 8.6 Authority × Scope × Composition

Authority ladder：

```text
A0 Runtime Safety / System Invariant
A1 Project Governance
A2 Responsibility Governance
A3 Work Governance
A4 Execution Strategy
A5 Skill / Mode Guidance
A6 Advisory / Contextual Guidance
```

解析顺序：

```text
Authority > Specificity > Composition > Text order
```

Composition Mode：

```text
Extend
Specialize
Constrain
ReplaceScope
Advisory
```

`ReplaceScope` 必须针对命名 slot，且 slot 明确声明 `replaceable = true`。Skill/Workspace custom instruction 不允许无意覆盖 Runtime Safety、Responsibility Boundary、Permission Semantics 或 Work Objective。

User text 不自动获得最高 Authority。涉及 Work/Responsibility 改变的自然语言输入必须转成正式 Governance Command 后才成为新的 Canonical instruction source。

## 8.7 Instruction Conflict

Resolver 输出：

```text
ResolvedInstructionSet
├── Effective[]
├── Suppressed[]
├── Conflicts[]
└── GovernanceIssues[]
```

第一版识别：

```text
AuthorityConflict
ScopeConflict
GoalConstraintConflict
CapabilityConflict
ReplacementConflict
```

自然语言语义冲突可以由 LLM 辅助检测；Authority/Capability resolution 由 deterministic Runtime 执行。

## 8.8 Context 分层

Context 正式分七层：

```text
C0 Control Context
C1 Mission / Task Context
C2 Coordination Context
C3 Cognitive Continuity
C4 Evidence / Environment
C5 Retrieved Knowledge
C6 On-demand Modules
```

### C0 Control

每 Turn 从 Canonical State fresh reconstruction：

```text
Base/Binding Protocol
ResponsibilityDefinition
Effective authority / permission
ResourceBoundary
hard Project/Workspace instruction
Output Contract
```

### C1 Mission

```text
Current Work / Mission
Objective
Constraints
CompletionExpectation
VerificationMission summary
Work revision
```

C0/C1 默认 Pinned，不因普通 token pressure 删除。

### C3 Cognitive Continuity

采用：

```text
Checkpoint + Recent Frontier
```

而不是完整 Session History。

Before a Work Session's first typed checkpoint, its active history projection
selects the latest 64 persisted Session Timeline rows by Session-local
sequence. The current input and canonical C0/C1 facts are pinned independently
of this count. P3 applies only its existing projector branches/filters to this
selected window; skipped rows do not cause older rows to be fetched as
replacements. A selected row skipped by P3 has no item or contextRef. The
selected `inputFrontier` is the considered row range, not proof of coverage.
After a typed checkpoint, use its exact sequence and every unsummarized typed
entry after it, without the pre-checkpoint 64-row cap.

## 8.9 Retention Class

Context Fragment 使用：

```text
Pinned
Protected
Compressible
Evictable
```

预算不足时：

```text
evict irrelevant optional
↓
shrink retrieved knowledge
↓
reduce artifact excerpts
↓
compress observations/history
↓
checkpoint / new epoch
↓
never silently drop hard control facts
```

若 Pinned + Protected 本身无法装入模型窗口，返回 `ContextUnsatisfiable`，不静默 truncate。

The latest 64-row bound applies only before the first Work checkpoint. It
does not bound the post-checkpoint frontier. Every request still includes the
current pinned input and independently reconstructed canonical C0/C1 facts,
regardless of row filtering or the bound.

## 8.10 Budget / Cache

Model Context Budget：

```text
B_ctx = B_model - B_output - B_protocol - B_tools
```

先 reserve output，再规划输入。

Fragment CacheClass：

```text
Stable
SemiStable
TurnDynamic
OnDemand
Synthetic
```

Compiler 尽量保持 Stable Prefix 稳定；Authority 与 physical prompt position 分离。

预算证据优先级：

```text
Provider reported usage
> provider/model tokenizer or estimator
> adapter structured-request estimator
> chars/4 conservative fallback
```

BudgetDecision/Manifest 记录 evidence kind、estimated/observed tokens、threshold、
reserves 与 model context limit。粗估算可以提前触发 Compaction，但不得单独把普通
可压缩历史压力判为 `ContextUnsatisfiable`。该错误只用于 Mandatory/Pinned/
Protected fixed content 在全部允许模型策略下仍不可满足。

## 8.11 Skills

Skill 是 On-demand Instruction Module，而不是 Tool。

模型默认只看到：

```text
name
short description
when-to-use
```

使用时再加载 body/reference/script。Skill 不能提升 capability，也不能覆盖更高 Authority instruction。

## 8.12 Cognitive Mode

Mode 属于 Execution cognitive state，而不是 Work lifecycle。

典型通用模式：

```text
Orient
Investigate
Plan
Execute
Diagnose
Integrate
```

Mode 可以影响 Prompt、Context Budget、Tool Surface、Skill hints 与 Output Contract。Agent 可以提出 `ChangeMode`，Runtime 校验 Profile 支持后生效。

## 8.13 Compaction

Compaction 拆为两部分：

### Cognitive Compression

总结：

```text
progress
important findings
failed approaches
open questions
current hypotheses
pending actions
relevant refs
```

### Control Reinjection

从 Canonical State fresh inject：

```text
Responsibility
Current Work
Constraints
Permissions
ResourceBoundary
Dependencies
Project rules
```

因此：

```text
Checkpoint preserves cognition;
Canonical State restores control.
```

Compaction 可以由 token pressure、semantic boundary 或 model/provider boundary 触发，不是简单的“达到 90% 就 summarize”。

Before the first typed Work checkpoint, `inputFrontier` bounds the rows
considered; the checkpoint's `retainedFrontier` may claim coverage only for
content actually represented by the existing P3 projector. Skipped or older
rows remain durable but uncovered. Once a checkpoint exists, its exact
sequence plus every unsummarized typed Session entry after it form the active
frontier; budget pressure triggers explicit compaction rather than truncation
by the pre-checkpoint cap.

Conversation continuity uses the exact RootWorkspaceId as a separate owner.
HumanMessage is immutable source identity/order/body; its legacy lifecycle,
claim and response columns are not answer or scheduler truth. Only a
contiguous FIFO prefix with exact Answered ResponseJobs and matching
ConversationAttempts/terminal ConversationResponseEpisode Executions may be
covered when they settle with `Completed(ConversationResponseProduced(messageId))`.
The current raw message is pinned once only for its exact Running
Job, active Attempt/Execution and current lease; non-Answered, malformed or
other-episode Running gaps stop coverage. Work Session history/checkpoints are
excluded. ProviderNative reuse requires an exact complete ResolvedModelBinding
fingerprint; otherwise portable Summary is rebuilt from retained HumanMessage
sources paired with their authoritative Answered Job response bodies.
Restart retains the same response episode and does not replay settled
Provider/action work. Owner storage and migration details remain separately
gated.

规范控制流：

```text
prepareTurn → NeedsCompaction(request)
→ persist Compaction ProviderTurn + Manifest
→ choose Summary | ProviderNative from capability/binding
→ execute + validate result
→ atomically append checkpoint + advance ContextEpoch
→ fresh canonical control reconstruction
→ retry the same (logicalStepNo, repairAttempt)
```

```text
CompactionResult =
  SummaryCheckpoint(summaryRef, retainedFrontier, newEpoch)
| NativeCheckpoint(opaqueItemRef, bindingFingerprint,
                   retainedFrontier, newEpoch)
```

- started 未 completed 时旧 epoch/frontier 继续有效；checkpoint + epoch advance 原子；
- Summary rolling update 保留 objective/requirements/decisions/progress/blockers/
  next move/relevant refs；recent frontier 有独立 token 上限；
- ProviderNative opaque item 只在兼容 ResolvedModelBinding 下复用；
- Provider context overflow 且尚无 durable assistant/tool effect 时允许一次 compact +
  same-step physical retry；第二次 overflow terminal；
- Compaction failure 可以使当前 Execution typed fail/Attention，但
  `NeedsCompaction` 本身不是 settlement；
- Compaction 不消费权限，不更改 Work/Verification/Acceptance，也不重放 action
  ledger 中已经解决的动作。

## 8.14 Context Progressive Disclosure

Artifact、Skill、Memory、历史报告默认按 metadata/summary/excerpt/reference 进入 Context，需要时再由 Tool 加载更多。

Raw Tool Result：

```text
Raw payload
↓
Artifact/Blob storage
↓
ToolRuntime CanonicalObservation
↓
ModelContext selection/compression
↓
Model-facing Observation
```

如果内容被截断/压缩，必须向模型保留 epistemic status 与原始 ArtifactRef。

## 8.15 Agent Control Loop

Arbor 使用两层 Loop：

```text
Deterministic Execution Control Loop
+
Agentic Goal Pursuit Protocol
```

每个 Model Turn 的 provider-neutral decode 产出 `ModelOutput` 与零个或多个
typed `ToolInvocation`。`ToolInvocation` 表示一次 model-facing tool call，
不表示该调用已获授权，也不携带可信的 Principal、Execution、Workspace、
revision 或 authority facts。

Executable invocation 路由到 P4 `ToolRuntime`。Control invocation 由
`ControlToolRegistry` 的注册 codec 校验并构造内部 `AgentAction`，再交给
shared Agent Runtime policy 进行 trusted-context binding、activity/safety
admission、freshness、policy dispatch 与结果归一化，最后进入对应的
Application command 或已有 Execution settlement boundary。

`AgentAction` 是 `agent-runtime` 所有的 process-local typed ADT，只供单进程、
单次控制路由消费。它不是 Model-facing schema、Provider output contract、
canonical wire value、Domain Event、Application Command DTO，也不得整体
持久化。Action variants/payload 与各 control tool codec 的逐项定义属于后续
phase-scoped contract；本裁决不冻结工具清单或暴露集合。

v1.20 的 `AgentLoopStepActionRecord` 不违反上述边界：它只保存 stable call/logical
identity、route/action kind、input/output hash、disposition 与 result refs。恢复先从
持久 Provider result 以 pinned decoder 重建 invocation，再与 ledger 校验；不得把
`AgentAction` 对象或模型自报的 trusted context 序列化进记录。完整交接状态机见
P3 `08`。

`decodeTurn` 只负责 `CanonicalProviderEvent` → `ModelOutput` / typed
`ToolInvocation`，包括 provider-neutral tool-call reconstruction、correlation
保留及 malformed/incomplete framing rejection。它不解释 control semantics、
不判断 executable/control authority、不构造 `AgentAction`，也不生成 universal
`AgentDirective`。ControlToolRegistry 与 executable ToolRuntime 分别负责
其路由后续的 typed validation。

已冻结 phase contract 中的 action 语义和结果仍由其原 owning phase 保有。
例如 `DirectiveUnsupported` 所表达的 P5 non-fatal result/observation 语义，
若仍适用，由对应的 internal control route 与 phase owner 保持；它不再要求
一个 model-facing `AgentDirective`/`DirectiveUnsupported` wire vocabulary。

Agent 的核心认知变量是 `OutcomeGap`：

```text
Expected outcome
- currently established evidence
= OutcomeGap
```

Agent 不机械执行原 Plan，而持续选择最能减少关键 OutcomeGap 的高价值 action。

## 8.16 Yield / Durable Wait / Completion / Dependency

`Yield` 不是“暂时停一下”的模糊结果，而是注册 durable waiting condition：

```text
Completed(
  Yielded {
    reason: YieldReason
    waitFor: WaitSpec
  }
)

WaitSpec = { mode: Any, conditions: NonEmptyArray<WakeCondition> }
```

第一版 `WakeCondition` 只允许：

```text
DependencyChanged(id, observedRevision)
DecisionChanged(id, observedRevision)
VerificationChanged(workId, targetWorkRevision)  # v1.11 G2: work-level
InboxAdvanced(workspaceId, observedSequence)
EnvironmentChanged(environmentRef, observedRevision)
TimeReached(instant)
Manual
```

禁止空 WaitSpec；无限等待人工必须显式使用 `Manual`。SettleExecution(Yielded) 的事务必须同时注册/替换 `WorkWait`，并重新读取所有带 observed revision/sequence 的事实；如果任一事实已经变化，则不得把 Work 永久 park，而应直接进入 runnable reevaluation。`TimeReached` 由 durable Scheduler 恢复，不依赖 Worker 内存 timer。

```text
CompletionClaim
→ Producer 认为 outcome 已充分建立
→ Execution settle = Completed(CompletionClaimed(...))
→ durable ExecutionSettled event
→ deterministic StartVerification Command
→ Work remains Open
```

只有：

```text
Verification PASS
+ Acceptance
+ CompleteWork
```

Work 才 Completed。

Ownership（P2 冻结）：

```text
P2 owns:
  ExecutionScheduler
  durable WorkWait registration / clear
  timer / wake mechanics
  lost-wake-up protection

Source phases own:
  wake-signal production for DependencyChanged / InboxAdvanced /
  VerificationChanged / EnvironmentChanged / DecisionChanged / …

P7 owns:
  full Work runnability / dependency reevaluation
  Wait-for graph / deadlock attention
```

`SettleExecution(Yielded)` 在同一事务内注册/替换 `WorkWait` 并重新读取 observed facts；P2 负责
该事务与 lost-wake-up 防护。P2 不实现跨 Work 的 runnable/dependency 图重算。

`DeclareDependency` 后不一定 Yield；只要还有独立可推进路径，Execution 可以继续。Dependency satisfaction 必须使用 §1.8 冻结的 structural matcher（`producerBinding` + `expectedDeliverable` 对 `DeliverableMatchView`）；Consumer 对“结果虽匹配但仍不足以支撑上层 Work”的判断通过新 Work/Dependency/Steer 表达，不把 deterministic satisfaction 改回语义猜测。

## 8.16A Runtime Safety Envelope

Runtime Safety Envelope 与用户 Cost Budget 分离。机制必须存在、数值阈值可配置/评测：

```text
max transient retries per operation
max repeated identical action fingerprints
max tool recursion / chaining depth
max consecutive turns without durable progress
provider/tool concurrency ceilings
rate / runaway protection
```

触发结果：

```text
Execution → Interrupted(RuntimeSafetyStop(reason))
Work remains Open
Attention emitted
```

禁止 Safety Envelope 自动把 Work 改为 Cancelled。

Ownership（P2 冻结）：execution-wide Runtime Safety / control gating 属于 **P2**，在
`ExecutionDriverPort` 边界统一执行（覆盖 max retries / repeated action fingerprints /
recursion depth / consecutive no-progress turns / concurrency ceilings）。**P3** 的真实 Driver 在
每个新的 ProviderTurn / ToolInvocation / Specialist action boundary 必须向 P2-owned
Runtime Safety / control gate 报告 activity 并获得 continue/stop 决定；具体 Port 形状下放 P2
phase contract。P3 不拥有 Safety 判定。

v1.14 (G7) cross-phase closure：P2 不 reopen。六个维度的 **mechanism / state / reset /
violation / tests 不得缺失**，数值阈值可配置。P2 契约已认领全部六维但实现仅覆盖
repeated-fingerprint，属 inherited partial delivery；P12 补齐其余五维（max transient
retries / recursion depth / no-progress turns / concurrency ceilings / rate-runaway），
列为 P12 completion blocker。

## 8.17 Long-lived Agent != Long-running Process

Workspace 可以存在数月，但 Worker/Execution 只在有 runnable action 时存在：

```text
Event / Work / Input
↓
Scheduler wakes Workspace
↓
Execution
↓
Agent works to stable boundary
↓
Yield / CompletionClaim / Stop / Failure
↓
release Worker
```

系统不让 Agent 为维持“在线”而不断重复检查。

## 8.18 WakeReason

每次 Workspace Execution 提供 typed `WakeReason`：

```text
WorkSelected
InputArrived
DependencySatisfied
VerificationReturned
HumanIntervention
ChildDelivered
EnvironmentChanged
Recovery
```

Continuation Program 和 Context selection 根据 WakeReason 定制，而不是每次加载最后 N 条消息。

`ChildDelivered` 由成功的 Deliver Inbox delivery 触发（v1.10 G2；P7 接线）。

WSC-1（2026-10-02 人工治理）：`DependencySatisfied` 是独立终态事实。满足转移
保持 Dependency revision 不变；消费该事实时，相同 `dependencyId` 的
`DependencyChanged` wait 无条件、幂等清除，不要求 `observedRevision <
toRevision`。非终态 dependency revision change 仍使用严格 revision 前进规则。

## 8.18A Deterministic Workspace Re-evaluation

Scheduler 每次 reevaluate Workspace：

```text
if Active Main Execution exists:
    do nothing
else:
    classify Current Work and runnable Pending Work
```

规则固定为：

| 条件 | 行为 |
|---|---|
| Current Work Open 且无 active WorkWait | 继续 Current |
| Current Work 有 active WorkWait，其他 runnable=0 | 不 Admit Execution |
| Current Work 有 active WorkWait，其他 runnable=1 | deterministic `SelectCurrentWork(theOne)` |
| Current Work 有 active WorkWait，其他 runnable>1 | Admit `WorkspaceExecution(focus=Coordination)` |
| currentWorkId=None，runnable=0 | idle |
| currentWorkId=None，runnable=1 | deterministic `SelectCurrentWork(theOne)` |
| currentWorkId=None，runnable>1 | Admit Coordination Execution |

Coordination Execution 的语义职责仅是处理多个候选 Work/coordination input，并可以提交 `SelectCurrentWork`。`Yielded` 不携带 suggestedNextWorkId，避免引入第二套隐式 Work-selection 语义。

**Runnability single authority（v1.10 G3）**：`RunnableWorkSource` 的 classify 是 Work
是否 runnable 的唯一权威判定——`active WorkWait` 与 `unresolved blocking Dependency`
均不得被 classify 为 Runnable（blocking Dependency := Unsatisfied Dependency 且 consumer
Work 存在引用 `DependencyChanged(该依赖)` 的 active WorkWait）。上表的 "active WorkWait"
列因此是 classify 已保证事实的呈现输入，`decide()` 不承担隐藏 blocking 判定。

Ownership（P2 冻结）：P2 提供 ExecutionScheduler 与 durable wake/timer 机制，使该 re-evaluation
可在无 Active Main Execution 时被确定性触发；**P7** 拥有完整的 runnable/dependency reevaluation
与 Wait-for graph。P2 不新增 runnable 语义。

**EGP new-write supersession:** the preceding focus/Coordination table is
historical. New writes use exact `ExecutionEpisodeBinding`; scheduler
ambiguity requiring model judgment persists `WorkSelectionDecisionRequest`
and admits a `DecisionEpisode`. `CoordinationCompleted` / `QueryCompleted` are
decoder/audit-only and cannot be new settlement results. The accepted RAI gate
below applies only to Work Episodes; other EGP episode variants are unaffected.

### 8.18A.1 Exact Work-revision readmission hold (RAI-DG-01)

For canonical Work `(projectId, workspaceId, workId, revision)`, hold admission
when a durable source is bound by exact EGP Work Episode `(workId, workRevision)`
and is one of:

1. settled `Interrupted(ControlledInterruption(RuntimeSafetyStop))`;
2. a P9 recovery-blocking source in the closed P9 `07` inventory; or
3. settled `OutcomeUnknown(ReconciliationRequired(invocationRefs))` with
   non-empty refs.

The closed P9 sources are `DeliverReplayEscalated` with its matching
`deliver_replay_attention_facts` row, `AssignWorkTargetBindingEscalated` with
its matching `assign_work_binding_attention_facts` row, and
`ReconciliationEscalated`. P9 `07` owns exact failure-code unions, source
identity, immutability and atomic fact/event commit. Ephemeral
`RecoveryBlocked` and `ReconciliationSourceError` are not independent sources
while the Execution remains Active. The settlement source applies even with
no separate Attention row when its exact `OutcomeUnknown` refs are durable.

P2 `02` owns `WorkReadmissionGateStore`; P7 `03` incorporates its exact-revision
result into the sole classifier. Work-bound admission rechecks the same gate
inside the existing `BEGIN IMMEDIATE` transaction. A valid hold returns typed
`WorkReadmissionHeld`; a missing/scope/revision-mismatched canonical target
returns `ReadmissionTargetMismatch`; malformed, absent, duplicate,
unsupported-version or conflicting source evidence returns the closed
`ReadmissionGateIntegrityFailure` union. Every rejection commits no Execution.
The query validates canonical Project/Workspace/Work/revision, unique source
Execution and episode state, exact source/fact/event witnesses, and the exact
`ExecutionEpisodeBinding`. It never infers identity from Session text,
`currentWorkId`, Message, Attention target, or Parent Workspace. A valid
non-Work Episode is outside this rule.

The gate is derived from canonical settlement/P9 source records, adds no gate
table or migration, changes no Work lifecycle/WorkWait/Dependency/approval,
and does not read P10 projections. Restart, queue ACK or same-revision
polling cannot release it. Only authorized `SteerWork` that atomically
advances canonical Work revision makes the old source stale; immutable source
facts remain audit evidence. P10 removes old-revision active Attention using a
same-snapshot canonical Work revision check, independent of consumer lag or
rebuild state. Accepted proposal SHA-256
`0CEB2DAA2E6128F86CBD1CAA185B9847EAAB240360011F94425E0856F39AA106`;
acceptance and prior landing review evidence are in
`planning/results/RAI-DG-01-governance-acceptance-and-landing.md`.

## 8.19 ModelContext Manifest

每个 Provider Turn 都持久记录一份 Manifest：

```text
ProviderTurnId
ExecutionId
SessionId / Epoch
ModelRef
Instruction fragments + revision/hash/source/scope
Context fragment refs
Skill refs
Tool definition refs/versions
OutputContract ref
Budget decision
CompiledRequestHash
LogicalStepNo / RepairAttempt
OperationKind
InputFrontier { firstSequence, lastSequence, checkpointSequence? }
TypedInputItemRefs[] / CallRefs[]
AgentStepContextFingerprint
ResolvedModelBindingFingerprint
BudgetEvidence { kind, estimatedTokens, observedTokens?, reserves, threshold }
Compaction { implementation?, fromEpoch?, retainedFrontier? }
ControlBasis {
  projectPolicyRevision
  workspacePolicyRevision
  responsibilityRevision
  resourceBoundaryRevision
  workId? / workRevision?
  authorizationDigest
  environmentRevision
}
```

For a Work ProviderTurn before its first typed checkpoint,
`InputFrontier(firstSequence,lastSequence)` identifies the latest-64 considered
Session-local row range; it does not assert that every selected row became a
typed input. `TypedInputItemRefs[]` and context refs identify actual emitted
content. A compaction `retainedFrontier` covers only content included under the
existing P3 projector. For a ConversationResponseEpisode, manifest source
identity binds the RootWorkspaceId owner, exact inclusive
`coveredThroughMessageId`, and each ordered paired turn's exact immutable
HumanMessage identity (`messageId`, `createdAt`, `bodyRef`, body digest) plus
Answered Job identity (exact Answered Job revision, `responseExecutionId`,
`attemptNo`, and bounded Job `responseBody` digest). It binds the unique
ConversationAttempt identity/Completed settlement and the terminal
ConversationResponseEpisode Execution, including its exact admission-time Job
revision and `Completed(ConversationResponseProduced(messageId))` result. The
current raw input binds the exact Running Job revision, messageId, attemptNo,
executionId, Episode admission revision and current lease fence. HumanMessage
legacy lifecycle, claim and response columns are not source or scheduler
authority. A ProviderNative checkpoint also binds the complete
ResolvedModelBinding fingerprint. Recovery proves these identities from
canonical owner/response facts rather than Session text or ProviderTurn ID
spelling. These are semantic bindings, not a choice of physical storage
encoding.

Prompt/Context change 是行为代码 change，必须可追踪和可回归。

旧要求“每个 effectful `AgentDirective` 在 model payload 内携带
`decisionBasisManifestId`”由本版 supersede。`ProviderTurn` 已绑定的
`ModelContextManifest` 与可信 invocation context 是 freshness 的依据；
Runtime 将一个 `ToolInvocation` 关联到该 turn/manifest，并在 control
`AgentAction` policy 或 executable ToolRuntime admission 时检查对应
`FreshnessRequirement`。`AgentAction` 不接收模型提供的 manifest、revision、
authority 或 identity claim。若相关 Work/Responsibility/Boundary/Policy/
Authorization/Environment revision 已变化，沿用 `DecisionStale` 既有语义；
read-only 与写入/破坏性动作的 freshness 强度仍由 owning action contract
决定。

---

# 9. DID-8 — Persistence Schema

## 9.1 Storage Strategy

Arbor v1 使用 SQLite 作为单一 Canonical Control Plane DB。前提：

```text
Only Arbor Runtime writes Canonical DB.
Workers / Agents / Tools / UI do not open the DB directly.
```

SQLite 使用：

```text
WAL
foreign_keys = ON
short transactions
busy_timeout
optimistic revision / CAS
```

v1.14 (G5)：**SQLite 保持默认**。P12 必须产出 `StorageScaleAssessment`（声明 operating
envelope + 度量 SQLite 是否满足）；只有无法满足 declared operating envelope 才实现
PostgreSQL adapter——多 Runtime 并发写 / DB HA / write contention 是触发候选，不是自动义务。

SQLite 是 v1 adapter，不是 durability contract。部署必须声明 `DurabilityEnvelope` 与备份/恢复策略：process/worker/runtime/compute-host failure 在 canonical storage 完整时必须可恢复；storage-media/region loss 的能力由配置的 backup/replication 与 RPO/RTO 决定，并通过恢复演练验证。

v1.14 (G5)：`DurabilityEnvelope` / backup-restore / RPO-RTO / restore drill 的交付归 **P12**
（P9 仍拥有 runtime fault hardening）；声明与演练是 P12 的 phase deliverable。

## 9.2 Control Plane vs Data Plane

```text
Arbor Control Plane
    Project / Workspace / Work / Session / Execution
    Event / Permission / Verification / Command / Metadata

Project Data Plane
    Git / files / datasets / external DB / services
    artifacts / compute / external environment
```

Agent Tool 不得直接访问 Arbor Control DB。

## 9.3 Core Tables

```text
projects
workspaces
workspace_lineage
resource_ownership
works
work_waits
work_acceptances
executions
execution_leases
agent_execution_state
sessions
session_epochs
session_entries
checkpoints
verifications
verification_executions
verification_evidence
dependencies
deliverables
deliverable_artifacts
artifacts
messages
message_consumptions
decisions
permission_grants
memories
commands
command_attempts
domain_events
consumer_offsets
provider_turns
provider_attempts
model_context_manifests
tool_invocations
deliver_replay_attention_facts
deliver_replay_attention_rows
tool_observation_replay_attention_facts
tool_observation_replay_attention_rows
```

Migration `0033_assign_work_target_bindings` (`PRAGMA user_version = 33`) is
additive and forward-only. It creates the following exact evidence tables and
indexes; it creates no binding for historical rows:

```sql
CREATE UNIQUE INDEX commands_id_project ON commands(command_id, project_id);
CREATE UNIQUE INDEX executions_id_project_workspace
  ON executions(execution_id, project_id, workspace_id);
CREATE UNIQUE INDEX workspaces_id_project_parent
  ON workspaces(workspace_id, project_id, parent_workspace_id);
CREATE UNIQUE INDEX works_id_project ON works(work_id, project_id);
CREATE UNIQUE INDEX permission_grants_id_project
  ON permission_grants(permission_grant_id, project_id);
CREATE UNIQUE INDEX action_approvals_id_project
  ON action_approvals(approval_id, project_id);

CREATE TABLE assign_work_target_bindings (
  command_id                    TEXT PRIMARY KEY,
  schema_version                INTEGER NOT NULL CHECK (schema_version = 1),
  project_id                    TEXT NOT NULL,
  execution_id                  TEXT NOT NULL,
  provider_turn_id              TEXT NOT NULL,
  logical_action_id             TEXT NOT NULL,
  call_ref                      TEXT NOT NULL,
  parent_workspace_id           TEXT NOT NULL,
  parent_work_id                TEXT NOT NULL,
  parent_work_revision_at_command INTEGER NOT NULL CHECK (parent_work_revision_at_command >= 0),
  target_workspace_ref          TEXT NOT NULL,
  target_ref_encoding_version   INTEGER NOT NULL CHECK (target_ref_encoding_version = 1),
  parent_workspace_revision_at_command INTEGER NOT NULL CHECK (parent_workspace_revision_at_command >= 0),
  target_workspace_revision_at_resolution INTEGER NOT NULL CHECK (target_workspace_revision_at_resolution >= 0),
  target_workspace_id           TEXT NOT NULL,
  target_lifecycle_at_commit    TEXT NOT NULL CHECK (target_lifecycle_at_commit = 'Active'),
  work_id                       TEXT NOT NULL,
  predecessor_work_id           TEXT NOT NULL,
  work_provenance_json          TEXT NOT NULL,
  authority_kind                TEXT NOT NULL CHECK (authority_kind IN ('PermissionGrant','ActionApproval')),
  permission_grant_id           TEXT,
  action_approval_id            TEXT,
  authority_evidence_json       TEXT NOT NULL,
  authority_checked_at          TEXT NOT NULL,
  created_at                    TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id),
  UNIQUE (work_id),
  FOREIGN KEY (command_id, project_id)
    REFERENCES commands(command_id, project_id),
  FOREIGN KEY (execution_id, project_id, parent_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id),
  FOREIGN KEY (parent_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id),
  FOREIGN KEY (target_workspace_id, project_id, parent_workspace_id)
    REFERENCES workspaces(workspace_id, project_id, parent_workspace_id),
  FOREIGN KEY (parent_work_id, project_id)
    REFERENCES works(work_id, project_id),
  FOREIGN KEY (work_id, project_id)
    REFERENCES works(work_id, project_id),
  FOREIGN KEY (predecessor_work_id, project_id)
    REFERENCES works(work_id, project_id),
  FOREIGN KEY (permission_grant_id, project_id)
    REFERENCES permission_grants(permission_grant_id, project_id),
  FOREIGN KEY (action_approval_id, project_id)
    REFERENCES action_approvals(approval_id, project_id),
  CHECK (
    (authority_kind = 'PermissionGrant' AND permission_grant_id IS NOT NULL AND action_approval_id IS NULL)
    OR
    (authority_kind = 'ActionApproval' AND permission_grant_id IS NULL AND action_approval_id IS NOT NULL)
  )
);

CREATE INDEX assign_work_target_bindings_target
  ON assign_work_target_bindings(project_id, target_workspace_id, target_workspace_ref);
CREATE INDEX assign_work_target_bindings_parent_work
  ON assign_work_target_bindings(project_id, parent_work_id, created_at);

CREATE TABLE assign_work_binding_attention_facts (
  attention_fact_id       TEXT PRIMARY KEY,
  event_id                TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  project_id              TEXT NOT NULL,
  execution_id            TEXT NOT NULL,
  target_workspace_id     TEXT NOT NULL,
  logical_action_id       TEXT NOT NULL,
  committed_command_id    TEXT NOT NULL,
  failure_code            TEXT NOT NULL CHECK (failure_code IN (
    'LegacyUnbound','MissingBinding','DuplicateBinding','MalformedBinding',
    'RefMismatch','AuthorityMismatch','ForeignTarget','PlacementMismatch',
    'SourceActionMismatch','ReceiptMismatch','WorkMismatch',
    'ProvenanceMismatch','EventMismatch','CommitLifecycleMismatch'
  )),
  first_detected_at       TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id, committed_command_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id),
  FOREIGN KEY (committed_command_id, project_id)
    REFERENCES commands(command_id, project_id)
);

CREATE INDEX assign_work_binding_attention_target
  ON assign_work_binding_attention_facts(project_id, target_workspace_id, first_detected_at);
```

`authority_evidence_json` is the versioned full typed union snapshot. Its
variant check and composite foreign keys enforce project consistency and the
same-project direct-child target→Parent edge. Transactional validation checks
the mutable Grant or ActionApproval values. `work_provenance_json` is the exact
serialized value written to the Work row; replay checks the parsed typed fields
and stored serialization, including `predecessorWorkId == parentWorkId` and
the pinned bounded reason. No hash algorithm or lossy projection is used.

The fact id is `att_` plus lowercase hex of the versioned SHA-256 tuple
`(executionId, logicalActionId, committedCommandId)`. The fact is immutable;
the first detected failure code is retained. Event and row are atomic. No
resolution command, dismissal state, automatic deletion, legacy backfill, or
schema downgrade is added. Older binaries refuse `user_version > 32`.

The accepted/planned migration prefix is append-only: `0034` is the accepted
P10 Attention materialization, `0035` is the accepted F21 resource activation
Attention source, `0036` is the accepted AH7/P36 schema, `0037` is the
accepted/planned AH10 Deliver P9 fact plus P10 projection marker, `0038` is
the EA-DG-01 Executable approval handoff schema, and `0039` is the accepted
AH7-DG-02 P39 reconciliation attempt/fact schema. The accepted P36 owner
contract is integrated in this governance baseline; migration `0036`
implementation/registration is not integrated in this tree. Migration `0037` is conditional on
integrating migration `0036` and MUST NOT be implemented, installed, or
released independently.
Migration `0038` depends on integrated `0036` and `0037` and likewise may not
be released as a standalone v35 upgrade. Migration `0039` depends on P36 and
P38 source contracts and, by the global `user_version` prefix, must follow
P37; its preflight runs before any pending P37/P38/P39 DDL on a v36–v38 DB.
The target path after qualification is v33→…→39, v35→…→39, v36→…→39,
v37→…→39, or v38→39, but none may skip a pending predecessor. The integrated
owner contracts do not imply migration implementation/registration. The P39
amendment above changes no body, checksum, numbering, or contract of migrations
0032–0038; the later P37 v1.43 amendment below changes only the proposed
0037 contract. No installed migration body or checksum is changed.

Migration `0037_ah10_deliver_replay_attention_rows` (`PRAGMA user_version = 37`)
is additive and forward-only. It creates no fact rows for historical
Deliver/Message events; P9 creates a source fact only when the accepted exact-
proof boundary detects incomplete/conflicting effect evidence. It adds the
P10 source-specific marker relation after the P9 fact relation:

```sql
CREATE TABLE deliver_replay_attention_facts (
  attention_fact_id       TEXT PRIMARY KEY,
  event_id                TEXT NOT NULL UNIQUE,
  project_id              TEXT NOT NULL,
  execution_id            TEXT NOT NULL,
  target_workspace_id     TEXT NOT NULL,
  logical_action_id       TEXT NOT NULL,
  message_id              TEXT NOT NULL,
  failure_code            TEXT NOT NULL CHECK (failure_code IN (
    'LegacyMessageMissingEvent','LegacyEventMissingMessage',
    'LegacyMessageBindingMismatch','LegacyInboxConflict',
    'PriorReceiptDecodeMismatch','PriorReceiptResultMismatch',
    'RejectedReceiptEffectConflict','PriorReceiptEffectConflict'
  )),
  first_detected_at       TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id, message_id),
  UNIQUE (attention_fact_id, project_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);

CREATE INDEX deliver_replay_attention_target
  ON deliver_replay_attention_facts(project_id, target_workspace_id, first_detected_at);
CREATE INDEX deliver_replay_attention_project_fact
  ON deliver_replay_attention_facts(project_id, attention_fact_id);

CREATE TABLE deliver_replay_attention_pending (
  queue_sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL,
  attention_fact_id  TEXT NOT NULL UNIQUE,
  enqueued_at        TEXT NOT NULL,
  FOREIGN KEY (attention_fact_id, project_id)
    REFERENCES deliver_replay_attention_facts(attention_fact_id, project_id)
);
CREATE INDEX deliver_replay_attention_pending_project_order
  ON deliver_replay_attention_pending(project_id, queue_sequence);

CREATE TABLE deliver_replay_attention_rows (
  attention_fact_id TEXT PRIMARY KEY
    REFERENCES deliver_replay_attention_facts(attention_fact_id)
);

CREATE TRIGGER deliver_replay_pending_delete_requires_marker
BEFORE DELETE ON deliver_replay_attention_pending
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM deliver_replay_attention_rows
   WHERE attention_fact_id = OLD.attention_fact_id
)
BEGIN
  SELECT RAISE(ABORT, 'DeliverReplay pending item requires a P10 marker');
END;

CREATE TABLE p10_attention_project_poll_state (
  project_id                    TEXT PRIMARY KEY,
  last_attempt_sequence          INTEGER NOT NULL DEFAULT 0 CHECK (last_attempt_sequence >= 0),
  consecutive_failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failed_attempts >= 0),
  next_eligible_at               TEXT NOT NULL,
  last_failure_code              TEXT CHECK (last_failure_code IS NULL OR last_failure_code IN (
    'PollLeaseExpired','JournalIdentityUnprovable','MissingP9Fact',
    'FactTupleMismatch','FactProjectMismatch','EventBindingMismatch',
    'QueueFactMismatch','MarkerBindingMismatch','QueueDeleteWithoutMarker'
  )),
  last_failure_at                 TEXT
);
CREATE INDEX p10_attention_project_due
  ON p10_attention_project_poll_state(next_eligible_at,last_attempt_sequence,project_id);
CREATE TABLE p10_attention_dispatch_state (
  singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_attempt_sequence    INTEGER NOT NULL CHECK (next_attempt_sequence >= 1),
  active_project_id        TEXT,
  lease_owner              TEXT,
  lease_generation         INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  claim_started_at         TEXT,
  lease_expires_at         TEXT,
  CHECK ((active_project_id IS NULL) = (lease_owner IS NULL)),
  CHECK ((lease_owner IS NULL) = (claim_started_at IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO p10_attention_dispatch_state(singleton,next_attempt_sequence)
VALUES (1,1);
```

`event_id` is a unique P9 audit identity and intentionally has no permanent
FK to prunable `domain_events`. The `deliver_replay_attention_pending` row
has no event FK or expiration/drop path; its exact fact/project FK ensures
queue provenance. P9 inserts the fact/event/queue in one transaction; P10
creates/verifies the marker before deleting/ACKing the queue row. P10 full
rebuild seeds markers from all durable P9 facts and ACKs seeded pending rows
inside its same reset/snapshot/offset-rewind transaction.

There is deliberately no Message/Event/Command FK from `message_id` or
`logical_action_id`: the fact must represent proof failures where those
canonical rows are missing. Its ID is `att_` plus lowercase SHA-256 hex of
UTF-8 `JSON.stringify({version:1,executionId,logicalActionId,messageId})`.
No canonical message repair, receipt synthesis, clear/dismiss state, or
legacy backfill is performed by the migration. The marker primary key is the
projection dedup identity and its FK requires a P9-owned fact. The marker does
not duplicate target, failure code, timestamp, or summary; P10 joins the fact
for display and can seed the marker after journal pruning. Ordinary
`MessageSent(v1)` and `SendMessage` remain unchanged. Binaries whose schema
ceiling is v33 refuse `user_version > 33`; P37 must follow the ordered P36
upgrade and no P37-only v35 release is valid.

### P37 v1.43 raw-event classification, poll and dispatcher contract

P1 `05` supplies the raw journal-candidate read. Within one poll
`BEGIN IMMEDIATE`, P1 reads the current Attention offset, reads the raw event
batch, and for each usable raw EventId queries the P9 fact before decoding
event type, version or payload. A matching fact requires strict
`DeliverReplayEscalated(v1)` decoding and exact witness comparison. Exact
Deliver type without a fact, or a fact with malformed/mismatched event, is a
typed source-integrity failure: roll back poll projections, marker, queue ACK,
dead letter and offset. It is never ordinary poison. Ordinary non-Deliver
decode poison and pure event-local projection defects retain P1's existing
dead-letter-and-advance behavior. P1 prune, P9 fact/outbox writes, P10 poll
and rebuild/reset serialize on the same SQLite writer transaction boundary.

A valid singleton global Attention lease returns `NoClaim` without mutating
owner, generation, expiry, Project or schedule state. Claims use
`BEGIN IMMEDIATE` plus compare-and-swap against the observed generation and
empty/expired lease predicate. Due eligible Projects are selected by
`(last_attempt_sequence, project_id)`; claim increments that sequence exactly
once. Success commits projection, offset and claim release together. Typed
integrity failure rolls back poll data then persists failure/backoff and
rotation. An expired claim finalizes the already-sequenced attempt once as
`PollLeaseExpired`; it does not receive immediate retry priority. Backoff is
the P12-pinned saturating rule
`min(baseBackoffMs * 2^(min(n-1, backoffExponentCap)), maxBackoffMs)`.
Repeated-crash Projects remain pending and are not promised completion; the
fairness guarantee is bounded selection among continuously due healthy
Projects, not wall-clock progress during unbounded writer lock or repeated
crash conditions. P12 `05` owns profile/evidence and measured lock-capacity
gates.

Migration `0038_executable_approval_handoff` (`PRAGMA user_version = 38`)
is forward-only after 0037. It rebuilds the 0032 `action_approvals` table
without editing migration 0032, retaining every existing column and row while
adding these nullable route-specific fields:

```text
logical_step_no, repair_attempt, action_index, logical_action_id,
call_ref, tool_invocation_id, cancelled_at, cancelled_by,
cancellation_reason
```

For new `Executable` rows, project/workspace/execution, Step identity,
LogicalActionId, callRef and ToolInvocationId are required and
`binding_proven=1`. Historical Executable rows remain `binding_proven=0` and
in their 0032 terminal state (`Expired` if unconsumed, `Consumed` if already
consumed), with `source_state` and `consumed_by` preserved. The migration does
not infer the missing invocation/Step identity, make a legacy row reusable, or
reinterpret historical `Denied(ApprovalRequired)` ToolInvocation rows.
Control rows keep their Control-owned shape and status semantics.

The rebuilt `state` checks add `Cancelled`. `Pending` carries no decision,
consumption or cancellation facts. `Approved`, `Rejected` and `Consumed`
require both human decision time and actor. `Expired` and `Cancelled` permit
both decision fields when preserving an earlier Approve, or neither when
closing a Pending row; half-populated provenance is invalid. `Cancelled`
requires its cancellation time, actor and reason. Only `Consumed` carries
both `consumed_by` and `consumed_at`; those two fields are either both present
or both absent. An Executable row with `binding_proven=0` is allowed only in
its preserved legacy terminal `Expired`/`Consumed` state; a proven Executable
row requires the full binding tuple above.

Migration 0038 drops the old digest-only unique index and installs
route-specific uniqueness:

```sql
DROP INDEX action_approvals_exact_action;
CREATE UNIQUE INDEX action_approvals_control_exact_action
  ON action_approvals(execution_id, action_digest, control_basis_digest)
  WHERE route_kind = 'Control' AND execution_id IS NOT NULL;
CREATE UNIQUE INDEX action_approvals_executable_logical_action
  ON action_approvals(execution_id, logical_step_no, repair_attempt,
                      action_index, logical_action_id)
  WHERE route_kind = 'Executable' AND binding_proven = 1;
CREATE UNIQUE INDEX action_approvals_id_project
  ON action_approvals(approval_id, project_id);
```

This keeps the existing Control exact-action uniqueness and permits different
LogicalActions in one Execution to request identical action/target/ControlBasis
semantics. The Executable key deduplicates one logical action; after a unique
conflict, Application compares route and every stable binding field but
excludes candidate `expiresAt`, mutable revision, state and decision. The
loser reads the committed winner's ApprovalId, first-commit expiry and current
revision. A different candidate `now` therefore never causes a binding
conflict or TTL refresh. Any other binding mismatch fails closed.

`action_approvals_id_project` is the unchanged composite UNIQUE key introduced
by migration 0033; 0038 must recreate it on the rebuilt table. The
`assign_work_target_bindings(action_approval_id, project_id)` foreign key
references this exact pair. Rebuilding `action_approvals` without this key
would invalidate the existing FK contract; 0038 changes neither that
AssignWork binding nor its Control approval semantics.

The P38 amendment's migration-order statement remains history for that
amendment. The current accepted/planned suffix is `0034 → 0035 → 0036 → 0037
→ 0038 → 0039`. P39 does not permit skipping a pending predecessor; its
preflight runs before pending P37/P38/P39 DDL. No earlier migration body,
checksum, Control row or Deliver projection is modified. The existing v37
binary's refusal at `user_version >= 38` remains unchanged; P39's schema
ceiling is a separate implementation gate and is not established by this
design-only amendment.

Migration `0039_ah7_reconciliation_attempts` (`PRAGMA user_version = 39`) is
the accepted forward-only P39 contract in P4 `06` and P1 `04`. Before any
pending 0037/0038/0039 transaction, maintenance-mode startup validates
`--migration-block-report-db <absolute-local-path>` and its dedicated
sidecar schema/WAL/FULL settings before opening the primary DB. On a v36–v38
primary, a read-only `BEGIN IMMEDIATE` snapshot detects active P36
`NotAdmitted` rows whose source binding is unprovable. If found, it commits and
reads back the stable immutable report under primary→sidecar lock order, rolls
back the primary snapshot, exits typed `P39_LEGACY_DB_ISOLATED` (78), and does
not start service runtime. The primary committed rows/schema/approval/P3
state/user_version remain unchanged. That DB is permanently isolated until
future governance; no binding is fabricated, approval refunded/transferred,
row deleted, or invocation retried. A clear snapshot proceeds through
0037→0038→0039 only while all other primary writers remain stopped.

P39 rebuilds P36 `tool_invocations` with monotone admission and binding state,
settlement provenance plus `selected_attempt_no/selected_fact_id`, and a
deferred composite FK to the same invocation/attempt immutable fact. It adds
`tool_invocation_recovery_bindings`, `tool_invocation_effect_attempts` (only
attempt 0/1, explicit legacy admission provenance and time precision) and
append-only `tool_reconciliation_facts`. New terminal reconciliation
Success/ExpectedFailure/ReconciledNoEffect requires exactly one selected fact;
ordinary terminal and preserved P36 terminal rows have no selected fact.
Historical MayHaveStarted gets unknown admission time (never `intent_at`), and
unprofiled history keeps null profile/effectKey/binding with physical
`LegacyProfileUnavailable` provenance while its canonical reason remains
`ProfileUnavailable`. P39 has no down migration; FK check and all DDL/backfill
share the forward migration transaction.

The operator sidecar uses a unique stable report key and content hash,
immutable report rows, readback verification and same-key conflict refusal.
Sidecar and primary DB are distinct SQLite files; lock order is primary then
sidecar, and uncertain sidecar commit is resolved by key/hash before primary
rollback or continuation. WAL/SHM are retained together; the named operator
owns backup/retention. Windows deployment is blocked until the actual Node VFS
and each supported local filesystem pass process-kill, I/O-fault, VM
hard-power-off, reopen and integrity qualification. `synchronous=FULL` is
conditional on VFS, OS and hardware flush behavior; network and unknown
filesystems fail closed. Exact table/column/check/FK/index/trigger contract is
owned by P4 `06`; CLI/preflight and migration boundary by P1 `04`/`06` and P14
`02`/`05`.

Migration `0040_tool_observation_evidence` (`PRAGMA user_version = 40`) is the
next forward-only suffix after P36→P37→P38→P39. It is cumulative-only and may
enter only at version 39; it cannot be registered in phase-local
`P4_MIGRATIONS`, released as a standalone v35 upgrade, or skip a predecessor.
P1 `04` owns this global prefix/version/startup boundary; P4 `06` owns the
`tool_invocations` evidence columns/checks/triggers; P9 `07` owns the immutable
replay-evidence fact/event; P10 `02` owns its source-specific marker relation.
The accepted P39 sidecar/preflight, RecoveryBinding, selected-fact and attempt
contracts are unchanged.

P40 adds nullable `observation_format_version TEXT`,
`observation_json BLOB`, and `observation_sha256 TEXT`; five DG01 evidence tags
and the accepted P39 `ReconciledNoEffect` branch use the same v1 UTF-8
canonical envelope with 16,384-byte cap and hash
`SHA-256(UTF8(version + LF + body))`. RNO's P4 Observation/result Artifact is
strictly separate from P39's `NotOccurred` proof `evidence_ref` and NULL fact
`result_ref`; P39 `selected_fact_id` remains bound to the exact invocation and
attempt. DG03 `Denied/NotAdmitted` is evidence-null and keeps its closed
reason-code projection. P40 performs no backfill, selected-fact update or P39
sidecar mutation.

P39 migration may be installed only as part of the cumulative maintenance
chain; **a database at `user_version=39` must not start Agent/P4 Runtime or be
released until P40 commits version 40**. The runtime binary must reject schema
40 unless its v1 Observation decoder includes the RNO branch. The migration
runner must serialize cross-process startup; this prerequisite, P36–P40 prefix
integration and P39 sidecar/Windows durability remain unqualified. P40 has no
down migration; DDL and `user_version=40` commit atomically.

Migration `0041_submitted_decision_binding_attention`
(`PRAGMA user_version=41`) is the forward-only P41 suffix after the complete
0036→0037→0038→0039→0040 prefix. It is cumulative-only: integration and
qualification of every predecessor are prerequisites; 0041 cannot be run from
v35, registered/skipped/released independently, or used to rewrite any prior
migration body, number, or checksum. It creates P9's immutable
`submitted_decision_binding_attention_facts`, unique on
`(execution_id, logical_step_no, repair_attempt, logical_action_id)`, with an
audit-only `event_id` that has no FK to `domain_events`; the row references the
exact Execution/Step/Action and records the first typed failure. It creates
P10's source-specific `submitted_decision_binding_attention_rows`, keyed by
`attention_fact_id` and FK-bound to the P9 fact and owning Workspace, with no
FK to the source event. It backfills no historical canonical/receipt rows and
does not infer from Session text. The P9 startup audit classifies exact
settled-Failed/AIP/Pending-select-current-work orphans as the specific mismatch
when still provable, otherwise
`SettledExecutionWithPendingDecisionAction`; it adds Attention only and never
resurrects/repairs the orphan. DID v1.42 describes the target contract; the
serialized cumulative runner, migration implementation and qualification
remain separate gates.

## 9.4 Relational vs JSON Rule

必须关系化：

```text
Identity / FK
Authority relation
transaction invariant
high-frequency filter/join
uniqueness
ordering
recovery / fencing
```

适合 JSON：

```text
ResponsibilityDefinition
VerificationMission
ResponsibilityBoundAgentBinding / ExecutionBoundAgentBinding
Project/Workspace Policy
ExpectedDeliverable
criteria results
structured semantic VO
```

## 9.5 Resource Ownership persistence

`resource_ownership` 持久化的是 resolved ownership claim，而不是未经解析的 path string。至少保存：

```text
workspace_id
resource_space_id
canonical_region
source_resource_address_snapshot/ref
resource_boundary_revision
resolved_at_environment_revision
created_at
```

具体 region 编码可以按 resource kind 使用关系列 + JSON VO，但 overlap evaluation 必须基于 `CanonicalResourceRegion` 的 domain function，而不是 SQL string-prefix 近似。

第一版单 Runtime 使用 `BEGIN IMMEDIATE` 序列化 ownership change transaction，在同一 transaction 内完成 conflict load → overlap evaluation → write。若未来迁 PostgreSQL，可以替换 persistence enforcement 机制，但不能改变 canonical overlap semantics。

## 9.6 Active Main Execution

不存 `is_active` 重复状态，使用 partial unique index 语义：

```text
UNIQUE(workspace_id)
WHERE binding_kind = 'workspace'
  AND settled_at IS NULL
```

保证：

```text
Workspace → at most one active main Execution
```

`executions.binding_kind ∈ { workspace, execution_bound }`；partial unique index 仅约束
`binding_kind = 'workspace'`。`ExecutionBound`（specialist）不受该唯一约束，P2 不新增其并发上限。

`executions` 必须 durable 保存 admission-time `session_id`，settle 后保存完整 `ExecutionSettlement` discriminator + semantic result payload/ref。不得只保存 `outcome = Completed` 而丢失 `CompletionClaimed/Yielded/...`。

## 9.7 Lease / Fencing

Lease 独立高频表：

```text
execution_id
worker_id
generation
expires_at
updated_at
```

Worker durable mutation 必须检查 current fencing generation；对 canonical command，该 generation check 与 canonical read/write、Command resolution、Domain Event append 共享同一 transaction/session。事务外 pre-check 不具权威性。

v1.14 (G6)：lease holder identity = `WorkerId`（可替换的执行者身份）+ `WorkerIncarnationId`
（同一 `WorkerId` 的进程/实例化身，用于区分重启后的旧持有者）。canonical control plane 保持
**single-writer**；remote Worker **禁止直连/直写 canonical DB**，只能经 authenticated
versioned transport 调用 control plane，由 control plane 在同一事务内执行 fence check +
mutation。不引入 distributed consensus / multi-writer control plane。

Authoritative fence validation 与 stop/quiescence mutation admission 是**两个独立检查**：

```text
fence validation
  = ownership/generation 是否有效
  = 失败返回 Application CommandRejection.FencingRejected

stop / quiescence admission
  = fence 仍有效，但 stopRequestedAt != null
  = 禁止新的 execution-originated mutation
  = 失败返回 Application CommandRejection.ExecutionStopping
    （ExecutionStopRequested 仍是既有 Domain Event / stop-request fact 名称）

一个 generation 仍然有效的合法 Worker，仅因 stopRequestedAt 被拒绝时，
不得返回 FencingRejected。
```

P1 冻结 persistence hook 与 transaction integration（fence validation +
canonical read/write + receipt + event 同一事务）；P2 负责 lease
acquisition/renewal/loss lifecycle。精确 SQL predicate 在 P1 phase contract 冻结。

P2 冻结：`SettleExecution` 的 `ExecutionOrigin` 路径是 `QuiescenceControlMutation`，在
`stopRequestedAt != null` 后仍 admissible，但仍必须通过 authoritative fencing；
`NormalExecutionMutation`（§3.4）在 stop 后返回 `ExecutionStopping`。该二分只适用于
Execution-originated mutation；`AdmitExecution` / `StopExecution` / `RecoveryController`
settlement 不归入该二分。两类 mutation 都不得用事务外 pre-check 替代 authoritative fence。

## 9.8 Session / Epoch / Entries

Session metadata 与 history 分离。`session_entries` 使用 Session-local sequence，保存有限认知 entry 类型：

```text
Input
ModelOutput
Observation
CheckpointReference
ContextUpdate
```

streaming delta 不直接进入 Session history。

v1.20 起，runtime-produced entry 可携带 `source_kind`、`source_ref` 与
`content_hash`。`ModelOutput` 使用 `ProviderTurn` source；同一
`(session_id, entry_kind, source_kind, source_ref)` 至多一条。重复相同 hash 返回
既有 sequence，不同 hash 是 invariant conflict。Worker-originated append 与
AgentLoopStep 状态推进在同一事务中验证完整 lease-holder triple（P2 `02`/`04`，P3
`08` §6）。

v1.22 起，`session_entries` 是 `SessionItem` versioned envelope 的物理 carrier。
下一 forward-only migration 是 **0019**（0018 已由 Project archive/human-message
terminal evolution 占用）；本设计落字不授权运行该 migration。最小列语义为：

```text
session_id + sequence
item_type + schema_version
payload_json
source_kind + source_ref + content_hash
context_epoch
created_at
```

新 sourced item 的 `(session_id, item_type, source_kind, source_ref)` 唯一。同 source/
different hash 是 invariant conflict。旧 `Input/ModelOutput/Observation/
CheckpointReference/ContextUpdate` row 保留为 Legacy evidence；不得从 payload text
猜测 callRef 或自动升级为 strict ToolResult。无法证明来源的 legacy row 只允许审计/
portable summary，不进入 strict tool-call replay。

`SessionRepository` 至少提供：

```text
appendItemIdempotent
listActiveFrontier(sessionId, epoch)
commitCompaction(expectedEpoch, checkpoint, fence)
```

`InputPromotionService.promoteInbox` 在同一 Transaction scope 完成 sourced Session
Input append + Inbox consumed；重复调用返回既有 sequence。

## 9.9 Commands / Events

`commands` 保存 logical request 的 authoritative resolution，而不是只保存成功 mutation：

```text
commands
────────────────────────────
command_id                    PK
project_id
semantic_request_fingerprint
schema_version
fingerprint_algorithm_version
resolution                    Committed | TerminalRejected
result_json?                  // Committed
terminal_error_json?          // TerminalRejected
created_at
settled_at?
```

同一 `command_id` 且 `semantic_request_fingerprint` 不一致 → `IdempotencyConflict`。

Operational attempts 单独记录为非权威 trace：

```text
command_attempts
────────────────────────────
command_id
attempt_no
started_at
settled_at?
outcome                    // Committed | TerminalRejected | RetryableOperationalFailure
failure_kind?
metadata_json?

PRIMARY KEY(command_id, attempt_no)
```

`command_attempts` 是非权威 operational trace，不要求 FK 到 `commands`
（一个 attempt 可能在任何 authoritative resolution 之前发生）。
`attempt_no` 从 0 开始。

`CommandReceipt` 是 `commands.resolution + result/error` 的稳定读取视图，不要求独立 table。

语义：

- `commands` 只持久化 authoritative resolution：`Committed | TerminalRejected`；
- 一个 semantic command 使用**单一事务**完成：
  canonical reads + authority/preconditions + fence validation +
  domain transition + canonical writes + authoritative receipt +
  Domain Events（仅 `Committed`），原子提交；
- 不引入 durable `Pending` 预登记，不引入双事务模型；
- 未 commit 的 operational failure：ROLLBACK → 不产生 authoritative
  resolution → 不写 `commands` row；同一 CommandId 可重试（语义请求不变）；
- 一旦存在 `Committed` / `TerminalRejected` row，same CommandId 重试：
  same fingerprint → 返回既有 Receipt；different fingerprint →
  `IdempotencyConflict`；
- `TerminalRejected` 是 durable command truth，但不产生 Domain Event；
- semantic stale precondition 改 payload 后必须新 CommandId；
- `FencingRejected` / `ExecutionStopping` 对 Execution-originated Command terminal。

EA-DG-01 `ResolveExecutableApproval` is an External human command through this
same Gateway/receipt boundary. P12 resolves the authenticated decision
authority before receipt lookup; missing/foreign approvals return the same
safe not-found outcome without target-existence disclosure. For an authorized
target, one `BEGIN IMMEDIATE` transaction compares route/project/workspace/
Execution/state/revision, CASes Approve/Reject or commits Expired when the
deadline wins, consumes the exact P6 Inbox key, appends
`ExecutableApprovalResolved(v1)` and commits the result receipt. A stale
authorized revision is `RevisionConflict`. Decision/replay never writes a P4
ToolInvocation effect or consumes a Control ActionApproval. StopExecution
atomically closes unclaimed Executable Pending/Approved rows as Cancelled in
its existing P2-authorized command transaction; all Control route semantics
remain unchanged.

`domain_events` 同时承担 durable outbox；多 Consumer 通过 `consumer_offsets` 分别推进，不额外维护单一 outbox delivery flag。

Direct-child AssignWork extends the single-transaction command path with the
typed `AssignWorkCommandEvidence` and `AssignWorkControlAuthorizationEvidence`
from §6A.16. Gateway validates every Grant field against the current durable
row (Active state, exact revision, subject, capability, target, and validity
window), or every ActionApproval field (Approved state/revision,
`binding_proven = 1`, Control route, project/workspace/execution, stable action,
action digest, target, ControlBasis, and expiry). It validates the existing
command evidence and source action, then writes the Work, `WorkAssigned`
event, Command receipt, and binding together. The binding is excluded from
`semanticRequestFingerprint`.

For ActionApproval, Gateway calls the P4-owned `ControlApprovalStore` inside
the same `TransactionScope` with `consumedBy: CommandId`. Consumption sets
`state = 'Consumed'`, increments revision once, and records the original
CommandId after the handler attempt and before transaction commit. A
FencingRejected or ExecutionStopping pre-handler result does not consume it.
Do not call a standalone post-commit approval consumer for AssignWork. Before
commit, rollback leaves no binding, Work, event, authoritative receipt, or
approval consumption (only the existing non-authoritative CommandAttempt may
remain). After commit, all canonical facts are visible together. Uniqueness
conflicts are handled by reading in a fresh transaction; exact existing
evidence may converge, conflicting evidence never overwrites or uses
`INSERT OR REPLACE`.

The P9 failure event payload is exactly
`{attentionFactId, executionId, targetWorkspaceId, logicalActionId,
committedCommandId, failureCode}`. Its `aggregate_ref` is the Execution's
owning Workspace, `correlation_ref` is the LogicalActionId, and
`caused_by_command_id` is the committed AssignWork Command. The new immutable
`assign_work_binding_attention_facts` row and event are appended in one
transaction by `RecoveryAttentionFactStore`. A duplicate identity tuple returns
the existing fact without another event; a deterministic fact/event conflict
with different payload is a typed invariant error. P10 consumes the event and
reads the P9 fact in its same projection transaction.


## 9.10 Provider Turn / Model Context

调用模型前 durable：

```text
ProviderTurn intent
+
ModelContextManifest
```

再执行 Provider request。这样 crash 后可以回答本次调用使用了什么模型上下文。

Compaction 也是 Provider Turn 类型的一种，不作为不可见内部 hack。

`provider_turns` 的语义 `operation_kind` 为：

```text
Inference | CompactionSummary | CompactionNative
```

三类均先持久 intent + Manifest，再调用 Provider。Native opaque item 存入 Blob/
Artifact 或等价耐久 carrier；ProviderTurn/Session 只保存 ref + binding fingerprint，
raw credential 不得进入 opaque item metadata。

## 9.11 ProviderTurn / ProviderAttempt

`ProviderTurn` 表示一次逻辑模型决策，绑定唯一 `ModelContextManifest`；transport 层的 safe retry 记录为该 Turn 下的 `provider_attempts`：

```text
provider_attempts
────────────────────────────
provider_turn_id
attempt_no
started_at
settled_at
outcome
provider_error_kind nullable
transport_metadata_json
canonical_event_prefix_json       # current P16 baseline
success_evidence_version nullable  # v1.20 migration 0017

PRIMARY KEY(provider_turn_id, attempt_no)
```

同一 Turn 的 retry 不产生新的 ModelContextManifest，不增加 Agent `turnNo`。只有新的语义模型决策才创建新的 ProviderTurn。

成功路径必须以一个语义 store 操作原子提交 `ProviderAttempt Success` 与
`ProviderTurn settled`。恢复发现完整成功证据时先本地收敛，禁止再次请求同一
Turn；仅无完整成功证据的 unsettled Turn 才进入 P9 safe retry。完整性校验按
`success_evidence_version` 选择版本化规则；legacy null 只能经受治理的 legacy
validator 采纳，不能自动视为成功。

## 9.11A AgentLoopStep / AgentLoopStepAction

Migration `0017_agent_loop_step_handoff` adds:

```text
agent_loop_steps
  PK(execution_id, logical_step_no, repair_attempt)
  UNIQUE(provider_turn_id)
  predecessor identity, manifest_id?, state, decoder_version?,
  provider_failure_json?, repair_disposition_json?, successor_json?,
  decoded_output_hash?, model_output_session_sequence?, next_action_index,
  settlement_json?, migration_provenance_json?, revision, updated_at

agent_loop_step_actions
  FK AgentLoopStep identity + action_index
  UNIQUE(logical_action_id)
  call_ref, route_kind, action_kind, input_hash, state,
  result_ref?, settlement_ref?, disposition_json?, observation_source_ref?,
  revision, updated_at

session_entries (additive)
  source_kind?, source_ref?, content_hash?
  UNIQUE(session_id, entry_kind, source_kind, source_ref)
    WHERE source_kind IS NOT NULL
```

Migration `0020_agent_loop_step_provider_turn_chain` adds:

```text
agent_loop_step_provider_turns
  FK AgentLoopStep identity
  overflow_ordinal = 0
  role = Inference | OverflowCompaction | OverflowReplacement
  provider_turn_id UNIQUE
  predecessor_provider_turn_id?
  context_epoch
  manifest_id?
  state = Prepared | SettledSuccess | SettledFailure
  PRIMARY KEY(step identity, overflow_ordinal, role)
```

The existing `agent_loop_steps.provider_turn_id` remains the original Inference
Turn for compatibility. Chain ensure is idempotent; binding mismatch is an
invariant conflict/Attention. Ordinary transport attempts and output repair do
not enter this chain.

Exact DDL/check constraints and forward-only legacy adoption are frozen in P2
`04`, P3 `08`, and P9 `07`. Every AgentLoopStep/action transition is a short
`BEGIN IMMEDIATE` transaction with authoritative fence validation, or converges
through an already committed stable idempotent result. No AgentLoopStep row enters
the Domain Event journal solely because runtime progress advanced.

## 9.12 Tool side-effect metadata

`tool_invocations` 必须保留 ToolDefinition 的 `SideEffectSemantics` snapshot/ref，使 Recovery 在 crash 后能区分 ReadOnly / Idempotent / Reconcilable / NonIdempotent，并据此决定 retry 或 reconciliation。`OutcomeUnknown` 不允许被普通 retry policy 吞掉。

## 9.13 Cyclic Foreign Keys

两个创建环：

```text
Project.rootWorkspaceId ↔ Workspace.projectId
Workspace.primarySessionId ↔ Session.workspaceId
```

优先使用 deferred FK semantics，使 Project + Root Workspace + Primary Session 能在同一事务中建立并在 COMMIT 时统一验证。

---

# 10. DID-9 — Package / Module Architecture

## 10.1 Monorepo Boundary

```text
arbor/
├── apps/
│   └── single-workspace/        # Composition Root + transport shells (P12)
├── packages/
│   ├── domain/
│   ├── ports/
│   ├── application/
│   ├── model-context/
│   ├── agent-runtime/
│   ├── execution-runtime/
│   ├── provider-runtime/
│   ├── tool-runtime/
│   ├── projection-runtime/
│   ├── api-contracts/
│   └── testkit/
├── adapters/
│   ├── persistence-sqlite/
│   ├── blob-local/
│   ├── environment-local/
│   ├── environment-resolver-local/
│   ├── sandbox-local/
│   ├── sandbox-worktree/
│   ├── secret-env/
│   ├── secret-file/
│   ├── provider-fake/
│   ├── provider-openai/
│   ├── worker-local/
│   └── worker-transport/
└── tests/
    └── architecture/
```

Package 只对应真实依赖/替换边界，不采用“一对象一 package”。

v1.14 (G8): `verification-runtime` **不是**独立物理包——Verification 由 `domain` /
`application` + generic `ExecutionBound` runtime 实现（P8 phase-scoped 边界决定），上表已移除。

## 10.2 Package Responsibility

| Package | 核心职责 |
|---|---|
| `domain` | 什么状态/变化是合法的 |
| `ports` | 系统需要哪些外部能力 |
| `application` | 哪个 Command 如何提交 |
| `model-context` | 模型在当前 Turn 如何理解世界 |
| `agent-runtime` | 执行 Model→Action→Observation loop；拥有 safe input drain、AgentStepContext orchestration、Compaction Coordinator、ControlToolRegistry、internal AgentAction、durable AgentLoopStep orchestration 与 shared control policy |
| `execution-runtime` | 谁何时运行、Lease/Fencing/Recovery；消费持久 settlement proposal |
| Verification (无独立包; v1.14 G8) | 组织独立 Agentic Verification（由 `domain` / `application` + generic `ExecutionBound` runtime 实现） |
| `provider-runtime` | 可靠调用模型与协议适配 |
| `tool-runtime` | 实现 Tool invocation authorization/sandbox/settlement；Tool catalog contract 位于 `ports` |
| `projection-runtime` | 将事实转为 Tree/Attention/UI read model |
| `api-contracts` | 外部 API/产品契约 |
| `testkit` | deterministic fake/harness/scenario testing |

## 10.3 Effect Boundary

`domain` 允许 Effect 的纯数据/FP vocabulary，并允许纯 transition 使用 `Effect<A,E,never>` 统一 expected-domain-error composition；Domain 不允许拥有 infrastructure Requirement。

`ports/application/runtime` 使用 Effect service、Layer、Stream、Scope、Schedule、Fiber 等能力。Port 是 Service contract，Adapter 是 Layer/provider implementation。

架构审计同时看三件事：

```text
A 是否暴露正确的成功语义
E 是否只包含该层可处理的 expected typed failure
R 是否只包含精确的 capability/service
```

禁止 global `AppEnv`、`RuntimeContext` 或任何把全部 service 合并成一个 Requirement 的 Service Locator。

## 10.4 Dependency Rules

硬规则：

```text
Domain has no infrastructure dependencies.
Canonical semantic mutation only through Application.
Runtime depends on Ports, not Adapters.
Composition happens only at app boundary.
Projection never participates in authority decisions.
```

禁止 deep import；通过 package `exports` + package dependency declaration + architecture tests 强制 DAG。

### 10.4.1 Allowed internal dependency matrix

以下是 v1.2 冻结的**允许直接依赖**。未列出的 internal edge 默认禁止；`testkit` 与 `apps/*` 作为测试/Composition Root 例外单独管理。

| Package | Allowed direct internal dependencies |
|---|---|
| `domain` | — |
| `ports` | `domain` |
| `application` | `domain`, `ports` |
| `model-context` | `domain`, `ports` |
| `agent-runtime` | `domain`, `ports`, `application`, `model-context` |
| `execution-runtime` | `domain`, `ports`, `application`, `agent-runtime` |
| `provider-runtime` | `ports` |
| `tool-runtime` | `domain`, `ports` |
| `projection-runtime` | `domain`, `ports` |
| `api-contracts` | `domain` |
| `adapters/*` | `domain`, `ports` |
| `apps/*` | Composition Root；可依赖所需 packages/adapters |
| `testkit` | test-only；可为 scenario/harness 依赖多 package，但 production package 不反向依赖它 |

> v1.14 (G8): `verification-runtime` 不作为独立包（Verification 由 `domain` /
> `application` + generic `ExecutionBound` runtime 实现），故不在此矩阵中。

DID v1.18 does not add a package or dependency edge. `ControlToolRegistry`
and the internal `AgentAction` remain inside the existing `agent-runtime`
package. The app Composition Root joins the registry's data-only control-tool
definition projection with executable definitions and supplies both to Model
Context. Thus `model-context !-> agent-runtime` and
`model-context !-> tool-runtime` remain hard boundaries.

DID v1.20 also adds no package or dependency edge. `AgentLoopStepStore` and the
extended Provider/Session stores are `ports` contracts implemented by the
existing persistence adapter; orchestration remains in `agent-runtime`, while
`execution-runtime` consumes the persisted proposal through existing allowed
edges.

DID v1.22 adds no package or dependency edge. `model-context` owns
ContextProjector/budget evidence/typed request compilation; `agent-runtime`
owns safe input drain and Compaction orchestration; `application` owns the
transactional InputPromotionService; `provider-runtime` owns operation lowering
and provider evidence. Existing forbidden edges remain unchanged.

额外硬规则：

```text
model-context !-> tool-runtime
model-context -> ports/ToolCatalogPort

agent-runtime !-> provider-runtime implementation
agent-runtime -> ports/ProviderPort

agent-runtime !-> tool-runtime implementation
agent-runtime -> ports/ToolRuntimePort

adapters !-> application/runtime
runtime packages !-> adapters
```

如果未来需要新增 edge，必须先证明它不是把 composition concern 或 implementation dependency 向内层泄漏。

Canonical architecture-test location:

```text
tests/architecture/**
```

所有 package-DAG、forbidden-import、exports-boundary 与 requirement-leak 测试都位于该目录。不允许存在第二个 architecture-test root。

## 10.5 API Error Presentation

内部 typed error 在 `api-contracts` 边界映射成稳定的 presentation DTO：

```text
Problem
├── code
├── category
├── message
├── correlationId
├── retryDisposition
└── safeDetails
```

UI/CLI 依赖稳定 `code`，不解析 message 文本。`Problem` 只是外部协议，不允许反向成为内部万能 Error 类型。

## 10.6 AgentRuntime 瘦身

AgentRuntime owns the shared control-action path but does not own executable
tool execution. Its turn routing is:

```text
load Execution + AgentExecutionState
↓
ModelContext.prepareTurn()
↓
ProviderRuntime / ProviderPort
↓
ModelContext.decodeTurn()
↓
typed ToolInvocation classification
├── executable → P4 ToolRuntimePort
└── control → ControlToolRegistry codec
              → in-process AgentAction
              → shared Agent Runtime policy
              → owning Application command / settlement boundary
↓
Observation
↓
continue or settle
```

P2 freezes the `ExecutionDriverPort` turn/step boundary and settlement trigger;
it does not freeze a universal AgentDirective vocabulary or output contract.
P3 supplies the real Agent loop through that port. P2 still owns
execution-wide Runtime Safety / control gating; AgentRuntime reports activity
at each new ProviderTurn, executable ToolInvocation, or control AgentAction
boundary and receives the existing continue/stop decision.

Prompt composition, context planning, and provider/model-family representation
remain outside AgentRuntime. AgentRuntime owns the control-tool registry, its
semantic codecs, and shared control policy. Model Context selects and compiles
the definition data supplied by the executable catalog and control registry;
composition joins these sources without moving their semantics into Model
Context or the composition root.

---

# 11. DID-10 — Development Phases

实现不以“Arbor 必须自举开发 Arbor”为硬约束。Self-hosting 只可作为后期 dogfooding / validation 场景。

采用 dependency-driven、risk-first、vertical-slice 方式推进。

DID v1.18 phase interpretation: action names in P5–P8 phase summaries and
their historical contracts denote semantic behaviors owned by those phases;
they do not define a provider/model wire union. The model-facing route is the
ToolInvocation → executable/control classification frozen in §§7.6, 8.15, and
10.6. Existing non-fatal result, command, settlement, and lifecycle semantics
remain with their phase owners.

## P0 — Functional Domain Kernel

```text
Repository skeleton
Typed IDs
Core ADTs / Value Objects
Project / Workspace / Work / Execution / Session
Verification / Dependency / Deliverable
Domain Errors / Domain Events definitions
Pure authority/policy vocabulary
Invariant tests
Architecture tests
```

没有 SQLite、LLM、Tool、HTTP、CLI。

## P1 — Persistence + Command Core

```text
SQLite schema
TransactionPort
Repositories
Command logical-request / attempt / receipt persistence
DomainEventJournal
CreateProject / CreateChildWorkspace / AssignWork commands
atomic State + Receipt + Event + authoritative fence *validation hook*
(lease acquisition / lease lifecycle 仍属于 P2)
```

## P2 — Execution / Session Kernel

```text
Execution admission
Lease / Fencing
AgentExecutionState
Session / Epoch / Checkpoint
Worker dispatch abstraction
Recovery skeleton
Fake Agent
```

```text
Execution admission        (WorkspaceMain + ExecutionBound; caller-preallocated IDs)
Lease / Fencing            (generation source; acquisition/renewal/loss lifecycle)
AgentExecutionState
Session / Epoch / Checkpoint  (+ SessionRepository.appendEntry)
Worker dispatch abstraction (WorkerDispatchPort)
ExecutionScheduler + durable WorkWait + timer/wake + lost-wake-up protection
ExecutionDriverPort + Fake Driver
execution-wide Runtime Safety / control gating
Application-level command-specific VerifiedRuntimeCommandAuthority
Recovery skeleton
```

P2 owns **generic** `ExecutionBound` admission (durable Execution + `ExecutionScoped` Session);
higher-level feature phases own spawn semantics (P6 delegation, P8 Execution-bound Verifier, …).
P2 只消费 environment revision/change facts；`RecordEnvironmentChange` 由 P11 拥有。

## P3 — Provider + Model Context + Minimal Agent Loop

```text
ProviderPort / ProviderRuntime
ModelCapabilityPort
Model Context v1
Base Agent Protocol
Responsibility-bound Protocol
Work Execution Program
Output Contract
Prompt provenance
real model multi-turn continuity
```

P3 通过 P2 的 `ExecutionDriverPort` 提供真实 Agent loop，并只上报 turn/tool activity
observations；execution-wide Runtime Safety / control gating 由 P2 执行。
P3 Output Contract remains available for independent bounded structured-output
protocols; it no longer defines a universal control-action output union.
P3 `08` additionally freezes the durable AgentLoopStep handoff: Provider success
replay, pinned decode, idempotent Session acceptance, action ledger,
unresolved-side-effect gate, successor and settlement proposal.

## P4 — Tool Runtime

```text
ToolCatalogPort / Tool definitions
Authority / Permission
ResourceBoundary / ResourceAddress resolution
Sandbox
ToolInvocation persistence
Blob/Artifact service
read / patch / shell minimal tools
```

```text
ToolCatalogPort / Tool definitions
Authority / Permission
ResourceBoundary / ResourceAddress resolution
Sandbox
ToolInvocation persistence
Blob/Artifact service
read / patch / shell minimal tools
```

P4 冻结边界（DID v1.8 G1–G5）：

```text
InvocationAuthority  = trusted Application-boundary fact; P4 exact-match only
InvocationApproval   = P4-owned record; atomic single consumption
Resource Admission   = validate-only; ownership changes are governance Commands
Sandbox              = P4 SandboxPort + minimal local executor; P11 advanced
Minimal tools        = read/patch/shell as versioned P4 contract artifacts
Tool schemas         = exact parameter/result schema + shell policy enforcement
                       mechanism are P4 phase-scoped contract (not implementation choice)
```

P4 的 `ToolRuntimePort` remains the sole execution route for executable tool
invocations. Its model-facing input is mapped from a provider-neutral typed
invocation to the existing P4 `ToolIntent`; the old
`AgentDirective.InvokeTool` serialization bridge is superseded. P4
authorization, resource admission, sandbox, side-effect persistence, and
recovery semantics are unchanged.

## P5 — Single-Workspace Vertical Slice

一个长期 Workspace Agent 可以跨多个 Execution、Session continuation、Tool effect、restart 完成 Work 并发出 CompletionClaim。

P5 是 **integration phase**（DID v1.9 G1–G7）：只 wiring P1–P4，不重设计任何子系统。

```text
minimal runnable apps/* composition root + deterministic end-to-end acceptance suite
provisional single-workspace RunnableWorkSource (P2 port impl; current/open Work) -> P7 supersedes
AssignWork -> ExecutionScheduler -> AdmitExecution -> lease -> real ExecutionDriverPort
multi-turn Session continuity across Executions (fixed execution.sessionId)
InvokeTool -> P4 pipeline -> Observation -> next turn
Yield -> durable WorkWait -> wake -> continuation
CompletionClaim -> ExecutionSettled(CompletionClaimed); Work stays Open
representative restart-continuity acceptance proof (P2 owns the mechanism)
DirectiveUnsupported directive execution result for P6/P7 directives not implemented in P5
```

P5 does **not** implement Verification / Acceptance / CompleteWork (P8),
dependency coordination (P7), multi-workspace formation / delegation (P6), or
systematic recovery hardening (P9).

## P6 — Responsibility Tree / Multi-Workspace

```text
Responsibility Formation Prompt
Bootstrap / Handoff
Parent/Child Authority
Communication Protocol
Human Steer
```

P6 owns delegation spawn semantics (child / specialist delegation on top of P2's generic
`ExecutionBound` admission).

P6 implements `ProposeChildWorkspace` and specialist spawn; in P5 those
directives return a non-fatal `DirectiveUnsupported` directive execution result
(DID v1.9 G3).

(`CreateChildWorkspace` is owned by P1; P6 builds the multi-workspace
formation/handoff behavior on top of it.)

## P7 — Dependency / Deliverable Coordination

```text
DeclareDependency / WithdrawDependency / MarkDependencyUnfulfillable / ReviseDependencyContract
ProduceDeliverable
Deliver (communication/orchestration primitive, v1.10 G2)
SatisfyDependency (single command face; exact-bound authority, v1.10 G6)
Wait-for Graph
Deadlock Attention (DeadlockAttentionRequested, v1.10 G4)
automatic runnable reevaluation (classification is the single authority, v1.10 G3)
event-driven P7 coordinator (AnyProducer auto-satisfaction, v1.10 G5)
```

P7 implements `DeclareDependency` / `ProduceDeliverable` / `SatisfyDependency`
directives and supersedes the provisional P5 `RunnableWorkSource`
implementation with the full dependency-aware one; in P5/P6 those directives
return a non-fatal `DirectiveUnsupported` directive execution result
(DID v1.9 G2/G3).

## P8 — Agentic Verification

```text
Execution-bound Verifier
Verification Program Family
Evidence lifecycle
PASS / FAIL / UNKNOWN
Parent Acceptance
Query Agent
```

P8 owns Execution-bound Verifier spawn semantics (on top of P2's generic `ExecutionBound`
admission).

P8 owns the `CompletionClaimed` → `StartVerification` → Acceptance →
`CompleteWork` chain; P5 only durably settles the Execution and leaves the Work
`Open` (DID v1.9 G4).

## P9 — Recovery Hardening

系统化故障注入：

```text
worker crash
daemon crash
provider disconnect
tool outcome unknown
lease expiration
old worker resurrection
dispatch failure
consumer crash
projection rebuild
settled Provider result / AgentLoopStep handoff crash windows
legacy AgentLoopStep adoption
```

Systematic fault injection and hardening belong to P9; **P2 owns the recovery
mechanism** and P5 owns only the representative restart-continuity acceptance
proof against the same durable state (DID v1.9 G5).
P9 `07` owns the v1.20 state-disposition matrix, AH1–AH14 crash injection and
evidence-gated legacy adoption. Complete Provider success always converges
locally before transport retry eligibility.

## P10 — Projection / UI

```text
Responsibility Tree
Attention
Workspace Detail
Work Detail
Current Work
Verification
Dependency View
Transcript
Query / Steer / Stop
Usage
```

v1.13 (G1–G8): the authoritative view inventory is SD §12/§13.9 (this list
is an incomplete summary — Search / Workspace Summary / Project Overview /
Inbox views also land here). EffectiveFacts is the single shared
canonical-state-derived projection (P10 owns; P3 consumes). The Attention
read-model contract (source→severity→target→bubbling→dedup) is owned here;
upstream phases only produce facts. External Stop authority resolution is
P12 (inherited clarification of P2 `01`); P10 exposes the control surface
only. Freshness = monotonic watermark + observable lag + explicit
FreshnessRequirement barrier; no implicit read-your-writes. P12 owns
transport shells and must not reinterpret view semantics.
`HumanInterventionApplied` becomes a durable audit/governance fact
(v1.13 G7) emitted by human-originated canonical commands in the same
semantic transaction; the vacant-workspace silent-wait lands as the
`WaitingOnVacantProducer` derived Attention view (P7-GAP-01 closed here).

## P11 — Environment / Git / Advanced Sandbox

```text
worktree/resource isolation
external change detection
impact analysis
environment snapshots
version invalidation
```

P11 owns `RecordEnvironmentChange` / `EnvironmentChanged`；P2 只消费 environment
revision/change facts。

P11 also owns worktree/resource isolation and advanced sandboxing; P4 owns the
minimal `SandboxPort` contract and a local executor (DID v1.8 G3).

## P12 — Production / Extensibility

```text
Plugin SDK / SPI（PluginId / PluginVersion / PluginSdkApiVersion + compatibility policy）
Project tool explicit registration（content/version-bound trust；project-local 不自动可信）
Authority Resolver production plane（只产 trusted authority facts，不执行 mutation）
more providers/tools
remote Worker（single-writer control plane；WorkerId + WorkerIncarnationId；
              authenticated versioned transport；禁止 direct canonical DB 写）
StorageScaleAssessment + DurabilityEnvelope / backup-restore / RPO-RTO / restore drill
              （SQLite 默认；PostgreSQL 仅当 declared operating envelope 无法满足）
observability / health / usage（真实事实派生；unknown cost ≠ 0；pricing versioned）
Runtime Safety Envelope 六维补全（§8.16A cross-phase closure）
security hardening
performance
```

P12 completion blockers（v1.14 G1–G8；与文件头 P12 completion blockers 列表一致）：

```text
1. region-encoding correctness fix
2. ToolCatalogPort inherited contract correction
3. full §8.16A Runtime Safety closure
4. Authority Resolver production plane
5. SecretStorePort / SecretRef + real adapter
6. observability / health / usage plane
7. StorageScaleAssessment + DurabilityEnvelope
8. Remote Worker transport / identity boundary
9. Plugin SDK / compatibility / trust model
```

## P13 — Product Web Client（post-core product-surface phase）

```text
浏览器瘦客户端（apps/web：Vite + React，TypeScript/ESM）
角色冻结：Projection Renderer + Command Initiator
  - 渲染 10 个 frozen view DTO（api-contracts），不重解释 view 语义
  - Human-actionable governance commands 表单化，经 /commands 提交
  - WS 仅用于 invalidation → refetch；无第二套 canonical/projection state
  - Problem DTO typed failures 的明确 UI 呈现
  - design token system（TR-WPU-A modern minimal light / Arbor Green；named semantic tokens）
  - 禁止 Search（out-of-v1）；禁止 domain/application/projection/adapters 依赖
chat-first 主 Workspace 对话面：defer 到 P14+（不在 P13 范围）
```

## P14 — Chat-First 主工作区对话面（post-core product-surface phase）

```text
SubmitHumanMessage（新 human-facing Command：Authenticated Human → Root
Workspace；不扩展 SendMessage；新事件 HumanMessageSubmitted）
对话轮执行 = 既有 WorkspaceMain + ExecutionFocus=Coordination（非
conversational Work；Completed(QueryCompleted) 收口）
one-active-main 下 durable pending 串行；chat 无 interrupt 语义
transcript read model 升级（Human/Assistant turn）；v1 无 streaming
对话权限 root-workspace-only；child 保持 read-only + SteerWork
UI：`/p/:projectId` Root Workbench（Tree + Root Conversation）+ root deep-link mirror；无 /chat 域
浏览器不得直连 external AdmitExecution（server-side wiring only）
合同：docs/design/implementation/P14/**
```

AH19 v1 adds a separate RootWorkspaceId-owned Conversation checkpoint
frontier, distinct from the Workspace Work Session. Immutable HumanMessage
identity/order/body is paired with exact Answered ResponseJob, Attempt and
terminal ConversationResponseEpisode Execution evidence for a contiguous FIFO
prefix. The current raw HumanMessage is pinned once only for its exact Running
Job, active Attempt/Execution and lease; other-episode Running and all earlier
non-Answered or malformed Job/Attempt evidence block the frontier. The exact
ordering, binding, restart, retention and Work-isolation semantics are in SD
v1.19 and P14 `02`. The owner-state physical design and migration remain
separately authorized.

---

# 12. Pre-implementation Closure v1.2

v1.2 的目标不是继续扩张顶层架构，而是关闭那些**现在可以通过推理确定、且会直接影响 P0/P1 接口、一致性与恢复语义**的断点。

## 12.1 C1–C10 Closure Index

| ID | Closure | Status | Canonical owning sections |
|---|---|---|---|
| C1 | ExecutionSettlement: technical outcome + semantic terminal result | **CLOSED** | §3.4, §6A.6 |
| C2 | CommandSubmissionContext + atomic fencing | **CLOSED** | §4.1, §6.3, §7.4 |
| C3 | `prepareTurn()` A/E semantics | **CLOSED** | §6A.10, §8.2 |
| C4 | Command logical request / attempt / receipt | **CLOSED** | §4.1, §6A.5, §9.9 |
| C5 | Shared semantic transaction scope / Repository propagation | **CLOSED** | §7.4 |
| C6 | Execution ↔ Session fixed binding | **CLOSED** | §1.7, §3.4 |
| C7 | Acceptance / Deliverable / Dependency revision binding | **CLOSED** | §1.8, §3.5–3.6 |
| C8 | ResourceAddress / canonical resource ownership algebra | **CLOSED (semantic contract)** | §1.5, §9.5 |
| C9 | Command ↔ Event ↔ Repository ↔ Owner ↔ Invariant + package DAG | **CLOSED (P0/P1 structural level)** | §5, §7, §10, §12.10 |
| C10 | Aggregate exact lifecycle / transition truth tables | **CLOSED** | §12.11 |

`CLOSED` 表示语义与 replacement boundary 已冻结；不等于所有 Phase 的 TypeScript signature、DDL、SQL query、Prompt 正文或性能参数已经提前写死。

## 12.2 C1 — ExecutionSettlement

冻结规则：

```text
ExecutionSettlement is a sum type,
not unrestricted Outcome × Result.
```

合法族：

```text
Completed(CompletedResult)
Interrupted(InterruptedResult)
Failed(ExecutionFailure)
OutcomeUnknown(ReconciliationRequired)
```

`CompletedResult` new writes 区分 `Yielded / CompletionClaimed / VerificationConcluded / Blocked`；历史 `CoordinationCompleted` / `QueryCompleted` 仅供 migration/decoder audit。`Blocked` 绑定精确 Work Episode 且不得改 Work 生命周期；完整拒绝证据与原子持久化由 P2 `01` / P3 `03` 拥有。Crash recovery 不能从裸 `Completed` 猜下一步。`VerificationConcluded { verificationId, verdict }` 仅由 exact-bound Verifier 在结论命令提交、wake 幂等交付后产生；它不触发 CompletionClaim consumer，且不蕴含 Acceptance 或 Work Completed。

`CompletionClaimed` 的 durable settlement + `ExecutionSettled` event 足以在 daemon crash 后通过 deterministic `StartVerification` Command replay 恢复后续动作。

## 12.3 C2 — Authenticated submission context + atomic fencing

冻结规则：

```text
CommandEnvelope
= declared domain intent

CommandSubmissionContext
= authenticated execution/system/external origin
```

Execution-originated context 携带 `executionId + fencingGeneration`，且：

```text
fence validation
+ canonical reads
+ canonical writes
+ Command resolution
+ Domain Event append
```

必须共享同一 authoritative semantic transaction。事务外 pre-check 不构成最终授权。

P2 扩展：internal runtime commands 不豁免 authority；其 trusted fact 为 command-specific
`VerifiedRuntimeCommandAuthority`（`AdmitExecutionAuthority` / `StopExecutionAuthority` /
`SettleExecutionAuthority`），exact-bind commandId、fingerprint、projectId、command kind、
target 与 submission origin。`SettleExecution` 的 `ExecutionOrigin` 路径是
`QuiescenceControlMutation`，stop 后仍 admissible，但 worker-originated settlement 仍必须通过
authoritative fencing；`RecoveryController` settlement 使用 recovery authority。

## 12.4 C3 — `prepareTurn()` A/E

```text
A =
Ready
| NeedsCompaction
| GovernanceBlocked

E includes =
ContextUnsatisfiable
+ narrow translated operational failures
```

`NeedsCompaction` / `GovernanceBlocked` 是 control result；`ContextUnsatisfiable` 是 expected typed failure。

## 12.5 C4 — Logical Command / Attempt / Receipt

```text
CommandId
= immutable logical request identity

CommandAttempt
= one operational resolution attempt

CommandReceipt
= authoritative logical request resolution
```

规则：

```text
same CommandId + same semanticRequestFingerprint
→ same logical request

same CommandId + different semanticRequestFingerprint
→ IdempotencyConflict
```

Operational retry 可以复用 CommandId；需要改变 semantic precondition/payload 的 reload-and-re-evaluate 必须新 CommandId。

特别冻结：

```text
explicit expectedRevision mismatch
→ TerminalRejected(RevisionConflict)

FencingRejected
→ terminal for that Execution-originated Command
```

Terminal rejection durable，但不进入 Domain Event Journal。

## 12.6 C5 — Semantic transaction scope

一个 semantic Command 的所有 participating repository 操作共享**同一个 transaction-scoped DB session**。`TransactionPort` 只是语义入口，不能出现“外层 transact + 内部 repo 各拿独立连接”的伪事务。

成功 mutation：

```text
Canonical State
+ Committed Receipt
+ Domain Events
+ authoritative fence decision
→ atomic
```

Terminal semantic rejection：

```text
consistent canonical read
+ TerminalRejected Receipt
→ atomic
```

Retryable operational failure 不产生 authoritative resolution。

## 12.7 C6 — Fixed Execution ↔ Session binding

```text
Workspace main Execution admission
→ snapshot workspace.primarySessionId
→ execution.sessionId immutable
```

`ReplacePrimarySession`：

```text
requires no Active Main Execution
```

replacement 只影响未来 Workspace Execution。异常需要换 Session 时，先停止/settle 当前 Execution，再 replacement，再 admission 新 Execution。

## 12.8 C7 — Revision binding chain

冻结：

```text
Verification.targetWorkRevision

Acceptance {
  workId
  targetWorkRevision
  verificationId
}

Deliverable {
  sourceWorkId
  sourceWorkRevision
}

Dependency satisfaction {
  dependencyId
  targetDependencyRevision
  deliverableId
}
```

Work refine 不删除旧 Verification/Acceptance，但它们不再适用于当前 revision。Dependency contract 改变不能静默重解释旧 satisfaction。

不新增 `OutputContract` Domain Entity。

## 12.9 C8 — Resource ownership algebra

资源语义拆成：

```text
ResponsibilityDefinition
→ ResourceBoundary
→ ResourceAddress
→ Environment resolver
→ CanonicalResourceRegion
→ ResourceOwnershipClaim
```

ownership overlap 定义在 canonical backing resources 上，而不是原始地址字符串上。

第一版至少支持可扩展地址族：

```text
FileTree
GitWorktree
DatabaseNamespace
ExternalResource
```

关键要求是 resolver 能处理不同地址指向相同 backing resource 的 alias。`CanonicalResourceRegion` 具有：

```text
resourceSpaceId
normalizedRegion
```

并定义确定性 `contains / overlaps`。

## 12.10 C9 — Semantic capability ownership audit

以下矩阵是结构审计的最小权威集；具体 payload/signature 仍在对应 Phase 前冻结。

| Capability | Command / mutation path | Durable Event | State / Repository | Owning implementation boundary | Critical invariant |
|---|---|---|---|---|---|
| Project lifecycle / name | CreateProject / RenameProject / CloseProject | ProjectCreated / ProjectRenamed / ProjectClosed | ProjectRepository | application | one root; CAS; Closed blocks new autonomous admission; P15 |
| Project directory | — (local read) | — | ProjectDirectoryPort / SQLite adapter | read boundary (P15) | local single-user, no pagination; transport owns no SQL |
| Child Workspace | CreateChildWorkspace | WorkspaceCreated | WorkspaceRepository | application | same Project; parent immutable |
| Responsibility | ChangeResponsibility | ResponsibilityChanged | WorkspaceRepository | application | authority + revision |
| Resource boundary / ownership | UpdateResourceBoundary | ResourceBoundaryChanged / ResourceOwnershipChanged | Workspace + ResourceOwnershipRepository | application | canonical write regions do not overlap |
| Primary Session | ReplacePrimarySession | PrimarySessionReplaced | Workspace + SessionRepository | application | no Active Main Execution |
| Work assignment | AssignWork | WorkAssigned | WorkRepository | application | Work belongs to target Workspace |
| Current Work | SelectCurrentWork | CurrentWorkChanged | Workspace + WorkRepository | application | ≤1 current; target Open |
| Work semantic revision | RefineWork / SteerWork | WorkRefined / WorkSteered | WorkRepository | application | canonical requirement change increments revision |
| Work completion | CompleteWork | WorkCompleted | Work + Acceptance + Verification repositories | application | PASS + Acceptance bind current Work revision |
| Work cancellation | CancelWork | WorkCancelled | WorkRepository | application | only Open → Cancelled |
| Dependency | DeclareDependency / SatisfyDependency | DependencyDeclared / DependencySatisfied | DependencyRepository | application | satisfaction binds current dependency revision |
| Dependency (terminal transitions) | WithdrawDependency / MarkDependencyUnfulfillable | DependencyWithdrawn / DependencyMarkedUnfulfillable | DependencyRepository | application | v1.10 G1; Unsatisfied-only, revision-bound; Unfulfillable emits Attention |
| Dependency (contract revision) | ReviseDependencyContract | DependencyContractRevised | DependencyRepository | application | v1.10 G1; revision++, never reinterprets prior satisfaction |
| Deadlock attention | — (derived fact) | DeadlockAttentionRequested | — (projection-consumed) | coordination consumer | v1.10 G4; deterministic detection; no automatic lifecycle mutation |
| Deliverable | ProduceDeliverable | DeliverableProduced | DeliverableRepository | application | source Work revision fixed |
| Message | SendMessage | MessageSent(v1) | MessageStore | application / communication | Message is durable communication, not a canonical Work/Deliverable mutation; External denied |
| Deliver handover | DeliverMessage/1 | MessageSent(v1) | MessageStore + InboxProjection | Application/communication | existing Deliverable only; Gateway envelope supplies P1 generation fence/receipt; MessageSent is sole ChildDelivered wake source |
| Deliver replay Attention | — (projection) | DeliverReplayEscalated(v1) | P9 `deliver_replay_attention_facts` + P10 `deliver_replay_attention_rows` | P10 projection consumer | one marker per P9 fact; P9 fact remains source; no canonical mutation |
| Verification | Start / RecordEvidence / Conclude | VerificationStarted / VerificationConcluded | VerificationRepository | verification + application | verdict immutable; version-bound |
| Acceptance | AcceptWorkOutcome | WorkOutcomeAccepted | AcceptanceRepository | application | target revision + Verification fixed |
| Permission | Grant / Revoke | PermissionChanged | PermissionGrantRepository | application | cannot exceed policy/ownership ceiling |
| Decision | RecordDecision | DecisionRecorded | DecisionRepository | application | supersede, no in-place history rewrite |
| Execution admission | AdmitExecution | ExecutionAdmitted | ExecutionRepository | application / execution-runtime | ≤1 active **main**; WorkspaceMain/ExecutionBound; session fixed; IDs caller-preallocated; command-specific runtime authority fact |
| Stop request | StopExecution | ExecutionStopRequested | ExecutionRepository | application / execution-runtime | stop ≠ Work cancel; command-specific runtime authority fact |
| Execution settlement | SettleExecution | ExecutionSettled | ExecutionRepository | application / execution-runtime | valid Settlement ADT; settle once; ExecutionOrigin path is QuiescenceControlMutation (admissible after stop, still fenced); RecoveryController uses recovery authority |
| Environment fact | RecordEnvironmentChange | EnvironmentChanged | environment/control metadata | application (**P11**) | future behavior invalidation is durable; P2 consumes facts only |
| Plugin SDK / SPI | plugin + Project-tool registration (P12 contract) | — | plugin/tool registration store (P12 contract) | **P12** | PluginId/PluginVersion/PluginSdkApiVersion compatibility; project-local not auto-trusted |
| Authority resolution | resolver production only (no mutation) | — | PermissionGrant / Parent / User governance | **P12** | produces exact-bound trusted authority facts; canonical mutation stays in CommandGateway |
| Operational observability | read-only derivation | — | observability/health/usage read models | **P12** | derived from real facts; unknown cost ≠ 0; pricing versioned |
| Worker identity | lease identity (P12 contract) | — | execution_leases | **P12** | WorkerId + WorkerIncarnationId; single-writer control plane; remote worker no direct DB |

另外：

```text
ToolCatalogPort owns tool definition discovery contract.
ToolRuntimePort owns invocation contract.
model-context never imports tool-runtime implementation.
```

Package-level ownership由 §10.4.1 的 allowed-edge matrix 强制。

## 12.11 C10 — Aggregate transition truth tables

这些表只冻结 canonical lifecycle / structural transition。Operational trace、projection 与 derived status 不被伪造为额外生命周期状态。

### Project

| Current | Operation | Preconditions | Next | Notes |
|---|---|---|---|---|
| absent | CreateProject | valid root/bootstrap transaction | Open | creates Project + Root Workspace + Primary Session atomically |
| Open | UpdateProjectPolicy | authority + expected revision | Open | revision++, projectPolicyRevision++ |
| Open | RenameProject | authority + expected revision + ProjectName v1 | Open | revision++; `ProjectRenamed`; policy revision unchanged |
| Open | CloseProject | authority + expected revision + confirmation | Closed | `ProjectClosed`; P15 lifecycle gate rejects new activity and cooperatively quiesces existing executions |
| Closed | lifecycle mutation | — | **illegal** | Closed lifecycle terminal |

`Closed` 后不 admission 新 autonomous Execution；read/recovery/audit 仍允许。

`CreateProject` bootstrap contract（P1 closure）：

```text
- projectId 由 caller 预分配（prj_ + UUIDv7）；CommandEnvelope.projectId 即该值。
- v2 payload 提供 Root Workspace 的 ResponsibilityDefinition /
  ResourceSelection（P1 host Profile ref/version 或 ConversationOnly）/
  ResponsibilityBoundAgentBinding / WorkspacePolicy / ProjectPolicy /
  default configuration / environmentRef；canonical ResourceBoundary 由
  trusted Profile Port 在 Gateway absent-receipt 分支构造，不接受客户端路径。
- rootWorkspaceId 与 primarySessionId 由 caller 预分配。
- 单一事务原子创建 Project + Root Workspace + WorkspacePrimary Session
  （§9.13 deferred FK 在同一 COMMIT 校验）。
- emitted events: ProjectCreated → WorkspaceCreated（同一事务）。
- Primary Session 创建不产生 Domain Event（§5.3 catalog 无 Session event；
  Session 仅通过 workspace.primarySessionId 被引用）。实现阶段不得自行
  新增 Session event。
- authority: bootstrap principal；无 authority → DomainError.AuthorityDenied。
```

### Workspace

Workspace 没有 `Running/Waiting/...` lifecycle。合法 canonical structural mutations：

| Operation | Preconditions | Effect |
|---|---|---|
| CreateChildWorkspace | parent same Project + authority | create child; `parentWorkspaceId` immutable |
| ChangeResponsibility | authority + expected revision | update definition; responsibility revision++ |
| UpdateResourceBoundary | authority + expected revision + ownership overlap check | boundary revision++ + ownership claims atomically update |
| UpdateWorkspacePolicy | authority + expected revision | revision++ + workspacePolicyRevision++ |
| SelectCurrentWork | target Work belongs Workspace + Open; switching cannot conflict with Active Main Execution | change `currentWorkId` only |
| ReplacePrimarySession | target `WorkspacePrimary`; no Active Main Execution | change `primarySessionId`; existing Execution bindings unchanged |
| RetireWorkspace | non-Root + no Active Main Execution/Open Work/Active Child/write ownership/no unresolved incoming Dependency with ProducerBinding = WorkspaceBound(this) or WorkBound(a Work owned by this) (unless resolved/replaced in same governance change) | lifecycle = Retired |

Forbidden ordinary transitions:

```text
ReparentWorkspace
MoveWorkspace
ReactivateRetiredWorkspace
```

### Work

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | AssignWork | valid Workspace + authority | Open |
| Open | RefineWork / semantic SteerWork | authority; producer cannot weaken protected upstream requirements | Open, revision++ |
| Open | CompleteWork | current-revision PASS Verification + current-revision Acceptance | Completed; if current, clear `workspace.currentWorkId` atomically |
| Open | CancelWork | governance authority | Cancelled; if current, clear `workspace.currentWorkId` atomically; request quiescence of focused active Execution |
| Completed | any lifecycle mutation | — | **illegal** |
| Cancelled | any lifecycle mutation | — | **illegal** |

`Current/Pending/Blocked/Verifying/Running` 都是 relation/projection，不进入 Work lifecycle。

### Execution

Canonical lifecycle:

```text
Absent
→ Active(settlement = none)
→ Settled(ExecutionSettlement)
```

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | AdmitExecution | admission invariants; for Workspace main: no other active main | Active |
| Active | StopExecution | authority | Active + stop-request fact |
| Active | SettleExecution | current authority/fence + valid Settlement ADT | Settled |
| Settled | SettleExecution again | — | **illegal / idempotent existing receipt only** |

Lease acquisition/renewal/loss is Runtime ownership state, not another Execution lifecycle state. Worker crash or lease expiry alone does not transition `Active → Settled`.

### Session

Session 不设计业务 lifecycle 状态机：

```text
Session identity = durable
SessionEntry = append-only local sequence
ContextEpoch = monotonic local ordinal
```

- Worker-originated append 需要有效 execution/fence；
- Compaction 创建新 checkpoint/epoch，不改变 canonical business truth；
- Workspace primary replacement 改的是 Workspace pointer，不重写旧 Session；
- already-admitted Execution 继续绑定 admission-time Session。

### Verification

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | StartVerification | Work/revision target valid; **no other Open Verification on the same (workId, targetWorkRevision)** (v1.11 G2) | Open |
| Open | RecordVerificationEvidence | verifier authority | Open |
| Open | ConcludeVerification(Pass/Fail/Unknown[; conclusionReason `Orphaned` allowed on Unknown — v1.11 G5]) | mission/evidence record valid | Concluded(verdict) |
| Concluded | mutate verdict | — | **illegal** |
| Concluded | StartVerification (re-verify) | new VerificationId; prior Open sibling on the same revision must first conclude Unknown(`Orphaned`) (v1.11 G5) | Open (new identity) |

重新验证创建新的 Verification identity。

### Dependency

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | DeclareDependency | valid consumer Work + ProducerBinding + structured ExpectedDeliverable | Unsatisfied |
| Unsatisfied | revise expected contract | authority; not yet terminal | Unsatisfied, DependencyRevision++ |
| Unsatisfied | SatisfyDependency | targetDependencyRevision == current + `matchesExpectedDeliverable(producerBinding, expectedDeliverable, DeliverableMatchView)` returns true | Satisfied |
| Unsatisfied | WithdrawDependency | consumer no longer requires result | Withdrawn |
| Unsatisfied | MarkDependencyUnfulfillable | requirement still needed but current contract cannot be fulfilled | Unfulfillable |
| Satisfied/Withdrawn/Unfulfillable | mutate terminal dependency | — | **illegal** |

Cancel consumer Work deterministically withdraws its remaining Unsatisfied Dependencies。Producer loss 规则完全由 `ProducerBinding` 决定：

```text
WorkBound(W) + W Cancelled
→ Dependency becomes Unfulfillable
  unless already terminal or replacement committed atomically

WorkspaceBound(WS) + WS Retired
→ Dependency becomes Unfulfillable
  unless already terminal or replacement committed atomically

WorkBound(W) where W belongs to a retiring WS
→ same rule

AnyProducer
→ producer Work cancellation / Workspace retirement alone
   does NOT imply Unfulfillable

WorkspaceBound(WS)
→ cancellation of one Work under WS does NOT imply Unfulfillable
```

新 contract 在 terminal dependency 后创建新 Dependency / explicit new requirement，不改写历史。

### PermissionGrant

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | GrantPermission | issuer authority + policy/ownership ceiling | Active |
| Active | RevokePermission | issuer/governance authority | Revoked |
| Revoked | reactivate same grant | — | **illegal** |

时间到期是 effective authorization evaluation，不把历史 Grant 删除；需要重新授予时创建新 grant identity。

### Immutable durable records

以下对象没有可变 lifecycle：

```text
Deliverable      // immutable formal result for source Work revision
Acceptance       // immutable acceptance of target Work revision + Verification
concluded Verification
terminal Dependency record
DomainEvent
```

Decision 使用 explicit supersede link，不原地覆盖历史。

---

# 13. Implementation Readiness & Remaining Phase-scoped Closure

v1.3 已关闭 P0 前必须通过推理确定的 C1–C10 与 X1–X11 cross-cutting contract。剩余问题按 Phase 所有权继续关闭，而不是阻塞所有实现。

| Item | Status | Must close before |
|---|---|---|
| C1–C10 cross-cutting semantics | **CLOSED** | P0 |
| Aggregate/domain ADT + invariant tests | **READY TO IMPLEMENT** | P0 completion |
| Package DAG architecture tests | **READY TO IMPLEMENT** | P0 completion |
| Exact per-Command payload/result/error/event TypeScript contracts | **P1 PHASE CONTRACT** | `docs/design/implementation/P1/**` |
| Exact Repository / Port Effect signatures | **P1 PHASE CONTRACT** | `docs/design/implementation/P1/**` |
| SQLite exact DDL / migration / indexes | **P1 PHASE CONTRACT** | `docs/design/implementation/P1/**` |
| Resource region physical encoding/query optimization | **P1 PHASE CONTRACT** | `docs/design/implementation/P1/**` |
| P2 exact execution/session contracts (commands, ports, DDL, lease/fencing, scheduler/wait, driver, recovery skeleton) | **P2 PHASE CONTRACT** | `docs/design/implementation/P2/**` |
| Prompt Program actual text / behavioral eval set | **PHASE CONTRACT** (P3/P6/P8) | per-phase contracts |
| P3 exact provider/model-context contracts (ports, DDL, driver, eval harness) | **P3 PHASE CONTRACT** | `docs/design/implementation/P3/**` |
| P4 exact tool contracts (parameter/result schemas, authority/approval, sandbox, shell policy enforcement) | **P4 PHASE CONTRACT** | `docs/design/implementation/P4/**` |
| P5 exact vertical-slice contracts (composition root, provisional runnable source, directive handling, slice acceptance) | **P5 PHASE CONTRACT** | `docs/design/implementation/P5/**` |
| Context/compaction numeric defaults | **EMPIRICAL** | tune by eval |
| SQLite performance ceiling | **EMPIRICAL** | `StorageScaleAssessment` (P12) |
| P12 exact contracts (Plugin SDK/SPI + compatibility; Authority Resolver production plane; Project tool registration/trust; observability/health/usage; remote Worker transport + identity; secret store; transport shells) | **P12 PHASE CONTRACT** | `docs/design/implementation/P12/**` |
| StorageScaleAssessment + DurabilityEnvelope / backup-restore / RPO-RTO / restore drill | **P12 PHASE CONTRACT** | `docs/design/implementation/P12/**` |
| Runtime Safety Envelope 六维补全（§8.16A cross-phase closure） | **P12 PHASE CONTRACT** | `docs/design/implementation/P12/**` |
| P13 Product Web Client（client boundary/role；Command → UI exposure policy matrix；view rendering + Problem 呈现；TR-WPU-A design token system；transport/build binding；acceptance） | **P13 PHASE CONTRACT** | `docs/design/implementation/P13/**` |
| P14 Chat-First 对话面（SubmitHumanMessage 命令/事件/persistence；conversation trigger + Coordination admission + one-active-main 排队 + exact-once；transcript read model 升级；TR-WPU-D Root Workbench/root-only web placement；acceptance 十 seams） | **P14 PHASE CONTRACT** | `docs/design/implementation/P14/**` |
| Durable AgentLoopStep handoff（Provider success replay、idempotent Session/action progression、generation-scoped Command identity、settlement recovery、legacy adoption、AH1–AH14） | **IMPLEMENTATION AUTHORIZED (v1.21 ALS-I1)** | `P1 07`, `P2 02/04/06`, `P3 08`, `P9 07`, `P12 08`, `P14 02/05` |

P1 phase-scoped implementation contracts are owned by:

```text
docs/design/implementation/P1/**
```

P2 phase-scoped implementation contracts will be owned by:

```text
docs/design/implementation/P2/**
```

P3 and P4 phase-scoped implementation contracts are owned by:

```text
docs/design/implementation/P3/**
docs/design/implementation/P4/**
```

Authority: this DID → P1 phase contracts. They may not change top-level
semantics; a conflict resolves in favor of this DID.

授权状态：

```text
Problem/Goals: frozen
Scenarios: frozen
System Design: frozen
DID top-level architecture: frozen
C1–C10: closed
X1–X11: closed
P0 coding: authorized
P1 coding: after P1-specific exact contracts/DDL close
```

v1.1 的 A1–A11 readiness patches 已经被吸收到正文对应 ownership section，不再保留一份平行补丁清单，避免同一规则存在两个权威位置。

---

# 14. P0 Technical Baseline

## 14.1 冻结技术基线

```text
Node        24.21.0 LTS
TypeScript  7.0.2
Effect      4.0.0-rc.115  (exact pin)
pnpm        12.4.2
Vitest      5.0.1
Biome       2.5.14

Module      ESM only
Build       tsc -b / TypeScript project references
Test        Vitest
Lint        Biome
Format      Biome
Architecture custom Vitest package-DAG tests
DB (P1)     SQLite + Effect SQL sqlite-node adapter
Frontend (P13, v1.15)  apps/web = Vite + React（TypeScript/ESM）；
                       Vite/React 及相关前端依赖 exact pin（P13 contract/lockfile）；
                       生产态 build 产物为 static dist，由 single-workspace
                       production daemon 同源托管；前端依赖升级一律单独变更验收
```

Effect v4 仍作为受控 RC dependency：所有 Effect v4 packages 精确 pin 同一 revision，每次升级作为单独变更并跑完整验收，不允许自动漂移。

## 14.2 Monorepo 工具策略

第一阶段不引入：

```text
Turborepo
Nx
Bazel
Prisma / TypeORM
ESLint + Prettier 双栈
Husky / lint-staged
```

原因：pnpm workspace + TS project references + Biome + Vitest 已足以支持 P0/P1；工具复杂度应晚于 Domain/Runtime complexity。

## 14.3 根验收入口

统一命令：

```text
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format
pnpm architecture
pnpm check
```

其中：

```text
pnpm check = lint + typecheck + architecture + test
```

避免在仓库中制造多套同义 quality gate。

## 14.4 Effect Integration Rules

P0 起即强制：

```text
Effect<A,E,R>
A = success semantics
E = expected typed failure
R = exact service requirements
```

工程规则：

1. Domain transition 可用 `Effect<A,E,never>`，但 Domain 不得获得 infrastructure R；
2. Port 使用 Effect service，Adapter 使用 Layer；
3. Service implementation dependency 由 Layer construction 解决；
4. 禁止 `Effect<A, Error, AppEnv>`、万能 `ArborError`、global Service Locator；
5. typed error 使用稳定 tag/code，调用方窄处理；
6. defect 与 interruption 不塞进 expected E；
7. Adapter-specific error 不越过 semantic boundary；
8. package review 检查 E/R 是否发生抽象泄漏；
9. Effect RC 升级必须作为独立受控变更，不自动漂移。

### 14.4.1 技术基线核对（2026-09-18）

本版重新核对官方来源：

- Effect v4 当前仍为 RC；`effect` main package version 为 `4.0.0-rc.115`，官方推荐 TypeScript 7，并要求 strict type checking；
- TypeScript 7.0 已于 2026-07-08 正式发布；
- Node.js 24.21.0 当前为 LTS；
- pnpm 12.4.2、Vitest 5.0.1、Biome 2.5.14 为当前公开稳定版本。

版本属于“当前实现基线”，不是永久架构 invariant；只有 Effect v4 package compatibility 需要特别严格的同 revision pin。

## 14.5 P0 完成标准

P0 只有在以下条件全部成立时完成：

1. `@arbor/domain` 编译通过；
2. Typed ID 在编译期不能误传；
3. Core Aggregate transition 是纯函数/typed result，并覆盖 §12.11 truth tables；
4. Work terminal lifecycle 无非法逆转；
5. Parent immutable；
6. CurrentWork ≤ 1 的 Domain 语义成立；
7. `ResponsibilityDefinition / ResourceBoundary / ResourceAddress / CanonicalResourceRegion` codecs 与纯 overlap algebra 成立；
8. Verification Verdict ADT 固定为 PASS / FAIL / UNKNOWN；
9. Execution Binding ADT 支持 Work / Coordination 与 `ExecutionBoundAgentBinding`；
10. `ExecutionSettlement` 是合法 sum type，非法 outcome/result 组合在类型层不可构造；
11. `Acceptance / Deliverable / Dependency` revision-binding Value Objects/records 可表达；
12. `CommandId / semanticRequestFingerprint / CommandResolution / CommandAttempt` 基础 ADT 可表达，且 same-id different-fingerprint 被类型/纯逻辑拒绝；
13. 不存在长期 `Agent` Entity / `AgentId`；
14. §10.4.1 package DAG architecture tests 通过；
15. `pnpm check` 全绿。

P0 不要求 SQLite、真实 Provider、真实 Tool 或 HTTP/CLI；C2/C4/C5 的 persistence 原子性在 P1 通过 adapter/integration tests 落实。

---

# 15. Final Architecture Summary

Arbor 的实现架构可以压缩为以下主链：

```text
User / Agent / Runtime
        ↓
     Command
        ↓
 Application
        ↓
Canonical State + Command Receipt + Event Journal
        ↓
Event Consumers / Scheduler
        ↓
Execution Admission
        ↓
Worker + Lease/Fencing
        ↓
AgentRuntime
        ↓
Model Context Control Plane
        ↓
PreparedModelTurn + Manifest
        ↓
ProviderRuntime
        ↓
CanonicalProviderEvent
        ↓
ModelContext.decodeTurn
        ↓
ModelOutput + provider-neutral ToolInvocation
        ↓
AgentRuntime exact route classification
    ┌───┴───────────────────────┐
    ↓                           ↓
Executable Tool             Control Tool
    ↓                           ↓
ToolRuntimePort       ControlToolRegistry
    ↓                           ↓
bounded observation       in-process AgentAction
    ↓                           ↓
    │                  shared Agent Runtime policy
    │                           ↓
    │                  Application / settlement boundary
    └──────────────┬────────────┘
                   ↓
          Observation / settlement
    ↓
next Turn / ExecutionSettlement
        ↓
CompletionClaimed? → VerificationRuntime
        ↓
PASS / FAIL / UNKNOWN
        ↓
Parent Acceptance
        ↓
CompleteWork
```

最终职责边界：

```text
Effect A/E/R        = success / typed failure / exact capability contract
Domain             = what state/change is legal
Application        = how semantic mutations resolve/commit atomically
ExecutionRuntime   = who runs, when, with what lease/fence
ModelContext       = how the model is allowed to understand this turn
AgentRuntime       = execute the cognitive loop
ProviderRuntime    = reliably call models
ToolCatalog        = tool definition/capability discovery
ToolRuntime        = safely invoke and settle actions on reality
ControlToolRegistry= decode model-facing control invocations into internal AgentAction
VerificationRuntime= independently judge formal outcomes
Session            = preserve cognition
Projection         = make truth observable
```

核心工程原则：

```text
Effect A/E/R is an architecture contract, not a convenience wrapper.
Expected failure is typed; impossible state is defect; cancellation is interruption.
Workspace is identity; Agent is execution role.
Plan is cognitive; Work is canonical.
Prompt guides; Runtime enforces.
Control is reconstructed; cognition is compressed.
Events notify; Canonical State decides.
Consumers react; Commands mutate.
Settlement preserves semantic terminal result.
Fence validation and canonical mutation are atomic.
Resource ownership compares canonical backing regions.
Long-lived Agent != long-running process.
```

---

# Appendix A — ID Prefix Convention

| Type | Prefix |
|---|---|
| Project | `prj_` |
| Workspace | `ws_` |
| Work | `wrk_` |
| Execution | `exe_` |
| Session | `ses_` |
| Verification | `ver_` |
| Dependency | `dep_` |
| Deliverable | `del_` |
| Message | `msg_` |
| Artifact | `art_` |
| Decision | `dec_` |
| Permission Grant | `pgr_` |
| Acceptance | `acc_` |
| Evidence | `evd_` |
| Memory | `mem_` |
| Command | `cmd_` |
| Event | `evt_` |
| Provider Turn | `ptn_` |
| Tool Invocation | `tin_` |
| Logical Action | `lac_` |
| Logical Settlement | `lst_` |
| Worker | `wkr_` |
| Worker Incarnation | `wic_` |
| Plugin | `plg_` |

---

# Appendix B — Runtime Interface Snapshot

```text
Application (Effect services)
├── CommandGateway(CommandEnvelope, CommandSubmissionContext)
│     (uses the Persistence ports below)
└── InputPromotionService(SessionRepository + InboxProjectionStore + TransactionPort)

Persistence ports (§7.2)
├── TransactionPort
├── CommandStore / Receipt
└── DomainEventJournal

ExecutionRuntime
├── ExecutionRepository
├── WorkerDispatchPort
├── ExecutionDriverPort
├── Lease/Fencing services
└── Clock

ModelContext
├── AgentContextSourcePort
├── KnowledgeQueryPort
├── ModelCapabilityPort
├── Skill Registry
├── ToolCatalogPort
├── ContextProjector
├── BudgetEvidenceResolver
└── PortableInputItem compiler

AgentRuntime
├── ModelContext
├── ProviderPort
├── AgentLoopStepStore
├── SafeBoundaryInputDrain
├── AgentStepContext capture
├── CompactionCoordinator
├── ControlToolRegistry
├── ToolRuntimePort (executable route only)
├── SessionRepository
└── CommandGateway

ControlToolRegistry
├── control-tool identity / schema projection
├── registered control invocation codecs
├── in-process AgentAction construction
└── shared control-policy metadata and handler routing

ToolRuntime
├── ToolCatalogPort (definition source is separate from invocation)
├── ProjectEnvironmentPort
├── SandboxPort
├── SecretStorePort
├── ToolInvocationStore
└── Blob/Artifact Service

ProjectionRuntime
├── DomainEventJournal reader
├── Projection Store
└── ProjectionQueryPort

ProviderRuntime
├── Inference / CompactionSummary / CompactionNative lowering
└── usage / overflow / binding evidence

Composition Root
├── joins executable and control definition projections for Model Context
└── Layer graph resolves all live adapters/services
```

---

# Appendix C — Design Freeze Status

```text
Problem Definition & Goals v1.2           FROZEN
Scenarios S1–S4 v1.2                      FROZEN / COMPLETE
System Design Specification v1.4          FROZEN
Detailed Implementation Design v1.23     TOP-LEVEL FROZEN
Model Context Control Plane               INCLUDED / TOP-LEVEL FROZEN
Effect A/E/R + Service/Layer Contract     CLOSED
Error Algebra + Failure Semantics         CLOSED
C1–C10 + X1–X11 Closure                  CLOSED
Agent control representation              FROZEN — internal AgentAction boundary
Agent control implementation authorization AUTHORIZED (v1.19 ACR-6; field-source gaps gate only their consumers per ACR-8)
S01 qualification authorization            AUTHORIZED (v1.19 ACR-7 — Control/Executable Route Qualification)
Wave 2 implementation authorization         AUTHORIZED (v1.19 ACR-6; scope = 51 module map, 52 DAG order)
Durable AgentLoopStep handoff design          FROZEN (v1.20 AHT-1…AHT-8; v1.21 name)
Durable AgentLoopStep implementation          AUTHORIZED (v1.21 ALS-I1)
Session / Context Runtime convergence         FROZEN (v1.22 SCRC-1…SCRC-12)
Session / Context Runtime implementation      NOT AUTHORIZED (migration 0019 reserved)
DOGFOOD-DG-01 design question             RESOLVED by v1.20 AHT-1…AHT-8
AgentLoopStep recovery implementation gate    OPEN — requires authorization + AH1–AH14 + equivalent fixture
P0 Technical Baseline                     FROZEN (versioned baseline)
P0 coding authorization                   AUTHORIZED
P1 coding authorization                   AFTER P1 exact contracts / DDL closure
P1 completion                             COMPLETE
P2 coding authorization                   AFTER P2 exact contracts closure
P2 completion                             COMPLETE
P3 completion                             COMPLETE
P4 coding authorization                   AFTER P4 exact contracts closure
P4 completion                             COMPLETE
P5 coding authorization                   AFTER P5 exact contracts closure
P5 completion                             COMPLETE
P6–P11 completion                         COMPLETE
P12 coding authorization                  AUTHORIZED (P12 contracts frozen, Blocking=0)
P12 completion                            COMPLETE — FORMALLY CLOSED
```

任何后续架构修改必须先落到拥有该语义的文档，并说明：

1. 哪个现有 invariant / scenario 无法实现；
2. 失败证据是什么；
3. 为什么不能通过现有对象/接口的局部细化解决；
4. 对 Domain、Persistence、Model Context、Runtime、Package DAG 和 Recovery 的影响。
