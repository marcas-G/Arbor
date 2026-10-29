import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeSandboxOperatorPolicyConfigV1,
  encodeSandboxOperatorPolicyConfigV1,
} from "@arbor/domain";
import {
  validateP39ProtectedDirectory,
  validateP39ProtectedFile,
} from "@arbor/persistence-sqlite";
import {
  SANDBOX_ENV_ALLOWLIST,
  SandboxAuthorityProvisioningStore,
  sha256Hex,
} from "@arbor/ports";
import { Effect } from "effect";
import { makeSandboxAuthorityProvisioningFileStore } from "../sandbox-authority-provisioning-file-store.js";
import { runSandboxAuthorityProvisioningCli } from "../sandbox-authority-v1-v2-provisioning.js";

interface CliArguments {
  readonly protectedRoot: string;
  readonly sourceFile: string;
  readonly highWaterFile: string;
  readonly forensicDirectory: string;
  readonly operatorConfigFile: string;
  readonly sourceIdentity: string;
}

class CliRefusal extends Error {
  readonly _tag = "SandboxAuthorityProvisioningCliRefusal";
  constructor(readonly code: string) {
    super(code);
  }
}

const fail = (code: string): never => {
  throw new CliRefusal(code);
};

export const sandboxAuthorityProvisioningUsage = () =>
  "Usage: pnpm --filter @arbor/single-workspace sandbox:authority-upgrade --offline-v1-to-v2 --protected-root <absolute-dir> --source-file <absolute-file> --high-water-file <absolute-file> --forensic-directory <absolute-dir> --operator-config-file <absolute-file> --source-identity <canonical-id>";

export const parseSandboxAuthorityProvisioningArguments = (
  argv: ReadonlyArray<string>,
): CliArguments => {
  const supported = new Set([
    "--protected-root",
    "--source-file",
    "--high-water-file",
    "--forensic-directory",
    "--operator-config-file",
    "--source-identity",
  ]);
  const values = new Map<string, string>();
  let offline = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--offline-v1-to-v2") {
      if (offline) fail("SANDBOX_AUTHORITY_PROVISION_ARGUMENT_DUPLICATE");
      offline = true;
      continue;
    }
    if (key === undefined || !supported.has(key) || values.has(key))
      return fail("SANDBOX_AUTHORITY_PROVISION_ARGUMENT_INVALID");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      return fail("SANDBOX_AUTHORITY_PROVISION_ARGUMENT_INVALID");
    values.set(key, value);
    index += 1;
  }
  if (!offline) fail("SANDBOX_AUTHORITY_PROVISION_OFFLINE_SWITCH_REQUIRED");
  const required = [
    "--protected-root",
    "--source-file",
    "--high-water-file",
    "--forensic-directory",
    "--operator-config-file",
    "--source-identity",
  ];
  if (required.some((key) => !values.has(key)))
    fail("SANDBOX_AUTHORITY_PROVISION_ARGUMENT_MISSING");
  const requiredValue = (key: string): string => {
    const value = values.get(key);
    if (value === undefined)
      return fail("SANDBOX_AUTHORITY_PROVISION_ARGUMENT_MISSING");
    return value;
  };
  const protectedRoot = requiredValue("--protected-root");
  const sourceFile = requiredValue("--source-file");
  const highWaterFile = requiredValue("--high-water-file");
  const forensicDirectory = requiredValue("--forensic-directory");
  const operatorConfigFile = requiredValue("--operator-config-file");
  const sourceIdentity = requiredValue("--source-identity");
  const paths = [
    protectedRoot,
    sourceFile,
    highWaterFile,
    forensicDirectory,
    operatorConfigFile,
  ];
  if (paths.some((path) => path === undefined || !isAbsolute(path)))
    fail("SANDBOX_AUTHORITY_PROVISION_ABSOLUTE_PATH_REQUIRED");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sourceIdentity))
    fail("SANDBOX_AUTHORITY_PROVISION_SOURCE_IDENTITY_INVALID");
  return {
    protectedRoot,
    sourceFile,
    highWaterFile,
    forensicDirectory,
    operatorConfigFile,
    sourceIdentity,
  };
};

