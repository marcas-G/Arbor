# Workspace authority: production integration checkpoint

Date: 2026-11-16  
Baseline: `e7065a7c` plus the existing dirty worktree. Delivery goal remains active.

## Implemented behavior

- Runtime schema57 and its fresh initialization, disposable copy/resume upgrader,
  signatures, descriptor pins, manifest transitions, maintenance terminal and
  current-schema fixtures are integrated. Historical schema56 descriptors,
  signatures and source-preservation assertions remain intact. No preserved user
  database was upgraded; preserved upgrades remain unsupported.
- Production always provides the authorization store and internal policy binder.
  Binding runs before the shared execution recovery gates and before shell
  materialization. Non-Ready outcomes cannot reach the shell runtime. A policy
  revision carrying a provider-unavailable fact must be renewed rather than
  reused just because its host and resource snapshots match.
- Public Human authorize/revoke commands and contextual browser authorization
  use one local human. Authorization defaults to persistent and supports finite
  expiry. External Parent source is rejected; the typed internal Gateway decoder
  accepts it only for subsequent authority resolution and transactional checks.
  The Binder remains internal and is absent from the Web command catalog.
- Modern policy reads and use validate the complete current source chain.
  File tool authority respects an existing authorization's ReadOnly or Revoked
  ceiling even if legacy grants would otherwise permit writing. Before any
  sandbox choice exists, existing file grants retain their compatibility path.
- InvocationAuthority carries current head and scope sources as an internal
  token. SQLite effect admission rereads those sources in its transaction;
  intervening revocation, network restriction or Parent/scope change rejects the
  stale effect. Process policy provenance must also match the authorization
  revision resolved for admission. Admission uses fresh trusted time.
- An explicit fresh ARBOR_CONFIG location no longer falls back to another
  configuration's model/runtime mode. Installed first-run verification exposed
  this: the first attempt unexpectedly entered the workbench using a default
  host config instead of displaying setup. The failed attempt is retained.

## Verified checkpoints

These are different bounded batches, not additive release coverage:

| Check | Result | Scope |
| --- | --- | --- |
| Upgrader, runtime startup, Binder | 3 files; 52 passed, 6 skipped | Includes schema56→57 commit-before/after interruption, source unchanged, resume and final read-only no-op; production services exist |
| Original runtime integration | 10 files; 114 passed, 2 Windows skips | Before later wire/admission changes |
| Public codec, receipt codec, authorization/Gateway | 3 files; 63 passed | Includes production Layer human authorize/reopen/revoke/recover; external Parent spoofing denied |
| Web | 40 files; 298 passed; typecheck/build exit0 | Contextual form, retries, revocation without candidates, command inventory; no native execution claim |
| Authorization/admission plus actual filesystem runtime | 2 files; 27 passed | New resolved-write→revoke→admit denial; ReadOnly write denied, read retained; network restriction and Parent source changes; existing filesystem effects |
| P4 pipeline | 89 passed | Includes unexpired old-authorization process policy; zero effect admissions, provider runs or terminal settlements |
| Production startup/provider/Binder | 3 files; 49 passed | Before the additional unavailable-policy renewal regression |
| Binder including unavailable-policy renewal | 11 passed | Transparent transaction/host/Gateway orchestration fixtures; not native OS proof |

Root lint/typecheck/architecture passed at intermediate checkpoints (architecture
38 files/199 tests). A final integrated batch is in progress; it is not yet a
full `pnpm check` or release-functional success claim.

## Failures and corrections

1. Public Authorize envelope validation accidentally selected SteerWork rules.
   The Gateway also reused public Human-only payload validation for internal
   Parent commands. Separated decoders retain the Human-only public restriction;
   the three-file rerun passed all 63 cases.
2. Expanded schema checks exposed obsolete current-head suffix, column and FK
   assertions in older migration tests. Updated only current-head expectations,
   retaining frozen predecessor and historical migration assertions. Initial
   full checks stopped at these failures; they are not recorded as green.
3. Independent static review identified missing file ceilings and a stale shell
   effect-admission interleaving. Added use-time checks and real-SQLite
   qualification. The reviewer's original recovery-ordering concern was retracted
   after reading the shared runExecution entry; its narrower unavailable-revision
   reuse concern was confirmed and corrected.
4. The first stale-policy pipeline test used an absent Episode and a mismatched
   control digest, so it was denied before exercising the intended gate. Corrected
   the fixture's exact Episode/approval authority; the full pipeline rerun passed.
5. Fresh installed browser verification initially inherited the host's default
   config despite selecting an explicit new config file. Corrected discovery and
   retained the first failure; a new source-free package is being verified.

## Remaining product delivery

The Parent allocation model catalog, typed AgentAction, shared authorization and
production Gateway route are now implemented. Real SQLite/Gateway qualification
covers revocation across reopen, rejection of a new allocation against a fresh
Child ref while revoked, explicit human restoration, and historical receipt
replay without new permission. A real model-driven two-Workspace journey remains
open. See `2026-11-16-installed-workspace-command.md` for installed failures and
subsequent corrections; catalog presence is not native execution evidence.

Same-package real-model/browser command/build/test, network, two-Workspace
isolation, stop/restart, independent Verification and human Acceptance remain
open. Revocation tests here concern admission of new effects; they do not prove
forced cancellation of a process already admitted. Full functional/package
checks and a clean Linux installation beyond the current host remain separate.

Accepted product decisions and fixed proposal hashes remain recorded in
`docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md`. No new design
semantics or historical proposal/evidence bytes were rewritten in this increment.
