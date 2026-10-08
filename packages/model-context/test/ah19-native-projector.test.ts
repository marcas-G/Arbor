import { parse, SessionId } from "@arbor/domain";
import type { SessionEntryRecord } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { projectSessionTimeline } from "../src/projector.js";

const bindingA = `p16fp_${"a".repeat(64)}`;
const bindingB = `p16fp_${"b".repeat(64)}`;

const nativeEntry = (
  sequence = 12,
  sourceRef = "ptn_exe-ah19_0_native_compact_0",
): SessionEntryRecord => ({
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  sequence,
  entryKind: "CheckpointReference",
  createdAt: "2026-10-08T00:00:00.000Z",
  source: {
    kind: "CompactionTurn",
    ref: sourceRef,
    contentHash: "checkpoint-hash",
  },
  payload: {
    _tag: "CompactionCheckpoint",
    implementation: "ProviderNative",
    fromEpoch: 0,
    toEpoch: 1,
    retainedFrontierRef: "frontier:session:0",
    opaqueItemRef: "opaque-ah19-a",
    bindingFingerprint: bindingA,
  },
});

describe("AH19 ProviderNative Session projection", () => {
  it("projects the opaque ref only for the exact full binding fingerprint", () => {
    const matching = projectSessionTimeline([nativeEntry()], bindingA, true);
    expect(matching.inputItems).toContainEqual({
      _tag: "CompactionCheckpoint",
      implementation: "ProviderNative",
      fromEpoch: 0,
      toEpoch: 1,
      retainedFrontierRef: "frontier:session:0",
      opaqueItemRef: "opaque-ah19-a",
      bindingFingerprint: bindingA,
    });
    expect(matching.nativeCheckpoint).toMatchObject({
      providerTurnId: "ptn_exe-ah19_0_native_compact_0",
      bindingFingerprint: bindingA,
      bindingMatches: true,
      fromEpoch: 0,
      toEpoch: 1,
    });
  });

  it("never projects a mismatched or absent binding's opaque reference", () => {
    for (const fingerprint of [bindingB, undefined]) {
      const projection = projectSessionTimeline(
        [nativeEntry()],
        fingerprint,
        true,
      );
      expect(projection.inputItems).not.toContainEqual(
        expect.objectContaining({
          _tag: "CompactionCheckpoint",
          implementation: "ProviderNative",
          opaqueItemRef: "opaque-ah19-a",
        }),
      );
      expect(projection.nativeCheckpoint?.bindingMatches).toBe(false);
    }
  });

  it("withholds an opaque ref when the Native checkpoint source identity is absent", () => {
    const projection = projectSessionTimeline(
      [nativeEntry(12, "")],
      bindingA,
      true,
    );
    expect(projection.inputItems).not.toContainEqual(
      expect.objectContaining({ opaqueItemRef: "opaque-ah19-a" }),
    );
    expect(projection.nativeCheckpoint).toMatchObject({
      bindingMatches: false,
    });
    expect(projection.nativeCheckpoint?.providerTurnId).toBeUndefined();
  });

  it("lets a newer portable Summary checkpoint supersede an older Native checkpoint", () => {
    const summary: SessionEntryRecord = {
      ...nativeEntry(20, "ptn_exe-ah19_0_compact_1"),
      payload: {
        _tag: "CompactionCheckpoint",
        implementation: "Summary",
        fromEpoch: 1,
        toEpoch: 2,
        retainedFrontierRef: "frontier:session:1",
        summaryText: "portable continuation",
        bindingFingerprint: null,
      },
    };
    const projection = projectSessionTimeline(
      [nativeEntry(), summary],
      bindingB,
      true,
    );
    expect(projection.nativeCheckpoint).toBeUndefined();
    expect(projection.inputItems).toEqual([
      {
        _tag: "Message",
        role: "system",
        text: "[Continuation checkpoint]\nportable continuation",
      },
    ]);
    expect(JSON.stringify(projection.inputItems)).not.toContain(
      "opaque-ah19-a",
    );
  });
});
