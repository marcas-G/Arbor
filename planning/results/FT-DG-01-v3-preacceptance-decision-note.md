# FT-DG-01 v3 pre-acceptance decision note

Date: 2026-10-10

Scope: proposal-only revision. No docs/design, production code, migration, or test
file changed; no tests were run.

## Baseline and evidence

- Main HEAD at review start: `860d89d49946e70541b1b13f2650e25d3edc15c7`.
- AH10 source evidence is present at that main revision, including the direct-child
  public formation result and generation/SendMessage public seed result. The tested
  AH10 documentation commit `1a1324ec6ea0536a116924e236382a550c4979f4` is an ancestor
  of the main HEAD.
- The isolated worktree was tracked-clean before the revision. Main had an unrelated
  tracked modification to `planning/results/P12.restore-drill.json`; it was not
  touched. The prior isolated AH7 commit's changed files matched main byte-for-byte.
- Proposal before this edit:
  `planning/proposals/ui-project-resource-admission-decision-draft.md`, SHA-256
  `E6EC3E2E395121699A2327329B42658218C90E8912D55EE960E77E3D15D91196`.
- Proposal after this edit: SHA-256
- Committed proposal blob content SHA-256 at v3 commit `b29b1a7`:
  `274885C110E3B277753B49F6BAD023619ADFCF52D866CC86F01F27F7FDA85DD0`.
  `git rev-parse HEAD:planning/proposals/ui-project-resource-admission-decision-draft.md`
  identifies that Git blob as `9eef97e801891e222928f4230e09f387b45de444`.
- The earlier `3BF05DBF...` value was a raw working-tree PowerShell hash, not the
  committed proposal content hash. Git reports `i/lf w/crlf` and system
  `core.autocrlf=true`: raw `Get-FileHash` of the checkout is
  `3BF05DBF1E90D701EAFC1A0F71EBE62F70DBC801FD92DDF45BD6B8B0AE04005C`, while
  PowerShell `Get-FileHash -InputStream` over the UTF-8 LF-normalized bytes returns
  `274885C110E3B277753B49F6BAD023619ADFCF52D866CC86F01F27F7FDA85DD0`, matching
  the exact bytes emitted by `git cat-file blob HEAD:<path>`.
- This follow-up addresses the independent review's sole Blocking finding: the prior
  note bound the CRLF worktree hash to the committed proposal. The v3 proposal blob
  and all three OPEN boundaries are unchanged by this correction.
- Static evidence: browser CreateProject sends an empty root ResourceBoundary;
  production does not consume the fixture-only ARBOR_PROJECT_ROOT; CreateProject
  v1 accepts a ResourceBoundary and persists it after only the revision check; and
  post-commit ownership activation currently receives the original command payload.
  See `F21-failing-browser-evidence.result.md`,
  `FT-DG-01-governance-readiness.review.md`, and the two F21 pending tests.

## Blocking findings closed in the v3 candidate

1. Removed the proposal's Composition/Resolver-before-Gateway CommandId pre-read and
   removed the historical-schema v1 receipt replay branch. The candidate now states
   the accepted DID v1.34 / FT-DG-03 order explicitly: authenticate → strict server
   wire-v1 decode → IDs → current schema/fingerprint → exact Actor/Principal binding
   → Resolver → Gateway transaction tuple comparison. No receipt is read outside
   Gateway, and no old raw result/error is decoded on mismatch.
2. Defined v1 CreateProject receipts/payloads as preserve-only. The current v2 codec
   rejects old raw-address payloads before receipt lookup. A valid v2 candidate that
   passes the existing authentication, actor binding, and Resolver visibility but
   reuses a stored v1 CommandId reaches the Gateway and fails current schema/tuple
   comparison with non-disclosing IdempotencyConflict. Existing rows/projects are
   not rewritten, upgraded, or replayed under stored-schema semantics.
