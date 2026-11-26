// Shared AH18 fixture lifecycle — moved verbatim from
// ah18-overflow-linked-compaction-resume.functional.test.ts (B5 split).
import type { Server } from "node:http";
import { resolve } from "node:path";
import type { ProductionFixture } from "../../../support/production-fixture.js";
import type { Ah18Probe } from "./snapshot.js";

export const fixtures: ProductionFixture[] = [];
export const providerServers: Server[] = [];
export const ah18Child = resolve(
  "tests/functional/support/ah18-overflow-crash-child.mjs",
);
export const ahCrashChild = resolve(
  "tests/functional/support/ah-crash-child.mjs",
);
export const boundaries = [
  "AH18BeforeOverflowLinksCommit",
  "AH18AfterOverflowLinksCommit",
  "AH18BeforeSummaryTurnCommit",
  "AH18AfterSummaryTurnCommit",
] as const;
export type Ah18Boundary = (typeof boundaries)[number];
export type Ah18CrashBoundary =
  | Ah18Boundary
  | "AH18BeforeInferenceFailTurnCommit";

export const probes: Ah18Probe[] = [];

export const ah18AfterEach = async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const server of providerServers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error !== undefined) rejectClose(error);
        else resolveClose();
      });
    });
  }
};
