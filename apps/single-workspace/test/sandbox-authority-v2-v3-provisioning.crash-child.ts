import { join } from "node:path";
import { SandboxAuthorityProvisioningStore } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../dist/sandbox-authority-bundle.js";
import { makeSandboxAuthorityProvisioningFileStore } from "../dist/sandbox-authority-provisioning-file-store.js";
import { provisionSandboxAuthorityV2ToV3 } from "../dist/sandbox-authority-v2-v3-provisioning.js";

const [root, stage, nonce] = process.argv.slice(2);
if (root === undefined || stage === undefined || nonce === undefined)
  throw new Error("D2 V3 crash fixture arguments required");
const trust =
  '{"version":1,"revision":1,"sourceIdentity":"host:test","providerId":"windows-restricted-appcontainer-job","keys":[{"keyId":"operator-2026-a","algorithm":"Ed25519","publicKeySpkiDerBase64":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","publicKeySpkiSha256":"06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9","validFrom":"2026-10-20T00:00:00.000Z","validUntil":"2027-10-20T00:00:00.000Z","status":"Active"}],"revokedKeyIds":[]}';
const store = await Effect.runPromise(
  makeSandboxAuthorityProvisioningFileStore({
    protectedRoot: root,
    sourceFile: join(root, "authority.json"),
    highWaterFile: join(root, "high-water.json"),
    forensicDirectory: join(root, "forensic"),
    sourceIdentity: "host:test",
  }),
);

if (stage === "probe") {
  const loaded = await Effect.runPromise(
    loadSandboxAuthorityBundleSnapshotCurrent(
      store,
      "2026-10-20T00:00:00.000Z",
      [],
    ),
  );
  process.stdout.write(
    `ARBOR_D2_V3_RESTART:${nonce}:${JSON.stringify({
      _tag: loaded._tag,
      version:
        loaded._tag === "Available" ? loaded.snapshot.bundle.version : null,
      failure: loaded._tag === "Unavailable" ? loaded.failure : null,
    })}\n`,
  );
  process.exit(0);
}

const crash = (at: string) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        process.stdout.write(
          `ARBOR_D2_V3_KILL:${nonce}:${at}:${process.pid}\n`,
          () => {
            try {
              process.kill(process.pid, "SIGKILL");
            } catch {
              process.exit(86);
            }
            resolve();
          },
        );
      }),
  );

if (stage === "before-source") await Effect.runPromise(crash(stage));
await Effect.runPromise(
  Effect.provide(
    provisionSandboxAuthorityV2ToV3({
      trustSetCanonicalJson: trust,
      atStage: (current) =>
        (stage === "before-high-water" &&
          current === "AfterV3SourceDurableBeforeHighWater") ||
        (stage === "after-high-water" && current === "AfterV3HighWaterDurable")
          ? crash(stage)
          : Effect.void,
    }),
    Layer.succeed(SandboxAuthorityProvisioningStore, store),
  ),
);
