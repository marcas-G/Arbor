# S3 AnyProducer Settled-Wait Gap — 2026-10-24

## Finding

The real run and retained DB evidence are recorded in
[`real-public-s3-collaboration-rerun-20261024.result.md`](./real-public-s3-collaboration-rerun-20261024.result.md).
The Parent Work settled with an `AnyProducer` `DependencyChanged` wait while
the Dependency remained Unsatisfied; no producer Work, matching Deliverable,
pending formation, active Execution, or satisfiable wake source existed.
Public Attention was empty and the Parent remained Open.

Frozen-contract review shows this state is outside existing vacant-producer
Attention: P7 `05` defines `AnyProducer` as a non-edge, and P10 `02`'s
`WaitingOnVacantProducer` source is explicitly limited to
`Unsatisfied ∧ WorkspaceBound` with a vacant non-retired producer Workspace.
P7 producer-loss semantics also exempt `AnyProducer`. The existing design does
not specify model-action eligibility or recovery visibility for a settled
AnyProducer wait with no current/pending producer. Adding either behavior to
production without governance would invent semantics; no production change was
made.

## RED evidence

`tests/functional/pending/s3-any-producer-settled-wait-attention.pending.test.ts`
seeds an in-memory P10 canonical state with an Open Parent Work, an exact
`DependencyChanged` WorkWait, an Unsatisfied `AnyProducer` Dependency, one
settled WorkEpisode, and no other Work, Deliverable, or FormationProposal. It
then queries the existing project Attention projection without mutation and
expects the proposed legacy `WaitingOnVacantProducer` row.

The isolated pending config produced the intended RED: 1 file / 2 tests, with
the fresh settled-wait positive failing at the row-presence assertion
(`expected false to be true`, confirming current Attention rows = 0) and the
stale `observedRevision` negative passing. The existing P10 Attention
read-model suite remained green (1 file / 13 tests). Complete
`tsconfig.test.json` typecheck, targeted Biome, and `git diff --check` passed.
The pending test stays outside normal test suites.

## Governance boundary

`planning/proposals/s3-any-producer-settled-wait-governance-draft.md` is a
fixed, unaccepted draft proposing a closed producer-evidence set for new
model-authored waits, a `ModelUsable` rejection when evidence is absent, and
read-only Attention for legacy settled idle waits. It also defines how a
known future Workspace or information-only external input should be expressed.
Draft SHA-256: `893E37EC5028B75F511890E82C97EB6E9DB66690F84E6C3F22B95C3CA263FCF3`.
Independent read-only review by p41 passed with 0 blocking findings.
The proposal changes no files under `docs/design/**` and authorizes no
implementation. Manual acceptance is pending.

S3 remains **unqualified**. No daemon or real Provider was run during this
design-gap investigation; no schema migration, API label, receipt/replay,
canonical mutation, or production code change was made.
