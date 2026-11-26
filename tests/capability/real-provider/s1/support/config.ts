// Shared REAL public S1 opt-in config readiness — moved verbatim from
// public-s1-lifecycle.test.ts (B5 split).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findArborConfigFile } from "../../../../../apps/single-workspace/src/provider-config.js";
import { validateRealJourneyEvidenceRoot } from "../../public-real-journey-support.js";
import type { ProductionProviderConfig } from "./captures.js";
import type { ConfigReadiness } from "./oracles.js";

export const OPT_IN_ENV = "ARBOR_RUN_REAL_PUBLIC_S1";
export const CONFIG_PATH_ENV = "ARBOR_PUBLIC_S1_CONFIG";
export const EVIDENCE_ROOT_ENV = "ARBOR_PUBLIC_REAL_EVIDENCE_ROOT";
export const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
export const CAPTURE_ENDPOINT_ENV = "ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT";
export const JOURNEY_TIMEOUT_MS = 8 * 60_000;
export const JOURNEY_BUDGET_MS = 20 * 60_000;
export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
export const fetchHook = fileURLToPath(
  new URL("../provider-fetch-capture-hook.mjs", import.meta.url),
);

export const productionProviderConfig = (): ConfigReadiness => {
  try {
    const configuredPath =
      process.env[CONFIG_PATH_ENV]?.trim() ||
      process.env.ARBOR_CONFIG?.trim() ||
      (existsSync("C:\\Arbor\\arbor.config.json")
        ? "C:\\Arbor\\arbor.config.json"
        : undefined);
    const previousConfigPath = process.env.ARBOR_CONFIG;
    let found: ReturnType<typeof findArborConfigFile>;
    try {
      if (configuredPath !== undefined)
        process.env.ARBOR_CONFIG = resolve(configuredPath);
      found = findArborConfigFile();
    } finally {
      if (configuredPath !== undefined) {
        if (previousConfigPath === undefined) delete process.env.ARBOR_CONFIG;
        else process.env.ARBOR_CONFIG = previousConfigPath;
      }
    }
    if (found === undefined) {
      return {
        ready: false,
        reason: "production arbor.config.json was not found",
      };
    }
    if (!found.ok) {
      return { ready: false, reason: "production provider config is invalid" };
    }
    const provider = found.config.provider;
    const secretKind = provider.secret?.kind;
    const missing: Array<string> = [];
    if (provider.deploymentId.trim().length === 0) missing.push("deploymentId");
    if (provider.modelRef.trim().length === 0) missing.push("modelRef");
    if (
      provider.endpoint?.trim().length === 0 ||
      provider.endpoint === undefined
    ) {
      missing.push("endpoint");
    }
    if (
      provider.wireModelName?.trim().length === 0 ||
      provider.wireModelName === undefined
    ) {
      missing.push("wireModelName");
    }
    if (
      secretKind !== "env" &&
      secretKind !== "file" &&
      secretKind !== "inline"
    ) {
      missing.push("SecretStore-backed provider.secret");
    }
    if (missing.length > 0) {
      return {
        ready: false,
        reason: `production config missing ${missing.join(", ")}`,
      };
    }
    const endpoint = provider.endpoint as string;
    const parsedEndpoint = new URL(endpoint);
    if (
      parsedEndpoint.protocol !== "https:" &&
      parsedEndpoint.protocol !== "http:"
    ) {
      return {
        ready: false,
        reason: "production provider endpoint must use HTTP(S)",
      };
    }
    return {
      ready: true,
      config: {
        path: resolve(found.path),
        deploymentId: provider.deploymentId,
        modelRef: provider.modelRef,
        endpoint,
        wireModelName: provider.wireModelName as string,
        secretKind: secretKind as ProductionProviderConfig["secretKind"],
      },
    };
  } catch {
    // Do not leak config parser errors: they may quote configuration content.
    return {
      ready: false,
      reason: "production provider config could not be resolved",
    };
  }
};

export const readinessAtLoad = productionProviderConfig();
export const missingBuildAssets = (): ReadonlyArray<string> =>
  [
    [
      "apps/single-workspace/dist/main.js",
      resolve(repositoryRoot, "apps/single-workspace/dist/main.js"),
    ],
    [
      "apps/web/dist/index.html",
      resolve(repositoryRoot, "apps/web/dist/index.html"),
    ],
  ]
    .filter(([, path]) => !existsSync(path as string))
    .map(([label]) => label as string);
export const buildAssetsMissingAtLoad = missingBuildAssets();
export const evidenceRootReadiness = validateRealJourneyEvidenceRoot(
  process.env[EVIDENCE_ROOT_ENV],
);
export const skipReason =
  process.env[OPT_IN_ENV] !== "1"
    ? `set ${OPT_IN_ENV}=1 to explicitly opt in`
    : readinessAtLoad.ready
      ? evidenceRootReadiness.ready
        ? undefined
        : evidenceRootReadiness.reason
      : readinessAtLoad.reason;
