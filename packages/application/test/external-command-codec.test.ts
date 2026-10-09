import { describe, expect, it } from "vitest";
import {
  CommandInputContractRegistry,
  decodeCommandPayload,
  decodeExternalCommand,
} from "../src/external-command-codec.js";

const UUID_V7 = "018f1f62-7b3c-7abc-8def-0123456789ab";

describe("external wire-v1 command payload codec", () => {
  it("rejects a malformed MessageId with a stable field path", () => {
    const result = decodeCommandPayload("SubmitHumanMessage", {
      messageId: "msg_not-a-uuid-v7",
      targetWorkspaceId: `ws_${UUID_V7}`,
      bodyRef: "body-ref",
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["messageId"], rule: "format" }],
    });
  });

  it("rejects an AcceptanceId with the wrong frozen prefix", () => {
    const result = decodeCommandPayload("AcceptWorkOutcome", {
      acceptanceId: `acp_${UUID_V7}`,
      workId: `wrk_${UUID_V7}`,
      targetWorkRevision: 1,
      verificationId: `ver_${UUID_V7}`,
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["acceptanceId"], rule: "format" }],
    });
  });

  it("rejects unknown keys without reflecting their name or value", () => {
    const privateKey = "sentinel-secret-field-name";
    const privateValue = "sentinel-secret-field-value";
    const result = decodeCommandPayload("SubmitHumanMessage", {
      messageId: `msg_${UUID_V7}`,
      targetWorkspaceId: `ws_${UUID_V7}`,
      bodyRef: "body-ref",
      [privateKey]: privateValue,
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["<unknown-field>"], rule: "unknown-field" }],
    });
    expect(JSON.stringify(result)).not.toContain(privateKey);
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it("rejects unknown keys inside a nested message object", () => {
    const result = decodeCommandPayload("SendMessage", {
      messageId: `msg_${UUID_V7}`,
      senderWorkspaceId: `ws_${UUID_V7}`,
      message: {
        kind: "Query",
        recipientWorkspaceId: `ws_${UUID_V7}`,
        bodyRef: "query-ref",
        urgency: "Normal",
        extra: "must stay private",
      },
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["message", "<unknown-field>"], rule: "unknown-field" }],
    });
    expect(JSON.stringify(result)).not.toContain("must stay private");
  });

  it("rejects an invalid ID in a tagged array member with a closed nested path", () => {
    const result = decodeCommandPayload("ProduceDeliverable", {
      deliverableId: `del_${UUID_V7}`,
      sourceWorkId: `wrk_${UUID_V7}`,
      observedSourceWorkRevision: 2,
      kind: "report",
      artifacts: [{ role: "source", artifactId: `wrk_${UUID_V7}` }],
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["artifacts", 0, "artifactId"], rule: "format" }],
    });
  });

  it("validates the outer envelope before returning a typed command envelope", () => {
    const result = decodeExternalCommand({
      commandType: "SubmitHumanMessage",
      commandId: `cmd_${UUID_V7}`,
      projectId: `prj_${UUID_V7}`,
      actor: "user:alice",
      issuedAt: "2026-10-10T00:00:00.000Z",
      payload: {
        messageId: `msg_${UUID_V7}`,
        targetWorkspaceId: `ws_${UUID_V7}`,
        bodyRef: "body-ref",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.commandType).toBe("SubmitHumanMessage");
    expect(result.value.payload).toMatchObject({ messageId: `msg_${UUID_V7}` });
  });

  it("keeps the frozen shell envelope closed", () => {
    const result = decodeExternalCommand({
      commandType: "SubmitHumanMessage",
      commandId: `cmd_${UUID_V7}`,
      projectId: `prj_${UUID_V7}`,
      actor: "user:alice",
      issuedAt: "2026-10-10T00:00:00.000Z",
      causationRef: "not part of ExternalCommandEnvelope v1",
      payload: {
        messageId: `msg_${UUID_V7}`,
        targetWorkspaceId: `ws_${UUID_V7}`,
        bodyRef: "body-ref",
      },
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["<unknown-field>"], rule: "unknown-field" }],
    });
  });

  it("rejects unsupported command types without reflecting caller text", () => {
    const result = decodeExternalCommand({
      commandType: "private-command-name",
      payload: { secret: "private-value" },
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["commandType"], rule: "unsupported-command" }],
    });
    expect(JSON.stringify(result)).not.toContain("private-command-name");
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("does not treat inherited object keys as enum or discriminator cases", () => {
    const result = decodeCommandPayload("SteerWork", {
      workId: `wrk_${UUID_V7}`,
      workspaceId: `ws_${UUID_V7}`,
      steer: { severity: "toString", guidance: "hold", scope: "Direction" },
      expectedWorkRevision: 1,
      provenance: { source: "HumanInput" },
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["steer", "severity"], rule: "enum" }],
    });
  });

  it.each([
    ["legacy Coordination focus only", { _tag: "Coordination" }],
    ["missing episode", undefined],
    ["legacy focus alongside exact episode", { _tag: "Coordination" }],
  ])("rejects WorkspaceMain payload shape: %s", (_caseName, focus) => {
    const payload: Record<string, unknown> = {
      _tag: "WorkspaceMain",
      executionId: `exe_${UUID_V7}`,
      workspaceId: `ws_${UUID_V7}`,
    };
    if (focus !== undefined) payload.focus = focus;
    if (_caseName === "legacy focus alongside exact episode") {
      payload.episode = {
        _tag: "WorkEpisode",
        workId: `wrk_${UUID_V7}`,
        targetWorkRevision: 1,
      };
    }

    expect(decodeCommandPayload("AdmitExecution", payload).ok).toBe(false);
  });

  it.each(["CoordinationCompleted", "QueryCompleted"])(
    "rejects historical %s as a new Completed settlement result",
    (resultTag) => {
      const result = decodeCommandPayload("SettleExecution", {
        executionId: `exe_${UUID_V7}`,
        settlement: {
          _tag: "Completed",
          result: { _tag: resultTag },
        },
      });

      expect(result.ok).toBe(false);
    },
  );

  it("applies the typed descriptor codec even when its external origin is denied", () => {
    const descriptor = CommandInputContractRegistry.lookup("AdmitExecution");
    expect(descriptor?.externalOriginAllowed).toBe(false);
    expect(
      descriptor?.decodePayload({
        _tag: "WorkspaceMain",
        executionId: `exe_${UUID_V7}`,
        workspaceId: `ws_${UUID_V7}`,
        episode: {
          _tag: "WorkEpisode",
          workId: `wrk_${UUID_V7}`,
          targetWorkRevision: 1,
        },
      }).ok,
    ).toBe(true);
  });
});
