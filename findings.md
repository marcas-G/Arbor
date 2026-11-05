# Findings

## Baseline

- Checkout: `master` at `8b1e968`.
- Frontend package: `apps/web`, Vite + React 19 + React Query.
- The recovered baseline is now green on this Windows checkout. `pnpm start` builds and hosts the local app at `http://127.0.0.1:8787`; `pnpm check` passes fully (one chmod-specific POSIX test is intentionally skipped on Windows).

## Automated checks

- `pnpm --filter @arbor/web build` succeeds, but outputs a 527.56 kB uncompressed initial JavaScript bundle, above Vite's 500 kB warning threshold.
- `pnpm --filter @arbor/web typecheck` fails before the contracts workspace is built: TypeScript cannot resolve `@arbor/api-contracts`, producing many downstream implicit-`any` errors. This is a reproducible developer/CI workflow defect if the web package is checked in isolation; root-level build ordering may make it non-user-facing.
- `pnpm build` also fails at `apps/single-workspace/src/provider-registry.table.ts`: it imports `@arbor/provider-testecho`, whose declaration output is missing. Thus the advertised root build is currently broken from a clean checkout.
- The root TypeScript project and `apps/single-workspace/tsconfig.json` both omit `adapters/provider-testecho` from their project references, confirming this is configuration rather than an installation failure.
- Baseline repairs add that reference/dependency, normalize text/hash and filesystem-boundary behavior across CRLF/native paths, and make test cleanup release its SQLite scope. The final `pnpm check` is green: 1,444 core tests passed, 1 POSIX-only test skipped, and 208 web tests passed.
- `pnpm --filter @arbor/web test` passes: 31 test files / 208 tests. The suite therefore does not cover the identified build configuration paths.

## Confirmed conversation defects

1. **Authenticated conversation history and streaming use the wrong/no token.** `ConversationTab.tsx` passes the literal `"local"` to `useConversation`; its manual `/views/transcript` fetch has no `Authorization` header at all. Other web transports correctly use `SessionContext.token`. A logged-in non-local user therefore gets a 401/403 on transcript and SSE, despite the browser holding a valid session token. The server authenticates the progress route and compares the principal to the message owner.
2. **Conversation history failures are shown as an empty conversation.** The custom transcript fetch neither checks `response.ok` nor the `{ ok: false, problem }` envelope. It consequently resolves with empty `entries` for a JSON error response, making React Query successful and rendering the no-records state instead of a retryable problem or login gate.
3. **A streamed answer disappears once its authoritative transcript arrives.** In `createConversationStore.applyTranscript`, a live assistant record with non-empty text is retained instead of being replaced by the authoritative record. Immediately after, `reapLive` removes every non-authoritative record whose id is present in the latest response. The result is no assistant message for that turn.
4. **Conversation pagination cannot progress beyond one older page.** `older` is permanently queried with `latest.data?.nextCursor`; after fetching an older page, its `nextCursor` is never used or accumulated. Subsequent top-of-list triggers refetch the same page, so a long conversation cannot reach pages 3+.

## Conversation v2 implementation

- The browser now uses one authoritative `useInfiniteQuery` transcript chain. Each older request derives its cursor from the last fetched page; pages are reversed only for chronological display and are never locally mutated.
- `ConversationTab` now uses the active `SessionContext` token and actor for both transcript fetches and `SubmitHumanMessage`; it shows retryable server problems rather than converting them to an empty timeline.
- Browser-side SSE progress, the optimistic conversation store, and the dev proxy have been removed. The only interim state is derived from authoritative Human turns lacking a correlated Assistant turn: `已排队或处理中`.
- The recovered conversation baseline is fully verified by `pnpm check`. The remaining frontend work is visual/IA redesign and optional future live-progress design; either must be scoped separately and live progress requires an explicit successor contract.

## Live local-debug blocker

- `pnpm start` serves the static UI and the root workbench correctly, including the authoritative Human turn and derived `已排队或处理中` state. Once the daemon consumes a message with no real provider deployment configured, it exits with `provider-stream-missing-turn-completion`.
- Cause: `main()` defaults to `provider-fake`; `FakeProviderLive({})` supplies an empty event list, but Provider Runtime deliberately rejects every provider stream that lacks a terminal `TurnCompleted`. This is a real local-default runtime bug, not an unavailable-model indicator. A follow-up needs an explicit product choice: a valid deterministic local response script, or a startup/configuration gate requiring a real provider. Add an end-to-end daemon-default test before changing it.

