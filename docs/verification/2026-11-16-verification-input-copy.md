# Independent verification input capture — 2026-11-16

Status: component implemented and tested; not connected to production verifier
commands, policy persistence or native qualification. The release goal remains OPEN.

Authority: accepted fixed proposal SHA-256
`a6e85e9e15301cbc377f3468d5bfca706cf3019e42bc28fe712a1947a0d6108d`;
decision and exact design landing review are in the same-date decision/review documents.

## Component behavior

`adapters/sandbox-local/src/verification-input-copy.ts` prepares one already
admitted Linux file-tree root in a separate caller-owned private runtime root.
It captures actual files, including untracked/uncommitted content, and safe
relative symlinks; no Git HEAD substitution, hard links to producer bytes or
implicit exclusions are used. Absolute/escaping/cyclic symlinks and special
files such as sockets cause visible failure and cleanup.

Directory/file reads use Linux descriptor-anchored paths and O_NOFOLLOW, so
replacing a traversed parent with a symlink cannot redirect the next read.
Regular files are copied with Node copyFile/reflink support. A second complete
content/metadata scan must agree; observed changes fail rather than publish a
mixed candidate. Resource limits and cancellation fail with sanitized codes.
Links are materialized only after file writes. The returned handle disposes
only its own ephemeral directory and leaves source bytes untouched.

The manifest includes exact Verification/Execution/Project/Workspace/Work revision
and relative input entries with content hashes, not host paths or file contents.
It is an evidence candidate, not a new public/durable policy contract.

## Checks

- New real-filesystem tests: 9 passed. Includes independent copy writes and
  generated build files, uncommitted content, safe/dangling relative links,
  direct and chained escapes, real pathname socket rejection, size limits,
  concurrent source mutation, cancellation and private/non-overlapping roots.
- Batched copy + executable invocation + Attention + wake regression:
  4 files / 45 passed. Log: `/tmp/arbor-verifier-copy-recovery-batch-20261116.log`.
- Root `pnpm typecheck`: exit 0 after the new component.
  Log: `/tmp/arbor-verification-input-typecheck-20261116.log`.
- Root `pnpm lint`: exit 0, 1534 files.
  Log: `/tmp/arbor-verification-input-lint-20261116.log`.

The first typecheck caught a TypeScript control-flow narrowing issue in the
throw helper; it was corrected before the final passing run. No complete
`pnpm check`, release-functional or installed verifier command success is claimed.

## Required next integration

The caller must obtain and recheck exact admitted regions, source ownership,
Verification target revision and current Workspace authorization; this helper
is not an authority resolver and does not interpret exclusion/ownership policy.
Each source root must be fully authorized; it must not be a broader Parent tree
containing inaccessible Child regions. Input consistency checks are not atomic
filesystem snapshots or proof that source remains unchanged after capture.

Production still needs a separately versioned exact verification policy/binding,
current authority/withdrawal checks at effect admission, durable input evidence
and recovery identity, safe temporary-root mounting through P4, actual provider
qualification for that mount combination, and cleanup after conclusion/stop/failure.
No process is spawned by the helper; no tests or shell commands bypass P4.
Finally one package must complete the full real-model browser journey through
independent native verification and human Acceptance.

## Trusted preparation and current-source recheck supplement

`apps/single-workspace/src/verification-command-environment.ts` now composes
the existing canonical repositories, complete Workspace authorization-chain
loader, boundary producer and current host source with input capture.

Preparation requires an active, unstopped canonical execution-bound verifier,
an exact Open Verification owner/execution binding and the same current Open
Work revision. Mission text cannot manufacture a verifier role. Source mounts
are read-only; only the physically separate copies are marked writable.
The candidate native tuple uses WorkspaceWrite for temporary outputs without
granted write access to the original. A generic Supported WorkspaceWrite row
is a prerequisite candidate, never new verification mount qualification.

Preparation compares the complete authority/resource/provider basis again
after capture. It rejects broad trees containing active delegated exclusions
until segmented capture is implemented; it does not silently copy the excluded
child or omit files. Before admission, revalidation rereads complete current
Parent/Child source chains, Work/Verification identity, source directory identity
and full source content/metadata, then rereads canonical authority again.
Revocation, reauthorization with a new revision, changed inputs, retired or
retargeted records, stale task versions and changed host/bundle basis invalidate
the prior candidate. This is still observation, not an atomic filesystem lock.

Preparation requires an Effect Scope. Scope closure releases successful
captures; failed/interrupted preparations release partial captures. Cancellation
of an in-flight capture aborts and joins the real promise's cleanup. This avoids
returning from stop while that promise can still create a forgotten copy.
Explicit disposal remains idempotent and invalidates later revalidation.

Checks after this supplement:

- Preparation 10, input-copy 9, existing Workspace Binder 12: 3 files/31 passed.
  Log: `/tmp/arbor-verification-environment-final-20261116.log`.
- Root typecheck exit 0: `/tmp/arbor-verification-environment-typecheck-20261116.log`.
- Root lint exit 0, 1536 files: `/tmp/arbor-verification-environment-lint-20261116.log`.

These are real-filesystem and trusted-record orchestration checks. The new
preparation tests use repository fixtures; they are not SQLite transactional
qualification, fake business Provider acceptance or actual native process proof.
There is no registration in the ordinary daemon yet. Separate versioned policy
persistence, native mount qualification, P4 wiring, durable evidence retention,
command/stop/restart and same-package real-model acceptance remain required.

## Recovery demo shutdown

The third-package disposable demo was stopped through ordinary `bin/arbor stop`
with its exact data directory and port 38231. Exit 0 reported Arbor stopped;
PID 1605861 was absent afterward. A read-only /proc scan found no live process
whose cwd or argument paths belonged to that acceptance instance. This is a
bounded shutdown observation, not proof of the future verifier-copy lifecycle.
The first stop invocation omitted the nondefault port and found no managed
instance; it sent no signal. The exact-port invocation performed the stop.