const exactProtectedOperatorConfig = (input: CliArguments) => {
  const root = resolve(input.protectedRoot);
  const configPath = resolve(input.operatorConfigFile);
  const rel = relative(root, configPath);
  const contained =
    rel === "" ||
    (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== "..");
  if (!contained) fail("SANDBOX_AUTHORITY_PROVISION_CONFIG_OUTSIDE_ROOT");
  try {
    const rootStat = statSync(root, { bigint: true });
    const rootLstat = lstatSync(root, { bigint: true });
    const configLstat = lstatSync(configPath, { bigint: true });
    const rootReal = realpathSync.native(root);
    const configReal = realpathSync.native(configPath);
    if (
      rootLstat.isSymbolicLink() ||
      rootReal !== root ||
      configLstat.isSymbolicLink() ||
      configReal !== configPath ||
      !configLstat.isFile() ||
      configLstat.dev !== rootStat.dev ||
      configLstat.nlink !== 1n ||
      !validateP39ProtectedDirectory(root) ||
      !validateP39ProtectedFile(configPath)
    )
      fail("SANDBOX_AUTHORITY_PROVISION_CONFIG_PROTECTION_INVALID");
    if (
      process.platform !== "win32" &&
      (rootStat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (rootStat.mode & 0o777n) !== 0o700n ||
        configLstat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (configLstat.mode & 0o777n) !== 0o600n)
    )
      fail("SANDBOX_AUTHORITY_PROVISION_CONFIG_MODE_INVALID");
    const bytes = readFileSync(configPath, "utf8");
    const decoded = decodeSandboxOperatorPolicyConfigV1(
      JSON.parse(bytes) as unknown,
      SANDBOX_ENV_ALLOWLIST,
    );
    if (
      decoded === undefined ||
      encodeSandboxOperatorPolicyConfigV1(decoded) !== bytes ||
      !/^[0-9a-f]{64}$/u.test(sha256Hex(bytes))
    )
      fail("SANDBOX_AUTHORITY_PROVISION_CONFIG_MALFORMED");
    return decoded;
  } catch (cause) {
    if (cause instanceof CliRefusal) throw cause;
    return fail("SANDBOX_AUTHORITY_PROVISION_CONFIG_UNREADABLE");
  }
};

export const runSandboxAuthorityProvisioningCommand = (
  argv: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const args = parseSandboxAuthorityProvisioningArguments(argv);
    const operatorConfig = exactProtectedOperatorConfig(args);
    const store = yield* makeSandboxAuthorityProvisioningFileStore({
      protectedRoot: args.protectedRoot,
      sourceFile: args.sourceFile,
      highWaterFile: args.highWaterFile,
      forensicDirectory: args.forensicDirectory,
      sourceIdentity: args.sourceIdentity,
    });
    return yield* Effect.provideService(
      runSandboxAuthorityProvisioningCli({
        offlineV1ToV2: true,
        operatorConfig,
        allowedEnvironmentNames: SANDBOX_ENV_ALLOWLIST,
      }),
      SandboxAuthorityProvisioningStore,
      store,
    );
  });

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  Effect.runPromise(
    runSandboxAuthorityProvisioningCommand(process.argv.slice(2)),
  ).then(
    (result) => {
      process.stdout.write(
        `SANDBOX_AUTHORITY_V2_ACTIVE:${result.sourceIdentity}:${result.v2Bundle.bundleRevision}:${result.v2BundleDigest}\n`,
      );
    },
    (cause) => {
      const code =
        typeof cause === "object" && cause !== null && "_tag" in cause
          ? String(cause._tag)
          : cause instanceof CliRefusal
            ? cause.code
            : "SANDBOX_AUTHORITY_PROVISION_FAILED";
      process.stderr.write(`${code}\n${sandboxAuthorityProvisioningUsage()}\n`);
      process.exitCode = 2;
    },
  );
}
