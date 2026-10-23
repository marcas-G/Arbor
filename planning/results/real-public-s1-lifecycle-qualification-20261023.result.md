# Real Public S1 Lifecycle Qualification — 2026-10-23

**Status:** PASS — one bounded, single-Workspace real-provider S1 lifecycle
slice. This is not S1–S4 closure or a general model-reliability claim.

## Candidate and evidence

- Test source SHA: `c69e87c79ff1c8f80672cec49b4776aa7e0e1ef4`.
- Agent Runtime / single-workspace build SHA: `53c36a77a2e1c07ba72989e18b01c90003f49f67`.
- Web static build carried forward from `166c2341cfa1568df93d013a0d86bc7129436af1`; no Web source changed in the later commits.
- The test used the configured real provider; no scripted provider response was used as fallback. Credentials and authorization headers were not recorded.
- Vitest: one test passed, zero failed, retry 0, one worker. Fourteen provider requests started and all fourteen responses completed with HTTP 200. The completed response capture identifies the configured real model/profile; HTTP success is not the functional oracle.
- Private run directory (P39 ACL verified):
  `.test-results/real-public-s1-c69e87c7-6fb8819c8e064c6d834c716ec403b311/`
- Private detailed evidence JSON:
  `evidence-OVDoeo/PUBLIC-S1-REAL-2026-10-23T09-04-24.867Z-b58f3485-c3cb-4d02-8ee3-b238fcc552b3.json`
- Private sanitized provider capture:
  `evidence-OVDoeo/provider-captures.jsonl`
- Vitest reports: `vitest.json`, `verbose.stdout.log`, and `verbose.stderr.log` in the run directory. The fixture database/workspace was fresh and was removed after the passing teardown; the private evidence and capture remain available for audit.

No endpoint URL, API key, secret value, authorization header, original user prompt, or model prose is reproduced in this result. The private files above contain the detailed request/response evidence and are not committed.

## Public lifecycle proved

The natural-language user request named a bounded file outcome and constraints; it did not mention internal tool names. The real Provider requests and public API observations established:

1. RootConversation received the versioned `prompt:root-conversation:goal-placement:v7` guidance, exposed its expected conversation-safe controls, and created the current-Workspace Work through `assign_work`.
2. The exact approval path completed. The WorkEpisode received the Work-only `prompt:base-agent-protocol:base-loop:v2` execution-role guidance (the RootConversation action prompt was not leaked into that profile) and used the authorized `patch` and `read` tools. It then issued `claim_completion`.
3. The independent Verifier produced a public Verification verdict of PASS with three passing criteria: file existence, exact content, and scope compliance. Root accepted that exact PASS result; public Work state became Completed.
4. After daemon restart, public reads returned the same Completed Work, PASS Verification, and Acceptance identity. Provider request count remained fourteen; no additional post-restart Provider request occurred.
5. Workspace snapshot comparison found the expected new proof file and the original baseline `proof.txt`; the harness asserted byte-exact expected content and that no other file was created or changed.

The primary lifecycle oracle is public commands/views plus the isolated workspace filesystem assertions. A separately labeled `ReadOnlySQLiteAuxiliary` assertion confirms that Verifier execution differed from Producer execution and that its three `ToolObservation` references bind successful `list`/`read` invocations/results. That auxiliary assertion supplements—rather than replaces or re-labels—the public lifecycle oracle; this is not described as a pure-black-box test.

## Earlier failed attempts and bounded fixes

These attempts are retained as failure evidence, not folded into the passing run:

- At `d5f4928d6465780deb02199a77001954a39c655f`, the initial test prompt named the internal `claim_completion` action. RootConversation answered that its own profile lacked file and completion tools and did not create a Work. The old waiter then timed out; Vitest recorded one failed test after 499.8 seconds. The public response was terminal `Answered`, with no Work approval/current Work. This motivated RootConversation guidance v7 and a natural user prompt that does not prescribe internal tools.
- At `de8d44c5944c904e49d20844fe9b97bdb5d10951`, RootConversation did create the current Work, but the WorkEpisode yielded on `VerificationChanged` before a file effect or CompletionClaim. Public Work remained Open and Verification was empty. The run was explicitly early-aborted after preserving the isolated capture/public-state record; it is not represented as a normal Vitest failure. This exposed the missing WorkEpisode execution-role context.
- The first attempt also exposed the full-path capture bug for `/v1/chat/completions`; the matcher now accepts the configured-origin capture path suffix and tests both root-mounted and `/v1` paths. PublicClient requests now share the bounded 20-minute journey deadline, with a 22-minute outer timeout and bounded teardown.

The integrated correction at `53c36a77` fills the existing optional BaseLoop slot only for `WorkspaceWork` turns; it does not add a prompt-program slot or a Runtime-wide prohibition on legal Waits. Test SHA `c69e87c7` adds an evidence-backed early diagnostic only when the current Work is Open, the Provider requested `Yielded` on that same Work’s `VerificationChanged`, a matching durable `WorkWait` exists, and there is no CompletionClaim, target proof, or Verification. Exact approval waits, dependency waits, mixed external conditions, and waits with a claim/proof/Verification are not classified as this self-wait failure.

## Qualification boundary and remaining work

This result qualifies one bounded Work → effect → independent Verification PASS → human Acceptance → Completed → restart/read path for the recorded candidate and provider profile. It does not qualify the full long-running S1 scenario, other providers/models, all tasks, or S2/S3/S4. The release matrix’s broader requirement for representative S1–S4 journeys, restart/resume, approval, and failure recovery remains open.
