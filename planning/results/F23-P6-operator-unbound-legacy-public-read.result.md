# F23/P6 operator UnboundLegacy public read qualification

Status: **PASS for the scoped public read-after-rebuild boundary**

## Scope and candidate

- Implementation commits: `29afcbda`, `baacc105`.
- No `docs/design/**` change, online database mutation, deployment, release, or
  new HTTP/Application/Agent surface.
- The fixture uses only a disposable exact schema-48 database, runs the
  existing operator CLI, advances that same database through accepted
  migrations 49–52, starts the production daemon, and reads the existing
  public `POST /views/inbox-view` route as the local human principal.
- The accepted row remains a P6 `Governance` Inbox entry with typed target
  `RetryVerificationUnboundLegacy`; this qualification does not invent a P10
  Attention source or reclassify it as a new persisted ActionRequired fact.

## Qualified behavior

The public-process case proves, in one chain:

1. an exact schema-48 historical disposition with no Inbox projection is
   rebuilt by `dist/p6-inbox-rebuild.js` under its P39 maintenance boundary;
2. the rebuilt database reaches current schema 52 through the accepted
   migration implementations and passes daemon startup;
3. the public Inbox returns exactly one stable-key `Governance` entry with the
   exact command/project/source Work/source Verification, fixed disposition
   and reason, creation time, revision, and operator update time;
4. repeated public reads return the same value and leave `consumed_at` null and
   revision 1;
5. Command, Event, Execution, ProviderTurn, Agent action, canonical source and
   Inbox snapshots are unchanged by both reads, and the Provider receives zero
   calls;
6. a raw provider-request identifier and raw filesystem path deliberately
   embedded in the historical receipt JSON do not appear in the public DTO;
   neither the database path nor operator manifest path appears there.

## Verification

Final targeted command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/f23-p6-operator-unbound-legacy-public-read.functional.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism
```

Result: **1 file / 1 test PASS**, test time `84.568s`, command duration
`117.79s`.

Supporting gates after the final fixture correction:

- `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false`: PASS.
- Biome on the changed fixture and functional test: PASS.
- `git diff --check`: PASS.
- Functional manifest validation: PASS, 63 Vitest files and 6 UI files.

## Failure evidence and root-cause correction

The first run failed closed at daemon startup because the older module-only
fixture used the non-codec Work identifier `wrk_p6_operator_fixture`.
Production reported `InternalCommandContractDefect` for
`SelectCurrentWork.workId`; no production decoder was relaxed.

The second run reached the HTTP route but returned 500 because the same legacy
fixture used module-test `{}` placeholders for Project resource source and
Verification mission. Those placeholders had never crossed the production
authority-input read path. The final fixture uses valid typed identifiers and
canonical Project/Work/Verification records, while keeping the default
operator-unit fixture byte shape unchanged. The source Work is terminal only
to keep the qualification read-only and prevent the scheduler from admitting
unrelated Agent work during this read-surface test.

No blind retry or assertion weakening was used. The final PASS covers the
public route that the prior implementation result explicitly left open; it
does not by itself claim all F23, P6, migration, or release closure.
