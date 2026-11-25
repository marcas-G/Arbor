import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ArborConfigFileResult } from "./provider-config.js";

export interface ModelSetup {
  readonly configured: boolean;
  readonly status: () => {
    readonly configured: boolean;
    readonly model: string | null;
  };
  readonly save: (input: unknown) => Promise<void>;
  readonly requestRestart: () => void;
}

export type FirstRunProcessExecutionMode = "Disabled" | "NativeOsSupportedOnly";

export class ModelSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const isLocal = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const decode = (input: unknown) => {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new ModelSetupError("invalid-input");
  const data = input as Record<string, unknown>;
  if (
    typeof data.endpoint !== "string" ||
    typeof data.model !== "string" ||
    typeof data.apiKey !== "string"
  )
    throw new ModelSetupError("invalid-input");
  const model = data.model.trim();
  const apiKey = data.apiKey.trim();
  if (
    !model ||
    model.length > 200 ||
    !apiKey ||
    apiKey.length > 16384 ||
    /[\r\n\0]/u.test(apiKey)
  )
    throw new ModelSetupError("invalid-input");
  let endpoint: URL;
  try {
    endpoint = new URL(data.endpoint.trim());
  } catch {
    throw new ModelSetupError("invalid-endpoint");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && isLocal(endpoint.hostname))
    )
  )
    throw new ModelSetupError("invalid-endpoint");
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
  return { endpoint: endpoint.href.replace(/\/+$/u, ""), model, apiKey };
};

const checkConnection = async (
  input: ReturnType<typeof decode>,
): Promise<void> => {
  try {
    const response = await fetch(`${input.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelSetupError(
        response.status === 401 || response.status === 403
          ? "authentication-failed"
          : "provider-rejected",
      );
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    if (
      !Array.isArray(body.choices) ||
      !body.choices.some(
        (choice) =>
          typeof choice.message?.content === "string" &&
          choice.message.content.length > 0,
      )
    )
      throw new ModelSetupError("invalid-provider-response");
  } catch (error) {
    // Never return the provider body, headers, key or fetch exception to the UI.
    if (error instanceof ModelSetupError) throw error;
    throw new ModelSetupError("connection-failed");
  }
};

const writeDurablePrivateFile = (filename: string, value: string) => {
  const fd = openSync(filename, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Host configuration, outside the domain command/event ledger. First-run only:
 * the credential is private file material; the config keeps a SecretRef. */
export const makeModelSetup = (options: {
  readonly loaded: ArborConfigFileResult | undefined;
  readonly configured: boolean;
  /** The launcher supplies the current host qualification result. This is
   * only used when creating a brand-new config; an existing runtime setting
   * remains the user's immutable startup snapshot. */
  readonly firstRunProcessExecutionMode?: FirstRunProcessExecutionMode;
  readonly configPath?: string;
  readonly requestRestart: () => void;
  readonly checkConnection?: (input: {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey: string;
  }) => Promise<void>;
}): ModelSetup => {
  const configPath = resolve(
    options.configPath ??
      (options.loaded?.ok === true
        ? options.loaded.path
        : (process.env.ARBOR_CONFIG ??
          join(homedir(), ".config/arbor/arbor.config.json"))),
  );
  let saving = false;
  let saved = false;
  return {
    configured: options.configured,
    status: () => ({
      configured: options.configured,
      model:
        options.loaded?.ok === true
          ? (options.loaded.config.provider.wireModelName ?? null)
          : null,
    }),
    requestRestart: options.requestRestart,
    save: async (value) => {
      if (options.configured) throw new ModelSetupError("already-configured");
      if (saving || saved) throw new ModelSetupError("save-in-progress");
      const input = decode(value);
      saving = true;
      try {
        await (options.checkConnection ?? checkConnection)(input);
        const parent = dirname(configPath);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        const stat = lstatSync(parent);
        if (
          !stat.isDirectory() ||
          (process.getuid !== undefined && stat.uid !== process.getuid()) ||
          (stat.mode & 0o022) !== 0
        )
          throw new ModelSetupError("unsafe-config-directory");
        if (existsSync(configPath)) {
          const current = lstatSync(configPath);
          if (
            !current.isFile() ||
            (process.getuid !== undefined &&
              current.uid !== process.getuid()) ||
            (current.mode & 0o022) !== 0
          )
            throw new ModelSetupError("unsafe-config-file");
        }
        const secretRoot = `${configPath}.secrets`;
        mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
        const secretDirectory = lstatSync(secretRoot);
        if (
          !secretDirectory.isDirectory() ||
          (process.getuid !== undefined &&
            secretDirectory.uid !== process.getuid()) ||
          (secretDirectory.mode & 0o077) !== 0
        )
          throw new ModelSetupError("unsafe-config-directory");
        if (!existsSync(join(secretRoot, ".gitignore")))
          writeDurablePrivateFile(join(secretRoot, ".gitignore"), "*\n");
        const secretName = `provider-${randomUUID()}.key`;
        writeDurablePrivateFile(join(secretRoot, secretName), input.apiKey);
        const secrets = openSync(secretRoot, "r");
        try {
          fsyncSync(secrets);
        } finally {
          closeSync(secrets);
        }
        const temporary = join(parent, `.arbor-config-${randomUUID()}.pending`);
        const config = {
          ...(options.loaded?.ok === true ? options.loaded.config : {}),
          ...(options.loaded?.ok !== true
            ? {
                runtime: {
                  processExecutionMode: {
                    version: 1,
                    processExecutionMode:
                      options.firstRunProcessExecutionMode ?? "Disabled",
                  },
                },
              }
            : {}),
          provider: {
            deploymentId: `local-${randomUUID()}`,
            modelRef: "model-openai",
            endpoint: input.endpoint,
            wireModelName: input.model,
            secret: { kind: "file", root: secretRoot, ref: secretName },
          },
        };
        writeDurablePrivateFile(
          temporary,
          `${JSON.stringify(config, null, 2)}\n`,
        );
        renameSync(temporary, configPath);
        const directory = openSync(parent, "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
        saved = true;
      } catch (error) {
        if (error instanceof ModelSetupError) throw error;
        throw new ModelSetupError("configuration-write-failed");
      } finally {
        saving = false;
      }
    },
  };
};

/** Existing file/env/inline deployments remain valid. This tests material
 * availability only; a network probe occurs on first-run save. */
export const hasConfiguredModel = (
  loaded: ArborConfigFileResult | undefined,
): boolean => {
  if (loaded?.ok !== true)
    return Boolean(
      process.env.ARBOR_MODEL_BASE_URL &&
        process.env.ARBOR_MODEL_NAME &&
        process.env[
          process.env.ARBOR_MODEL_API_KEY_VAR ?? "ARBOR_MODEL_API_KEY"
        ],
    );
  const provider = loaded.config.provider;
  if (
    provider.modelRef === "model-fake" ||
    provider.modelRef === "model-testecho"
  )
    return false;
  if (!provider.endpoint || !provider.wireModelName || !provider.secret)
    return false;
  const secret = provider.secret;
  try {
    if (secret.kind === "inline") return Boolean(secret.value?.trim());
    if (secret.kind === "env")
      return Boolean(process.env[secret.ref ?? ""]?.trim());
    if (!secret.ref || (!isAbsolute(secret.ref) && !secret.root)) return false;
    return (
      readFileSync(
        resolve(secret.root ?? process.cwd(), secret.ref),
        "utf8",
      ).trim().length > 0
    );
  } catch {
    return false;
  }
};
