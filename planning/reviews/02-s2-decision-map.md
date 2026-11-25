# S2 — human supervision, drill-down, and correction

Source: `docs/design/01-scenarios.md` §§S2.1–S2.5, especially S2.3 and S2.4 steps 1–8. User choices such as deciding to inspect or issue a correction are explicit human inputs; this map evaluates only what the system/model does with them.

## Decision points

### S2-DP14 — Does inspection remain observation rather than being treated as takeover?

- **Source:** S2.3; S2.4 steps 1–3; S2.5 “观察 ≠ 接管”.
- **Situation / decision:** User views global or local Workspace/Agent state without issuing a modifying instruction.
- **Possible outcomes:** Return the requested observation and leave work running; do not silently turn inspection into steer, assignment, or authority change.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** Distinguish read/projection operations from mutation commands; no state-changing command follows solely from viewing.
- **Model judgment:** None required for the observation/takeover boundary itself.
- **Required inputs:** Authenticated view request, selected Workspace/path, projected state and permissions.
- **Observable output:** Read result with unchanged canonical state and execution status.
- **Existing Prompt Program:** `p8-query-inspection` is text-backed but is for a query execution, not proof of user UI inspection wiring; it should not be needed to enforce read-only browsing.
- **Existing Runtime surface:** Tree/detail read models and command gateway; DID read/mutation boundaries; P14 web/read surfaces.
- **Current tests:** `tests/p10-views-detail.test.ts`, `p10-tree-status.test.ts`, `tests/architecture/p13-web-boundaries.test.ts`; these test projection/surface boundaries, not model behavior.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL**.
- **Why:** The user’s decision to inspect is outside the model, and read-only semantics must be mechanically enforced.

### S2-DP15 — Is a user change local steer or a high-level direction change?

- **Source:** S2.4 steps 5 and 8; S2.5 “局部问题局部纠错 / 高层变化回到 Main Agent”.
- **Situation / decision:** A user changes a fact, constraint, priority, objective, route, or first-layer organization.
- **Possible outcomes:** Apply a local correction to the selected Workspace; return a project/first-layer change to Main Agent discussion; escalate if the requested decision exceeds the local agent’s authority.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Sender identity, target Workspace, steer command kind, responsibility revisions, and authority chain are canonical inputs; Runtime can route an explicit target but cannot infer the semantic level of an ambiguous instruction.
- **Model judgment:** Identify the scope of the requested change and which responsibilities are actually affected.
- **Required inputs:** Full user message, selected Workspace and responsibility, parent chain, current objective/constraints, and whether the user explicitly changed project-level direction.
- **Observable output:** Local plan correction or a bounded high-level discussion/escalation; no silent responsibility transfer.
- **Existing Prompt Program:** `p6-human-steer` covers absorbing correction; no separate text-backed program for distinguishing local correction from high-level direction.
- **Existing Runtime surface:** P6 `SteerWork`, P14 Root/Main conversation; P6 `04`; P14 `02`.
- **Current tests:** `tests/p6-steer.test.ts`, `tests/p10-humanintervention.test.ts` exercise command routing and state, not natural-language scope classification.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** Wrong scope either loses a local fix or spreads a high-level change through the wrong management path.

### S2-DP16 — How should the correction change the existing line of work?

- **Source:** S2.4 steps 4–5 and 7.
- **Situation / decision:** A user has inspected local context and issued a correction to a specific agent.
- **Possible outcomes:** Merge the guidance into the existing work while retaining unaffected progress; revise the local plan where necessary; surface a material conflict for ruling.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime appends the human input and preserves prior canonical work/history; it cannot determine which findings the new correction invalidates.
- **Model judgment:** Absorb the correction without discarding valid prior work, while not preserving conclusions the correction actually disproves.
- **Required inputs:** Current responsibility and work frontier, prior evidence/decisions, correction text, and the scope classification from DP15.
- **Observable output:** Updated plan/next directive with explicit retained and revised assumptions when material.
- **Existing Prompt Program:** `p6-human-steer` explicitly says to merge guidance into the existing line and preserve unaffected prior work; no production `loadProgram` call was found.
- **Existing Runtime surface:** Steer inbox/session input and subsequent WorkspaceMain execution; P6 `04`.
- **Current tests:** `tests/p6-steer.test.ts`, `tests/p6-acceptance.test.ts` verify steer storage/routing and static clause presence, not absorption quality.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** The distinguishing outcome is correction on top of a continuing work thread, rather than either ignoring the user or starting over.

### S2-DP17 — Does the input require an immediate Critical Stop?

- **Source:** S2.3 and S2.4 step 6.
- **Situation / decision:** A user correction arrives while an execution may be acting; it may be ordinary guidance, explicit stop, or a sufficiently high-risk direction error.
- **Possible outcomes:** Normal steer at a safe point; Critical Stop path; ask for clarification if the stop intent/risk cannot be established.
- **Owner:** MIXED.
- **Deterministic enforcement:** Once an authenticated Critical Steer is submitted, Runtime gates new provider/tool/specialist activity and applies stop/quiescence rules. Explicit command kind is authoritative.
- **Model judgment:** If the input is ordinary language rather than an explicit critical command, determine whether its content indicates a high-risk direction error; do not promote mere disagreement to critical interruption.
- **Required inputs:** Exact user text, explicit urgency/stop intent, active action and its side-effect boundary, authority, and current Work/Execution state.
- **Observable output:** A Normal steer or Critical Steer decision plus a traceable stop/control event.
- **Existing Prompt Program:** `p6-human-steer` describes Normal vs Critical semantics; code controls whether a Critical Steer actually stops work.
- **Existing Runtime surface:** `submitCriticalSteer`, `SteerWork`, Critical Steer quiescence; P6 `04`; `packages/application/src/critical-steer.ts`.
- **Current tests:** `tests/p6-critical-steer.test.ts`, `tests/p6-steer.test.ts`, `tests/p10-humanintervention.test.ts` cover explicit command mechanics, not natural-language risk classification.
- **Behavioral Test Candidate:** YES — **ADVERSARIAL** for the classification half; separately test stop guarantees mechanically.
- **Why:** Pair “strongly worded but ordinary correction” with “explicit/high-risk immediate stop” to measure false positives and false negatives.

