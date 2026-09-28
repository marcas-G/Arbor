# S01 Canonical Readiness Review

**Date:** 2026-09-27  
**Status:** `NOT READY — S01 NOT AUTHORIZED`

## Findings

### `CANONICAL_AGENT_DIRECTIVE_DRIFT`

Confirmed for the five branches previously identified:

- `DeclareDependency`
- `RequestGovernance`
- `SpawnSpecialist`
- `ProposeChildWorkspace`
- `Communicate`

The first four use `unknown`/`{}` placeholders even though downstream P6/P7
contracts require model-level semantic inputs. `Communicate` exposes only
`message.text` even though P6 requires an `OutboundMessage` semantic boundary.
These are canonical contract defects, not Qwen, llama.cpp, provider adapter,
representation, or Runtime-defaulting problems.

### Additional vocabulary alignment item

P7 v1.10 governance inputs mention `ProduceDeliverable`, `SatisfyDependency`,
and `Deliver`, but the current decoder's ten-tag v1 allowlist does not include
them. The P7 implementation documents are marked DRAFT. This is not silently
resolved in this review; governance must decide whether those tags belong in
`agent-directive-v2`.

## Closure scorecard

| Gate | Result | Evidence |
|---|---|---|
| All ten branches mapped from intent to downstream effect | **MAPPED 10/10** | [19-agent-directive-semantic-mapping.md](./19-agent-directive-semantic-mapping.md) |
| Soundness of current v1 payloads | **FAIL** | five branches do not carry all required semantics |
| Completeness of current v1 payloads | **FAIL** | four `{}` payloads and text-only `Communicate` lose semantics |
| Semantic preservation on paper | **PARTIAL** | five branches require v2 payloads; Communicate has unresolved body/reply transformations |
| Canonical version decision | **v2 required** | [20-agent-directive-versioning-decision.md](./20-agent-directive-versioning-decision.md) |
| Model-facing representation readiness | **BLOCKED** | canonical layer must close first |
| S01 authorization | **NOT AUTHORIZED** | no implementation permitted |

“10/10 mapped” means every current tag has an explicit audit row. It does not
mean the current v1 contract is 10/10 semantically closed.

## Remaining Design Gaps

1. **Communicate content persistence:** P6 freezes `bodyRef` as the durable
   message reference and says authored content is stored in Artifact/Blob, but
   no frozen AgentDirective-to-content persistence transformation exists.
2. **Reply target selection:** P6 freezes correlation allocation/validation,
   but does not define how a model selects one Reply target when more than one
   Query is outstanding.
3. **P7 vocabulary placement:** decide whether the P7 directive vocabulary is
   part of `agent-directive-v2` or a later canonical contract.

No other ownership gap was found in the ten current branches once the
canonical payload is typed: Runtime identity, authority, revisions, IDs,
formation depth, safety, and command idempotency are downstream/runtime facts;
model intent remains explicit.

## Readiness verdict

Canonical semantics have **not** reached `10/10 CLOSED` at the current v1
contract level. The ten branches are fully mapped as governance artifacts, but
the five drift branches cannot be implemented without a v2 contract and the
three design gaps above.

S01 representation design **cannot restart**. The required order remains:

```text
canonical semantics / v2 contract closure
  → canonical validator and downstream mapping proof
  → model-facing representation design
  → S01 implementation authorization
```

This phase stops here. It does not modify production code, Prompt text,
Runtime, Output Contract implementation, tests, or model-facing tools.
