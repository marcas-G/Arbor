# P10 — 05 Query Surface, User Actions, Transport Boundary (GQ4/GQ6)

**Authority:** DID v1.13 G4/G6, §7.2 (ProjectionQueryPort), §10.4.1 (projection-runtime deps domain+ports; api-contracts deps domain), §10.5 (Problem DTO); SD v1.3 §12.5, §13.10; P8 `05` (P14 consume-only); P6 `04` (Steer), P2 `01` (Stop).
**Status:** FROZEN — DID v1.17 D-1 additive read-model successor (TR-WPU-B/C/D).

**FT-DG-02 additive contract amendment (2026-10-08):** `work-detail` is added
as a read-only view. It does not reopen P10 or alter P12 transport ownership.
Audit references: accepted proposal SHA-256
`6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`; landing
package SHA-256
`266884FC5B8858CA631DC87EFA1EA29B6BFD7265FB93C324F0A5F65FF8C68433`.

## 1. ProjectionQueryPort (signature freeze)

```ts
interface ProjectionQueryPort {
  readonly query: <Req, Res>(view: ViewId, request: Req,
      barrier?: FreshnessRequirement) => Effect<QueryResult<Res>, ProjectionQueryError>;
}
// QueryResult carries { value, watermark, lag } (GQ5); errors use the frozen
// Problem DTO vocabulary (DID §10.5) — stable codes, no message parsing.
```

- DTOs live in `api-contracts` (deps: domain only). ViewId enumeration = `01` §1 must-list.

### Minimal per-view shapes (BLK-3 fix — frozen request/response cores; field-level rendering details are implementation)

```ts
TreeViewReq        = { projectId, depth? }                     → nodes[{workspaceId, parentWorkspaceId|null, name, status, currentWork?, subtreeAttention{attention, actionRequired}, usageSummary? }]
AttentionReq       = { projectId }                             → rows[{source, severity, targetWorkspaceId, dedupKey, summaryRef, occurredAt }]
WorkspaceDetailReq = { workspaceId }                           → { responsibility, boundary, currentWork?, pendingWorks[], executionSummary?, dependencies[], inboxUnconsumed[], verification?, auditTimeline[] }
CurrentWorkReq     = { workspaceId }                           → { workId?, objective, status, revision, activeExecution? } | null
VerificationReq    = { workId }                                → { verificationId?, targetWorkRevision?, verdict?, criteriaResults[], evidenceRefs[], acceptance? }
DependencyReq      = { projectId | workspaceId }               → rows[{dependencyId, consumerWorkId, binding, state, satisfiedBy?}]
TranscriptReq      = { workspaceId, sessionId?, cursor?, limit } → { entries[{kind, summaryRef, at}], nextCursor? }   // first production read path over session_entries
UsageReq           = { projectId, groupBy: "workspace"|"subtree"|"project" } → rows[{workspaceId, tokens, cost, turns }]
InboxViewReq       = { workspaceId }                           → { unconsumed[{entryKey, kind, summary, watermark}] }
WorkDetailReq      = { projectId, workspaceId, workId }        → { workId, projectId, workspaceId, objective, why, completionExpectation, lifecycle, revision, acceptedResult? }
```

The additive `AttentionSource` literal `WorkspaceResourceActivationPending`
is owned by P10 `02` and is the only new wire-vocabulary member in this
landing. It adds no request/response fields, ViewId, or transport endpoint.
Its row is `ActionRequired`, targets the root Workspace, and uses the
deterministic key
`resource-activation:${projectId}:${workspaceId}:${resourceBoundaryRevision}`.
`summaryRef` is the fixed path-free text “Project resource activation is
pending; file actions are unavailable.” `occurredAt` is the source intent's
`createdAt`, stable across event redelivery and rebuild.

P10's source-specific activation Attention projection store atomically
upserts/deletes this key from the P1 status event, lists/replaces the project's
Pending rows during rebuild, and resets this source for the project. These
writes share the P1 `TransactionScope` with Attention projection rows and the
consumer offset. P10 reads only P1 intent identity/status/timestamps, never
boundary addresses, Profile ref/version, or activation failure details.

