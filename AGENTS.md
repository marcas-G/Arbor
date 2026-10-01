# Arbor — Agent Guide

Arbor is a multi-agent work system organized around long-lived Responsibilities, not chat sessions. Read `docs/design/00-problem-goals.md` first; the rest of the chain explains HOW.

## Document chain (ownership)

| Doc | Owns | Status |
|---|---|---|
| `docs/design/00-problem-goals.md` | WHY/WHAT: P1–P8, G1–G8, mission, success criteria | FROZEN |
| `docs/design/01-scenarios.md` | Observable end-to-end behavior S1–S4 | FROZEN |
| `docs/design/02-system-design.md` | Domain semantics, Runtime boundaries, 68 system invariants | FROZEN |
| `docs/design/03-detailed-implementation-design.md` | Executable contracts: ADT/Command/Event/Ports/SQL/Package DAG/phases | TOP-LEVEL FROZEN |

These four files are the latest frozen baselines (Problem & Goals v1.2, Scenarios v1.2, System Design v1.4, DID v1.22).

## Design governance (docs/design/**)

```text
docs/design/** = manually governed source of truth
               = MUST NOT be modified by the Planning Agent
               = MUST NOT be modified by the Coding Agent
```

Only manual governance changes design documents, and only in the document that owns the semantics. Never silently rewrite upstream semantics from implementation code or planning artifacts.

Manual-governance delegation exception (authorized 2026-10-01): after the
user/manual governor explicitly accepts a fixed governance proposal, Codex may
apply that exact accepted landing package to `docs/design/**` on the governor's
behalf. The proposal hash, decision record, owning-document revisions and
post-landing consistency review must remain auditable. This exception does not
permit Codex to invent unaccepted semantics or silently resolve a new gap.

If a code implementation discovers a design gap: **stop implementation and raise a Design Gap** (with failure evidence: failing test, concurrency counterexample, or recovery failure) for manual governance — do not edit the design directly.

DID v1.18 governance adoption (`REDUCE_TO_INTERNAL_AGENT_ACTION_ADT`):
model-facing tools decode to provider-neutral typed invocations; executable
tools route through P4 `ToolRuntime`; control tools route through Agent
Runtime `ControlToolRegistry` → process-local `AgentAction` → shared Agent
Runtime policy → owning Application/settlement boundary. `AgentAction` is
neither a wire/output contract nor persisted. `decodeTurn` does not construct a
universal `AgentDirective`.

DID v1.19 governance authorization (`AGENT_CONTROL_IMPLEMENTATION_AUTHORIZED`,
ACR-6…ACR-8): agent control implementation, S01 qualification (redefined as
Control/Executable Route Qualification, carried by the L3 capability suites),
and Wave 2 (scope = `planning/tool-surface-review/51` module map sequenced by
`52` DAG) are AUTHORIZED. The four field-source gaps (AssignWork.Provenance,
G-V2-2/3/4) remain OPEN and gate only the actions that consume them; B10 stays
`BLOCKED_BY_DESIGN_GAP` until they close.

DID v1.20 governance adoption (`AHT-1`…`AHT-8`) freezes the durable Provider
result handoff: persisted `AgentLoopStep`, replayable complete Provider success,
idempotent sourced Session/action progression, generation-scoped Application
Command identity, unresolved-side-effect gate, deterministic successors,
evidence-gated legacy adoption, and P14 final convergence. Design landing is
complete; at the v1.20 checkpoint **implementation was NOT AUTHORIZED**. Migration
`0017_agent_loop_step_handoff`, recovery implementation, and replay/mutation of the
preserved DOGFOOD database require separate implementation authorization plus
AH1–AH14 and equivalent-fixture evidence. `DOGFOOD-DG-01`'s design question is
RESOLVED by v1.20; that resolution is not implementation evidence.