3. Added P1 `01` as the owner of the CreateProject v2 payload, Handler schema,
   rejection and Event contract, and P1 `02` as owner of the Profile Port shape and
   transaction/I/O boundary. Added a P12 host catalog/transport owner while keeping
   P12 `02` as a pure Authority Resolver. External wire codec remains v1; only the
   Handler semantic schema is v2.
4. Replaced the post-commit raw-payload activation source with a contract requirement
   to reread the durable root Workspace boundary. Profile lookup is a frozen,
   deterministic in-memory mapping after the Gateway proves no existing receipt;
   filesystem resolution/ownership I/O stays outside BEGIN IMMEDIATE.
5. Explicitly kept ProjectCreated EventVersion 1 and its payload unchanged. P1 `05`
   currently limits v1 writers/readers to EventVersion 1 and treats higher versions
   as poison; the candidate no longer proposes silently adding Profile metadata or
   writing EventVersion 2.

## Smallest candidate behavior

The browser selects either a host-registered Profile ref/version or explicit
ConversationOnly. The external CreateProject payload is a closed union and cannot
carry raw addresses. The trusted Profile maps to a canonical FileTree boundary
persisted atomically in the existing Workspace row. ConversationOnly persists an
empty boundary. Project, Workspace, Session and existing v1 events remain in the
same Gateway transaction. No GitWorktree is created and no SQL migration is proposed.

After commit, ownership activation rereads the persisted boundary. A missing or
replaced path fails closed without switching to another registered directory; an
exact receipt retry replays under the existing F23 order and retries only that same
durable-boundary activation.

## Explicit OPEN items

- **OPEN-1 — durable source attribution:** F21's file-read happy path can be
  black-box qualified from the persisted canonical Workspace boundary; it does not
  require later lookup of the original Profile ref/version. However, v2 had proposed
  ProjectCreated source audit, and v3 deliberately leaves that product requirement
  undecided. The existing command receipt is durable (P1 04 says commands are never
  hard-deleted), but current CommandStore lookup is keyed by CommandId; without a
  retained ProjectCreated event or a Project→receipt query it is not independently
  discoverable by Project after event retention. Extending the v2 receipt result
  alone is therefore not yet a complete project audit read path.

  ProjectCreated EventVersion 2 is feasible only as an explicit P1 01/P1 05 package:
  P1 05 writer/reader rules, packages/application consumer ceiling, and
  adapters/persistence-sqlite projection ceiling must all accept v1/v2 before a v2
  writer is enabled. Current application and SQLite readers quarantine versions >1.
  The generic event_version column requires no SQL migration, but consumers and their
  compatibility tests do. A Project metadata column is another explicit option and
  would require a forward-only SQLite migration with old projects marked
  Unknown/Legacy. F21 functional PASS alone can close the file-access journey, but
  formal FT-DG-01 closure cannot claim source audit unless the governor accepts a
  scope without that requirement or one durable/queryable option is governed.
- **OPEN-2 — legacy retry product expectation:** preserve-only is safe and matches
  current F23 tuple semantics. If product requirements demand successful same-ID
  retry of an old v1 CreateProject receipt after upgrade, that is a separate F23
  governance gap and blocks that compatibility requirement, not the v2 F21 happy
  path; this note does not define a bypass or legacy decoder.
- Post-commit activation failure remains a committed Project with its canonical
  boundary. Qualification must prove the same-command retry/restart path does not
  report rollback or choose a new directory; durable public Attention semantics, if
  required, need an owning contract before that recovery/attention claim is closed.

## Required independent review / qualification (not run)

The v3 acceptance matrix requires F21 browser success, public raw-path and forged-ref
negative tests, exact v1 receipt preservation/non-disclosure, v2 same-ID tuple
conflict, Profile version change across host restart, ConversationOnly behavior, and
post-commit activation recovery from the exact persisted boundary. Both F21 tests
remain pending and the full functional suite was not run or interrupted.
