# Durable Programming Rules

These are standing rules, not a temporary checklist. They apply to production
code, tests, adapters, and review decisions.

## R-01 — Types are executable boundaries

Use ADTs, schemas, branded IDs, and typed failures to make invalid states
unrepresentable. `as unknown as` is allowed only at a named external adapter
boundary with runtime validation and a comment explaining the escape. It is
forbidden in domain/application state transitions and UI business logic.

## R-02 — Decode once, then stay typed

Untrusted JSON, provider frames, database rows, browser errors, and environment
values must be decoded at the boundary. Internal code must consume the decoded
type, not repeatedly inspect `Record<string, unknown>` or match error strings.

## R-03 — One owner per state machine

Each durable state transition has one owning layer. Projection derives; it does
not mutate. Runtime interprets; it does not redefine domain lifecycle. Application
commits commands; adapters do not invent business transitions.

## R-04 — One explicit transaction owner

The outer application/runtime boundary owns transaction scope. Nested transaction
behavior must be explicit and tested. A helper may reuse an ambient scope only
through a named contract, never by convention hidden in implementation code.

## R-05 — Effects enter through ports

Time, randomness, environment, network, filesystem, process state, and storage
enter through injected ports. Native APIs are confined to adapters or explicitly
declared composition roots.

## R-06 — Durable facts carry provenance

Every persisted input, output, observation, decision, and wake fact must carry
enough identity to answer project/workspace/work/execution/episode ownership and
causal predecessor questions. Unbound records cannot be silently projected into
active context.

## R-07 — Recovery reuses durable identity

An existing ProviderTurn, manifest, request, frontier, command identity, or
receipt is resumed from its persisted binding. Current state may validate it,
but may not silently reconstruct a different request under the old identity.

## R-08 — Errors are typed before they are rendered

Recoverable, terminal, reconciliation-required, governance-required, and
unavailable outcomes are distinct types. String messages are display details,
not control flow.

## R-09 — Tests prove the boundary they name

Pure tests prove pure functions; port tests prove contracts; application tests
prove transaction/idempotency behavior; process tests prove restart/crash
behavior; public tests prove user-visible contracts. A lower-level green test
does not close a higher-level requirement.

## R-10 — Main path before exception matrix

Keep one small end-to-end path correct and observable before adding another
recovery branch. Every exceptional branch must identify its predecessor,
successor, idempotency identity, and public disposition.

## R-11 — Evidence is subordinate to code and contracts

Evidence files record verification; they do not define semantics, authorize
design changes, or substitute for a readable implementation boundary.

## R-12 — Small reviewable changes

One change should have one purpose, one owner, one acceptance record, and a
bounded diff. Generated databases, provider evidence, and unrelated UI changes
must not be mixed into a semantic implementation change.

## Review questions

Before approval, reviewers must answer:

- Where is untrusted data decoded?
- Which layer owns this state transition?
- Who owns the transaction?
- What is the durable identity and provenance?
- What happens after process restart or duplicate delivery?
- Which test proves the same scope as the claim?
