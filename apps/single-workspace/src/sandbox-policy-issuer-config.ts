import { createHash } from "node:crypto";
import {
  decodeSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  type SandboxPolicyGrantIssuerConfigSnapshotV1,
} from "@arbor/domain";
import type { TrustedHostConfigurationSourceService } from "@arbor/ports";

/** Read once during P5 composition. A missing, invalid or unavailable trusted
 * source disables only sandbox policy authority; there is no env/local-user
 * fallback. The source adapter owns OS protection and monotone revision. */
export const loadSandboxPolicyGrantIssuerConfigSnapshot = (
  source: TrustedHostConfigurationSourceService | undefined,
): SandboxPolicyGrantIssuerConfigSnapshotV1 | undefined => {
  if (source === undefined) return undefined;
  try {
    const config = decodeSandboxPolicyGrantIssuerConfigV1(
      source.readVerified("sandboxPolicyGrantIssuerConfigV1"),
    );
    if (config === undefined) return undefined;
    const canonicalJson = encodeSandboxPolicyGrantIssuerConfigV1(config);
    const configDigest = createHash("sha256")
      .update(canonicalJson, "utf8")
      .digest("hex");
    return Object.freeze({
      config: Object.freeze({
        ...config,
        operators: Object.freeze([...config.operators]),
      }),
      configDigest,
    });
  } catch {
    return undefined;
  }
};
