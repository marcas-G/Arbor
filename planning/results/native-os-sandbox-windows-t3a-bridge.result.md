# Native OS Sandbox Windows T3-A test bridge checkpoint

Date: 2026-10-19. Baseline: `3953bde52d5eb36c0cac718017a08cf73fd7435e`.
Scope: test-only C# P/Invoke harness and Vitest qualification on the Windows
10.0.19044 x64 host. No production runner, provider capability, or design
contract was changed.

## Win32 203 diagnosis and environment projection

The initial bridge removed ambient variables from its own process and called
`CreateProcessAsUser` with a null environment pointer. The following repeated
single-variable trials used the same compiled bridge, child, AppContainer,
restricted-token setup, and explicit handle list:

| Retained variables beyond `PATH` | `CreateProcessAsUser` result |
|---|---|
| `SystemRoot` | Win32 203 (`ERROR_ENVVAR_NOT_FOUND`) |
| Each of `windir`, `SystemDrive`, `ComSpec`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `HOMEDRIVE`, `HOMEPATH`, `USERNAME`, `USERDOMAIN`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`, `PATHEXT`, `PSModulePath`, individually alongside `SystemRoot` | Win32 203 |
| `SystemRoot;LOCALAPPDATA` | Root exit 0 |
| `LOCALAPPDATA` alone | Root exit 0 |

The host's AppContainer process creation therefore requires `LOCALAPPDATA` in
this launch configuration. The checkpoint now allocates an explicit UTF-16LE,
double-NUL-terminated environment block containing exactly `LOCALAPPDATA`,
`PATH`, and `SystemRoot`, and supplies it with
`CREATE_UNICODE_ENVIRONMENT`. It no longer edits the bridge's ambient
environment. The effective child environment contained these three entries
plus `TEMP` and `TMP`; the ambient
`ARBOR_SANDBOX_SENTINEL` was absent. No ambient secret or arbitrary variable
is copied into the constructed block.

## Test-only control observations

The native child reported an AppContainer token, low integrity, the same user
SID as the bridge, at most one enabled privilege, membership in the Job Object,
valid stdout/stderr, and invalid stdin. The bridge provided an explicit
two-handle inheritance list. The token query
`IsTokenRestricted` returned 0 on this host; this checkpoint does not treat
that query as proof of a restricted token. The bridge calls
`CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE | LUA_TOKEN` and aborts if
that call fails. Profile creation and deletion failures abort the test bridge.

The focused tests also observed Job Object descendant containment,
active-process limit rejection, kill-on-close, walltime and stdout bounds, and
job memory and CPU-time limits. These are test-process observations only. No
exact admitted-root filesystem enforcement, reparse/junction defense,
direct-network denial, named-pipe broker, or cooperative Stop was implemented
or qualified. `windows-restricted-appcontainer-job` remains
Experimental/empty/typed Unavailable; no Windows provider is Supported.

## Source integrity and verification

The Vitest fixture checks the exact C# source bytes before compilation:
`.gitattributes` pins these two C# files to LF on checkout so the byte digests
remain valid on Windows as well as other hosts.

| Source | SHA-256 |
|---|---|
| `adapters/sandbox-windows/test/native/WindowsSandboxBridgeHarness.cs` | `13d90437697290e2cffe0394cc27f5c5063fa563214b90aee7537089b7afa393` |
| `adapters/sandbox-windows/test/native/WindowsSandboxChild.cs` | `0d7252568c1e9248522323555e36dcaa5d2a936d9fede35211dc6c5f32503e16` |

- Native bridge focused test: PASS, 4/4.
- Native bridge plus existing Windows provider tests: PASS, 8/8.
- Windows adapter architecture and package DAG tests: PASS, 15/15.
- `pnpm exec tsc -p adapters/sandbox-windows/tsconfig.json --noEmit`: PASS.
- `pnpm exec biome check adapters/sandbox-windows/test/windows-native-bridge.test.ts`: PASS.

No full-suite, network, production process, or release qualification is
claimed. T3 remains open.
