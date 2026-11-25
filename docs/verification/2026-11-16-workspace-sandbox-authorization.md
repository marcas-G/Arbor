# Workspace sandbox authorization foundations

Date: 2026-11-16  
Baseline: `e7065a7c` plus the existing dirty worktree and this continuation.  
Status: domain/storage/Gateway qualification only; delivery goal remains active.

Subsequent production integration supersedes the staged status below. See
`docs/verification/2026-11-16-workspace-production-integration.md` for current
schema57, production/UI/admission work and its remaining acceptance limits.
The checks below remain evidence of their original checkpoint.

## Accepted behavior and implemented boundary

Persistent Workspace authorization and bounded explicit direct-Parent allocation
were already accepted. The owner additionally confirmed that a user's Child
revocation can only be cleared by a new human authorization. Parent permission
does not entitle it to regrant after that revocation. Q-018 records this resolved
product decision.

Implemented in this continuation:

- Strict version1 Granted/Revoked Workspace facts, canonical encoding, and pure
  resolution over complete current source chains. Each head binds resource and
  policy revision, not the task-changing general Workspace revision.
- Transaction-bound source-chain loading through Workspace/store ports.
- Staged immutable SQLite ledger with exact-successor, same-Project Parent,
  predecessor and deferred command foreign keys. The adapter checks canonical
  facts against complete exact committed receipt results; corruption is not
  treated as an absent grant.
- Staged `AuthorizeWorkspaceSandbox` and
  `RevokeWorkspaceSandboxAuthorization` Gateway handlers, exact resolver
  authority, transactional rereads, trusted time and one version1 change event.
  Parent allocation must still fit the current complete source ceiling, and a
  current human Revoked head rejects freshly resolved Parent requests too.
- Optional internal schema1 receipt decoders with exact Project/Command binding.

## Verification

Final concentrated run, exit 0: **6 files / 86 tests passed**:

```sh
pnpm exec vitest run \
  packages/domain/test/workspace-sandbox-authorization.test.ts \
  tests/workspace-sandbox-authorization.test.ts \
  packages/application/test/command-result-codec.test.ts \
  packages/application/test/p1-gateway.test.ts \
  packages/application/test/workspace-permission-continuity.test.ts \
  tests/workspace-permission-durability.test.ts
```

The new tests exercise multilevel source chains; missing/ambiguous/foreign
sources; retirement, reparenting, cycles, expiry and resource/policy invalidation;
write/provider/network/lifetime ceilings; receipt and fact equality; reopening,
idempotent command replay and general Workspace revision continuity; originating
Parent Execution settlement; human Child revocation across reopened connections;
fresh Parent regrant denial and explicit human recovery; stale source/target CAS;
Parent fencing rejection; independent SQLite connection replacement competition;
immutable history; malformed/foreign/unknown receipt corruption; typed stale
append; and rollback without the required deferred receipt.

Additional checks:

- `pnpm typecheck`: exit 0, including source build and test typecheck.
- `pnpm lint`: exit 0, 1523 files checked, no fixes.
- `pnpm architecture`: exit 0, 38 files / 199 tests. This ran after the structural
  additions and before the subsequent bounded human-revocation guard/test change.
- `node scripts/testing/check-manifest.mjs`: exit 0, `ok: true`.

No final full `pnpm check`, complete functional batch, Web/browser or installed
real-provider command journey was run in this continuation. The Parent fence
case injects a Gateway fence verdict; it does not qualify real native lease or
OS-process crash competition. Connection reopening is not process-kill evidence.

## Governance landing and self-review

The accepted product decisions are recorded in
`docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md`.
The exact engineering package is
`docs/proposals/2026-11-16-workspace-authorization-commands-and-revocation.md`,
SHA-256 `07e2552d26ff41a1b23df398260cda6752c81f4fe0fe5f275eda54f291e65e7c`.
The preceding immutable storage package remains
`3beeec1c67f3b4013431f9971d5dee562294a218a9a00032c62e77de9129d21c`.

Owning documents have dated supplements with the product authority and exact
package hash. Post-landing file hashes:

| Owner | SHA-256 |
|---|---|
| Scenarios | `239483dc874c181a641cee2ad20c111cca18d5e68007667849b456e8f97a8877` |
| System Design | `ef73dcb9f7df769eb2a83337205bd660ac238c8e5a0d515efee5dcc1796bcaa9` |
| Detailed Implementation Design | `f9046b97a8fe13b5d3932ff00fab42d637471defb5575653f868799c883e6f47` |
| P12/02 Authority Resolver | `e12e03b81028ced834116086e356ba422cb95fd0b0f5a8a40ad035c49525dd4e` |
| P4/03 Authority/Permission/Approval | `2e91d1a4b6bdf31b738f4b6200aeca9082c0cc94c0f9508ad09bda56fb1999d1` |
| P1/02 Ports | `d9468a3d90f552d8d48bfa01bddec458bf712beb3a0304f2815a239f04dab61c` |
| P1/04 SQLite Schema | `f4b67729fa2b46c44f1800d42eb389130c9d710a458182ba72771f2755ecc8f9` |

Self-review checked the accepted behavior, owner separation, current runtime
version and staging claims against the code and maintained health documents.
This is not an independent Agent review or formal release closure.

## Remaining delivery work

Runtime remains **schema56**. The schema57 migration descriptor is not registered
in `CURRENT_MIGRATIONS`; the new handlers are not external wire commands or
ordinary production handlers. No preserved user database has been upgraded.

The old Native two-human `DecideSandboxPolicy` path still blocks delivery. The
next integrated batch must replace that authority source while preserving
historical grant/provenance and inbound provider-unavailable foreign keys, bind
fresh exact Execution/Episode policy from current Workspace authority, integrate
migration tooling/signatures/manifest/maintenance, and connect ordinary UI,
revocation and restart. The resulting source-free Linux package must then pass
the active real-model/browser file/command/network/isolation/recovery journey.
These layer checks cannot substitute for it.
