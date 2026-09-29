import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ModelDeployment,
  ProviderExecutionPolicyOverrides,
} from "@arbor/ports";
import { secretRef } from "@arbor/ports";

/**
 * Standard Arbor configuration file (`arbor.config.json`).
 *
 * The provider section is the ModelDeployment source of truth (P16 `01`
 * §5): pure data, SecretRef only — the raw credential NEVER lives in this
 * file. Resolution precedence: config file → legacy env vars → the
 * deterministic fake provider (CI never needs network).
 *
 * Lookup order for the file itself: $ARBOR_CONFIG, then ./arbor.config.json,
 * then ~/.config/arbor/arbor.config.json.
 */

export interface ArborProviderSecretConfig {
  /** "env": `ref` names the environment variable holding the key.
   *  "file": `ref` is a path (relative to `root` when given) to a file whose
   *  trimmed content is the key. */
  readonly kind: "env" | "file";
  readonly ref: string;
  readonly root?: string;
}

export interface ArborProviderConfigFile {
  readonly provider: {
    readonly deploymentId: string;
    readonly modelRef: string;
    readonly endpoint?: string;
    readonly wireModelName?: string;
    readonly secret?: ArborProviderSecretConfig;
    readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
    readonly extraHeaders?: ReadonlyArray<Record<string, string>>;
  };
}

export interface LoadedProviderConfig {
  readonly deployment: ModelDeployment;
  /** Which secret adapter must back the SecretStorePort for this ref kind. */
  readonly secretStore:
    | { readonly _tag: "Env" }
    | { readonly _tag: "File"; readonly root: string };
}

export type ProviderConfigError = {
  readonly _tag: "ProviderConfigInvalid";
  readonly path: string;
  readonly reason: string;
};

const DEFAULT_CONFIG_FILENAME = "arbor.config.json";

const candidatePaths = (): ReadonlyArray<string> => {
  const paths: string[] = [];
  const explicit = process.env.ARBOR_CONFIG;
  if (explicit !== undefined && explicit.length > 0) {
    paths.push(explicit);
  }
  paths.push(resolve(process.cwd(), DEFAULT_CONFIG_FILENAME));
  const home = process.env.HOME;
  if (home !== undefined) {
    paths.push(resolve(home, ".config", "arbor", DEFAULT_CONFIG_FILENAME));
  }
  return paths;
};

/** Find and parse the standard config file; undefined = no config present. */
export type ArborConfigFileResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly config: ArborProviderConfigFile;
    }
  | { readonly ok: false; readonly error: ProviderConfigError };

export const findArborConfigFile = (): ArborConfigFileResult | undefined => {
  for (const path of candidatePaths()) {
    if (!existsSync(path)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      return {
        ok: false,
        error: {
          _tag: "ProviderConfigInvalid",
          path,
          reason: `JSON parse failed: ${String(cause)}`,
        },
      };
    }
    const config = parsed as ArborProviderConfigFile;
    if (
      typeof config !== "object" ||
      config === null ||
      typeof config.provider !== "object" ||
      config.provider === null ||
      typeof config.provider.deploymentId !== "string" ||
      config.provider.deploymentId.length === 0 ||
      typeof config.provider.modelRef !== "string" ||
      config.provider.modelRef.length === 0
    ) {
      return {
        ok: false,
        error: {
          _tag: "ProviderConfigInvalid",
          path,
          reason:
            "provider.deploymentId and provider.modelRef are required strings",
        },
      };
    }
    const secret = config.provider.secret;
    if (
      secret !== undefined &&
      ((secret.kind !== "env" && secret.kind !== "file") ||
        typeof secret.ref !== "string" ||
        secret.ref.length === 0 ||
        (secret.kind === "file" &&
          !isAbsolute(secret.ref) &&
          secret.root === undefined))
    ) {
      return {
        ok: false,
        error: {
          _tag: "ProviderConfigInvalid",
          path,
          reason:
            "provider.secret must be { kind: 'env' | 'file', ref, root? }; relative file refs require root",
        },
      };
    }
    return { ok: true, path, config };
  }
  return undefined;
};

/** Build the deployment + secret-store selection from a parsed config file. */
export const providerDeploymentOfConfig = (
  config: ArborProviderConfigFile,
): {
  readonly deployment: ModelDeployment;
  readonly secretStore: LoadedProviderConfig["secretStore"];
} => {
  const provider = config.provider;
  const secret = provider.secret;
  return {
    deployment: {
      deploymentId: provider.deploymentId,
      modelRef: provider.modelRef,
      ...(provider.endpoint !== undefined && provider.endpoint.length > 0
        ? { endpoint: provider.endpoint }
        : {}),
      ...(provider.wireModelName !== undefined &&
      provider.wireModelName.length > 0
        ? { wireModelName: provider.wireModelName }
        : {}),
      ...(secret !== undefined ? { secretRef: secretRef(secret.ref) } : {}),
      ...(provider.executionPolicyOverrides !== undefined
        ? { executionPolicyOverrides: provider.executionPolicyOverrides }
        : {}),
      ...(provider.extraHeaders !== undefined
        ? { extraHeaders: provider.extraHeaders }
        : {}),
    },
    secretStore:
      secret?.kind === "file"
        ? { _tag: "File", root: secret.root ?? resolve(process.cwd()) }
        : { _tag: "Env" },
  };
};
