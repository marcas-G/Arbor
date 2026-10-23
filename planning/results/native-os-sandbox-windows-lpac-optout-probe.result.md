# Windows LPAC opt-out microprobe — exploratory result

Date: 2026-10-24  
Code baseline: `f4086b032ca0f3cd5344d4777dc901156ed327eb` plus two test-only
files in this result commit.  
Proposal SHA-256 checked before the probe:
`29690BC98885FE028ADFCA9779D289DB7D733C7A455318746587FCDE627C072A`.  
The owner-relayed B1 review items (pre-profile journal, fixed journal/recovery
versioning, protocol V2/error delivery and exact primitive/rule versions) are
all explicitly specified in that proposal; no separate LPAC-specific review
artifact was present in this checkout.

Status: **exploratory, not T3/production qualification**. No production source,
Run edge, operator signature, registry row, database, or `docs/design/**` was
changed. Windows production remains Unavailable/Unsupported.

## Method and bounded scope

The test-owned C# driver was compiled with the installed .NET Framework 4
compiler (`/nologo /warnaserror /platform:x64`, references `System.dll`,
`System.Core.dll`, `System.Security.dll`). The driver launches the system
`cmd.exe` directly, with the same zero-capability `SECURITY_CAPABILITIES`,
restricted low-integrity token, explicit standard-handle list, suspended
creation, Job assignment and resume in both arms. The LPAC arm adds only the
third attribute `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` with
`PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT=1`; it does not change the
package SID, capabilities, environment projection, DACL rights, or child
command.

Each arm gets a unique AppContainer profile. Its file fixtures are created
inside that profile's `LOCALAPPDATA`, so no host user directory or system-file
ACL is changed. The mounted workspace directory is granted package-SID
Modify. The outside fixture directory permits package-SID traversal, but the
file's protected DACL grants read only to the host user and
`ALL_APPLICATION_PACKAGES`—not to the AppContainer package SID. The exact
profile-local ACLs are snapshotted/restored; each profile is deleted and
recreated/deleted to verify cleanup. The external driver is built in its own
TEMP directory, which is removed by `afterAll`.

Run: direct Node/Vitest invocation of only
`adapters/sandbox-windows/test/windows-native-lpac-optout-probe.test.ts`, one
worker, retry zero, with a 15-second `spawnSync` deadline. The first run's
retained JSON was only the Vitest process summary at
`.test-results/windows-private-env-exploratory-7aa5bc73/lpac-optout-probe-profile-inline-details-f4086b03.json`;
it did not preserve the driver's structured child fields. After review found
that evidence gap, a test-only change added a separate P39-private artifact
written before assertions. The single rerun's raw structured artifact is
`.test-results/lpac-p39-raw-sSvh58/probe-result.json` (artifact ID
`47b974f9-430c-4f7a-85c9-07fe27b358f3`, SHA-256
`F49E064DD83BEFE596EE23B72A0C94BD97E36A8CC97FDC71425E5FDEE6C47E1A`). Its
schema is `Arbor.WindowsLpacOptOutProbeRawV1`; its `driverSourceSha256` is the
native driver source hash. The artifact records host/limits, native process
status and an allowlisted set of scalar probe and cleanup fields. It does not
hash the TypeScript field extractor, compiled PE, or runner, so it is
field-observation evidence rather than an end-to-end tamper-evident chain. It
intentionally excludes stdout/stderr, paths, environment values, secrets and
driver error payloads. The file ACL was verified to grant
FullControl only to the current user, SYSTEM and Administrators. The test
assertions remain unchanged and still fail on this result.
The test is now opt-in for future runs via the test-only environment variable
`ARBOR_RUN_WINDOWS_LPAC_PROBE=1`; it is not a production flag. Replay with:

```powershell
$env:ARBOR_RUN_WINDOWS_LPAC_PROBE = '1'
node .\node_modules\vitest\vitest.mjs run adapters/sandbox-windows/test/windows-native-lpac-optout-probe.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose --reporter=json --outputFile=.test-results/windows-private-env-exploratory-7aa5bc73/lpac-optout-probe-replay.json
```

## Result on Windows 10 build 19044

The regular AppContainer control and LPAC candidate both passed process
creation, Job assignment, resume, and normal child exit (`exitCode=0`). The
LPAC policy attribute was accepted by `UpdateProcThreadAttribute` on this host.
The actual file-access observations were:

| Check | Regular AppContainer | LPAC opt-out |
|---|---|---|
| Outside fixture with only `ALL_APPLICATION_PACKAGES` file-read grant | `OUTSIDE_READ=ALLOWED` | `OUTSIDE_READ=DENIED` |
| Package-SID workspace create/write/read | `WORKSPACE_CONTENT_MATCH=1` | `WORKSPACE_CONTENT_MATCH=0`; no workspace write file was created |
| Workspace rename/delete | Failed: original file remained; not the requested read/write oracle | Not reached successfully |
| Profile Temp environment/create/write/read | Failed this arm's oracle (`TEMP_OPS=FAIL`) | Failed this arm's oracle (`TEMP_OPS=FAIL`) |

Therefore, the API-level LPAC opt-out works on build 19044 for the narrow
`ALL_APPLICATION_PACKAGES` denial: the ordinary AppContainer read succeeds,
while the LPAC read is denied. But the current LPAC construction did **not**
retain the exact package-SID workspace write control in this probe. The
profile-Temp oracle also did not pass in either arm. This does not establish a
production-capable LPAC provider; it exposes a positive-control gap that keeps
the candidate fail-closed. Do not add capabilities, broaden DACLs, restore
`ALL_APPLICATION_PACKAGES`, or weaken the denial assertion to make the probe
green.

The `OUTSIDE_CONTENT_MATCH` telemetry is not used as the result: the driver
trims fixture text before comparing it with a string containing a newline,
which reports false even when `type` exits successfully. The decisive
outside-file oracle is the native `type` command's success/failure captured as
`OUTSIDE_READ`; the raw report preserves both that status and the faulty
secondary telemetry. The workspace-write result is independently checked by
the file content and existence witnesses.

## Cleanup and verification

The final run reported, for both arms, child exited, `PROFILE_DELETED=1`,
`ACL_RESTORED=1`, and `CLEANUP_FAILURES=0`. The profile cleanup check recreated
and deleted the unique profile again. After the run, the recent
`arbor-lpac-probe-*` TEMP fixture count was zero and no LPAC probe or cmd child
process remained. Earlier harness iterations (managed self-child CLR failure,
then shell-fixture access failures) have separate preserved JSON reports in the
same ignored `.test-results/windows-private-env-exploratory-7aa5bc73/` folder;
they were not substituted for the final native-command result.

The structured fields in the P39 artifact confirm both children were created,
assigned to Jobs, resumed and exited successfully; both profile deletion and
ACL restoration reported success, and `CLEANUP_FAILURES=0`. The artifact also
shows the actual access results: regular `OUTSIDE_READ=ALLOWED`, LPAC
`OUTSIDE_READ=DENIED`; regular workspace content matched, while LPAC workspace
operations failed. Both Temp oracles failed. `OUTSIDE_CONTENT_MATCH` is known
faulty secondary telemetry because the driver trims fixture text before
comparing against a newline-terminated expected string; it is retained but not
used as evidence. The outside-read command exit status is the relevant oracle.

Static verification after adding the artifact writer: TypeScript typecheck,
Biome, and `git diff --check` passed; the C# driver compiled with warnings as
errors. Post-run checks found zero recent `arbor-lpac-probe-*` TEMP fixtures and
no matching probe/cmd child processes. No full native suite or daemon suite
was run.
