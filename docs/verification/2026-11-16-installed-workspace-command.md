# Installed Workspace authorization and command delivery — 2026-11-16

Status: OPEN. The installed producer command/file/build/test/HTTPS path has
passed with a real model. Independent native verification, final Acceptance,
two-Workspace isolation and the complete installed stop/recovery journey have
not passed. Earlier failures below remain historical evidence.

## Latest real command and recovery observations

Producer package:

- Archive: `/home/lgao/.local/share/Arbor/release-preview-builds/workspace-qualification-evidence-fixed-20261116/arbor-0.0.0-preview-c283c8709076-7166d262-linux-x64.tar.gz`.
- SHA-256: `b0fafd1a0d3d323cd1360e5801987f2c69c5a74bbfed5f47c913bc6232bfca74`.
- Build ID: `sha256:c283c8709076bb3b94fc61001ca1f980115366afc1538b4db4e295779f3445da`.
- External model: `gpt-6.1-sol`; no fake Provider or test-only command capability.
- Installation/data: `/home/lgao/.local/share/arbor-authority-real-WHayxB`.

Ordinary installation and browser actions configured the model, reloaded the
daemon, selected a Chinese/space-containing project path, approved Work and
authorized its environment/file/command capabilities. Durable P4 observations
show the initial `npm test` failed with `-1 !== 5`, patch changed subtraction to
addition, then `npm run build` and `npm test` each exited 0 (one test passed).
`curl -I --max-time 15 https://example.com` exited 0 with HTTP 200. Host inspection
after normal stop/start retained the changed `index.js`; the other three project
files match their fixture content. Host inspection is diagnostic evidence, not
a substitute for Arbor's independent Verification.

Work revision 3 settled `CompletionClaimed`. Verification
`ver_df893549-a600-7ca1-8e2e-2143a433d11e` remained Open with no evidence or verdict.
Its execution `exe_5ce48031-126b-74cc-8325-93e55534f8ed` read files, then attempted
`shell`. The executable adapter had no supported policy binding for an
ExecutionBound Verifier and returned a policy interruption before creating any
durable P4 policy request. Repeated redispatch reached `RuntimeSafetyStop`.
There was no independent test execution and no Acceptance.

That legitimate ExecutionBoundEpisode safety-stop also broke project Attention:
`projection/unavailable`, `RuntimeSafetyEnvelope`, `EpisodeVersionUnsupported`.
The P10 fix validates the canonical `execution_bound` kind and exact execution
identity, keeping workspace-scoped Attention without inventing a Work binding.
Unknown, malformed, mismatched or Work-joined identities still fail closed.
Its source ownership is P10 `02`'s existing safety-stop mapping and P8 `02`'s
execution-bound Verifier, so this is an implementation correction, not a new
Workspace episode or sandbox permission.

Recovery package `0eb639331a31` (SHA-256
`6956347e63864debd531fd4f29f92f98f8c89df161ec468780d53f3589b809df`)
was extracted separately and started with ordinary `bin/arbor` on the unchanged,
disposable acceptance database. Browser Work, queue and Attention became live;
Attention showed both the safety-stop and VerifierOrphan. No database repair or
business mutation was used to repair the view. This is a two-build recovery
check, not a same-package complete journey or preserved-user upgrade promise.

