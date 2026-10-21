import { describe, expect, it } from "vitest";
import {
  encode,
  generate,
  ID_PREFIXES,
  ID_SCHEMAS,
  ExecutionId,
  PermissionGrantId,
  PREFIX_TO_ID,
  ProviderTurnId,
  ProjectId,
  parse,
  providerTurnConversationNativeCompactionId,
  providerTurnConversationSummaryCompactionId,
  providerTurnInferenceId,
  providerTurnNativeCompactionId,
  providerTurnOverflowReplacementId,
  providerTurnRepairInferenceId,
  providerTurnSummaryCompactionId,
  WorkId,
  WorkspaceId,
} from "../src/index.js";

const UUID_V7_SAMPLE = "018f2b3c-4d5e-7abc-8def-0123456789ab";
const EXECUTION_ID = parse(ExecutionId)(`exe_${UUID_V7_SAMPLE}`);
const PROVIDER_TURN_V2_FAMILIES = [
  `ptn_${EXECUTION_ID}_0`,
  `ptn_${EXECUTION_ID}_0_r1`,
  `ptn_${EXECUTION_ID}_0_compact_0`,
  `ptn_${EXECUTION_ID}_0_native_compact_0`,
  `ptn_${EXECUTION_ID}_0_conversation_compact_0`,
  `ptn_${EXECUTION_ID}_0_conversation_native_compact_0`,
  `ptn_${EXECUTION_ID}_0_overflow_0`,
];

const EXPECTED_IDS = [
  "ProjectId",
  "WorkspaceId",
  "WorkId",
  "ExecutionId",
  "SessionId",
  "VerificationId",
  "DependencyId",
  "DeliverableId",
  "MessageId",
  "ArtifactId",
  "DecisionId",
  "PermissionGrantId",
  "AcceptanceId",
  "EvidenceId",
  "MemoryId",
  "CommandId",
  "EventId",
  "ProviderTurnId",
  "ToolInvocationId",
  "WorkerId",
  // P12 `06` §2 (G6): worker process/instance incarnation, phase-contract evolution
  "WorkerIncarnationId",
  // P6 `01` §4.1 (D1): governance-entity id, phase-contract evolution
  "FormationProposalId",
  // P12 `01` §2 (G1): plugin identity, phase-contract evolution
  "PluginId",
].sort();

describe("typed ids", () => {
  it("exposes exactly the §2.1 id set in prefixes and schemas", () => {
    expect(Object.keys(ID_PREFIXES).sort()).toEqual(EXPECTED_IDS);
    expect(Object.keys(ID_SCHEMAS).sort()).toEqual(EXPECTED_IDS);
  });

  it("does not define AgentId / RootWorkspaceId / PrimarySessionId", () => {
    for (const forbidden of [
      "AgentId",
      "RootWorkspaceId",
      "PrimarySessionId",
    ]) {
      expect(Object.keys(ID_PREFIXES)).not.toContain(forbidden);
      expect(Object.keys(ID_SCHEMAS)).not.toContain(forbidden);
    }
  });

  it("maps PermissionGrantId to pgr_ and reverse-maps every prefix", () => {
    expect(ID_PREFIXES.PermissionGrantId).toBe("pgr_");
    expect(PREFIX_TO_ID.pgr_).toBe("PermissionGrantId");
    for (const [name, prefix] of Object.entries(ID_PREFIXES)) {
      expect(PREFIX_TO_ID[prefix]).toBe(name);
    }
  });

  it("round-trips encode/decode", () => {
    const value = parse(ProjectId)(`${ID_PREFIXES.ProjectId}${UUID_V7_SAMPLE}`);
    expect(encode(ProjectId)(value)).toBe(
      `${ID_PREFIXES.ProjectId}${UUID_V7_SAMPLE}`,
    );
  });

  it("rejects a wrong prefix", () => {
    expect(() =>
      parse(ProjectId)(`${ID_PREFIXES.WorkspaceId}${UUID_V7_SAMPLE}`),
    ).toThrow();
  });

  it("rejects a malformed uuid body", () => {
    expect(() =>
      parse(WorkspaceId)(`${ID_PREFIXES.WorkspaceId}not-a-uuid`),
    ).toThrow();
  });

  it("generates time-sortable ids purely from provided inputs", () => {
    const random = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const earlier = generate(WorkId, ID_PREFIXES.WorkId)(1000, random);
    const later = generate(WorkId, ID_PREFIXES.WorkId)(2000, random);
    expect(earlier < later).toBe(true);
    expect(parse(WorkId)(earlier)).toBe(earlier);
    expect(encode(WorkId)(earlier)).toBe(earlier);
  });

  it("encodes no name/path/sequence beyond prefix + uuid", () => {
    const id = parse(ProjectId)(`${ID_PREFIXES.ProjectId}${UUID_V7_SAMPLE}`);
    expect(encode(ProjectId)(id).slice(ID_PREFIXES.ProjectId.length)).toBe(
      UUID_V7_SAMPLE,
    );
  });

  it("type-level: ids are not interchangeable", () => {
    const workspaceId = parse(WorkspaceId)(
      `${ID_PREFIXES.WorkspaceId}${UUID_V7_SAMPLE}`,
    );
    // @ts-expect-error a WorkspaceId is not a WorkId
    const wrongWork: WorkId = workspaceId;
    void wrongWork;

    const projectId = parse(ProjectId)(
      `${ID_PREFIXES.ProjectId}${UUID_V7_SAMPLE}`,
    );
    // @ts-expect-error a ProjectId is not a WorkspaceId
    const wrongWorkspace: WorkspaceId = projectId;
    void wrongWorkspace;

    void PermissionGrantId;
  });
});

