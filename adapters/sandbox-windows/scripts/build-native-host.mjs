import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(
  adapterRoot,
  "src",
  "native",
  "WindowsSandboxProcessHost.cs",
);
const outputPath = join(
  adapterRoot,
  "dist",
  "native",
  "WindowsSandboxProcessHost.exe",
);
const compilerPath = win32.join(
  "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);
const temporaryPrefix = "arbor-windows-sandbox-host-build-";

const compilerArguments = (source, output) => [
  "/nologo",
  "/warnaserror",
  "/platform:x64",
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Security.dll",
  "/target:exe",
  `/out:${output}`,
  source,
];

const makePlan = (source = sourcePath, output = outputPath) => ({
  compiler: compilerPath,
  source,
  output,
  arguments: compilerArguments(source, output),
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const assertX64Pe = (bytes) => {
  if (bytes.length < 256 || bytes.toString("ascii", 0, 2) !== "MZ")
    throw new Error("native host compiler output is not a PE image");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset + 6 > bytes.length ||
    bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new Error("native host compiler output is not an x64 PE image");
  }
};

const compile = (plan) => {
  if (process.platform !== "win32") {
    throw new Error("Windows native host compilation requires a Windows host");
  }
  if (!existsSync(plan.compiler))
    throw new Error("fixed Framework64 csc.exe is missing");
  if (!existsSync(plan.source))
    throw new Error("fixed native host source is missing");
  mkdirSync(dirname(plan.output), { recursive: true });
  execFileSync(plan.compiler, plan.arguments, {
    windowsHide: true,
    timeout: 20_000,
    stdio: "pipe",
  });
  const binary = readFileSync(plan.output);
  assertX64Pe(binary);
  return {
    sourceSha256: sha256(readFileSync(plan.source)),
    binarySha256: sha256(binary),
    binaryBytes: binary.length,
  };
};

const compileToPrivateTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), temporaryPrefix));
  try {
    const canonicalDirectory = resolve(directory);
    const canonicalTemp = resolve(tmpdir());
    const relativePath = relative(canonicalTemp, canonicalDirectory);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`,
      ) ||
      basename(canonicalDirectory).startsWith(temporaryPrefix) === false
    ) {
      throw new Error(
        "native host compile-check temporary path failed its guard",
      );
    }
    const result = compile(
      makePlan(
        sourcePath,
        join(canonicalDirectory, "WindowsSandboxProcessHost.exe"),
      ),
    );
    return { status: "CompiledToPrivateTemp", ...result };
  } finally {
    const canonicalDirectory = resolve(directory);
    const canonicalTemp = resolve(tmpdir());
    const relativePath = relative(canonicalTemp, canonicalDirectory);
    if (
      relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`,
      ) &&
      basename(canonicalDirectory).startsWith(temporaryPrefix)
    ) {
      rmSync(canonicalDirectory, { recursive: true, force: false });
    }
  }
};

const main = () => {
  const command = process.argv[2];
  if (command === "--print-plan") {
    process.stdout.write(`${JSON.stringify(makePlan(), null, 2)}\n`);
    return;
  }
  if (command === "--verify-compile") {
    process.stdout.write(
      `${JSON.stringify(compileToPrivateTemporaryDirectory())}\n`,
    );
    return;
  }
  if (command !== undefined) {
    throw new Error("supported commands: --print-plan, --verify-compile");
  }
  const result = compile(makePlan());
  process.stdout.write(
    `${JSON.stringify({ status: "BuiltFixedArtifact", ...result })}\n`,
  );
};

try {
  main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "native host build failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
