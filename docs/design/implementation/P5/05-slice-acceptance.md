# P5 — 05 Vertical-Slice Acceptance

**Authority:** DID v1.9 §11 P5, G1/G4/G5/G6/G7.
**Status:** DRAFT (first draft for contract review).

## 1. The single acceptance story (G7)

One deterministic end-to-end story must pass, using the composition root (`01`)
and the deterministic Fake Provider (G6):

```text
1.  CreateProject + AssignWork (P1 commands)          -> Open Work, session
2.  Scheduler.reevaluate (02 provisional source)      -> SelectCurrentWork(theOne)
3.  SelectCurrentWork command (Application; `01` §3.1) -> workspace.currentWorkId
4.  Scheduler.reevaluate                              -> Admit Work(current)
5.  AdmitExecution (P2)                                -> durable Execution, lease
6.  real ExecutionDriverPort (P3) drive
7.  prepareTurn (P3)                                   -> Ready, Manifest
8.  ProviderRuntime + Fake Provider                    -> CanonicalProviderEvents
9.  decodeTurn -> InvokeTool (P3)                      -> AgentDirective
10. ToolRuntimePort.invoke (P4)                        -> CanonicalToolObservation
11. Observation appended to the fixed Session          -> session entry
12. next turn: prepareTurn sees the Observation        -> multi-turn continuity
13. Yield(reason, waitSpec)                            -> Completed(Yielded)
14. WorkWait registered (P2, same tx)                  -> Work stays Open
15. wake (durable) -> Scheduler.reevaluate             -> new Execution
16. continuation on the SAME primarySessionId
17. CompletionClaim                                    -> Completed(CompletionClaimed)
18. Execution settled; Work remains Open (P8 owns the Verification/Acceptance chain)
19. restart: stop runtime, reconstruct on same DB      -> same Work/Session, loop resumes
```

Step 2–4 exercise the scheduler-decision / command-execution split (`01` §3.1):
the loop forwards the evaluator's exact `SelectCurrentWork(workId)` to the
Application command and never selects a Work itself.

- Work is **`Open`** at the end (no `CompleteWork`); the `ExecutionSettled`
  event is the P8 hand-off.
- Steps 8–9 exercise the P3→P4→P3 tool seam; step 12 the Yield/Wait seam;
  steps 11–14 the wake/continuation seam; step 17 the restart seam.

## 2. Acceptance assertions

```text
- exactly one active main Execution at a time (P2 partial unique)
- Execution 1 settles Completed(Yielded); Execution 2 settles Completed(CompletionClaimed)
- both Executions share the same execution.sessionId
- Session entries include the ModelOutput + Observation from the tool turn
- Work lifecycle remains Open; no Verification row is created
- a WorkWait row exists between Yield and wake, then is cleared
- restart reuses the same Work and Session; no duplicate Execution
- every step is deterministic under the Fake Provider (no live network)
```

## 3. Non-slice directives (G3)

- A turn that emits `ProposeChildWorkspace` / `SpawnSpecialist` /
  `DeclareDependency` yields a `DirectiveUnsupported` Observation and the loop
  continues; the Execution is not failed and no `AuthorityDenied` is produced.

## 4. Restart-continuity acceptance (G5)

```text
- stop the runtime (dispose layers, close the DB)
- reconstruct against the same durable DB file
- assert: same Open Work, same primarySessionId, entries intact, loop resumes
```

- No mid-transaction crash injection (P9); this is the representative continuity
  proof.

## 5. Provider (G6)

- The acceptance suite runs against the deterministic Fake Provider.
- Real-provider dogfooding is optional and must not gate CI or P5 completion.

## 6. Must Not Decide

- No verification verdict / acceptance / CompleteWork (P8).
- No dependency coordination (P7).
- No multi-workspace formation (P6).
- No systematic fault injection (P9).
