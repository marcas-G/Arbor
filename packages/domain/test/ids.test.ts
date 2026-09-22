import { describe, expect, it } from "vitest";
import {
  encode,
  generate,
  ID_PREFIXES,
  ID_SCHEMAS,
  PermissionGrantId,
  PREFIX_TO_ID,
  ProjectId,
  parse,
  WorkId,
  WorkspaceId,
} from "../src/index.js";

const UUID_V7_SAMPLE = "018f2b3c-4d5e-7abc-8def-0123456789ab";

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
