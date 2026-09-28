# AgentDirective v2 Semantic Preservation Review

**Date:** 2026-09-27
**Status:** Design proof review; no implementation

## Proof obligations

For each branch, the review asks whether:

- **Soundness:** every accepted canonical intent maps only to its declared
  downstream effect, under the owning authority and validation rules;
- **Completeness:** every ACTIVE scenario intent assigned to that action has a
  representation in the canonical payload;
- **Semantic preservation:** target, authored meaning, and judgments survive
  transformation without reinterpretation;
- **No invented semantics:** Runtime adds only authoritative binding,
  generated identity, persistence, or deterministic derived data.

`PASS` below means the frozen semantic mapping is sufficiently specified.
`BLOCKED` means a known source-contract omission prevents one or more proof
obligations; it is not an implementation defect.

## Branch proof table

| Branch | Soundness | Completeness | Semantic preservation | No invented semantics | Result / evidence |
|---|---|---|---|---|---|
| `InvokeTool` | **PASS** — P4 validates the exact selected definition, arguments, authority, resource, approval, and side-effect policy before invocation. | **PASS** — tool identity + exact arguments express the action; P4 tool catalog provides the admitted capability surface. | **PASS** — same intent reaches ToolRuntime; settlement/observation records the result. | **PASS** — Runtime binds invocation, version, authority, and resolved resources; it does not change arguments. | `docs/design/implementation/P4/01-tool-contracts.md` §§1–6; `02-tool-runtime-pipeline.md` §§1–5. |
| `AssignWork` | **PASS** for authorization, target, P1 assignment, and P8 mission validity. | **BLOCKED** where downstream P1 requires `Provenance` but frozen P1 does not state how its causal values are derived from this action. | **BLOCKED** until provenance derivation is exact; an invented predecessor or reason would alter Work history. | **BLOCKED** until source mapping for provenance is frozen. | P1 `01-command-contracts.md` §7; P1/DID Work and Provenance definitions; accepted ownership at `28-action-language-final-matrix.md`. |
| `Wait` | **PASS** — P2 rejects empty conditions and atomically rechecks observations at settle. | **PASS** — all frozen WakeCondition semantics have condition-intent forms. | **PASS** — Runtime attaches authoritative observed revisions/sequences without changing selected condition. | **PASS** — Runtime supplies only observations, timer/wake IDs, and current binding. | P2 `05-scheduler-wait.md` §§2, 5. |
| `ClaimCompletion` | **PASS** — only current Work revision can be claimed; Work stays Open. | **PASS** — `claimRef` and readiness decision express the frozen producer claim. | **PASS** — settlement retains claim/reference and revision; consumer deterministically starts Verification. | **PASS** — Runtime adds exact Work/revision and command facts only. | P2 `01-command-contracts.md` §7; P5 `03-agent-loop-driver.md` §§3, 6; P8 `03-chain-consumers.md` §1. |
| `AcceptWorkOutcome` | **PASS** — authority and current Pass binding are rechecked by P8. | **PASS** — Parent sufficiency judgment plus explicit selection when multiple targets covers the action. | **PASS** — selected Work/Verification pair is preserved; deterministic consumer only completes that exact accepted revision. | **PASS** — Runtime supplies revision, authority, acceptance ID; it does not make the sufficiency judgment. | P8 `01-verification-commands.md` §4; `03-chain-consumers.md` §2; SD §9.7. |
| `RecordVerificationEvidence` | **PASS** for verifier authority, criterion membership, append-only persistence. | **BLOCKED** for ToolObservation evidence because the P8 EvidenceRecord has no frozen exact source-observation/invocation reference. | **BLOCKED** — a criterion relation can persist, but the chosen ToolObservation cannot be proven to remain identifiable. | **BLOCKED** until the reference is represented by frozen P8 storage semantics; do not attach a guessed artifact. | P8 `01-verification-commands.md` §2; `04-evidence-binding.md` §1. |
| `ConcludeVerification` | **PASS** for exact verifier authority, criterion completeness, aggregation, immutability, and Orphaned restrictions. | **BLOCKED** until the source/content of required `summaryRef` is defined and durably associated with the Verification. | **BLOCKED** — verdicts/evidence can map, but conclusion summary meaning cannot yet be resolved from durable canonical state. | **BLOCKED** — Runtime cannot fabricate a missing P8 durable association or commit a ref it cannot retain. | P8 `01-verification-commands.md` §3; `04-evidence-binding.md` §§2–3; `44-g-v2-3-conclusion-summary-closure.md`. |
| `SendMessage` | **PASS** — all kind-specific routing, authority, and target checks are explicit. | **PASS** — all four kinds, discretionary Query target, and conditional exact Reply target are represented. | **PASS** — kind/body/recipient/reply target persist unchanged; bodyRef is Runtime-created. | **PASS** — Runtime supplies only sender/IDs/reference/correlation/time and fixed urgency. | `31-communication-binding-closure.md`; `32-send-message-kind-matrix.md`; `33-reply-target-semantics.md`. |
| `DeclareDependency` | **PASS** — current consumer Work and same-Project producer selectors are checked. | **PASS** — producer binding and expected result contract are the complete semantic request. | **PASS** — matcher contract is not embedded into declaration; command records exact contract. | **PASS** — Runtime adds consumer binding/ID/revision/authority and does not choose producer or result kind. | P7 `01-dependency-deliverable-commands.md` §§2, 9; domain `dependency.ts` frozen ADTs. |
| `ProduceDeliverable` | **PASS** — source Work ownership/revision and artifact validity are checked. | **PASS** — kind and role-tagged existing artifacts express the formal result. | **PASS** — DeliverableProduced retains source revision, kind, and roles. | **PASS** — Runtime allocates identity/binds source and does not choose result meaning. | P7 `01-dependency-deliverable-commands.md` §3; `planning/results/P7.result.md`. |
| `RequestDependencyMatch` | **PASS** — only exact ConsumerExecution path submits and the structural matcher is authoritative. | **PASS** — exact pair is the entire request intent. | **PASS** — the pair is submitted unchanged; rejection leaves state unchanged. | **PASS** — Runtime supplies observed dependency revision/authority, never a satisfaction result. | P7 `01-dependency-deliverable-commands.md` §4; `04-coordinator-satisfaction.md` §5. |
| `Deliver` | **PASS** — source ownership, direct-Parent target, and durable body are checked. | **PASS** — existing Deliverable plus authored handover body expresses formal delivery. | **PASS** — Deliver remains distinct, maps to Message kind Deliver, and never satisfies dependency. | **PASS** — Runtime derives parent and bodyRef; it does not create a Deliverable or choose its target. | P7 `02-deliver-primitive.md` §§3–8; communication closure `32` crosswalk. |
| `ProposeChildWorkspace` | **PASS** for proposal admission, boundary ceiling, structural depth, and human gate. | **BLOCKED** for optional initial Work: the proposal has no P8-valid mission field, and the placeholder is later rejected. | **BLOCKED** — no deterministic mapping can preserve both approved proposal content and valid VerificationMission. | **BLOCKED** — Runtime cannot invent criteria or a verification goal. | P6 `01-formation-semantics.md` §§2, 4; P8 `04-evidence-binding.md` §5; P8 `01-verification-commands.md` §1. |
| `SpawnSpecialist` | **PASS** — admission, Workspace binding, safety, quiescence, and capability checks are exact. | **PASS** — mission, constraints, and skill selections cover temporary delegation intent. | **PASS** — the request becomes an ExecutionBound specialist in the current Workspace; settlement returns through the Parent Inbox. | **PASS** — Runtime adds execution/session identity and admission facts only. | P6 `01-formation-semantics.md` §3; P2 `01-command-contracts.md`; P6 `03-authority-delegation.md` §3. |