describe("ProviderTurnId V2 closed codec", () => {
  it("decodes all seven deterministic families and preserves exact spelling", () => {
    expect(
      PROVIDER_TURN_V2_FAMILIES.map((value) => parse(ProviderTurnId)(value)),
    ).toEqual(PROVIDER_TURN_V2_FAMILIES);
    const historical = "ptn_018f2b3c-4d5e-7abc-8def-0123456789ab";
    expect(parse(ProviderTurnId)(historical)).toBe(historical);
  });

  it("constructs only the frozen V2 family strings", () => {
    expect(providerTurnInferenceId(EXECUTION_ID, 0)).toBe(
      PROVIDER_TURN_V2_FAMILIES[0],
    );
    expect(providerTurnRepairInferenceId(EXECUTION_ID, 0, 1)).toBe(
      PROVIDER_TURN_V2_FAMILIES[1],
    );
    expect(providerTurnSummaryCompactionId(EXECUTION_ID, 0, 0)).toBe(
      PROVIDER_TURN_V2_FAMILIES[2],
    );
    expect(providerTurnNativeCompactionId(EXECUTION_ID, 0, 0)).toBe(
      PROVIDER_TURN_V2_FAMILIES[3],
    );
    expect(
      providerTurnConversationSummaryCompactionId(EXECUTION_ID, 0, 0),
    ).toBe(PROVIDER_TURN_V2_FAMILIES[4]);
    expect(providerTurnConversationNativeCompactionId(EXECUTION_ID, 0, 0)).toBe(
      PROVIDER_TURN_V2_FAMILIES[5],
    );
    expect(providerTurnOverflowReplacementId(EXECUTION_ID, 0)).toBe(
      PROVIDER_TURN_V2_FAMILIES[6],
    );
  });

  it("accepts safe epoch boundaries and rejects malformed or ambiguous forms", () => {
    for (const family of [
      "compact",
      "native_compact",
      "conversation_compact",
      "conversation_native_compact",
    ]) {
      expect(() =>
        parse(ProviderTurnId)(
          `ptn_${EXECUTION_ID}_0_${family}_${Number.MAX_SAFE_INTEGER}`,
        ),
      ).not.toThrow();
      for (const epoch of ["-1", "00", String(Number.MAX_SAFE_INTEGER + 1)]) {
        expect(() =>
          parse(ProviderTurnId)(`ptn_${EXECUTION_ID}_0_${family}_${epoch}`),
        ).toThrow();
      }
    }

    for (const value of [
      `ptn_${EXECUTION_ID}_00`,
      `ptn_${EXECUTION_ID}_0_r0`,
      `ptn_${EXECUTION_ID}_0_r01`,
      `ptn_${EXECUTION_ID}_0_unknown_1`,
      `ptn_${EXECUTION_ID}_0_overflow_1`,
      `ptn_${EXECUTION_ID}_0_compact_1_native_compact_1`,
      `ptn_${EXECUTION_ID}_0_conversation_native_compact_01`,
      "ptn_exe_not-an-execution_0",
      "ptn_exe_018f2b3c-4d5e-4abc-8def-0123456789ab_0",
      "ptn_exe_018f2b3c-4d5e-7abc-8def-0123456789ab_9007199254740992",
      "ptn_forged",
      "ptn_018f2b3c-4d5e-4abc-8def-0123456789ab",
    ]) {
      expect(() => parse(ProviderTurnId)(value), value).toThrow();
    }
  });

  it("rejects invalid constructor ordinals and execution identities", () => {
    for (const ordinal of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => providerTurnInferenceId(EXECUTION_ID, ordinal)).toThrow();
    }
    for (const attempt of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        providerTurnRepairInferenceId(EXECUTION_ID, 0, attempt),
      ).toThrow();
    }
    expect(() =>
      providerTurnInferenceId("exe_bad" as ExecutionId, 0),
    ).toThrow();
  });
});
