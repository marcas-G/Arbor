# Test and Evidence Review

## Evidence levels

| Level | Meaning | Current examples | What it proves |
|---|---|---|---|
| L1 static/contract | names, hashes, schema projections, forbidden placeholders | `tests/p12-toolcatalog.test.ts`, `packages/tool-runtime/test/p4-catalog.test.ts` | definitions and projections are structurally present |
| L2 scripted pipeline | fake provider or deterministic runtime path | `packages/model-context/test/p3-decode.test.ts`, `packages/tool-runtime/test/p4-pipeline.test.ts`, provider client stream tests | parser/handler/runtime wiring under scripted inputs |
| L3 real behavioral | actual model scenario and measured behavior | `planning/results/wave1-live-call-evidence.json`, `/tmp/agentdirective-provider-replication/` | limited model/provider behavior in the tested scenario |

Static and scripted tests must not be called behavioral evals.

## Coverage map

| Surface | L1 | L2 | L3 | Current conclusion |
|---|---|---|---|---|
| builtin names/metadata | yes | yes | no | contract/projection proven |
| builtin input validation and authority | partial | yes | no | runtime mechanism proven; model behavior not |
| project registry projection | yes | yes | no | visible catalog union proven; executable path absent |
| stream tool-call reconstruction | no | yes | limited provider evidence | adapter reconstruction tested; live model path limited |
| `arbor_directive` canonical schema | yes | yes | replication shows representation failure | canonical validator works; representation compatibility issue remains |
| per-purpose exposure | no dedicated gate | no dedicated gate | no | HIGH evidence gap |
| query/verifier read-only tool surface | no | no | no | not established |
| shell output refs/artifacts | schema only | executor unit path | no | mismatch unresolved |
| project tool invocation | registry only | denial path possible | no | visible-but-unexecutable |
| skill tool surface | type/helper tests only | empty registry path | no | no active model-facing skill evidence |

## Named test evidence

- `tests/p12-toolcatalog.test.ts:171-275`: builtin projection and compiled tool names; expects `arbor_directive`, `list`, `patch`, `read`, `shell` and a `oneOf` directive schema.
- `tests/p12-toolcatalog.test.ts:350-405`: committed project definitions join the catalog and project refs resolve.
- `apps/single-workspace/test/p5-slice-acceptance.test.ts:650-680`: live Work request includes the same five names and canonical output-contract metadata.
- `packages/tool-runtime/test/p4-pipeline.test.ts`: definition lookup, validation, authority/admission, approval, and unknown-tool paths.
- `packages/model-context/test/p3-decode.test.ts`: canonical directive acceptance/rejection and arbitrary tool-call conversion to `InvokeTool`.
- `adapters/provider-openai/test/provider-client.test.ts:205-294`: streamed tool-call argument reconstruction, including parallel call isolation.
- `planning/results/wave1-live-call-evidence.json`: real request/manifests from the live provider path.
- `/tmp/agentdirective-provider-replication/gate.json`: controlled real-model L1/L2/L5/MT representation replication.

## Evaluation gaps

1. No scenario matrix compares tool exposure across Work, Query, Verification, Formation, Bootstrap, Steer, Child, and Recovery.
2. No real-model evaluation measures whether descriptions cause correct tool choice under minimal pairs.
3. No real-model test verifies project tools can execute after registration.
4. No real-model evidence demonstrates artifact refs and failure-state distinctions are usable in the next turn.
5. No stability evidence for any future representation compiler in production.

## Evidence labels

For the audit claims in this directory, current readiness is mostly `TESTED` at L1/L2 and only `BEHAVIORALLY VERIFIED` for the narrow live Work/provider and representation experiments. Tool-surface least privilege is **not** behaviorally verified.