## Coverage and orthogonality

The accepted 49-point S1–S4 Decision Map and final Action Language Matrix
assign every ACTIVE required intent to one action or, for `RespondToHuman`,
the ordinary P14 response channel. No action is added for pure reasoning
decisions. The accepted action matrix also closes the prior overlap questions
between `SendMessage`/`Deliver`, `ClaimCompletion`/`ProduceDeliverable`,
`ConcludeVerification`/`AcceptWorkOutcome`, `RequestDependencyMatch`/P7
coordinator automation, and `Wait`/runtime idle parking.

Current counts:

```text
ACTIVE canonical action coverage by branch/channel = 15 / 15
ACTIVE structured v2 branches                    = 14
structured branch mapping proofs fully closed    = 10 / 14
structured branch mappings blocked               = 4 / 14
unresolved action identity overlap                = 0
unresolved missing action name                    = 0
unresolved field ownership/source mapping          > 0
```

The first three counts concern action taxonomy and scope. They do **not**
close incomplete downstream field semantics. In particular, action coverage
must not be reported as full semantic completeness while a canonical payload
cannot be transformed losslessly.

## Findings requiring governance closure

1. **AssignWork provenance source:** P1 requires `Provenance`, but no frozen
   rule derives its predecessor/reason values from the accepted action.
2. **Verification evidence source:** P8 has no exact persisted locator for a
   selected `ToolObservation`.
3. **Verification conclusion summary:** P8 requires `summaryRef` but does not
   freeze its content owner, content-to-reference transformation, or durable
   association with the concluded Verification.
4. **Formation initial Work mission:** P6's optional initial Work creates a
   placeholder mission; P8 rejects that placeholder and requires valid mission
   content. The approved proposal cannot currently carry a P8-valid mission.

These are design-surface gaps, not permission to change the frozen contracts
inside this review.
