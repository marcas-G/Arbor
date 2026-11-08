# Project recovery analysis

## Goal

Recover Arbor to a productive baseline, then restore the frontend conversation path to the frozen P14 server-authoritative semantics: authenticated transcript queries, explicit failures, durable submit/refetch behavior, and true cursor-chain pagination. Frozen design documents remain unchanged.

## Phases

- [x] 1. Establish repository and frontend test context.
- [x] 2. Run static and automated frontend checks.
- [~] 3. Start the app and exercise primary routes at desktop and compact sizes (blocked: no controlled browser interface is available in this environment).
- [x] 4. Inspect failures, correlate them with implementation, and assess severity.
- [x] 5. Deliver frontend findings.
- [x] 6. Map architecture, design baseline, repository state, and evidence.
- [x] 7. Identify the few blockers that prevent productive development.
- [x] 8. Recommend a staged recovery plan and decision points.
- [x] 9. Restore a deterministic clean-checkout build graph.
- [x] 10. Add a documented, one-command local run path.
- [x] 11. Verify the recovered baseline and report remaining runtime prerequisites.
- [x] 12. Add failing conversation contract tests for session auth, response failures, no optimistic insertion, authoritative settlement, and three-page pagination.
- [x] 13. Replace the competing optimistic/SSE conversation state with one authoritative paginated transcript query.
- [x] 14. Verify child read-only behavior, viewport stability, targeted web checks, and the complete repository check.
- [x] 15. Report the recovered conversation baseline and remaining visual redesign scope.
- [x] 16. Start a real local debug session and capture any runtime blocker without changing runtime semantics.
- [x] 17. Add a Git-ignored OpenAI-compatible provider configuration for the requested DeepSeek Flash deployment, with the secret supplied only at runtime through an environment variable.
- [x] 18. Make stale ProviderTurn bindings recover as a per-execution visible terminal disposition, while preserving the prohibition on cross-model/provider resume and keeping the daemon available for new work.
- [x] 19. Treat typed Provider execution timeouts as a per-execution terminal outcome and propagate the configured deployment timeout policy into every Provider turn.
- [x] 20. Preserve same-generation lease fencing for long Provider calls while renewing immediately before the durable execution settlement boundary.
- [x] 21. Re-run the research-only dogfood scenario in a fresh local database; capture the generated research draft and the failure evidence when the authoritative session write is fenced.
- [x] 22. Reproduce dense provider-stream starvation of the concurrent heartbeat and fix the scheduling yield with a regression test.
- [x] 23. Escalate the settled-ProviderTurn/active-Execution recovery state as a Design Gap and deliver the recovered research design. Re-running the affected execution is blocked pending governance.
- [x] 24. Draft a governance-ready durable AgentLoopStep handoff design covering Provider result replay, idempotent Session/action progression, settlement recovery, and fault-injection acceptance.
- [x] 25. Disposition the independent R1–R5 review and revise the governance draft for generation-scoped command attempts, atomic Provider success, failure/repair exits, partial-action recovery, and legacy adoption.
- [x] 26. Disposition round-two R6–R8: gate unresolved side effects, close deterministic successor recovery, and split acceptance assertions by success/retry/stop/OutcomeUnknown/Attention outcomes.
- [x] 27. Verify the round-three reviewed SHA and prepare an immutable manual-governance submission without changing the reviewed proposal.
- [x] 28. Verify the governance-submission review and register the immutable reviewed submission as decision-ready without inferring ACCEPT authority.
- [x] 29. Record the user's explicit manual-governance `ACCEPT` decision and preserve the reviewed proposal/submission hashes.
- [x] 30. Amend the owning frozen design contracts (DID, P1/Application, P2 session/fencing, P3, P9, P12, P14) with the approved AgentLoopStep handoff semantics.
- [x] 31. Run cross-document consistency review, update governance/index status, and produce the design-closure record.
- [x] 32. Stop at the design boundary and report the separate implementation-authorization requirement.
- [x] 33. Record the AgentLoopStep naming successor and explicit implementation authorization without altering immutable reviewed proposal hashes.
- [x] 34. Add failing migration/port tests for migration 0017, sourced Session idempotency, and the AgentLoopStep/action state store.
- [x] 35. Implement migration 0017, ports, SQLite stores, exports, and composition wiring.
- [x] 36. Make ProviderAttempt success + ProviderTurn settlement atomic and expose validated settled-result replay.
- [x] 37. Integrate AgentLoopStep progression into the Agent loop without persisting process-local AgentAction.
- [~] 38. Implement evidence-gated legacy adoption and restart recovery, including the DOGFOOD-DG-01 equivalent fixture.
- [ ] 39. Complete AH1–AH14 crash-window and branch-specific acceptance tests; run full repository checks.
- [ ] 40. Produce the implementation result and decide separately whether the preserved real failure database is eligible for recovery.

## Open blocker

Manual governance ACCEPTED the reviewed direction. The owning contracts are
landed as DID v1.20 and the design question in `DOGFOOD-DG-01` is RESOLVED.
Recovery implementation, migration 0017, AH1–AH14 and replay of the preserved
failure database remain a separate, unauthorized gate.

## Errors encountered

| Error | Resolution |
| --- | --- |
| Root `README.md` is absent. | Used `AGENTS.md`, package scripts, and web source/test inventory instead. |
| Root `pnpm build` fails before web typechecking. | Missing built declaration for `@arbor/provider-testecho`; inspect TypeScript project references and package outputs. |
| Browser UI validation is unavailable. | No supported controlled-browser runtime is exposed; performed automated and source-level validation instead. |
| Assumed P14 web-contract file names were incorrect. | Located the frozen contracts as `docs/design/implementation/P14/04-web-surface.md` and `05-acceptance.md`. |
| `pnpm start` initially failed on Windows with `spawn EINVAL`. | Updated the local launcher to invoke `pnpm.cmd` through the Windows shell, then rerun the startup verification. |
| Full `pnpm check` initially failed on Windows with 43 test failures. | Repaired CRLF-sensitive prompt/header and SSE parsing, native path comparison, test resource disposal, and POSIX-only permission expectation. The final full check passes. |
| Targeted web tests could not start under shell Node 24.19 / pnpm 11.19. | Project pins Node 24.21 / pnpm 12.4; use the workspace's bundled runtime before interpreting any test failure. |
| Transcript DTO uses a catch-all `kind: string` arm. | String discriminants alone do not narrow it; check required turn fields explicitly and keep unknown entries in the read-only fallback. |
| Local daemon exits after consuming a message with the default fake provider. | `provider-fake` falls back to an empty event stream, while Provider Runtime requires a terminal `TurnCompleted`; record as a runtime bug and do not silently alter provider semantics during a frontend debug pass. |
| Full check after enabling an inline real-provider config did not produce progress for several minutes. | Interrupted it before it could accidentally exercise real-provider paths; lint, typecheck, architecture, and focused recovery tests have passed. The prior full check passed before this core-only change. |
| Research-only dogfood timed out after 30 seconds and then hit `FencingRejected` at settlement. | The deployment policy was not threaded from composition into `ProviderRunInput`; fixed with a regression test. Added a same-generation final CAS renewal before settlement so scheduler delay cannot turn an owned long-running drive into a stale write. |
