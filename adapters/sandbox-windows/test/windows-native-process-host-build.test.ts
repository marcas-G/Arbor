import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1 } from "../src/qualification-manifest.js";

const adapterRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const buildScript = join(adapterRoot, "scripts", "build-native-host.mjs");
const source = join(
  adapterRoot,
  "src",
  "native",
  "WindowsSandboxProcessHost.cs",
);

const printPlan = (): {
  readonly compiler: string;
  readonly source: string;
  readonly output: string;
  readonly arguments: ReadonlyArray<string>;
} =>
  JSON.parse(
    execFileSync(process.execPath, [buildScript, "--print-plan"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    }),
  ) as {
    readonly compiler: string;
    readonly source: string;
    readonly output: string;
    readonly arguments: ReadonlyArray<string>;
  };

describe("Windows process-host D4a build boundary", () => {
  it("uses only the fixed Framework64 compiler, source, PE path and D2 argv template", () => {
    const plan = printPlan();
    const sourceMarker = "<adapter-src-native>/WindowsSandboxProcessHost.cs";
    const outputMarker =
      "/out:<adapter-dist-native>/WindowsSandboxProcessHost.exe";
    const expectedArgs = WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1.map(
      (argument) =>
        argument === sourceMarker
          ? plan.source
          : argument === outputMarker
            ? `/out:${plan.output}`
            : argument,
    );

    expect(plan.compiler).toBe(
      win32.join(
        "C:\\Windows",
        "Microsoft.NET",
        "Framework64",
        "v4.0.30319",
        "csc.exe",
      ),
    );
    expect(plan.source).toBe(source);
    expect(plan.output).toBe(
      join(adapterRoot, "dist", "native", "WindowsSandboxProcessHost.exe"),
    );
    expect(plan.arguments).toEqual(expectedArgs);
  });

  it.skipIf(process.platform !== "win32")(
    "compiles the fixed D4a source to an x64 PE in a private temporary path",
    () => {
      const output = execFileSync(
        process.execPath,
        [buildScript, "--verify-compile"],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      const result = JSON.parse(output) as {
        readonly status: string;
        readonly sourceSha256: string;
        readonly binarySha256: string;
        readonly binaryBytes: number;
      };
      expect(result.status).toBe("CompiledToPrivateTemp");
      expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.binarySha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.binaryBytes).toBeGreaterThan(256);
    },
  );

  it("keeps the D4a helper launch disabled", () => {
    const sourceText = readFileSync(source, "utf8");
    expect(sourceText).toContain("ProductionRunNotEnabled");
    expect(sourceText).not.toContain("Process.Start");
    expect(sourceText).not.toContain("CreateProcessAsUser");
  });
});
