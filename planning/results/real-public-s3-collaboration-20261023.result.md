# Real Public S3 Collaboration Journey — 2026-10-23

## Outcome

**FAIL; no S3 qualification.** One explicitly authorized, real-provider S3 run
was attempted against `C:\Arbor\arbor.config.json` with retry 0 and one worker.
The test terminated after 133.6 seconds at the public
`GET /views/responsibility-tree` read. The response was HTTP 503
`projection/unavailable`, with safe details
`sourceKind=RuntimeSafetyEnvelope` and
`reasonCode=EpisodeVersionUnsupported`. The run had handled two Governance
Inbox items and had not yet recorded dependency-stage evidence. No retry or
second real-provider run was made.

The public capture recorded 21 `request-start` and 21 `response-complete`
events; 11 responses were held and all 11 were released. The captured daemon
PID had exited at post-run inspection. No listening socket owned by that PID
remained.

## Evidence and limits

Private evidence was retained under the worktree's `.test-results` directory:

- Run directory: `.test-results/real-public-real-public-s3-real-s3-60a4abbfd0-eYUKJ4/evidence-bytvl1/`
- Sanitized result JSON SHA-256: `27B11601D3EE3269D408F5F7A3CB478D3F931470E166FD0A721DB2503A9C1653`
- Provider capture JSONL SHA-256: `107135EF9CE814DA419452759EC8B57524329B98ECB2C35869783572816C228B`

The JSON contains the public failure, capture counts/events, and run identifiers;
provider bodies are deliberately not reproduced here. The fixture's original
database/workspace path was under the temporary
`.arbor-functional-schema44-*` root. Vitest's schema-44 global teardown removed
that root, so the DB and workspace were unavailable for attribution. Therefore
the exact persisted episode tag that triggered this response cannot be
established from this run; the capture alone is not used to infer it.

## Diagnosis and corrective changes

The loader routed every `RuntimeSafetyEnvelope` safety-stop source through the
Work-bound active-execution revision filter. P10's frozen contract scopes that
envelope to the Execution Workspace, and its exact Work revision rule applies
only to Work-bound sources. A valid non-Work `ExecutionEpisodeBinding` should
therefore project workspace-scoped Attention without `workId`; Work episodes
must still pass the exact current Work/revision check, while malformed,
unknown, legacy-ambiguous, and `ExecutionBoundEpisode` identities remain
fail-closed.

That minimal split is committed as `cffce57896a139a3202c0ee1c8525342642a8efb`
(`fix(projection): scope non-work safety attention by workspace`). The isolated
P10 regression was RED for the three valid non-Work variants and GREEN after
the change. The focused P10 suite passed 8/8, the existing attention-readmodel
suite passed 13/13, complete `tsconfig.test.json` typecheck passed, Biome and
`git diff --check` passed. Independent static review was PASS. No daemon,
provider, or real journey was run for this correction.

The fixture loss was a separate harness issue: `preserveDirectoryOnStop` kept
the fixture only until Vitest's global schema-44 teardown removed its parent
root. Shared real-provider teardown now moves a stopped failed fixture into the
private run directory using `archiveProductionFixtureFailure`, records the
archived DB/workspace paths in evidence, and still cleans successful fixtures.
This is committed separately as
`5f3cabf3edeb590da2b19efe66478a104cb0f79b`
(`test(real-provider): retain failed public fixture evidence`). Its regression
simulates schema-root teardown and confirms the archived DB/workspace survive.
The retention/S0 unit batch passed 12/12; complete test TypeScript check,
Biome, and `git diff --check` passed. The retention fix has **not** been
requalified with a real S3 run.

## Qualification boundary

S3 remains **unqualified**. This run does not establish the exact persisted
episode cause because its DB was lost, and the projection and retention fixes
have not been followed by a new real-provider S3 attempt. The earlier S1 pass
does not qualify S3.
