# Real Public S3 Collaboration Rerun — 2026-10-24

## Outcome

**FAIL — `EARLY_TERMINAL_STALLED`; no S3 qualification.** This was the single
authorized rerun of
`tests/capability/real-provider/public-s3-collaboration.test.ts` on
`34adf883ce922b15e4821649a5d47e16a0eabd06`, with
`C:\Arbor\arbor.config.json`, retry 0, one worker, current daemon/Web build
assets, and a fresh P39-private `.test-results` run directory. No other test
file, build, daemon, or real-provider attempt was started.

The journey reached a stable no-producer wait, not the earlier projection 503.
The Vitest case ended at its own 20-minute deadline (1,200.815 seconds) with
`public client overall request deadline exceeded` while the formation loop
continued reading the public responsibility tree. It was not automatically
retried.

## Durable and public state at failure

Read-only public views during the stall and the retained database after the
case ended agree:

- The responsibility tree contained only the root and one approved Parent;
  no Child workspace was formed.
- The root `ConversationResponseEpisode` execution and the Parent
  `WorkEpisode` execution were both settled `Completed`. The Parent execution
  settled at `2026-10-23T18:26:02.312Z`.
- The Parent Work remained `Open`, revision 0, with a durable `Any` wait.
  Its only dependency was `Unsatisfied`, bound to `AnyProducer`, with no
  producer Workspace or satisfying Deliverable.
- There was no active execution, pending Work, pending formation proposal,
  Parent inbox item, verification, or Attention row. The root inbox held the
  original human message and the decision record for the approved Parent.
- The persisted event summary contained one `WorkAssigned`, one
  `DependencyDeclared`, and two `WorkspaceCreated` events (root and Parent).
- The provider capture contained 11 started/completed requests and four held
  responses, all four released. It contained no extra request after the
  Parent's dependency wait and no captured request failure.

This identifies a settled-no-producer stall: the Parent declared and waited
for an `AnyProducer` Dependency, but no Child/producers existed and no
execution or pending approval remained that could form one. The run did not
reach child write approval, Artifact/Deliverable delivery, dependency
satisfaction, verification, or either Acceptance boundary. Therefore it
proves neither the S3 happy path nor the requested recovery branch.

The frozen contract review confirms that this is not the previously-fixed
projection defect. P7 `05` makes `AnyProducer` a non-edge in wait-for graph
and only satisfiable when a matching fact arrives; P7 `01` explicitly exempts
`AnyProducer` from producer-loss handling. P10 `02`'s existing
`WaitingOnVacantProducer` source is narrowly `Unsatisfied ∧ WorkspaceBound`
with a vacant, non-retired producer Workspace. The captured AnyProducer wait
is outside that Attention source. S3 describes escalation and governance
disposition when a needed source cannot provide, but does not specify how an
AnyProducer wait with no current/pending producer is recognized or recovered.
No frozen rule authorizes widening P10 or blocking `DeclareDependency` for
this condition. A narrow design gap is therefore raised; production semantics
were not changed.

## Private evidence and cleanup

The failure teardown archived the fixture into a P39-private direct child of
the run directory. The database and Workspace remain available at:

`.test-results/real-public-real-public-s3-real-s3-76d2543909-9tl6f4/retained-fixture-98c38cc6-d31c-422d-a140-16534fd59382/`

- Private result JSON SHA-256: `E6A2DBF8FCFEB44809B757E8580988CE1739ADB52E0101DB4B876F84415F94F4`
- Provider capture JSONL SHA-256: `97577FD609DE6AFE187793C548357FF4F94F8FCA16EB55A9900BD15079EAE674`
- Archived SQLite database SHA-256: `26B540482EC5F90F858316580BF9E2CFA61311E9CCDF4E1B6B492239A7434730`
- Archived database exists; Workspace directory exists and contains one file (19 bytes).
- The final result JSON records `status=FAIL`, the public deadline diagnostic,
  the archived fixture paths, and `daemonExited=true` with no daemon errors.
- The captured daemon PID exited; its owned listener count was 0.

Provider bodies, human-message text, Work objectives, DB payloads, and
credentials are not included in this report. No inference is made from their
contents.

## Qualification boundary

S3 remains **unqualified**. The durable evidence diagnoses a settled
AnyProducer wait without a producer, and its P7/P10 design gap is being
reviewed separately. The projection fix (`cffce578`) and both fixture-retention
fixes (`5f3cabf3`, `6e25b80b`) were in place for this run. No real Provider
rerun is authorized by this result; a later attempt requires explicit
orchestration after governance and implementation authorization.
