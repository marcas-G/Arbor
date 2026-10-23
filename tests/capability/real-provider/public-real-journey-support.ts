import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findArborConfigFile } from "../../../apps/single-workspace/src/provider-config.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../functional/support/production-fixture.js";
import { makePublicClient } from "../../functional/support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../../functional/support/schema44-bootstrap.js";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
} from "../../support/p39-windows-deployment-test.js";

export interface RealProviderConfig {
  readonly path: string;
  readonly deploymentId: string;
  readonly modelRef: string;
  readonly endpoint: string;
  readonly wireModelName: string;
  readonly secretKind: "env" | "file" | "inline";
}

export type RealProviderReadiness =
  | { readonly ready: true; readonly config: RealProviderConfig }
  | { readonly ready: false; readonly reason: string };

export interface ProviderCapture {
  readonly event:
    | "request-start"
    | "response-complete"
    | "response-held"
    | "response-released"
    | "response-capture-failed"
    | "request-failed";
  readonly requestId: string;
  readonly processId: number;
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly request?: Record<string, unknown>;
  readonly status?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBodyBase64?: string;
  readonly captureError?: string;
  readonly error?: string;
}

export interface StartedRealProviderFixture {
  readonly fixture: ProductionFixture;
  readonly captureFile: string;
  readonly evidenceDirectory: string;
  readonly responseGateDirectory?: string;
}

export interface WorkspaceFileSnapshot {
  readonly entries: Readonly<
    Record<
      string,
      {
        readonly kind: "file" | "directory";
        readonly size?: number;
        readonly sha256?: string;
        readonly bytesBase64?: string;
      }
    >
  >;
}

const CONFIG_PATH_ENV = "ARBOR_PUBLIC_S1_CONFIG";
const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const CAPTURE_ENDPOINT_ENV = "ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT";

export const discoverProductionProviderConfig = (): RealProviderReadiness => {
  try {
    const configPath =
      process.env[CONFIG_PATH_ENV]?.trim() ||
      process.env.ARBOR_CONFIG?.trim() ||
      (existsSync("C:\\Arbor\\arbor.config.json")
        ? "C:\\Arbor\\arbor.config.json"
        : undefined);
    const previousConfigPath = process.env.ARBOR_CONFIG;
    let found: ReturnType<typeof findArborConfigFile>;
    try {
      if (configPath !== undefined)
        process.env.ARBOR_CONFIG = resolve(configPath);
      found = findArborConfigFile();
    } finally {
      if (configPath !== undefined) {
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
        secretKind: secretKind as RealProviderConfig["secretKind"],
      },
    };
  } catch {
    // Parser errors may include config values; keep readiness diagnostics value-free.
    return {
      ready: false,
      reason: "production provider config could not be resolved",
    };
  }
};

