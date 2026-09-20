import { describe, expect, it } from "vitest";
import type {
  CanonicalToolObservation,
  SideEffectSemantics,
} from "../packages/ports/src/index.js";
import {
  ArtifactMetadataRepository,
  ArtifactService,
  BlobStorePort,
  ResourceAdmission,
  SandboxPort,
  ToolDefinitionStore,
  ToolInvocationStore,
  ToolRuntimePort,
} from "../packages/ports/src/index.js";

describe("P4 ports", () => {
  it("exports the P4 Effect services with stable keys", () => {
    expect(ToolRuntimePort.key).toBe("arbor/ToolRuntimePort");
    expect(ToolDefinitionStore.key).toBe("arbor/ToolDefinitionStore");
    expect(SandboxPort.key).toBe("arbor/SandboxPort");
    expect(ResourceAdmission.key).toBe("arbor/ResourceAdmission");
    expect(ToolInvocationStore.key).toBe("arbor/ToolInvocationStore");
    expect(BlobStorePort.key).toBe("arbor/BlobStorePort");
    expect(ArtifactMetadataRepository.key).toBe(
      "arbor/ArtifactMetadataRepository",
    );
    expect(ArtifactService.key).toBe("arbor/ArtifactService");
  });

  it("freezes SideEffectSemantics and the denial projection", () => {
    const kinds: ReadonlyArray<SideEffectSemantics> = [
      "ReadOnly",
      "Idempotent",
      "Reconcilable",
      "NonIdempotent",
    ];
    expect(kinds).toHaveLength(4);
    const denied: CanonicalToolObservation = {
      _tag: "Denied",
      reason: "no authority",
    };
    expect(denied._tag).toBe("Denied");
  });
});
