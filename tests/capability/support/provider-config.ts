import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Provider configuration file (`capability.config.json` at the repo root, or
 * a path in ARBOR_CAPABILITY_CONFIG). Environment variables always override
 * file entries, so CI can pin a run without touching the file. */
export interface ProviderConfigFile {
  readonly providerUrl?: string;
  readonly model?: string;
  readonly serverBuildId?: string;
  readonly auth?: "none" | "env";
  /** Name of the environment variable holding the API key (preferred — the
   * key never lands in a file). */
  readonly apiKeyVar?: string;
  /** Literal key for local use. The file must never be committed. */
  readonly apiKey?: string;
  readonly modelRevision?: string;
  readonly evidenceDir?: string;
}

export interface ResolvedProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision?: string;
  readonly apiKey?: string;
  readonly evidenceDir?: string;
  /** Where each resolved field came from (evidence/diagnostics only). */
  readonly source: {
    readonly file: string | null;
    readonly envKeys: ReadonlyArray<string>;
  };
}

const configFilePath = (): string | null => {
  const explicit = process.env.ARBOR_CAPABILITY_CONFIG?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const defaultPath = resolve(repoRoot, "capability.config.json");
  return existsSync(defaultPath) ? defaultPath : null;
};

const readConfigFile = (): {
  readonly path: string | null;
  readonly value: ProviderConfigFile;
} => {
  const path = configFilePath();
  if (path === null) {
    return { path: null, value: {} };
  }
  if (!existsSync(path)) {
    throw new Error(
      `capability provider config file ${path} does not exist (ARBOR_CAPABILITY_CONFIG)`,
    );
  }
  try {
    return {
      path,
      value: JSON.parse(readFileSync(path, "utf8")) as ProviderConfigFile,
    };
  } catch (error) {
    throw new Error(
      `capability provider config file ${path} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export const resolveProviderConfig = (): ResolvedProviderConfig => {
  const { path, value: file } = readConfigFile();
  const envKeys: Array<string> = [];

  const fromEnv = (key: string): string | undefined => {
    const raw = process.env[key]?.trim();
    if (raw !== undefined && raw.length > 0) {
      envKeys.push(key);
      return raw;
    }
    return undefined;
  };

  const baseUrl = fromEnv("ARBOR_CAPABILITY_PROVIDER_URL") ?? file.providerUrl;
  const model = fromEnv("ARBOR_CAPABILITY_MODEL") ?? file.model;
  const serverBuildId =
    fromEnv("ARBOR_CAPABILITY_SERVER_BUILD_ID") ?? file.serverBuildId;
  const authRaw = fromEnv("ARBOR_CAPABILITY_AUTH") ?? file.auth ?? "none";
  if (authRaw !== "none" && authRaw !== "env") {
    throw new Error(
      'provider auth must be "none" or "env" (ARBOR_CAPABILITY_AUTH or capability.config.json "auth")',
    );
  }

  const apiKeyVar =
    file.apiKeyVar !== undefined && file.apiKeyVar.length > 0
      ? file.apiKeyVar
      : undefined;
  const envApiKey = fromEnv("ARBOR_CAPABILITY_API_KEY");
  const varApiKey = apiKeyVar?.trim()
    ? (process.env[apiKeyVar.trim()] ?? "").trim() || undefined
    : undefined;
  const apiKey = envApiKey ?? varApiKey ?? file.apiKey;
  if (authRaw === "env" && apiKey === undefined) {
    throw new Error(
      "provider auth=env requires a key (ARBOR_CAPABILITY_API_KEY, apiKeyVar, or apiKey)",
    );
  }

  const modelRevision =
    fromEnv("ARBOR_CAPABILITY_MODEL_REVISION") ?? file.modelRevision;
  const evidenceDir =
    process.env.ARBOR_CAPABILITY_EVIDENCE_DIR?.trim() || file.evidenceDir;

  return {
    baseUrl: baseUrl ?? "",
    model: model ?? "",
    serverBuildId: serverBuildId ?? "",
    authMode: authRaw,
    ...(modelRevision === undefined || modelRevision.length === 0
      ? {}
      : { modelRevision }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(evidenceDir === undefined || evidenceDir.length === 0
      ? {}
      : { evidenceDir: resolve(repoRoot, evidenceDir) }),
    source: {
      file: path === null ? null : path,
      envKeys: [...new Set(envKeys)],
    },
  };
};

export const providerConfigReady = (
  config: ResolvedProviderConfig,
): { readonly ready: boolean; readonly missing: ReadonlyArray<string> } => {
  const missing: Array<string> = [];
  if (!config.baseUrl) missing.push("providerUrl");
  if (!config.model) missing.push("model");
  if (!config.serverBuildId) missing.push("serverBuildId");
  return { ready: missing.length === 0, missing };
};
