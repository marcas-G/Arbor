# AgentDirective Versioning Decision

**Date:** 2026-09-27  
**Decision status:** `agent-directive-v2 REQUIRED FOR THE RECONCILED CONTRACT`

## Existing versions

The current decoder defines:

- `agent-directive-v1` with ten tags;
- `completion-claim-v1` as a single-branch output contract.

Evidence:

- `packages/model-context/src/decode.ts:47-70`;
- schema definitions at `packages/model-context/src/decode.ts:131-215`;
- frozen vocabulary in `docs/design/implementation/P3/03-agent-loop-driver.md:53-66`.

## Why compatible supersession is insufficient

Keeping the identifier `agent-directive-v1` while changing the payload meaning
would make the same canonical wire value mean different things:

1. The four current `{}` schemas accept an unconstrained object but do not
   establish the required dependency, governance, specialist, or formation
   semantics. Adding required fields would change validation and the meaning of
   values previously admitted by v1.
2. `Communicate` currently means `{ message: { text } }` in the decoder, while
   P6 freezes `OutboundMessage` with kind, recipient, body reference,
   correlation/causation, and fixed urgency. This is a structural and semantic
   change, not a compatible field extension.
3. The current v1 output contract is used by manifests, provider schemas,
   decoder validation, repair, and tests. Silent reinterpretation would make a
   stored `outputContractRef = agent-directive-v1` ambiguous.

Therefore, the reconciled ten-branch contract must use a new
`agent-directive-v2` identity. v1 remains a legacy contract for historical
records and any explicitly retained legacy decoder path; it must not be
silently widened or reinterpreted.

## v2 scope

`agent-directive-v2` should contain:

- typed `DeclareDependency` payload;
- discriminated `RequestGovernance` payload;
- typed `SpawnSpecialist` payload;
- typed `ProposeChildWorkspace` payload;
- a reconciled `Communicate` payload whose content/reference and Reply target
  semantics have been explicitly frozen;
- the unchanged semantics of `InvokeTool`, `LoadSkill`, `ChangeMode`,
  `CompletionClaim`, and `Yield`, unless contract review finds a separate
  incompatibility.

The v2 contract must not automatically add P7's `ProduceDeliverable`,
`SatisfyDependency`, or `Deliver` tags. Those are a separate vocabulary
decision because P7's implementation documents are marked DRAFT and the
current decoder does not admit those tags. If governance adopts them as
canonical AgentDirective branches, that adoption must be represented in the
v2 contract review rather than hidden in a representation layer.

`completion-claim-v1` can remain unchanged because its branch semantics are
unchanged. A later contract may add `completion-claim-v2` only if its
work-binding semantics change; no such change is decided here.

## Compatibility policy

The following are compatible within a future v2 family only when the semantic
meaning stays identical:

- adding non-semantic provenance or representation metadata outside the
  canonical directive value;
- tightening Runtime validation of an already frozen binding without changing
  the accepted canonical fields;
- deterministic command IDs, authority facts, and generated identities that
  are explicitly outside the directive layer.

The following require a contract revision/bump and cannot be hidden as
Runtime defaults:

- adding or removing required branch payload fields;
- changing `Communicate` from text-only to `OutboundMessage` semantics;
- changing whether a target/revision is model-selected or Runtime-bound;
- adding P7 directive tags to the v1 allowlist.

## Versioning gate

Before any v2 implementation or model-facing representation work:

1. Governance freezes the `Communicate` body/reference persistence boundary and
   exact Reply-target rule.
2. Governance approves typed payloads and ownership for the four placeholder
   branches.
3. Governance decides whether the P7 vocabulary is part of v2 or remains a
   later contract.
4. The canonical schema, decoder, output-contract reference, repair contract,
   and manifest identity are versioned together.
5. A v1 → v2 compatibility/migration record states which historical
   manifests remain decodable and which new turns must reject v1.

No production changes are made by this decision record.
