import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Context } from "effect";

/** Diagnostic identity only; never an authorization or readiness input. */
export interface RuntimeInfo {
  readonly product: "Arbor";
  readonly protocolVersion: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly processStart: string | null;
  readonly databaseFingerprint: string;
  readonly buildId: string | null;
}

export class RuntimeIdentity extends Context.Service<
  RuntimeIdentity,
  RuntimeInfo
>()("arbor/RuntimeIdentity") {}

export const makeRuntimeInfo = (databaseFilename: string): RuntimeInfo => {
  let processStart: string | null = null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      processStart =
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      // Non-Linux launchers can still match a live instance over HTTP.
    }
  }
  return {
    product: "Arbor",
    protocolVersion: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    processStart,
    databaseFingerprint: createHash("sha256")
      .update(resolve(databaseFilename))
      .digest("hex"),
    buildId: process.env.ARBOR_BUILD_ID ?? null,
  };
};