During diagnosis two public browser Steers advanced Work revision 3 → 4 → 5.
Both committed, but the revision-3 `VerificationChanged` self-wait remained and
blocked dispatch even after restart. They are failed recovery attempts, not
successful resumption. P8 `03` already requires old waits to expire after revision
advance while old Verification remains immutable. The wake sink now releases
only an obsolete self-verification wait for the explicitly targeted Work during
an unconsumed human Steer wake. Same/future revisions, other Works, generic input
and consumed corrections cannot clear it. The failing reproduction and corrected
23-test batch are retained. Package `06193bb2acc3` (archive SHA-256
`93ea8f75c7a02c85bd6186c55b3d6d808a905680fa58e58d0111441bf54e5ebc`)
then resumed the unchanged disposable database through ordinary `bin/arbor`.
A public browser Steer advanced revision 5 → 6, cleared the obsolete wait,
and admitted `exe_07b75674-cb34-78a0-8ed6-1da65e03a23f` with a policy and
a new exact command approval. No approval was made in that continuation;
Verification/Acceptance remain incomplete. `wake-recovery-result.json` and
`wake-recovery-stable.json` plus screenshots record this third-build recovery
check. Three packages must not be combined into one complete journey.

The unsupported execution-bound shell path now gives the model a typed
`action/tool-unavailable` rejection instead of a nonexistent pending request.
It reports that no command ran and tells the model to use available observations
and Unknown for unverified criteria. This avoids the phantom wait; it does not
implement native Verifier commands or qualify independent testing.

Evidence: `.test-results/workspace-qualification-evidence-fixed-20261116/`,
including `native-command-observed.json` (read-only SQLite diagnostic export),
`recovery-result.json`, and public-page screenshots. The original setup
`result.json` records setup-stage success only; it is not final task success.

New checks: Attention 3 files/32 passed; executable adapter 1 file/12 passed;
wake/verification 3 files/23 passed (the new stale case first failed). The
consolidated `pnpm check` failed in core batch 15/51 because the P14 tool
allowlist omitted the already registered `allocate_workspace_sandbox`. That
assertion was corrected and its file passed 2/2; the full check was not rerun
to completion and its Web stages did not run. Final root TypeScript and lint
(1532 files) passed before the input-copy component was added. The latter
component and recovery batch subsequently passed 4 files/45 tests and root
TypeScript. No final complete check or release-functional pass is claimed.

The public queue rendered command and cwd as `[redacted]` but still offered
Approve. This is not evidence of a usable exact-action review; see KP-018.
The owner has now accepted the fixed temporary-copy proposal; exact design
landing and implementation boundaries are recorded in the linked decision and
`docs/verification/2026-11-16-verification-input-copy.md`. Native verifier
execution is still not connected.

## Product rules and implementation

The human's decision is persistent: a revoked Child cannot be reauthorized by
Parent. Only explicit human authorization clears that head. Parent can explicitly
allocate within its own current ceiling to a direct Child, without sharing files
or creating another human role. Task/restart boundaries do not expire standing
grants.

`allocate_workspace_sandbox` now decodes to `AllocateWorkspaceSandbox`; the
production handler resolves an opaque direct-Child ref, binds identity/provider/
revisions, and uses the existing Gateway. Gateway owns the transactional Parent
ceiling and human-revocation gate. Receipt-first replay reports a prior effect
before resolving a possibly stale Child ref; it never overwrites a newer human
revocation. New calls still check the current Child and current authorization.

The real SQLite/Gateway integration covers allocation, reopen, human revoke,
old-success replay with a stale ref, rejection of a new call even with a fresh
ref while revoked, and human restoration followed by allocation. The model
surface is present in RootConversation/Work/Inbox and absent from Decision,
Verifier and historical Specialist profiles. This is bounded integration
qualification, not proof of real-model multi-Workspace delivery.

## Installed failures found and corrected

1. Linux qualification produced a V2 authority bundle, but the Linux preparation
   selector incorrectly required V3 (the Windows signed trust format). Removed
   only that Linux V3 check; duplicate exact tuples still reject. Windows checks
   retain their V3 requirement.
2. Daemon failure raced against a pending restart using `Effect.race`, which waits
   for success and concealed the failure. `Effect.raceFirst` now propagates and
   logs the actual daemon failure.
3. The shell adapter returned a policy interruption before P4 persisted its
   intent/requirement. The scheduler repeated the same action until a safety
   stop. The adapter now delegates policy waiting to P4 after invoking Binder.
   Its orchestration test proves delegation, not durable persistence by a mock.
