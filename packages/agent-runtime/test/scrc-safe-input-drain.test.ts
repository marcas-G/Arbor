import type { InboxEntry } from "@arbor/domain";
import { parse, WorkspaceId } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { selectPendingInputPromotions } from "../src/safe-input-drain.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const entry = (entryKey: string, kind: InboxEntry["kind"]): InboxEntry => ({
  recipientWorkspaceId: workspaceId,
  entryKey,
  kind,
  summary: entryKey,
  admittedAt: entryKey,
});

describe("SCRC safe-boundary input drain", () => {
  it("admits every Steer at the next boundary but no Queue during continuation", () => {
    expect(
      selectPendingInputPromotions(
        [entry("q1", "Message"), entry("s1", "HumanInput")],
        { freshDrain: false },
      ).map(({ entry: selected, delivery }) => [selected.entryKey, delivery]),
    ).toEqual([["s1", "Steer"]]);
  });

  it("admits all Steers and exactly one FIFO Queue at a fresh drain", () => {
    expect(
      selectPendingInputPromotions(
        [
          entry("q1", "Message"),
          entry("s1", "HumanInput"),
          entry("q2", "SpecialistSettled"),
          entry("s2", "HumanInput"),
        ],
        { freshDrain: true },
      ).map(({ entry: selected, delivery }) => [selected.entryKey, delivery]),
    ).toEqual([
      ["s1", "Steer"],
      ["s2", "Steer"],
      ["q1", "Queue"],
    ]);
  });
});
