# Windows native sandbox T3-C production-bound seam checkpoint

Date: 2026-10-19. Baseline: `5b0b4c024daadc96938bcbce8087c09eb46282b1`.
Implementation layer: `7737217a` (`planning/tasks/native-os-sandbox-windows-t3c.md`).
Status: fixed adapter-owned source/build evidence seam and reusable native
inspection tests landed; production execution remains unavailable. No V6
authority or `docs/design/**` modification was used.

## Fixed artifact boundary

The C# P/Invoke bridge source moved from test ownership to
`adapters/sandbox-windows/src/native/WindowsSandboxBridgeHarness.cs`. It remains
a qualification bridge with test commands, not an approved production runner.
The Windows adapter exports a read-only artifact contract that selects one
package source path, one Framework64 `csc.exe` path, and one package binary
path. It uses no PATH search, caller-selected executable, compiler fallback,
or production compile/spawn path. Package dry-run after build includes the C#
source and `dist/native-artifact.js`; there is no shipped EXE.

| Artifact evidence | Observed value |
|---|---|
| Adapter-owned C# source SHA-256 | `6a18eb4d3c64b48c771041c116704256c91a774fb66854a43f924598bde16366` |
| Host `Framework64/v4.0.30319/csc.exe` SHA-256 | `aae1db57f898ca8bda18590c56f86ced6d0ead80c22033b76fdfe9119706f116` |
| Two same-source/same-compiler/same-output-path diagnostic builds | `8f3d2a2fb6dfe59bc400a7589d2870e5e723611dfd328e70c084479b972ab117`, then `311c5372558a178a0066bb2c52325c8bb3402109bee689594191afe68d3f4db7` |

The two build digests differ; source/compiler hashes cannot stand in for the
actual shipped binary hash. The contract requires an operator binding of
source, compiler, argument template, binary, provider/version/capability,
Windows build, profile×network mode, enforcement rule set, exact six limits,
operator config, manifest and signature references. This adapter has no
signature/T3-manifest verifier. Even a synthetic byte-matched binding returns
`ObservedUnqualified`, never launch authority. With no package EXE, the
read-only inspection returns `NativeBinaryMissing` on this host.

`SandboxProcessPort.run` was not connected to the bridge. All Windows rows
remain Experimental with empty profile/network tuples and typed Unavailable;
even an injected probe where every Boolean prerequisite is true ends at
`NativeControlsUnqualified`. No TrustedLocal fallback exists.

## Handle-based root inspection and race counterexample

The fixed source adds a read-only native root inspector for disposable test
fixtures. It opens and holds each path component with
`FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, queries
`GetFinalPathNameByHandle` and file identity (`volume serial`, `file index`,
`link count`), compares the target's final path to the admitted root, and
rejects reparse points, multi-link files, outside-root targets, and Win32
query failures. A second handle-identity pass before return detects a path
that changed during inspection. Normal admitted file passes; junction,
hard-link, and outside-root fixtures reject in focused tests.

The concurrent replacement test disproved the initial lock assumption:
another Windows process renamed the target while the inspector held all
component handles without delete sharing. The final revalidation then returned
`Rejected/PathChangedDuringInspection`, as tested. This only detects the
observed inspection-window race. A mutation after final revalidation and
before any future process/effect remains unclosed. The inspector is not wired
to `run`, and its `AdmissibleSnapshot` result is not T3 admitted-root
authorization. A handle-relative effect path or equivalent lifetime-safe
primitive still needs implementation and qualification. This is recorded as
an implementation/evidence gap, not resolved by changing design semantics.

## Disabled network and other open controls

The T3-B native child still proves an AppContainer token with zero
`TokenCapabilities`; literal private and reserved-public connects returned
WSAEACCES 10013. A live loopback listener received no connection during the
bounded two-second attempt, which timed out without an explicit denial code.
That is insufficient to qualify exact Disabled direct-network denial. The
fixed seam does not supply a named-pipe broker, Restricted/Enabled DNS/IP
pinning and redirect controls, signed helper provenance, or a complete
process-lifetime filesystem boundary. Existing exact environment projection,
explicit output handles, Job Object limit readback, kill/cleanup, and ACL
restoration tests continue to run, but do not close those remaining controls.

## Verification

- Windows provider, artifact-contract, and native bridge tests: PASS, 17/17.
- Windows adapter architecture and package DAG tests: PASS, 15/15.
- `pnpm exec tsc -p adapters/sandbox-windows/tsconfig.json --noEmit`: PASS.
- `pnpm --filter @arbor/sandbox-windows build`: PASS.
- Targeted Biome check: PASS.
- `npm pack --dry-run --json`: PASS; source and compiled contract included,
  no binary artifact included.
- `git diff --check`: PASS.

No full-suite, operator T3 manifest, Supported tuple, production process,
online endpoint, or release qualification is claimed.
