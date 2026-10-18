# Native OS Sandbox Wave A — Final Independent Review

**Review target:** `8b680a4b3f2a57680ff27dd8c4868c80a6081854`
**Scope:** Read-only final review of Wave A remediation and its storage overlay
against the accepted Native OS Sandbox contract and fixed implementation plan.
**Result:** **Wave A closed; B0 = 0, B1 = 0, B2 = 0.**

## Reviewed commit sequence

- `c947587df33a2caec7f5a898d2e7460c303a7c37` — initial provider-neutral
  runtime boundary and shell spawn routing.
- `e8bf4c7e27d8bb762d76e439367f14610f2969d8` — remediation adding strict
  policy codecs/bindings, process capability registration, typed unavailable
  propagation, timeout clamping and compiler-token architecture scanning.
- `f705a517f7f9e0bb46e527bb438d96beaea539b4` — schema 49/50 storage overlay.
- `8b680a4b3f2a57680ff27dd8c4868c80a6081854` — final review-gap fixes and
  Wave A evidence update. The storage overlay does not change Wave A files.

## Contract and threat-model disposition

The review confirms that the initial findings were addressed:

- Historical `LocalTrusted` decoding canonicalizes to `TrustedLocal`; provider
  resolution uses the exact selected provider/version/capability revision and
  never falls back.
- `NetworkPolicyV1` has closed-field canonical codecs. Process policy requires
  a non-empty exact Execution/Episode binding and binds the handle, mounts,
  policy revision/digest, provider/version, network policy, environment
  allow-list, limits and audit references.
- Only executors explicitly registered with `processCapability:
  "SandboxProcess"` receive the runtime-owned runner. Runtime rejects missing
  or mismatched policy, execution/episode/handle/mount bindings, unsupported
  provider capability and invalid timeout before provider execution. Requested
  timeout is clamped to the policy wall-time limit.
- Provider unavailability retains its typed policy/provider/evidence/failure
  binding through ToolRuntime, Application handling, AgentLoopAction and
  `ExecutionDriveOutcome`.
- The architecture guard scans the declared production source extensions and
  rejects the reviewed static import, alias, dynamic import, native binding,
  Worker, VM and dynamic-code escape patterns. The P39 exception is fixed by
  LF-normalized source SHA-256 and exact process-call shape, with registered
  call-site checks.

The architecture scan is a static architecture tripwire. Under the accepted
threat model, hostile inputs do not include malicious trusted application
source or dependency supply-chain code; project plugins cannot inject
JavaScript, and dependencies run in child processes. The tripwire is not
required to provide a Turing-complete proof against deliberate obfuscation.
No constructor-chain bypass is present in the reviewed production source; if
one were introduced into a trusted executor, it would be an ordinary code
review defect under this contract.

## Qualification

Focused tests run against the reviewed Wave A files at the review target:

- Architecture boundary: **1 file / 22 tests passed**.
- Domain sandbox policy, P4 shell/pipeline and Application executable outcome:
  **4 files / 125 tests passed**.
- The no-run cases cover absent policy, episode mismatch, handle/mount mismatch,
  unregistered process capability, unsupported provider, provider-version
  mismatch and invalid requested timeout. Provider invocation is asserted zero
  for each rejection/unavailable case.

The working tree was clean before this review record was added. No
`docs/design/**`, implementation source, test source or migration file was
changed by this review.

## Boundary of this result

Wave A **does not implement or qualify an OS sandbox provider** and makes no
`Supported` provider or release claim. P9 durable
`SandboxProviderUnavailableFactV1` and P10 queue/event/Attention persistence
remain Wave D work after storage integration. That exclusion is a later-stage
boundary, not an open Wave A finding.