4. A new source-free package passed ordinary Linux first installation, real
   browser model setup/automatic reload, private credential checks, Chinese and
   space-containing project paths, task approval and browser environment
   authorization. It then exited on strict policy-store input validation.
   Diagnostic capture identified an unprefixed UUID-v4 `decisionCommandId` from
   the production IdGenerator, whereas the test fixture supplied an already
   valid CommandId. Binder now creates a validated prefixed UUID-v7 CommandId
   using the existing `newUuid7` utility and generator entropy. A regression uses
   the real production generator. Strict persistence validation remains intact.

5. After the command-id correction, the same package reached a real Work. The first
Provider tool turn succeeded, but the next Provider turn ended with incomplete
terminal failure evidence (`SourceProviderAttemptMismatch`). The readmission gate
correctly held the Work, but the scheduler incorrectly propagated that hold as a
daemon-fatal error, preventing the public SteerWork recovery action. The runnable
source now treats this integrity hold as a durable blocked Work while leaving the
daemon available for inspection and a new Work revision. The correction is tested
against the P5/P7 classification suites; a new package and browser continuation are still required. The next browser run
then reached and approved the real `npm test`, but the installed provider was
rejected as `QualificationEvidenceMismatch`: the policy compared the
operator-issued `blob:sha256:` tuple evidence with the separate current-host
`sha256:` prerequisite probe fingerprint. The resolver now checks the tuple
qualification evidence and retains the probe fingerprint only as diagnostic
context; domain/tool/native-posix coverage is 146 passed, 6 skipped, and root
TypeScript passes. A new package is required to qualify this correction.

The failure evidence is retained at
`.test-results/workspace-auth-native-final-20261116/`, daemon log
`/home/lgao/.local/share/arbor-authority-real-6rVaCl/data/arbor-45481.log`, and
`/tmp/arbor-policy-input-diagnostic.log`. The diagnostic temporarily instrumented
an extracted disposable package and invoked its exported daemon directly; its
original file bytes were restored. That invocation is diagnosis only and is
excluded from ordinary-product acceptance evidence.

## Checks and package identity

- Control profile/decoder, authorization integration, executable identity and
  preparation: 5 files, 48 passed, 2 Windows-only skips.
- Binder with real IdGenerator plus SQLite policy store: 2 files, 19 passed.
- Root TypeScript check after these changes: exit 0.
- Readmission/runnable classification: 2 files, 11 passed; confirms incomplete
  terminal Provider evidence holds the Work without terminating the scheduler.
- Earlier root lint: 1532 files; architecture: 38 files / 199 passed. These predate
  the CommandId correction; no final full `pnpm check` success is claimed. An
  earlier full run failed four outdated Workspace fixtures, subsequently fixed
  and checked in their two files. Earlier release-functional failure remains
  recorded in CURRENT_STATE.

Failed package SHA-256:
`9bdbc3fd0edfd8b2585a4ad8aa0ae605b8dd7681e3314febadf5541a1bdce88a`.

New package SHA-256:
`c7f0bfc0f20675359e558e292146d54e728fc83f5b8cd72fd32a8c764aace65f`.
Build ID:
`sha256:e356417bb981488746297bf8e7a70c1401dc0e62c3afdb0d81da9197e94cb367`.
Archive:
`/home/lgao/.local/share/Arbor/release-preview-builds/workspace-command-id-fixed-20261116/arbor-0.0.0-preview-e356417bb981-7166d262-linux-x64.tar.gz`.
It remains `releaseQualified: false`.

Ordinary fresh installation/browser verification of the new package is running
under `.test-results/workspace-command-id-fixed-20261116/`. Its result must be
recorded before making any native command success claim. Same-package public
permissions, actual file changes/build/test/network, stop/restart, two Workspace
isolation, independent Verification and human Acceptance remain required.
