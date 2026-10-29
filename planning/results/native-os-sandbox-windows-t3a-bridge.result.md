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
active-process limit rejection, kill-on-close, and walltime and stdout bounds.
`QueryInformationJobObject` independently reads back extended limits (class 9),
CPU-rate control (class 15), and post-run basic accounting (class 1). The
readback, rather than the requested values, is emitted by the bridge:

| Probe | Kernel readback | Child/process observation |
|---|---|---|
| 64 MiB memory | Job and process memory limits both 67,108,864 bytes; limit flags 8,972 | A touched 64 MiB allocation throws `OutOfMemoryException`; child exits 24 |
| 256 MiB memory control | Job and process memory limits both 268,435,456 bytes | The same allocation completes; child exits 0 |
| CPU | Per-job user-time setting 500 ms; CPU rate flags 5 and rate 2,000 (20%) | Root exits `0xC0000044` (`STATUS_QUOTA_EXCEEDED` in the installed Windows SDK), Job terminated-process count is 1, and the 10 s harness walltime guard did not fire |

The CPU status is a generic quota status, not a dedicated CPU-limit
notification. Job accounting readback exceeded the configured 500 ms in the
diagnostic run, so this checkpoint does not claim precise 500 ms cutoff.
The memory contrast does not prove an exact peak-usage threshold. These are
test-process observations only. No exact admitted-root filesystem enforcement,
reparse/junction defense,
direct-network denial, named-pipe broker, or cooperative Stop was implemented
or qualified. `windows-restricted-appcontainer-job` remains
Experimental/empty/typed Unavailable; no Windows provider is Supported.

## Source integrity and verification

The Vitest fixture checks the exact C# source bytes before compilation.
`.gitattributes` pins these two C# files to LF on checkout so the byte digests
remain valid on Windows as well as other hosts.

| Source | SHA-256 |
|---|---|
| `adapters/sandbox-windows/test/native/WindowsSandboxBridgeHarness.cs` | `aefa0bed85c3a8b4ae11af92f29ad2e20cb3006b8424b1ebf89c5c2ccb96c709` |
| `adapters/sandbox-windows/test/native/WindowsSandboxChild.cs` | `ae4e8d60e18206407938013e7005c79ef813054bdd512b16204a84ca7d3231b1` |

The local `csc.exe` compilation is an execution step. This fixture has no
trusted compiled-EXE digest, signature, or binary attestation; a 64-character
hash shape check was removed because it could not establish integrity.

- Native bridge focused test: PASS, 4/4.
- Native bridge plus existing Windows provider tests: PASS, 8/8.
- Windows adapter architecture and package DAG tests: PASS, 15/15.
- `pnpm exec tsc -p adapters/sandbox-windows/tsconfig.json --noEmit`: PASS.
- `pnpm exec biome check adapters/sandbox-windows/test/windows-native-bridge.test.ts`: PASS.

No full-suite, network, production process, or release qualification is
claimed. T3 remains open.