## Requested real-provider configuration

- The local ignored `arbor.config.json` now targets the requested OpenAI-compatible endpoint using `modelRef: model-openai` and the `deepseek-flash` wire-model identifier, which appears in existing provider protocol evidence.
- The credential is deliberately not stored in the file: startup requires `ARBOR_MODEL_API_KEY` in the invoking process environment. No API call has been sent yet. Starting the daemon with the existing pending `你好` message will consume that message and send it to the provider, so it may incur usage and transmit that content.
- The initial real-provider startup did not issue a request. It stopped on `provider-turn-resume-binding-invalid`: the existing pending turn was recorded for the fake provider, and Provider Runtime fail-closes when the resumed manifest/request binding differs. Resetting the ignored `arbor-slice.db` would clear this stale local test state but also deletes the current project and transcript; do not do that without the user's explicit approval.
- Product decision accepted: an execution must be pinned to its starting model/provider; a later configuration change applies only to new executions. Binding mismatch therefore remains a no-resume safety result, but its recovery boundary must settle/escalate only that execution and leave the daemon available. Frozen recovery material already requires a resumed ProviderTurn to retain the same manifest; no design document will be edited.
- Implemented and tested the required boundary behavior without weakening the binding invariant: Provider Runtime terminally settles the stale ProviderTurn; Agent Driver maps only `UnknownProviderFailure(provider-turn-resume-binding-invalid)` to `Failed(ExecutionFailure(ProviderTurnBindingChanged))`. Other typed provider, storage, and timeout failures retain their original paths. The existing P14 settlement sweep releases a failed human-message execution for a fresh execution, which uses the current deployment.
- Live dogfood verification passed: after switching from the fake default to the configured DeepSeek deployment, the preserved `你好` message received one authoritative assistant reply while the daemon stayed up and HTTP continued to return 200.

## Research-only dogfood stability repairs

- A fresh, isolated quant-research prompt was sent with explicit non-trading constraints. It did not place an order, access a brokerage account, or use funds. The provider emitted no terminal result before the default `StreamIdleTimeout` and the execution was not settled cleanly because its lease had expired.
- Root cause 1: composition resolved `ModelDeployment.executionPolicyOverrides`, but `AgentDriverLive` omitted them from `ProviderRunInput`. Provider Runtime therefore retained the 30-second default rather than the configured local 90-second idle and 10-minute turn limits. The options are now propagated and a driver-level regression test asserts the exact override reaches the runtime boundary.
- Root cause 2 mitigation: long-running calls keep the TTL/3 renewal loop, and now perform one final same-owner/same-generation renewal immediately before the fenced durable settlement. This does not relax fencing: a changed worker, incarnation, or generation still yields `LeaseLost` and prevents mutation.
- The two failed local research databases are preserved for evidence; they will not be reused because their unfinished execution/ProviderTurn records belong to the failed attempts. A fresh ignored database will be used for the next dogfood run.
- The third attempt (`arbor-quant-v2.db`) proved the configured policy reaches Provider Runtime and the model produced a Chinese research design. The output did not reach the authoritative conversation: dense durable streaming starved the lease renewal fiber, then a fenced Session append failed after the 30-second lease expiry. A 512-delta controlled test reproduced the starvation and passed after periodic `Effect.yieldNow` in Provider Runtime.
- This failure left a successful settled ProviderTurn with an Active Execution and claimed Human message. Frozen P9 recovery describes only unsettled ProviderTurn retry. `planning/gaps/DOGFOOD-DG-01-settled-provider-turn-active-execution.md` records the evidence and asks governance to specify replay/idempotency/settlement semantics. No direct database mutation or speculative replay was attempted.
- Manual governance subsequently ACCEPTED the reviewed recovery direction at proposal SHA-256 `BDC9AFB28515B2BC6FDBC450EEEB8006ACB1D8A4994DB5AB290A472EA0AB512F` and submission SHA-256 `908610EE54ED33B3AA5448264E8C18A32EFB333B372D18934D97EC1993EB3A08`. This authorizes design-contract landing only; implementation remains a separate gate.
- Design landing necessarily includes P2 even though the proposal's minimum list named P1/P3/P9/P12/P14: P2 owns Session append, the lease-holder triple, Execution settlement mechanics, and the recovery skeleton. Omitting it would leave the accepted idempotency/fencing rule non-executable. DID v1.20 therefore records P2 as an owning seam without authorizing implementation.
- Cross-document review caught and separated `FencingRejected` from `ExecutionStopping`: only the former can permit a new generation-scoped CommandId after receipt/ledger checks; persistent stop state forbids new normal actions and requires quiescence/reconciliation. It also pinned complete Provider evidence to a versioned validator and made legacy null evidence non-success by default.
- The design/implementation status must not be represented by leaving a resolved Design Gap OPEN. Per `planning/gaps/README.md`, the owning-contract update resolves the Design Gap; implementation remains a separate explicit authorization/evidence gate. The closure record now makes this split mechanical.
- Provider capability changes participate in the P16 ResolvedModelBinding fingerprint. Raising the shared `model-openai` output ceiling silently invalidated its qualification record; the correct configuration is a separate `model-deepseek-v4-flash` catalog entry (128K/8K) while the qualified shared entry stays 128K/4K. AgentLoopStep recovery uses the persisted original Manifest, so changing the configured model for new Executions no longer requires pretending historical Turns used the new binding.

