# Native OS Sandbox Windows T3-B test checkpoint

Date: 2026-10-19. Baseline: `e9d18a52481fba760361eff8407cb22f13592df1`.
Scope: test-only extension of the C# native bridge and Vitest fixture on Windows
10.0.19044 x64. No V6 authority, production `run`, provider capability row,
online data, or `docs/design/**` file was changed.

## Disposable fixture and ACL restoration

The fixture creates a disposable temporary root with `admitted/root.txt`,
`forbidden/private.txt`, `control/control.db`, and an `admitted/escape`
junction to the forbidden directory. The control DB is a fixture text file,
not an Arbor database. The test compiles its own child executable in another
temporary directory.

The bridge creates a fresh AppContainer profile with zero capabilities. It
grants that profile only read/execute on the executable directory and child
binary, read/execute on the fixture root, and read/write on the admitted
directory and file. These are explicit, non-inheritable DACL grants; no grant
is placed on the forbidden sibling, control DB, or junction target. Every
modified directory/file DACL is recorded before mutation and rewritten in
`finally`, including when launch or a child probe fails. An injected failure
immediately after both bootstrap ACL grants proves restoration and profile
deletion occur without spawning a child. Restoration verifies
the original allow-ACE set. Windows can reorder equivalent allow ACEs while
writing a DACL; a pre-existing deny or other order-sensitive ACE makes this
test bridge fail closed instead of using order-insensitive comparison. The
bridge reports two restored ACL snapshots for ordinary launches and five for
the filesystem probe. Disposable roots are validated before recursive test
cleanup.

## Observed controls and limits

| Probe | Observation |
|---|---|
| Admitted root | Child read and appended to `root.txt`; parent observed the exact appended marker. |
| Forbidden sibling and control DB | Child read and append attempts each raised `UnauthorizedAccessException`; parent confirmed both files remained unchanged. |
| Junction escape | Child read and append through `admitted/escape` raised `UnauthorizedAccessException`; the target file remained unchanged. A separate bounded static preflight detected the reparse point before any child spawn. |
| Inherited handles | The default launch advertises two stdout/stderr handles; both are valid in the child. A third parent event is inheritable but absent from that list. The child cannot wait on its numeric handle (this host raises `SEHException`); a deliberate three-handle positive control can wait on it and returns `WAIT_TIMEOUT=258`. |
| Disabled direct network | `TokenCapabilities` query returned 0. A live loopback listener accepted no connection; the child did not complete its bounded two-second loopback connect. Literal private `192.168.0.1` and reserved public `203.0.113.1` attempts returned WSAEACCES 10013. No application data was sent. |

The junction result proves denial to this forbidden target and detection in a
static preflight. It does not prove race-resistant reparse handling, hard-link
defense, or exact mounts for a production runner. The loopback timeout and
empty listener prove no connection in the probe window; they do not identify
an OS denial code or prove an indefinite loopback block. The handle test is a
differential sentinel check, not exhaustive enumeration of every child handle.
These limits keep full T3 qualification open.

No Restricted/Enabled network broker, DNS/IP pinning, or redirect behavior was
implemented or claimed. `windows-restricted-appcontainer-job` remains
Experimental with empty tuples and typed Unavailable; no Windows provider is
Supported.

## Source pins and verification

The existing `.gitattributes` rule keeps the two C# sources LF on checkout;
Vitest checks their exact SHA-256 bytes before compilation:

| Source | SHA-256 |
|---|---|
| `adapters/sandbox-windows/test/native/WindowsSandboxBridgeHarness.cs` | `1b26026d28f27ef11a1d8cb5a9b9f90e5641e13bd510bebfe7d9a7e59b29e926` |
| `adapters/sandbox-windows/test/native/WindowsSandboxChild.cs` | `cc7473e7b8496357f40728f67b8963bf3f70fafa6469c03acb2e47e73711b42d` |

The compiler output has no trusted binary attestation. This checkpoint does
not issue a T3 operator evidence manifest or a Supported tuple.

- Windows native bridge plus existing provider tests: PASS, 12/12.
- Windows adapter architecture and package DAG tests: PASS, 15/15.
- `pnpm exec tsc -p adapters/sandbox-windows/tsconfig.json --noEmit`: PASS.
- `pnpm exec biome check adapters/sandbox-windows/test/windows-native-bridge.test.ts`: PASS.
- `git diff --check`: PASS.
