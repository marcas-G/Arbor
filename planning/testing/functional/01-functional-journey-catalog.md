# Arbor Functional Journey Catalog

## Implemented

| ID | User journey | Driver | Pass oracle |
|---|---|---|---|
| F01 | create Project and see responsibility tree | public HTTP | tree contains root/child projections |
| F02 | greet Root Workspace and receive answer | public HTTP | authoritative transcript contains both turns |
| F03 | natural-language goal pauses for exact approval | public HTTP | Inbox exposes approval; Current Work remains empty |
| F04 | approve goal and observe Work | public HTTP | Current Work exposes Open Work and objective |
| F05 | claim, independently verify, accept and complete | public HTTP | PASS evidence; completion only after Acceptance |
| F06 | hard restart after completion | public HTTP | state preserved; provider call count unchanged |
| F07 | apply a user steer | public HTTP | public command commits |
| F08 | create Project and chat as a browser user | Playwright | visible authoritative Human/Arbor turns |
| F09 | browser reload after hard daemon restart | Playwright | same turns remain; no provider replay |
| F10 | reject approval | public HTTP | no Work; visible rejection/correction |
| F11 | provider unavailable then recover | public HTTP | one answer after bounded retry; no duplicate |
| F12 | Verification Fail | public HTTP | Work remains Open; evidence and Fail visible |
| F13 | Verification Unknown | public HTTP | Work remains Open; no Acceptance/Completion |
| F14 | browser approval flow | Playwright | approve exact action without copying an ID |
| F15 | browser Work completion flow | Playwright | PASS appears as acceptance item; completion follows user acceptance |
| F16 | crash after provider wire completion | public process | one visible answer after restart; safe bounded provider retry |
| F17 | long conversation pagination | public HTTP | third page reachable with no duplicate turns |
| F18 | child Workspace proposal/approval/result | public HTTP | child initial Work PASS is parent-accepted and completed |
| F19 | Dependency/Deliverable workflow | public HTTP | tool Artifact → Produce → Deliver → deterministic Satisfied |

## Next release-blocking journeys

| ID | User journey | Required oracle |
|---|---|---|
| F20 | fresh packaged checkout | install, build, start and F01/F02 from committed artifact |
| F21 | UI-created Project receives an executable boundary | evidence-based Work completes without hidden API setup |

## Definition of done for each journey

1. A user-observable Given/When/Then contract exists first.
2. The test owns a fresh isolated environment.
3. No forbidden internal oracle is imported or queried.
4. Failure emits bounded diagnostics and retains a trace where applicable.
5. The case passes alone and in the release-functional batch with zero retry.
6. A known product defect makes the case fail before the fix.