## Test coverage gaps

- The current conversation tests cover one older page and a stream that never receives an authoritative assistant entry with the submitted message id. They do not exercise non-local authentication, error envelopes, terminal transcript replacement, or a second older-page cursor.

## Whole-project assessment

### What Arbor is

- The intended product is a durable, governance-oriented multi-agent work system: `Workspace`/`Responsibility` persist longer than individual executions; deterministic runtimes own state, authority, recovery, tools, and verification; the UI is a command/query projection rather than a source of truth.
- The architecture is deliberately large: Domain, Application, model/agent/execution/provider/tool/projection runtimes, 12 adapters, a single-workspace composition root, and a React web client. That boundary design is coherent and suited to the stated problem, but expensive to evolve.

### Current baseline is not trustworthy

- The repository still declares all P0–P12 and Web v1/D10 formally closed, with Dogfooding as the next step. However, `master` is 51 commits past D10 (`7752e0e`), changing 522 files and adding 922,149 lines. Much of that delta is test-evidence/report output, but it also includes provider-extension, runtime, transport, and conversation changes.
- The frozen P14 web contract explicitly prohibits browser streaming and optimistic turns. Current `master` introduces an SSE preview channel and optimistic messages. No matching P14 redesign/acceptance closure was found. Therefore the formal closure records no longer describe the checked-out executable product.
- The advertised root build now fails from a clean checkout due to a missing TypeScript project-reference edge for the newly added `provider-testecho` package. A top-level `pnpm check` cannot be trusted until this feedback loop is restored.
- The newest core-capability progress evidence (2026-09-28) still labels basic conversation and memory as proven, but tool use, control actions, restart/continuation, failure recovery, and Web projection as fail-near/blocked/not-yet-rerun. This is useful engineering evidence, not a release qualification.

### Why forward development feels stuck

1. **There is no single current contract.** Frozen design/closure evidence and current behavior conflict, so every fix risks choosing semantics implicitly.
2. **The developer feedback loop is broken.** Root build fails; web unit tests pass while missing authenticated, multi-page, and authoritative-stream scenarios.
3. **Several workstreams are coupled in one moving branch.** Product UX, streaming transport, runtime directives, provider extensibility, real-provider qualification, and evidence generation land together.
4. **The repository optimizes for proof artifacts before a dogfood loop.** The closure-to-current delta is dominated by reports/evidence, while a root README and one-command local start path are absent. Starting the production daemon requires inferred build output and environment variables.
5. **The product's riskiest assumption remains product-facing.** The value proposition is not a provider adapter or a virtualized conversation; it is whether a user can hand a real multi-day responsibility to Arbor, understand what it is doing, and safely correct it.

### Recommended recovery direction

Do not redesign the domain core. Freeze feature expansion and create a short-lived `release-baseline` effort with these gates:

1. Restore the mechanical baseline: repair the TypeScript reference graph, make `pnpm check` deterministic from a clean checkout, and provide a documented `pnpm dev`/`pnpm start` local path.
2. Resolve the chat contract explicitly: either revert SSE/optimistic behavior to frozen P14 v1 or write and approve a successor conversation contract. The successor must own auth, pagination, error handling, overlay-to-authoritative replacement, and acceptance tests.
3. Create one dogfood scenario: a local user starts one real project, submits a goal, observes one root conversation → execution → result → verification/attention loop, then restarts the daemon and resumes. Everything outside that path is deferred.
4. Promote only defects found in that scenario. Provider-family expansion, advanced control actions, and more UI polish remain parked until the scenario works repeatedly.
