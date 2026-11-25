import { createHash } from "node:crypto";
import {
  encodeSandboxEnforcementRuleSetV2,
  sandboxEnforcementRuleSetV2ForProvider,
} from "@arbor/domain";
import type { TrustedHostConfigurationSourceService } from "@arbor/ports";
import { probeLinuxBwrapHost } from "@arbor/sandbox-native-posix";
import { readInstalledLinuxQualificationArtifact } from "./sandbox-linux-artifacts.js";
import {
  readLinuxSandboxQualificationEvidence,
  readLinuxSupportedQualificationRows,
} from "./sandbox-linux-qualification.js";

/** Shared by production admission and `arbor doctor`. A registry row alone
 * cannot qualify a missing, changed or incompatible installed executor. */
export const probeInstalledLinuxSandbox = async (
  source: TrustedHostConfigurationSourceService | undefined,
) => {
  const qualificationRows = await readLinuxSupportedQualificationRows(source);
  const ruleSet = sandboxEnforcementRuleSetV2ForProvider("linux-bwrap");
  const v2Digest =
    ruleSet === undefined
      ? undefined
      : createHash("sha256")
          .update(encodeSandboxEnforcementRuleSetV2(ruleSet), "utf8")
          .digest("hex");
  return probeLinuxBwrapHost({
    platform: process.platform,
    networkBrokerChannel: "PrerequisiteDetected",
    qualificationRows,
    readQualificationArtifact: readInstalledLinuxQualificationArtifact,
    readQualificationEvidence: (ref) =>
      readLinuxSandboxQualificationEvidence(source, ref),
    ...(v2Digest !== undefined &&
    qualificationRows.some((row) => row.enforcementRuleSetDigest === v2Digest)
      ? { enforcementRuleSetVersion: 2 as const }
      : {}),
  });
};