`acceptedResult` is exactly `{ acceptanceId, verificationId, targetWorkRevision,
verdict: Pass, actor, acceptedAt }`. It is present only when a canonical
Acceptance is bound to that Work revision and its exact concluded PASS
Verification. For `Completed`, absent or inconsistent binding is a typed
projection-integrity failure. `Open` with a bound accepted result remains
Open; `Cancelled` remains canonical Cancelled and preserves Acceptance only as
history. The Work Detail view does not change `current-work` or
`workspace-detail.pendingWorks`.

For `VerificationReq`, when an Acceptance exists for the current Work revision,
select only its bound Verification; otherwise retain the existing selection
rule. `WorkDetailReq` for an absent Work or a Work outside the requested
project/workspace returns a `ProjectionQueryError` branch with code
`projection/work-not-found`, category `not-found`, and non-retryable
disposition. Both cases use identical safe details, containing no target
identity or existence signal; the public response is HTTP 404 for either case.
Malformed request shapes remain `projection/invalid-request`. These are
read-model semantics under P10; P12 continues to own and forward the transport.

Every response carries `{ watermark, lag }` (§1 signature). Shapes are the contract; row limits/cursors beyond Transcript's are transport concerns (P12).

> **DID v1.17 D-1 (TR-WPU-B/C/D).** `parentWorkspaceId` is the direct server-projected
> canonical edge: exactly one returned Tree node has `null`; every non-null parent exists in the
> response; parent pointers are acyclic; row order remains root-first deterministic preorder.
> Invalid hierarchy input is a typed projection failure, never browser repair. A present
> `currentWork` has canonical `status` and `revision`; absent Tree work omits `currentWork`.
> `CurrentWorkSummary.revision` is exactly canonical `Work.revision`. A selected Verification
> emits `verificationId` and `targetWorkRevision` as an inseparable frozen identity pair; an
> empty view omits both. Existing ordered/list clients may ignore these additive members.

> **P12 TR-5 propagation (P12 `04` §3.2/§5; DID v1.14 G4).** The `UsageReq`
> row `cost` field is the P12 `UsageCost` ADT (`Known` | `Unknown`), not a
> hardcoded `0`; **unknown cost stays `Unknown`, never `0`**. P10 renders the
> field (observe-only, invariant 45); cost derivation and versioned pricing are
> P12-owned and do not change P10 view semantics.
- projection-runtime package deps stay `domain, ports` (DID §10.4.1); it never participates in authority (§10.4 hard rule).

## 2. User-action surfaces (SD §12.5 four verbs; UI only issues Commands)

| Verb | Surface | Backing command (existing, unchanged) |
|---|---|---|
| Query | **message-mediated** (BLK-2 fix): the surface submits a Query **Message** to the target workspace (P6 channel); the workspace's cognition side spawns the P14 Execution-bound query execution (P8 `05` read-only program; result = Message/Inbox back-flow). Direct external AdmitExecution stays resolver-gated exactly like Stop (GQ4 scope: external AdmitExecution/Stop both await the P12 resolver — P2 `01` §2 wording; P10 never calls it directly) | SendMessage (query request) → workspace-side AdmitExecution(ExecutionBound) + SendMessage (result) |
| Steer | steer request surface | SteerWork (P6 `04`; severity Normal/Critical; human principal) |
| Stop | stop request/control surface | StopExecution (P2) — **P10 exposes the request only; trusted-authority resolution is P12 (GQ4 inherited clarification)** |
| Governance Change | entry presentation over existing governance commands | formation approval, accept outcome, withdraw/mark-unfulfillable, etc. |

- All surfaces submit via `CommandGateway`; none write storage directly (SD §13.10).
- Stop requests from the P10 surface carry a human principal identifier and are submitted exactly like any external command — P2 validates trusted Stop authority as frozen; no resolver is implemented here.

## 3. P10/P12 transport boundary (GQ6)

```text
P10 owns : programmatic projection/query + UI-facing view semantics
           (this contract set; acceptance is test-driven)
P12 owns : HTTP/WebSocket/CLI/web shell/auth/deployment transports —
           they RENDER the api-contracts DTOs and FORWARD commands;
           they must not reinterpret view semantics
```

- apps/web (DID §10.1) remains unbuilt in P10; P10 delivers the `api-contracts` package as the transport-neutral contract surface P12 binds to.

## 4. Must Not Decide

- No transport protocol/auth choices; no P2 runtime-semantics change; no resolver implementation; no P14 program redefinition (P8 owns; consume only — v1.11 G6).
