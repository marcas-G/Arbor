# Installed Linux executor artifact binding

This checkpoint advances the Linux coding-agent delivery goal. It does not
qualify process execution for ordinary users or complete release acceptance.
No design documents or preserved user databases were changed in this step.

## Implemented behavior

Production now reads full installed files for all eight V2 manifest roles at
capability/effect admission. Missing or changed files cannot qualify a V2 row.
The fixed catalog accepts roles only, never paths from a manifest or project.

| Role | Installed file |
| --- | --- |
| adapter-runtime | This installation's resolved sandbox-native-posix `dist/index.js` |
| adapter-source | The same package's shipped `src/index.ts` |
| bwrap | `/usr/bin/bwrap` |
| qualification-control | `/usr/bin/setpriv`, which installs the inherited command filter |
| relay-runtime | The shipped `src/transport/network-proxy-helper.mjs` |
| relay-source | The same JavaScript file; it runs without transpilation |
| systemctl | `/usr/bin/systemctl` |
| systemd-run | `/usr/bin/systemd-run` |

The seccomp BPF is embedded in adapter index.ts and therefore also in index.js;
there is no separately loaded, unhashed filter module. The generator replaces
only the marked generated section. Probe and execution use the same absolute
tool paths, independent of inherited PATH.

V2 mounts the fixed installed relay directly instead of writing an unbound
temporary helper. V1 retains its per-invocation copy from that same shipped
JavaScript. Missing relay material is read at admission/open, not at application
module import, so it does not prevent model configuration or diagnostics.

`arbor doctor` and production now share `probeInstalledLinuxSandbox`, including
manifest, actual artifact bytes and host prerequisites. A registry row alone
cannot produce a ready diagnostic. Doctor exits unsuccessfully when a required
check, including Linux command readiness, fails.

## Validation and failures

- Native POSIX policy/execution file: 46/46, with native execution enabled.
  The V2 fixture additionally verifies both missing and changed bytes for each
  of the eight roles, and rejects an absent artifact reader.
- Actual native command-boundary regressions: 4/4, including C compilation,
  both mount-access socket cases, and internal TCP/process support.
- Network transport/lifecycle file: 18/18 after the fixed-relay change.
- Architecture: 198/198 after updating the supervisor boundary assertions to
  require absolute executable paths. Root test typecheck and production build
  passed; changed-file Biome and diff whitespace checks passed.
- Final shared-probe build: root test typecheck, architecture 198/198 and
  launcher tests 4/4 passed. Regenerating the embedded filter and formatting
  index.ts reproduced the packaged adapter source byte-for-byte.
- The two external Git journeys still failed with GitHub CONNECT 504.
  Their failure is retained; no skip, shorter journey or fake network success
  replaced them.

The previously running complete functional batch terminated with exit 1:
268 passed, 1 failed, 1 skipped; `completeCoverage=false`. Its result is
`.test-results/2026-11-15T22-08-38-493Z-1139599/result-manifest.json`.
The browser stage did not run. Runtime builds changed during this long run,
so this batch also cannot establish a single final distribution baseline.

Its failure initially hit SQLITE_BUSY in the lease-takeover fixture's direct
connection. That connection now uses a five-second busy timeout, matching its
independent-daemon writer scenario. The subsequent focused run exposed a
pre-P40 assertion requiring the recovered invocation to stay unsettled.
Current P4 06 / DID v1.41 requires durable terminal OutcomeUnknown evidence.
The corrected test preserves the stale-worker fence, one effect, consumed
approval and absence of successful observations, and additionally checks the
exact unknown refs, stored bytes and version-prefixed observation digest.
The first strengthened digest assertion omitted the format prefix and failed;
after correcting it, the focused real-daemon scenario passed 1/1.
This does not turn the failed complete batch into a pass.

## Package evidence and limits

An intermediate extracted preview in
`.test-results/installed-artifact-catalog-final-20261116/` verified all eight
actual files and exact relay identity. Its archive SHA-256 is
`04b2d47334a22c06cc07dcc5566a8ab77cf0acc533b84b919bea4e98716fd093`.
The adapter and relay in that package passed nine low-level bwrap diagnostics:
host socket denial/descendant inheritance, internal TCP/processes, namespace
and proc restrictions, real C compilation, real npm installation plus a Node
assertion, and example.com HTTPS 200. These tests invoke the installed plan
builder directly; they do not establish cgroup qualification, ordinary
production admission, two Workspace behavior or a real-model browser journey.

In that disposable extraction, changing/removing the relay was observed on
the next artifact read; a fresh process could import diagnostics with the
relay missing and reported it unavailable. Arbitrary path/inherited-property
inputs were rejected. Original relay bytes were restored exactly. Raw results:

- `installed-verification.json`
- `installed-development-result.json`
- `installed-drift-verification.json`

The shared doctor probe was added after this intermediate package. Its new
package evidence is recorded separately in
`.test-results/installed-artifact-catalog-doctor-20261116/`; the intermediate
archive does not inherit later source changes.

The final preview is `arbor-0.0.0-preview-6ec7eb5d655d-7166d262-linux-x64.tar.gz`,
SHA-256 `9939a4224cd453c6268d022c539dd9f6cd1a8da8c510fa3e954c4dcc3214a472`.
Its extracted installation again verified all eight files and exact relay
identity. Its real host probe without authority reported Experimental /
QualificationEvidenceUnavailable; its actual `bin/arbor doctor` printed the
unavailable command-environment message and exited 1. The same final package
also passed the nine low-level development diagnostics listed above, including
real npm installation plus its Node assertion, C compilation and HTTPS 200.
See `installed-verification.json` and `installed-development-result.json` in
that final evidence directory. No browser or real-model journey was run for
this package, and `releaseQualified` remains false.

Remaining delivery work includes the independent complete qualification and
installation flow, schema version alignment required by DID 8.3, actual
acceptance/landing audit consistency, GitHub network access, service reuse and
preview, and the final installed real-model browser/two-Workspace journey.
No Supported authority row was created by these checks.
