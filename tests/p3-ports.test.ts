import { describe, expect, it } from "vitest";
import {
  AgentContextSourcePort,
  KnowledgeQueryPort,
  ModelCapabilityPort,
  ProviderPort,
  SecretStorePort,
  SkillRegistry,
  ToolCatalogPort,
} from "../packages/ports/src/index.js";

describe("P3 ports", () => {
  it("exports the P3 Effect services with stable keys", () => {
    expect(ProviderPort.key).toBe("arbor/ProviderPort");
    expect(ModelCapabilityPort.key).toBe("arbor/ModelCapabilityPort");
    expect(SkillRegistry.key).toBe("arbor/SkillRegistry");
    expect(AgentContextSourcePort.key).toBe("arbor/AgentContextSourcePort");
    expect(KnowledgeQueryPort.key).toBe("arbor/KnowledgeQueryPort");
    expect(ToolCatalogPort.key).toBe("arbor/ToolCatalogPort");
    expect(SecretStorePort.key).toBe("arbor/SecretStorePort");
  });
});
