# Real Public S4-A Request Capture RED — 2026-10-24

## Run

- Candidate: `e6a11dc721c66e151f707c4bbb3531dbd038f5c5` (`6aafae5f` plus the
  S3 result record only).
- Command selected only `REAL S4-A`, with one worker and retry 0:

  ```text
  pnpm exec vitest run --config vitest.public-real.config.ts tests/capability/real-provider/public-s4-recovery.test.ts --testNamePattern 'REAL S4-A' --maxWorkers=1 --retry=0
  ```

- Result: **FAIL, 1 test; S4-B skipped.** The configured Provider returned a
  successful HTTP 200 response for the first public conversation round, and
  the public assistant reply was present. The test then failed before arming
  the response gate: it searched for the first prompt in `request-start`,
  which intentionally has no request body. The body is carried by the matching
  `response-complete` event. This is a test-oracle defect; this run did not
  reach held response, process-tree kill, restart, or recovery assertions.
- Teardown confirmed the daemon exited; the fixture was archived. No automatic
  retry was performed. The credential/config values and captured conversation
  content remain private and are not reproduced here.

## Preserved private evidence

Run directory:
`.test-results/real-public-s4-a-conversation-hard-restart-tnIsk4/`

The `evidence-mKhlXB/` directory contains the sanitized run evidence and
provider capture. `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/`
contains the failed run's database files and workspace. The archive records
`status=FAIL`, `daemonExited=true`, and zero daemon errors.

| File | SHA-256 |
|---|---|
| `evidence-mKhlXB/provider-captures.jsonl` | `D1EBBE7C1E04BAC96B6FCC9B12FE12401EDCCF4D4B3EB9C639D5720F8F60E909` |
| `evidence-mKhlXB/s4-a-conversation-hard-restart-2026-10-23T18-48-20.943Z.json` | `BB070CC37BC39877ABE84EAE50FAB7101071142A1891CEFE31934D30AD333989` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/failure-evidence.json` | `D8D36C1F3B1645CDE283E9E49325117C542ECAD44293E3457F78407319742C62` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/arbor-functional.db` | `4F065A4EED27E781EF2452A4B14C756A392CAB08A433035EE4CBBABE2F8A60B7` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/arbor-functional.db-wal` | `011D353C64DCB5D84BD03F8D735BB1F1879807CEEAE1D552AA7B5B39A8AD9616` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/workspace/proof.txt` | `D1574F67AE06C81C6988C3ECCEC572C403A0602DA3DB45EA6F3FCAA431B18514` |

## Correction and qualification status

The harness now joins body-bearing response events to exactly one
`request-start` by request ID and rejects duplicate or conflicting evidence.
S4-A's post-restart check also compares the public transcript again after a
bounded 1.5-second quiet window. These changes address the RED but have not
been qualified by another real Provider run. This result remains a failed
pre-fix qualification, not S4-A PASS evidence.

The stub-only response-gate regression passed **1/1** under the default root
Vitest configuration with bounded serial execution:

```text
pnpm exec vitest run --config vitest.config.ts tests/capability/support/provider-fetch-capture-hook.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism
```

The test replaces `globalThis.fetch` in its short-lived Node helper with an
in-memory `Response`; the `.invalid` endpoint is never contacted. It verifies
the bodyless start event, matching body-bearing completion/held events,
body-to-start identity checks including duplicate/conflict rejection, explicit
release, and that a new process with an empty gate path does not inherit the
old held gate. This is harness evidence only, not a daemon, model, or S4
recovery qualification.
