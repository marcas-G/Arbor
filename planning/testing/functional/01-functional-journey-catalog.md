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

## Next release-blocking journeys

| ID | User journey | Required oracle |
|---|---|---|
| F10 | reject approval | no Work; visible rejection/correction |
| F11 | provider unavailable then recover | visible retry/attention; no duplicate answer |
| F12 | Verification Fail | Work remains Open; failure summary visible |
| F13 | Verification Unknown | no Acceptance/Completion; uncertainty visible |
| F14 | browser approval flow | user can inspect and approve without copying an ID |
| F15 | browser Work completion flow | status visibly traverses Open → Verified → Completed |
| F16 | crash after provider success before presentation | one answer after restart; no provider replay |
| F17 | long conversation pagination | third historical page reachable with no duplicates |
| F18 | child Workspace proposal/approval/result | organization change and result visible end to end |
| F19 | Dependency/Deliverable workflow | consumer visibly wakes only after deterministic match |
| F20 | fresh packaged checkout | install, build, start and F01/F02 from committed artifact |

## Definition of done for each journey

1. A user-observable Given/When/Then contract exists first.
2. The test owns a fresh isolated environment.
3. No forbidden internal oracle is imported or queried.
4. Failure emits bounded diagnostics and retains a trace where applicable.
5. The case passes alone and in the release-functional batch with zero retry.
6. A known product defect makes the case fail before the fix.
