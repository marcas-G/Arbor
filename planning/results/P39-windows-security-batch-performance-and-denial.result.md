# P39 Windows security probe batching and denial evidence

Date: 2026-10-15

Status: **targeted implementation and denial evidence PASS; no full functional
suite run**.

Commits:

- `1538c6cef71dc35520da96ec1cc65a5d9c1ffe93` — batch P39 Windows security probes.
- `e0142a735e0e42ebf68d0c48e23198044baf6d32` — add Windows denial-path evidence.

## Windows lane and negative cases

Host: `W10-20250217599`; test account: `w10-20250217599\thinkpad`;
`process.platform=win32`; `p39WindowsAclQualificationAvailable()=true`.
The runner explicitly supplied the inbox PowerShell module path:

```powershell
$env:PSModulePath = Join-Path (Join-Path (Join-Path $env:WINDIR 'System32') 'WindowsPowerShell\v1.0') 'Modules'
pnpm exec vitest run adapters/persistence-sqlite/test/p39-reality-proof-migration.test.ts --testNamePattern 'derives one shared writer-lock identity|uses a primary-shared lock path|inherits the invocation-wide private TEMP ACL|retains single-path directory and file validation entrypoints|real protected file grants a foreign principal|mismatched ACL owner|unsupported volume facts' --reporter=verbose
```

Result: **8 passed, 16 skipped** (24 total). All four new denial cases ran and
passed; none was skipped by the platform gate:

- Real file DACL with an added `Everyone` write ACE: rejected. The test resets
  that disposable file's ACL and removes its fixture in `finally`.
- Mismatched owner: rejected by executing the generated PowerShell probe with
  a controlled in-memory `FileSecurity.SetOwner(SYSTEM)` after the real
  `Get-Acl`. This does not alter the fixture's on-disk owner or ACL; a normal
  validation immediately afterward still passes.
- Unsupported `Network/NTFS` drive facts: rejected by substituting the
  `DriveInfo` fact constructor in the probe and executing the actual generated
  script's fail-closed branch.
- Unsupported `Fixed/UNKNOWN` drive facts: rejected through the same
  controlled probe.

The other 16 cases were outside the command's `--testNamePattern`, including
the broader P39 migration scenarios; they were not counted as denials or
Windows qualification. Existing selected positive, hard-link, alias, and
single-path directory/file checks passed in the same lane.

The initial foreign-ACE test draft used `Set-Acl`, which this account cannot
use because `SeSecurityPrivilege` is unavailable. The committed test uses
`icacls /grant` for the disposable ACE and `icacls /reset` in `finally`.

## Cross-platform gate

`p39WindowsAclQualificationAvailable()` now returns false off Windows. The
four OS-specific denial tests use the explicit gate
`process.platform === "win32" && p39WindowsAclQualificationAvailable()`.
The P39 path/recovery suites that support POSIX use the separate gate
`process.platform !== "win32" || p39WindowsAclQualificationAvailable()`;
specifically, `blocked-workepisode-restart-wake.test.ts` and
`p39-maintenance-writer-exclusion.functional.test.ts` remain enabled on POSIX.
A pure gate test checks the non-Windows branch, Windows without the ACL module,
and Windows with the module. No Linux-host run is claimed.

```powershell
pnpm exec vitest run adapters/persistence-sqlite/test/p39-windows-security-timeout.test.ts --reporter=verbose
```

Result: **7/7 PASS**. The pure gate test verifies POSIX remains enabled for
cross-platform path suites even when no Windows ACL module is available.

The Windows lane also confirmed both cross-platform suites still execute when
the Windows ACL module is available:

```powershell
pnpm exec vitest run apps/single-workspace/test/blocked-workepisode-restart-wake.test.ts --reporter=verbose
```

Result: **2/2 PASS** on `W10-20250217599`.

```powershell
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p39-maintenance-writer-exclusion.functional.test.ts --reporter=verbose
```

Result: **3/3 PASS** on `W10-20250217599`; all three cross-process writer
exclusion cases ran rather than being suite-skipped.

Both cross-platform suite gates use the pure predicate
`isP39PathQualificationEnabled(process.platform, p39WindowsAclQualificationAvailable())`;
the four OS-specific denial cases continue to use the stricter Windows-only
predicate. No Linux host was available in this run, so the POSIX behavior is
verified through the explicit pure-gate cases above rather than claimed as an
OS-host execution.

## Performance and remaining checks

The final ten-round isolated benchmark used copies of a disposable schema-42
template and made no primary-database writes. Compared with the pre-change
ten-round sample:

| Function | Before p50 / max | After p50 / max |
|---|---:|---:|
| `prepareP39PrimaryDatabasePath` | 4,487.5 / 6,611.8 ms | 1,228.8 / 1,327.2 ms |
| `p39WriterLockFilename` (existing lock path) | 3,077.1 / 5,349.8 ms | 632.0 / 689.5 ms |
| `validateP39ProtectedDirectory` | 1,026.2 / 1,106.0 ms | 610.4 / 642.5 ms |
| `validateP39ProtectedFile` | 1,011.3 / 1,153.1 ms | 610.1 / 674.2 ms |

Post-change AH19 ordinary-history, AH17-before, and AH17-after process cases
passed **3/3**. Six daemon startups all reached LISTEN in 5.67–6.35 seconds;
the P39 batches took about 0.6–1.5 seconds per stage. This is focused evidence,
not a full functional-suite qualification.

- `pnpm --filter @arbor/persistence-sqlite build`: PASS.
- `pnpm build`: PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false`: PASS.
- Biome on the four touched test/source files: PASS.
- `git diff --check`: PASS.
