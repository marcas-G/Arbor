# AH7 Same-holder Owner Decision Record

Date: 2026-10-12  
Decision source: user's structured reply to proposal SHA-256
`FBCBAB1D2A3EE245A8561C683C460EF8F7329DC72A47D3AAC92B18C564ADBB76`.  
Record status: **Decision captured; exact landing package drafted; independent review and user confirmation of that package remain.**

## Question put to the owner

The accepted proposal asks whether two concurrent `ToolRuntimePort.invoke`
callers for the same `(ExecutionId, ToolInvocationId)` may be supported when
they carry an identical active P2 lease-holder tuple
`(workerId, workerIncarnationId, generation)`. If supported, P4 needs an
invocation-level owner/wait rule so an in-flight loser cannot persist terminal
`OutcomeUnknown` before the active effect owner settles. If unsupported,
production invocation remains one P2-authorized Worker with serial AgentLoop
action dispatch; the cloned-holder process case remains a strict pending
diagnostic until a real LeaseService G0→G1 takeover qualification passes and
the default-suite disposition is authorized.

## Owner response

**Accepted selection: Option C/B — “不支持复制身份（推荐）：生产坚持单 Worker 串行；保留原严格红测作待治理诊断，补真实租约接管资格后才调整默认门禁。”**

The selection is bound to the fixed proposal SHA-256 above. It accepts the
unsupported-cloned-holder boundary and directs a real generation-takeover
qualification before any default-gate change. It does not accept or authorize
an invocation-owner schema/migration, a production-code change, weakening the
strict oracle, or changing the test's current default status before that
qualification.

## Landing audit

The current DRAFT captures the chosen behavior, but it does not contain an
exact frozen-document landing package (owning paths, exact accepted text,
resulting revisions, and post-landing consistency criteria). The existing
P2 `03` / P4 `02` / P4 `06` clauses specify the lease tuple, effect admission,
current-fence settlement and NonIdempotent recovery, but do not explicitly
state the accepted same-holder-overlap boundary. Therefore no
`docs/design/**` edit is made under this decision record. A fixed owner-document
landing package must be prepared and accepted before those contracts are
changed.

## Qualification prerequisite and status

The accepted response requires real P2 LeaseService generation-0 / generation-1
takeover evidence before moving the cloned-holder strict test out of the
default gate. The reviewed AH7 same-holder focused stress (5/5) does not satisfy
this prerequisite. The static coverage audit found the following existing
process qualifications:

- `tests/functional/process/p4-ah7-live-lease-acquisition.functional.test.ts`
  uses two production daemons and the real runExecution/LeaseService path to
  prove a second daemon cannot acquire or begin P4 while G0 holds a live lease.
- `tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts`
  (qualification record baseline `7ac041a`)
  uses two production daemons. G0 passes P4 effect admission and writes one
  real shell marker, then pauses before settlement. After G0 renewal is paused,
  the isolated DB's expiry timestamp is advanced to the past; G1 obtains
  generation 1 through the real LeaseService path and does not replay the
  effect. When G0 resumes, its late P4 settlement is fenced. G1 then converges
  the invocation and Execution to `OutcomeUnknown`, with no successful
  ToolResult/Observation. The recorded process case passed 1/1.

The generation acquisition, two daemons, post-effect pause, late stale write,
no-replay result and `OutcomeUnknown` all use production runtime paths. For the
accepted replacement oracle, the existing P4 process qualification is
sufficient: the test exercises an actual G0 holder, an actual G1
`LeaseService.acquire`, a post-admission external effect, no G1 executor replay,
the late G0 fence rejection, and the resulting P4 `OutcomeUnknown`. It does
**not** wait for natural TTL passage: it fast-forwards the expiry timestamp in
the isolated fixture DB before G1's real acquisition. P2 defines the lease
predicate as `expires_at <= now`; the user response did not require a
wall-clock TTL wait. The live-lease process qualification separately proves
that a second daemon cannot acquire while G0's lease is live.

The qualification prerequisite is therefore satisfied by existing recorded
evidence; no additional process source is required for this accepted
replacement oracle. The default clone-holder test remains unchanged until the
owning-document landing package is independently reviewed and confirmed.

## Owning-document landing state

The accepted proposal did not contain exact owning-document paths, landing
text, or baseline owner hashes. No `docs/design/**` file has been changed. The
exact candidate package is now recorded at
`planning/proposals/AH7-same-holder-owner-boundary-design-landing-draft.md`.
It is a separate DRAFT and requires independent review and explicit user
confirmation of its own SHA-256 before landing. The prior owner-decision
response is not represented as acceptance of wording that was not shown to
the user.

