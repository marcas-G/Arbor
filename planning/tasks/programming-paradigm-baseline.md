# Programming Paradigm Baseline — Executable Todo

This file is the compact index. The complete governance package is in
`planning/programming-paradigm/`:

- `00-rules.md` — durable programming rules;
- `01-work-breakdown.md` — IDed implementation work and acceptance;
- `02-governance-gates.md` — semantic decisions that block implementation.

This task list records the programming-habit and paradigm findings from the
2026-11-03/04 review. It does not change `docs/design/**`; items that require
new durable semantics remain governance-gated.

## P0 — executable hygiene

- [x] Remove the production `false as unknown as true` escape hatch from the
  StopExecution form; keep confirmation as a boolean UI state and let the Zod
  literal enforce `true` at submit time.
- [ ] Replace production `as unknown as` uses at command-registry and Web
  problem boundaries with named decoding/erasure helpers.
- [ ] Add a lint rule or architecture check that rejects new production
  `as unknown as` outside explicitly approved adapter files.
- [ ] Keep `pnpm biome check`, `pnpm typecheck`, and the focused Web form tests
  green after each boundary cleanup.

## P1 — side-effect discipline

- [ ] Inventory production `new Date()`, `Date.now()`, `process.env`, and
  `globalThis.fetch` uses; classify each as adapter-owned or a violation.
- [ ] Route application/runtime time through the existing Clock/Time port and
  environment through an injected configuration port. This is an
  implementation task only where the owning contract already exists.
- [ ] Add an architecture check preventing Domain/Application code from
  importing ambient time, process environment, or global network APIs.

## P1 — state-machine and transaction ownership

- [ ] Produce a module map for `runModelDecision` and split projection,
  recovery, provider execution, action progression, and settlement into
  separately testable interpreters.
- [ ] Declare one transaction owner for each Application service; remove the
  implicit nested-transaction convention from new code.
- [ ] Add contract tests for transaction ownership and idempotent retry at the
  public command boundary.

## P1 — identity and context boundary (governance prerequisite)

- [ ] Define the durable provenance needed to distinguish Work input/history
  from RootConversation and other Work episodes in a shared Session.
- [ ] Define the Work admission handoff fact for `AssignWork → scheduler →
  WorkEpisode` recovery.
- [ ] After manual governance accepts those contracts, implement the
  Work-context frontier and public regression tests. Do not guess-filter
  Session entries before that acceptance.

## P2 — testing and review practice

- [ ] Replace high-value test fixtures that fabricate domain objects with
  builders/decoders producing valid ADTs.
- [ ] Separate pure, port-contract, application-transaction, process-recovery,
  and public black-box tests in the task/result records.
- [ ] Keep evidence artifacts subordinate to a small, reviewable code change;
  do not use a green evidence batch as a substitute for boundary proof.

## Exit criteria

- P0 items are complete and verified by focused tests plus type/lint checks.
- P1 identity/context items remain explicitly blocked until governance owns the
  new semantic contract.
- Every completed item has a result record with commands and observed output.

The detailed work IDs and ordering in `01-work-breakdown.md` are authoritative
for execution; this file remains the review-friendly summary.
