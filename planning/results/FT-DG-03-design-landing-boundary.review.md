# FT-DG-03 Accepted Design Landing — Independent Boundary Review

Date: 2026-10-09

Accepted proposal SHA-256: `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

Scope: read-only cross-boundary consistency review of the accepted FT-DG-03
design landing. This review covers the System Design v1.12 / DID v1.34 clauses
and the P1, P12, and P13 owning-contract amendments listed in
`planning/results/FT-DG-03-governance-acceptance-and-landing.md`. It does not
qualify runtime implementation or authorize code, test, or migration work.

## Result

**Blocking = 0.** The accepted landing is internally consistent across the
reviewed P1/P12/DTO/registry/AH10/F21 boundaries. The proposal file's current
SHA-256 was independently recomputed and matches the accepted SHA above. The
current design diff retains the accepted owner boundaries; no additional
semantic landing change is required by this review.

## Boundary checks

1. **External ordering and P1 receipt order agree.** DID §4.1B requires strict
   wire-v1 decode, ID validation, Handler schema/fingerprint derivation, exact
   Actor/Principal binding, and P12 Resolver visibility before entering the
   Gateway. No receipt is read before Resolver success. P1 `01` §3 and `03`
   §3.1 preserve the exact tuple lookup inside Gateway `BEGIN IMMEDIATE`,
   before the final exact-authority check. The external Resolver is expressly
   a visibility gate, so the older P1 wording about receipt-first replay does
   not authorize pre-Resolver receipt disclosure. References: DID
   `03-detailed-implementation-design.md:2300-2323`; P1
   `01-command-contracts.md:116-154`; P1
   `03-transaction-model.md:67-106`; P12
   `02-authority-resolver.md:75-87`.

2. **Wire version and durable receipt versions remain distinct.** The wire
   codec is server-selected v1 with no caller version field and is not
   persisted. Handler `schemaVersion` remains the semantic command/receipt
   schema and fingerprint input; `fingerprint_algorithm_version` remains the
   P1 canonicalization/hash version. A valid current request with an old
   stored tuple receives `IdempotencyConflict`; no legacy comparator or row
   rewrite is introduced. References: DID
   `03-detailed-implementation-design.md:2286-2298,2380-2387`; P1
   `04-sqlite-schema.md:247-270`.

3. **Malformed inputs and historical rows have a single non-replay policy.**
   Invalid current payloads or CommandIds return the transport-only
   `InvalidCommandPayload`; a matching historical row is not looked up or
   disclosed and remains immutable. The DTO only admits server-owned
   `RegisteredCommandType`, schema-authored paths and a fixed
   `"<unknown-field>"` marker; unknown values/keys and request content are not
   reflected. The contract places codec failures before Resolver/Gateway and
   creates no receipt, attempt, Event, or canonical write. References: DID
   `03-detailed-implementation-design.md:2349-2387`; P1
   `04-sqlite-schema.md:255-268`.

4. **Transport response status is a defined implementation requirement.**
   The accepted contract maps malformed/unsupported payloads to HTTP 400 and
   excludes them from CommandRejection/receipt/Event vocabulary. This is
   consistent with the transport-only DTO boundary. Current code still casts
   request objects to `ExternalCommandEnvelope` in HTTP and WebSocket
   (`apps/single-workspace/src/transport/http.ts:67-70`,
   `websocket.ts:47-50`); `statusForCategory` currently maps `validation` to
   its default 503 (`apps/single-workspace/src/transport/errors.ts:88-102`).
   The landing record explicitly records this implementation delta and says
   runtime implementation needs separate authorization
   (`planning/results/FT-DG-03-governance-acceptance-and-landing.md:78-84`).
   These are outstanding implementation requirements, not contradictions in
   the accepted design landing.

5. **Registry scope matches production composition.** P13 separates UI
   exposure from external codec registration, lists the 26 current command
   types and their origin policies, and excludes the six factory-only
   commands: `ReviseDependencyContract`, `WithdrawDependency`,
   `MarkDependencyUnfulfillable`, `RegisterProjectTool`, `CreateWorktree`, and
   `RetireWorktree`. The production composition provides
   `ControlApprovalStoreLive`, so the conditional `ResolveControlApproval`
   handler is present in the production registry. References: P13
   `02-command-exposure-matrix.md:23-81`;
   `apps/single-workspace/src/composition.ts:548-560` and
   `apps/single-workspace/src/registry.ts:200-210,293-298`;
   landing record lines 48-63.

6. **AH10 and F21 remain outside F23 authority changes.** External
   `AssignWork` remains denied; the codec cannot construct AH10 typed target or
   Grant/ActionApproval evidence. The exact approval-consumption transaction,
   immutable binding, P1 `07` proof-complete old-Committed recovery exception,
   and P9/P10 failure fact/projection owners remain unchanged. The CreateProject
   codec checks only the existing payload contract and does not supply the
   trusted resource-admission flow owned by the separate FT-DG-01/F21 work.
   References: DID `03-detailed-implementation-design.md:2389-2401`; SD
   `02-system-design.md:34-50,52-65,1278-1297`; P1
   `07-agent-loop-step-command-identity.md:57-71`; P4
   `03-authority-permission-approval.md:78-84`.

## Verification limits

No tests or implementation checks were run. Review evidence is the accepted
proposal digest, current design diff, owner-contract text, and read-only source
inspection of production registry composition and transport status/casts.
Runtime codec, non-reflecting response behavior, and HTTP 400 remain unqualified
until separately authorized implementation and qualification work.
