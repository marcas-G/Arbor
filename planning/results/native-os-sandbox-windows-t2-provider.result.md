# Native OS Sandbox Windows T2 provider probe

**Status:** T2 identity/probe adapter complete; all three providers remain
Experimental and return typed Unavailable. T3 security/resource conformance is
not claimed. No `docs/design/**` files changed.

## Provider identities and disposition

| Provider ID | T2 disposition | Current unavailable reason |
|---|---|---|
| `windows-mxc` | Experimental, probe only | `MxcPrerequisitesUnverified` |
| `windows-elevated-dedicated-user` | Experimental, probe only | `ElevationNotVerified` in the shipped Node probe; the host-session probe confirmed this user is not elevated |
| `windows-restricted-appcontainer-job` | Experimental candidate | `NativeApiBridgeUnavailable`; no reviewed runner/broker applies the controls |

The new `@arbor/sandbox-windows` adapter registers the three exact identities
with `SandboxProcessPort`. Capability snapshots claim no profile and no
network mode. `run` always returns the port's typed `Unavailable` outcome and
does not import or invoke process/network spawn APIs. It does not fall back to
TrustedLocal. P5's composition injects this provider into the existing P4
ToolRuntime path.

## Current host probe

Probe date: 2026-10-19. Host: Windows 10 IoT Enterprise LTSC, version
`10.0.19044`, build `19044`, x64. The current user is not a member of the
elevated Administrators role.

| Probe | Result |
|---|---|
| Windows 10 SDK headers directory | Present at the standard Windows Kits 10 include root |
| .NET Framework C# compiler | Present (`Framework64\v4.0.30319\csc.exe`); compiler is not on PATH |
| Windows PowerShell / PowerShell 7 | Present |
| Native API export probe | Present for `CreateRestrictedToken`, `SetTokenInformation`, `CreateAppContainerProfile`, `DeriveAppContainerSidFromAppContainerName`, `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `CreateProcessAsUserW`, `CreateJobObjectW`, `SetInformationJobObject`, and `AssignProcessToJobObject` |
| Elevated dedicated identity | Not available in this session; the current token is not elevated and no dedicated-user runner is configured |
| Native implementation bridge in Arbor | Absent; the adapter cannot safely apply the available APIs |
| Named-pipe-only network broker | Absent / unqualified |
| Admitted-root ACL and reparse defenses | Not implemented or qualified |
| Job Object process, memory, and CPU limits | API exports exist; enforcement and cleanup are not implemented or qualified |

The export probe used a temporary in-memory C# P/Invoke declaration to inspect
OS symbol presence. It did not create a restricted token, AppContainer, Job
Object, broker, or user process. SDK/compiler/API presence is not control
enforcement evidence. A native helper or managed bridge would still need a
reviewed implementation and adversarial qualification before `run` can start
anything.

No T3 claim is made for exact admitted roots, low-integrity/AppContainer token
identity, control-database isolation, environment sentinel exclusion, direct
network denial, named-pipe broker mediation, DNS/IP pinning, redirects,
whole-tree cleanup, walltime/output/process/memory/CPU limits, or cooperative
Stop. These controls remain unavailable; no test represents them as passed.

## Verification

- `pnpm --filter @arbor/sandbox-windows build` — PASS.
- `pnpm exec vitest run adapters/sandbox-windows/test/windows-provider.test.ts` — PASS, 4/4. Covers exact distinct provider IDs, Experimental-only capability snapshots, no advertised profile/network mode, typed provider-specific Unavailable reasons, second admitted control-DB mount, and environment sentinel non-disclosure.
- `pnpm exec vitest run --config vitest.architecture.config.ts tests/architecture/native-os-sandbox-windows.test.ts tests/architecture/package-dag.test.ts` — PASS, 15/15. Covers composition registration, allowed package edge, and absence of arbitrary spawn imports/calls.
- `pnpm exec tsc -b apps/single-workspace` — PASS.
- Targeted TypeScript check of the two new test files — PASS.
- `pnpm exec biome check` on changed source/config/test files — PASS.
- Existing `apps/single-workspace/test/p5-composition.test.ts` was attempted separately and failed before assertions because its fixture rejects online upgrade from schema 48 to schema 50 (`database user_version 48 requires an offline upgrade to schema 50`). This failure is retained and is not counted as a pass.
- No full suite, database upgrade, deployment, or network access was run.
