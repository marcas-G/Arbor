# Focused test impact execution

Purpose: shorten feedback by running the smallest trustworthy evidence layer
that covers a change, while keeping each evidence claim attached to the boundary
that can prove it. The impact planner recommends lanes; it does not execute
tests and never grants release coverage.

## Order of evidence

1. **Deterministic contracts and state transitions.** Run domain, codec,
   command/receipt, and model-context tests first. For generated sequence tests,
   retain the random seed and minimized counterexample as a fixed regression
   vector. These checks establish local transition and serialization rules;
   they do not establish process recovery or external side effects.
2. **Component and persistence boundaries.** Exercise the owning adapter/store,
   SQLite transaction, migration, and provider-runtime component with fixed,
   versioned fixtures. Use real SQLite transactions for uniqueness and
   rollback claims. Fixture metadata must identify schema version, builder
   version, and content fingerprint so stale fixtures cannot silently pass.
3. **Scripted production process.** For changes crossing Runtime/application,
   command, recovery, or durable boundaries, start the production daemon against
   an isolated database and controlled HTTP/tool boundary. Place deterministic
   crashes at the contract's commit edges and assert both public observations
   and canonical durable facts. Keep each case independently selectable and
   preserve zero retries.
4. **Real provider.** Run the separately governed real-provider qualification
   when the changed surface can affect prompts, model context, provider
   adapters, tool selection, or a required release scenario. A captured,
   redacted transcript is useful for deterministic replay and diagnosis; replay
   proves adapter/recovery behavior against that transcript, never that a live
   provider behaved correctly. Record source/config/provider identity and the
   semantic oracle for each live qualification.
5. **Browser and package boundary.** Run the affected browser flow for Web/UI
   or user-visible API changes, and the clean-checkout package lane for package,
   lockfile, startup, or distribution changes. A browser pass does not replace
   process/recovery evidence.
6. **Final candidate qualification.** After fixes are integrated and the tree
   is committed and clean, run the complete configured `pnpm check`,
   `pnpm test:functional`, and `pnpm test:functional:package` once on the exact
   candidate SHA. If a run is interrupted, use only the existing audited
   compatible-resume mechanism and retain its source SHA and inherited-file
   list. A selected-lane or resumed subset is not a single uninterrupted run;
   report what actually executed and what was inherited.

## Impact planner

Use a known comparison point:

```powershell
node scripts/testing/plan-test-impact.mjs --base <git-ref>
```

For a manual/read-only preview, pass explicit changed paths:

```powershell
node scripts/testing/plan-test-impact.mjs --changed packages/agent-runtime/src/agent-loop-driver.ts
```

The JSON response includes changed paths, matching rules, high-risk tags,
selected lanes, commands, and reasons. `selected-lane` means the lane's whole
configured command; `full-lane` means a high-risk rule explicitly expanded to
that entire lane. An unclassified path selects every lane conservatively.
Provider selection does not launch an L3 real-provider run; that decision
remains explicit. `completeCoverage` is always `false` in planner output.

The current map is intentionally conservative and hand-maintained in
`planning/testing/impact-map.json`. Add path ownership and risk edges as code
areas move. If the planner cannot classify a change, do not narrow the run based
on intuition: update the map or use the conservative recommendation. The final
release profile remains the complete manifest inventory with zero retries.

## Evidence limits

- A state-machine/property result proves only the generated model and asserted
  invariants. It does not prove adapter transactionality or daemon restart.
- A component result proves the selected implementation boundary and fixture;
  it does not prove public API visibility or browser behavior.
- A scripted process result proves the named process/fault matrix, not every
  possible interleaving, live model response, native OS enforcement, or
  preserved user-database upgrade.
- A live provider result is bounded to its exact provider/model/config/source
  and scenario. It cannot be synthesized by replaying a capture.
- A release-manifest pass proves only the inventory and exact revision named in
  its result artifact. It does not subsume Native OS, online database, or other
  separately governed release gates.