### S2-DP18 — What is safe to consider stopped after Critical Steer?

- **Source:** S2.4 step 6.
- **Situation / decision:** A Critical Steer has been accepted while a provider call, tool, or external action may be in flight.
- **Possible outcomes:** Cancel safe in-flight work; preserve completed effects; reconcile uncertain effects; mark not-yet-safe work as still requiring reconciliation.
- **Owner:** MIXED.
- **Deterministic enforcement:** Runtime must block new model/tool/state-changing work, attempt only safe cancellation, and never assert that an already-issued external side effect was undone.
- **Model judgment:** Given observations of external state, identify what remains unknown and request/perform a permitted reconciliation rather than continuing blindly.
- **Required inputs:** Critical Stop event, in-flight activity identity, cancellation result, action idempotency/effect status, and available read evidence.
- **Observable output:** Quiescent execution or explicit “reconcile required” state, with actual completed effects retained.
- **Existing Prompt Program:** `p6-human-steer` tells the agent to re-read the Canonical Control surface after Critical Steer; hard stop behavior belongs to Runtime, not the prompt.
- **Existing Runtime surface:** Runtime Safety Gate, P6 Critical Steer, P9 recovery and P12 runtime-safety controls.
- **Current tests:** `tests/p6-critical-steer.test.ts`, `tests/p12-runtime-safety.test.ts`, `tests/p9-tool-outcome-unknown.test.ts`.
- **Behavioral Test Candidate:** YES — **EDGE** for the model’s reconciliation response; **NOT_BEHAVIORAL** for the stop/cancellation fence.
- **Why:** Human review should keep the semantic reconciliation choice distinct from the mechanically enforceable “no new action” invariant.

### S2-DP19 — After absorbing the correction, should the agent proceed autonomously or wait?

- **Source:** S2.4 step 7; S2.5 “干预之后恢复自治”.
- **Situation / decision:** The correction is understood and the affected work remains authorized.
- **Possible outcomes:** Continue planning, acting, checking, and repairing; pause only for a genuinely unresolved ruling/precondition.
- **Owner:** MIXED.
- **Deterministic enforcement:** Runtime can queue/wake the execution and enforce explicit waiting conditions; it cannot decide whether the guidance is sufficient to resume useful work.
- **Model judgment:** Choose a safe next action and avoid accumulating unnecessary step-by-step confirmation debt.
- **Required inputs:** Absorbed correction, remaining authority, work frontier, current blockers, and pending human decisions.
- **Observable output:** A work directive/progress action, or one specific bounded request where blocked.
- **Existing Prompt Program:** `p6-human-steer` states restore autonomy and avoid repeated confirmation; no real-model evidence was identified.
- **Existing Runtime surface:** P6 steer wake and WorkspaceMain loop; `tests/p6-steer.test.ts`, `tests/p6-inbox-promotion.test.ts`.
- **Current tests:** Scripted wake/steer stories exercise routing, not whether the model resumes appropriately.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** It separates an agent that can continue from a prompt responder that waits for “continue” after every correction.

### S2-DP20 — Is the change an update to existing responsibility or a responsibility transfer?

- **Source:** S2.4 step 8.
- **Situation / decision:** A high-level change affects goal, constraints, interface, or who is responsible for an outcome.
- **Possible outcomes:** Keep the responsibility and update its work when only goals/constraints/interfaces change; if long-term ownership changes, perform an explicit handoff with needed facts/artifacts/open work before the old owner exits.
- **Owner:** MIXED.
- **Deterministic enforcement:** Runtime preserves parent links/history and can require governed creation/assignment transitions; it must not silently move an existing responsibility between parents.
- **Model judgment:** Determine whether the change alters “what to do” or “who owns it”; identify transfer contents and affected descendant work.
- **Required inputs:** Old/new responsibility definitions, parent/child relationships, open work/dependencies, artifacts, and the user’s stated intent.
- **Observable output:** Constraint/work update, or an explicit transfer proposal/handoff plan routed through the proper governance path.
- **Existing Prompt Program:** `p6-formation` governs creating child responsibilities; `p6-human-steer` governs absorbing guidance. Neither artifact fully defines semantic detection of responsibility transfer.
- **Existing Runtime surface:** P6 formation/authority/delegation and Workspace parent links; P11 ownership wiring; no evidence that a natural-language handoff detector is mechanically specified.
- **Current tests:** `tests/p6-acceptance.test.ts`, `tests/p11-ownership-wiring.test.ts`, `tests/p11-revision-algebra.test.ts` cover canonical boundaries, not model classification.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** This distinction protects long-lived responsibility identity and history while allowing ordinary objective changes.

## S2 evidence interpretation

The runtime stories prove that explicit steer/stop inputs reach defined governance paths; they do not prove how ordinary language is classified or absorbed. DP17–20 are mixed specifically because a prompt cannot replace stop/authority/relationship enforcement, while Runtime alone cannot assess the meaning of a user correction.