DID v1.21 (`ALS-N1`, `ALS-I1`) renames the current durable record from the
reviewed proposal's historical `AgentTurn` to `AgentLoopStep` and AUTHORIZES
implementation. `AgentLoop` = overall runtime algorithm; `AgentLoopStep` = one
durable recoverable iteration; `ProviderTurn` = one logical model decision.
Authorized scope is migration 0017, stores/ports, runtime/recovery integration
and AH1–AH14. The preserved dogfood database remains read-only until the
equivalent fixture and migration verification pass.

## Planning

- `planning/phases/` — one file per phase P0–P12 (see DID §11)
- `planning/tasks/` — task breakdown per phase
- `planning/results/` — completion evidence, verification output per phase

Current authorization state: **P0–P14 COMPLETE; P14 FORMALLY CLOSED; D-1 Product UI
Contract Closure COMPLETE; D0–D3 Web Product UI Foundation COMPLETE; D4–D6 Web Product UI
Core Workbench COMPLETE / PHASE-BOUNDARY CLOSED; D7–D9 Web Product UI COMPLETE /
PHASE-BOUNDARY CLOSED at `master@09d0b81a6e27e2b20f2a7b28f1fea89c1400984c`; D10 Web
Product UI Final Convergence COMPLETE — **Web Product UI FORMALLY CLOSED** at
`master@7752e0e5bba1cf4ffd7351895c1e405bb7158855`.** Evidence:
`planning/results/D4-D6-web-product-ui-core-workbench.result.md`,
`planning/results/D7-D9-web-product-ui-surfaces.result.md`, and
`planning/results/D10-web-product-ui-final-convergence.result.md`.
Next activity: **Dogfooding / Release Validation** — use Arbor for real tasks;
Web v1 implementation is closed.
Provider-result handoff governance: **DESIGN CLOSED at DID v1.20;
IMPLEMENTATION AUTHORIZED at DID v1.21**. `DOGFOOD-DG-01` is RESOLVED at the
design layer; implementation still requires TDD/AH1–AH14 evidence before any
preserved-database recovery.
Session / Context Runtime convergence: **SCRC-1…SCRC-12 ACCEPTED; owning
contracts landed as System Design v1.4 / DID v1.22 at `75589c5`;
post-landing review Blocking = 0; `SCRC-DG-01` RESOLVED**. Migration 0019 and
SCRC code implementation are AUTHORIZED by the manual token
`AUTHORIZE_SESSION_CONTEXT_RUNTIME_IMPLEMENTATION` (2026-10-01). SCRC planning is COMPLETE
(`planning/phases/SCRC.md`; 8 task contracts; T01–T30 acceptance matrix;
planning review Blocking = 0). Execute SCRC-001…SCRC-008 strictly by the phase
DAG; only SCRC-008 may claim full completion. Current implementation state:
**SCRC-001/002 COMPLETE; next SCRC-003 + SCRC-004**
(`planning/results/SCRC-001.result.md`, `planning/results/SCRC-002.result.md`).
P16 (Provider Extension Architecture — DID-side implementation design under
`docs/design/implementation/P16-provider-extension/`, governance-authorized
2026-09-29): **Gate A design contracts FROZEN**; **Gate B Design Closure =
ACCEPTED, implementation = AUTHORIZED (2026-09-29)** with two acceptance
clarifications merged (E4 split into E4a compatible-provider / E4b
protocol-family extensibility; CapabilityQualification binds a
ResolvedModelBinding fingerprint with full identity/version records,
INV-P16-9/10 frozen). Exit = mechanical evidence E1–E5 incl. E4a/E4b
proofs; **STOP if either E4a or E4b fails — no further provider family
onboarding**. Scope guards: no real new provider family, zero agent-runtime
diff, no Model Context semantic compilation change, no cache-usage/native
continuation implementation, no CanonicalProviderEvent extension.
**Final Closure Audit COMPLETE (2026-09-29, baseline 59958f8)**: G-B1 —
fingerprint contract==implementation restored (pure-TypeScript SHA-256 in
ports, environment-neutral, no node:crypto; reference-digest asserted by
spec; both qualification records rebound to SHA-256 fingerprints); G-B2 —
provider-testecho now carries the DISTINCT protocol-family identity
`testecho-echo-v1` (registry resolves by that identity; adapter owns an
independent protocol path; E4b re-proven as a true new-family onboarding).
E1–E5 re-passed, pnpm check green, git diff --check clean, scope guards
re-verified. **Gate B = FORMALLY CLOSED.** Gate C NOT entered (no new
authorization). Subsequent state (evidence in
`planning/testing/provider-qualification/` and the git log): Gate C
Infrastructure CLOSED (canonical usage, continuation/reasoning substrate,
qualification matrix + runner); Gate D1 live qualification of dep-env
(DeepSeek) COMPLETE — final matrix PROVEN 8 / UNSUPPORTED 4 / FAILED 0 /
NOT_RUN 0 (fragmented-args root cause graded BEST_SUPPORTED_PROVIDER_SIDE;
remediated fail-closed), cache extraction landed with declaration aligned.
The extension protocol is plug-and-play: any reachable OpenAI-compatible
deployment onboards as pure data (env vars → ModelDeployment → registry
resolution → qualification runner), as E4a proved — no code change, no
bespoke procedure per deployment. **Gate B IMPLEMENTATION COMPLETE (2026-09-29)**: B-1..B-10 evidenced —
registry/binding/env wiring landed; E1/E2 arch gates (tests/architecture/
p16-architecture.test.ts) green; E3 conformance suite A1–A10 green on
provider-openai / provider-fake / provider-testecho / provider-openai@
dep-openai-compat-echo (41 specs; found & fixed two real adapter taxonomy
defects: 403 pre-classified as invalid_api_key, transport TypeErrors
pre-wrapped as 503); E4a compatible-provider proof exit 0 (dep-openai-
compat-echo: catalog data + deployment fixture + qualification, zero
core/adapter diff); E4b protocol-family proof exit 0 (provider-testecho
in-process family; provider-runtime/model-context/agent-runtime/provider.ts
diff empty); E5 qualification bound to binding fingerprints (p16fp_*) for
dep-env (DeepSeek, stableRuns=3) and dep-openai-compat-echo (offline
proof); pnpm check green (arch 19 / core 236 / web 31); capability
gray-box green; scope guards re-verified (agent-runtime 0-line diff,
CanonicalProviderEvent 0-line diff, all capability flags false).
**SYSTEM IMPLEMENTATION COMPLETE** — **FINAL CLOSURE PASS**
(`planning/final-system-closure.md`; `planning/results/ARBOR_FINAL.result.md`).
P14 (Chat-First 主工作区对话面 — DID v1.16 G-A–G-F: SubmitHumanMessage +
WorkspaceMain/Coordination conversation execution, root-only, no streaming):
design closure + planning + implementation COMPLETE and FORMALLY CLOSED
(`planning/results/P14.result.md`; 10/10 seams S1–S10 evidenced; G-gate 8/8;
recorded mechanism note: settle write-back via P14 tick sweep).
D-1 (Product UI Contract Closure — DID v1.17 TR-WPU-A–D): presentation-only
supersession adopted; Tree carries server-projected `parentWorkspaceId`; current-work carries
canonical `Work.revision`; selected Verification carries frozen `targetWorkRevision` paired with
`verificationId`; `/p/:projectId` is the formal Root Workbench landing. No command/event/DDL/
authority/transport/System Design change and no Web visual/route implementation. **G1a, G1b and
G6 CLOSED; G2–G5 remain DEFERRED.**
P13 (Product Web Client — post-core product-surface phase, DID v1.15 G1–G4):
design closure + planning + implementation COMPLETE and FORMALLY CLOSED
(`planning/results/P13.result.md`; 14/14 exit criteria PASS; no open Design
Gap; recorded deviations: tree depth-field TR deferred, external
AdmitExecution + chat-first deferred to P14+).
(P7-GAP-01 dispositioned: DEFERRED to P10, non-blocking). P6 result:
`planning/results/P6.result.md`; P7 result: `planning/results/P7.result.md`
(11/11 exit criteria PASS; no open implementation Design Gap).
P8 is COMPLETE and FORMALLY CLOSED: `planning/results/P8.result.md`
(11/11 exit criteria PASS; no open Design Gap; migrations M-1..M-4
landed as frozen contracts). P9 is COMPLETE and FORMALLY CLOSED: `planning/results/P9.result.md`
(11/11 exit criteria PASS; no open Design Gap; GQ1–GQ5 fidelity
held; three closure deviations reconciled under DID v1.12 G1/G2).
P10 is COMPLETE and FORMALLY CLOSED: `planning/results/P10.result.md`
(11/11 exit criteria PASS; P7-GAP-01 CLOSED as the
WaitingOnVacantProducer derived view; DID v1.13 G1–G8 fidelity
held). P11 is COMPLETE: `planning/results/P11.result.md` (11/11 exit
criteria PASS; CI-1..CI-5 mechanically proven; no open Design Gap;
three P12 convergence items recorded). P12 design closure COMPLETE (DID v1.14
governance rulings GQ1–GQ8 landed; P12 contracts FROZEN, Blocking=0) and P12
planning COMPLETE (planning review Blocking=0). P12 implementation COMPLETE and
FORMALLY CLOSED: `planning/results/P12.result.md` (14/14 exit criteria PASS; all
nine completion blockers mechanically evidenced; no open P12 Design Gap).

