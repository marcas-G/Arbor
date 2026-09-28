# AgentDirective v1 → v2 Versioning Decision

**Date:** 2026-09-27
**Status:** Contract-version policy; no decoder or persistence change

## Decision

The canonical identity is versioned by contract name:

```text
agent-directive-v1
  → superseded by
agent-directive-v2
```

`agent-directive-v2` means the 14-branch structured subset in
`35-agent-directive-v2-contract.md`. `RespondToHuman` remains on P14's ordinary
bounded ModelOutput channel. `ResponsibilityHandoff` remains deferred.

Compatibility extension under the name `agent-directive-v1` is prohibited.
Changing required fields, branch payload semantics, or the structured action
set changes the canonical meaning and requires the v2 identity.

This decision supersedes the **scope proposal** in
`20-agent-directive-versioning-decision.md`, which predates the accepted P7
action-language closure and therefore did not include `ProduceDeliverable`,
`RequestDependencyMatch`, or `Deliver`. The later accepted scope in
`27-agent-action-language-governance.md`,
`28-action-language-final-matrix.md`, and
`34-agent-directive-v2-final-readiness.md` is authoritative for v2 membership.
The earlier finding that a v2 identity is required remains consistent.

## Read, replay, and production policy

| Question | Decision |
|---|---|
| May historical v1 records still be read? | **Yes.** Persisted v1 manifests and outputs remain decoded with the exact v1 decoder and validation rules for audit, transcript reconstruction, and historical result interpretation. |
| May a v1 payload be interpreted as v2? | **No.** Version identity is mandatory. No tag/payload coercion, default insertion, or silent reinterpretation is permitted. |
| May already persisted v1 attempts be replayed? | **Yes, as v1 historical replay only.** Reuse stored request/response and existing receipts under their original manifest and v1 decoder; do not resubmit their directives as new effects. Any unresolved effect remains governed by its original reconciliation/idempotency contract. |
| May production create a new ProviderTurn using v1 after cutover? | **No.** New production turns must bind `agent-directive-v2` and its exact manifest identity. |
| May an unsettled execution make a fresh provider call under v1 after cutover? | **No.** It may consume an already persisted v1 result; any new provider turn must be prepared and persisted with v2 identity before calling the provider. |
| Is `completion-claim-v1` a v2 alias? | **No.** It remains a distinct historical output-contract identity if present in old manifests. New production structured action output uses `agent-directive-v2`; a historical `completion-claim-v1` record is read only under its own decoder. |

This policy avoids confusing a stored contract reference with a current
contract. It also prevents old v1 action payloads from gaining new execution
semantics during replay.

## Historical persistence and migration

No historical payload rewrite or database data conversion is required.

Persisted ProviderTurns, attempts, manifests, raw outputs, and receipts keep
their original `outputContractRef`, contract hash, and decoder provenance.
Readers retain the v1 decoder alongside v2 for the historical retention
period. Replay uses the contract version recorded on the historical turn;
fresh generation uses v2.

This is **decoder/version coexistence**, not schema reinterpretation:

```text
stored ref = agent-directive-v1 → v1 validation/meaning
stored ref = agent-directive-v2 → v2 validation/meaning
unknown ref                       → reject/unsupported; never guess
```

Historical effects are not reissued simply because a record is read or
replayed. Only the original idempotency and reconciliation pathways may
resolve an existing effect.

## Manifest/provenance requirement for a future implementation

A future implementation must persist the exact canonical output-contract
identity and hash on each ProviderTurn manifest, next to provider-facing
representation provenance. For v2, that record must distinguish canonical
contract identity from any later compiler/profile/tool-definition identity.
This document does not specify the latter representation.

## Evidence anchors

- Existing decoder identity and ten-branch v1 schema:
  `packages/model-context/src/decode.ts` symbols
  `AGENT_DIRECTIVE_CONTRACT`, `OUTPUT_CONTRACTS`, `AgentDirective`.
- Existing P3 contract vocabulary:
  `docs/design/implementation/P3/03-agent-loop-driver.md` §3 and §4.
- Existing manifest binding:
  `docs/design/implementation/P3/02-model-context-contracts.md` §6.
- Why a version bump is required:
  `planning/tool-surface-review/20-agent-directive-versioning-decision.md`.
- New canonical v2 scope:
  `planning/tool-surface-review/35-agent-directive-v2-contract.md`.