const safeEndpoint = (endpoint: string): string => {
  const parsed = new URL(endpoint);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const fetchHook = fileURLToPath(
  new URL("./provider-fetch-capture-hook.mjs", import.meta.url),
);

/** Starts only the production daemon with its configured real provider.
 * The local scripted-provider endpoint is a fail-closed tripwire, never a fallback. */
export const startRealProviderFixture = async (input: {
  readonly config: RealProviderConfig;
  readonly evidenceRoot: string;
  readonly journeyId: string;
  readonly responseGate?: boolean;
  readonly onProviderStarted?: (fixture: ProductionFixture) => void;
}): Promise<StartedRealProviderFixture> => {
  if (!existsSync(input.evidenceRoot)) {
    throw new Error(
      "REAL NOT QUALIFIED: evidenceRoot must be an existing private run directory",
    );
  }
  const evidenceDirectory = makeP39PrivateTestDirectory(
    input.evidenceRoot,
    `evidence-${input.journeyId}-`,
  );
  const responseGateDirectory = input.responseGate
    ? makeP39PrivateTestDirectory(evidenceDirectory, "response-gate-")
    : undefined;
  let captureFile: string | undefined;
  const previousCapturePath = process.env[CAPTURE_FILE_ENV];
  let fixture: ProductionFixture;
  try {
    fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      preserveDirectoryOnStop: true,
      reply: () => {
        throw new Error(
          "REAL NOT QUALIFIED: scripted provider endpoint received a request",
        );
      },
      daemonEnvironment: {
        ARBOR_CONFIG: input.config.path,
        ARBOR_MODEL_BASE_URL: "",
        ARBOR_MODEL_NAME: "",
        ARBOR_MODEL_API_KEY_VAR: "",
        [CAPTURE_ENDPOINT_ENV]: safeEndpoint(input.config.endpoint),
        ...(responseGateDirectory === undefined
          ? {}
          : { ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR: responseGateDirectory }),
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(fetchHook).href}`.trim(),
      },
      setupProbe: (event) => {
        if (event.stage !== "after-clone") return;
        captureFile = join(evidenceDirectory, "provider-captures.jsonl");
        createP39PrivateTestFile(captureFile);
        process.env[CAPTURE_FILE_ENV] = captureFile;
      },
    });
  } finally {
    if (previousCapturePath === undefined) delete process.env[CAPTURE_FILE_ENV];
    else process.env[CAPTURE_FILE_ENV] = previousCapturePath;
  }
  if (captureFile === undefined) {
    await fixture.stop();
    throw new Error(
      "REAL NOT QUALIFIED: private Provider capture file was not initialized",
    );
  }
  input.onProviderStarted?.(fixture);
  return {
    fixture,
    captureFile,
    evidenceDirectory,
    ...(responseGateDirectory === undefined ? {} : { responseGateDirectory }),
  };
};

export const makeDeadlinePublicClient = (
  fixture: ProductionFixture,
  deadlineAt: number,
) => makePublicClient(fixture.baseUrl, { deadlineAt });

export const readProviderCaptures = (
  captureFile: string,
): Array<ProviderCapture> => {
  try {
    const text = readFileSync(captureFile, "utf8");
    return text
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ProviderCapture];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

export const startedProviderRequests = (
  captures: ReadonlyArray<ProviderCapture>,
): ReadonlyArray<ProviderCapture> =>
  captures.filter((capture) => capture.event === "request-start");

export const armProviderResponseGate = (
  run: StartedRealProviderFixture,
  selector?: {
    readonly requiredAdvertisedToolName?: string;
    readonly requiredMessageText?: string;
  },
): void => {
  if (run.responseGateDirectory === undefined) {
    throw new Error(
      "response gate was not enabled for this real-provider fixture",
    );
  }
  if (selector !== undefined) {
    const selectorPath = join(run.responseGateDirectory, "selector.json");
    createP39PrivateTestFile(selectorPath);
    writeFileSync(selectorPath, `${JSON.stringify(selector)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  createP39PrivateTestFile(join(run.responseGateDirectory, "armed"));
};

export const releaseProviderResponse = (
  run: StartedRealProviderFixture,
  requestId: string,
): void => {
  if (
    run.responseGateDirectory === undefined ||
    !/^[0-9a-f-]{36}$/iu.test(requestId)
  ) {
    throw new Error("invalid private response-gate release target");
  }
  createP39PrivateTestFile(
    join(run.responseGateDirectory, `release-${requestId}`),
  );
};

export const waitForHeldProviderResponse = async (
  run: StartedRealProviderFixture,
  input: { readonly afterSequence: number; readonly deadlineAt: number },
): Promise<ProviderCapture> => {
  while (Date.now() < input.deadlineAt) {
    const captures = readProviderCaptures(run.captureFile);
    const held = captures.find(
      (capture) =>
        capture.event === "response-held" &&
        capture.sequence > input.afterSequence &&
        captures.some(
          (completed) =>
            completed.event === "response-complete" &&
            completed.requestId === capture.requestId,
        ),
    );
    if (held !== undefined) return held;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    "REAL NOT QUALIFIED: deadline waiting for a genuine held Provider response",
  );
};

export const finishRealProviderFixture = async (
  run: StartedRealProviderFixture,
  requestedStatus: "PASS" | "FAIL",
): Promise<{
  readonly status: "PASS" | "FAIL";
  readonly error?: string;
  readonly fixtureRetained: boolean;
}> => {
  let status = requestedStatus;
  let error: string | undefined;
  try {
    await run.fixture.stop();
    if (!run.fixture.daemonsExited()) {
      throw new Error("fixture stop returned while a daemon remained alive");
    }
    if (status === "PASS")
      removeFunctionalFixtureDirectory(run.fixture.directory);
  } catch (failure) {
    status = "FAIL";
    error = redactRealProviderDiagnostic(
      failure instanceof Error ? failure.message : String(failure),
    );
  }
  return {
    status,
    ...(error === undefined ? {} : { error }),
    fixtureRetained: status === "FAIL",
  };
};

export const writeRealProviderEvidence = (input: {
  readonly run: StartedRealProviderFixture;
  readonly journeyId: string;
  readonly config: RealProviderConfig;
  readonly status: "PASS" | "FAIL";
  readonly state: unknown;
  readonly error?: string;
}): string => {
  const outputPath = join(
    input.run.evidenceDirectory,
    `${input.journeyId}-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  createP39PrivateTestFile(outputPath);
  writeFileSync(
    `${outputPath}`,
    `${JSON.stringify(
      {
        schemaVersion: "arbor-real-public-journey-evidence-v1",
        journeyId: input.journeyId,
        recordedAt: new Date().toISOString(),
        status: input.status,
        providerMode: "REAL",
        provider: {
          configPath: input.config.path,
          deploymentId: input.config.deploymentId,
          modelRef: input.config.modelRef,
          wireModelName: input.config.wireModelName,
          secretStoreKind: input.config.secretKind,
          credentialsRecorded: false,
        },
        fixture: {
          directory: input.run.fixture.directory,
          databaseFile: input.run.fixture.databaseFile,
          workspaceDirectory: input.run.fixture.workspaceDirectory,
          daemonExited: input.run.fixture.daemonsExited(),
          daemonErrors: input.run.fixture.daemonErrors.map(
            redactRealProviderDiagnostic,
          ),
        },
        captureFile: input.run.captureFile,
        captures: readProviderCaptures(input.run.captureFile),
        state: input.state,
        ...(input.error === undefined
          ? {}
          : { error: redactRealProviderDiagnostic(input.error) }),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outputPath;
};

export const redactRealProviderDiagnostic = (text: string): string =>
  text
    .replace(/bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|credential|token)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, 8_000);

export const repositoryBuildAssets = (): ReadonlyArray<string> => {
  const repositoryRoot = resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  return [
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
};

export const captureWorkspaceSnapshot = (
  workspaceDirectory: string,
): WorkspaceFileSnapshot => {
  const entries: Record<string, WorkspaceFileSnapshot["entries"][string]> = {};
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const relativePath =
        relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`workspace snapshot refuses symlink ${relativePath}`);
      }
      if (stat.isDirectory()) {
        entries[relativePath] = { kind: "directory" };
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const bytes = readFileSync(absolutePath);
        entries[relativePath] = {
          kind: "file",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytesBase64: bytes.toString("base64"),
        };
      } else {
        throw new Error(
          `workspace snapshot refuses non-file entry ${relativePath}`,
        );
      }
    }
  };
  visit(workspaceDirectory, "");
  return { entries };
};