```text
P12 design closure COMPLETE (contracts FROZEN; four-way review Blocking=0)
P12 planning COMPLETE (phase plan + task contracts; planning review Blocking=0)
P12 implementation COMPLETE; P12 FORMALLY CLOSED
```

P12 completion blockers (must remain explicit throughout closure):
region-encoding correctness fix; ToolCatalogPort inherited contract correction;
full §8.16A Runtime Safety closure; Authority Resolver production plane;
SecretStorePort / SecretRef + real adapter; observability / health / usage plane;
StorageScaleAssessment + DurabilityEnvelope; Remote Worker transport / identity
boundary; Plugin SDK / compatibility / trust model.

P5 result: `planning/results/P5.result.md` (11/11 exit criteria PASS; no open Design Gap). P5-DG-01 was resolved by the decision/execution split: the scheduler evaluator owns the selection decision, the Application owns the `SelectCurrentWork` canonical mutation (P5 `01` §3.1).

## Technical baseline (versioned, from DID §14)

```text
Node 24.21.0 | TypeScript 7.0.2 | effect 4.0.0-rc.115 (exact pin) | pnpm 12.4.2
Vitest 5.0.1 | Biome 2.5.14 | ESM only | tsc -b build
```

Commands: `pnpm build` / `typecheck` / `test` / `lint` / `format` / `architecture` / `check`.
`pnpm check` = lint + typecheck + architecture + test. All must be green before a phase is done.

## Hard engineering rules

1. `Effect<A, E, R>` is an architecture contract: A = success semantics, E = narrow typed failure, R = exact capabilities. No `Effect<A, Error, AppEnv>`, no service locators, no catch-all errors.
2. Domain is pure: `R = never` in domain transitions; no infrastructure imports in `domain`.
3. Port = Effect service; Adapter = Layer. Adapter-specific errors never cross a semantic boundary.
4. Hard invariants are enforced by code (Domain/Command/Persistence/Runtime/Sandbox/Projection, DID-6), never by prompt text.
5. Package dependency follows the allowed-edge matrix in DID §10.4.1; enforce with architecture tests in `tests/architecture/`.
6. Prompt/Model Context changes are behavior code: version them, keep provenance, regression-test them.
7. TDD: write the failing test from design-doc requirements (not from existing code) before implementation.

## Key concepts (do not confuse)

```text
Workspace  = long-lived responsible identity (not folder/session/process)
Work       = phase outcome requirement (Open | Completed | Cancelled)
Execution  = recoverable execution episode (one active main per Workspace)
Agent      = runtime execution role, not a long-term entity (no AgentId)
Verification PASS != Parent Acceptance != Work Completed
```
