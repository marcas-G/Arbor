# Functional runner case-level fail-fast

Status: **PASS — runner implementation and synthetic qualification**

The functional runner now passes Vitest `--bail=1` and Playwright
`--max-failures=1`. The installed CLIs were checked directly before use:
Vitest **5.0.1** lists `--bail <number>` (“Stop test execution when given
number of tests have failed”); Playwright **1.63.0** lists
`--max-failures <N>` (“Stop after the first N failures”). The release profile
still selects the manifest's complete **48 Vitest + 6 Playwright files**,
disables cache, and sets retries to zero.

## Evidence

- A temporary two-case Vitest file used `--bail=1`: the first case failed, the
  second case's filesystem sentinel was absent, and the JSON report contained
  one failed case, two total cases, and a non-passed record for the case that
  did not run. This is runner behavior evidence only; it does not qualify any
  product suite.
- A synthetic release invocation used a fake pnpm CLI that let both build
  commands complete and returned failure for the first Vitest group. The final
  result manifest and summary were written with `status: failed`, nonzero exit,
  and `completeCoverage: false`; all 54 release files remained in
  `selectedFiles`, while the Playwright group was not started. A skipped test
  remains part of the failed report and does not imply complete coverage.
- `node --check` passed for the runner and its Node test file.
- `node --test scripts/testing/runner-startup.test.mjs` passed, **3/3**.
- `pnpm test:manifest` passed, **11/11 Node tests**, and the manifest validator
  reported 48 functional Vitest files and 6 UI files.

No full functional, core, or product test suite was run for this change.
