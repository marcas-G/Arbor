import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArborProviderConfigFile,
  findArborConfigFile,
  providerDeploymentOfConfig,
} from "../src/provider-config.js";

/**
 * Standard arbor.config.json loading (P16 `01` §5 source of truth).
 * Lookup precedence, secret kinds (env/file), and typed validation errors.
 */

const tempDirs: string[] = [];
const withConfig = (content: string): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), "arbor-config-"));
  tempDirs.push(dir);
  const path = join(dir, "arbor.config.json");
  writeFileSync(path, content);
  return { dir, path };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("arbor.config.json — standard provider configuration", () => {
  it("a full env-secret config builds the ModelDeployment with SecretRef only", () => {
    const { path } = withConfig(
      JSON.stringify({
        provider: {
          deploymentId: "dep-env",
          modelRef: "model-openai",
          endpoint: "https://api.deepseek.com/v1",
          wireModelName: "deepseek-chat",
          secret: { kind: "env", ref: "ARBOR_MODEL_API_KEY" },
          executionPolicyOverrides: { connectTimeoutMs: 10_000 },
        },
      }),
    );
    const priorConfig = process.env.ARBOR_CONFIG;
    process.env.ARBOR_CONFIG = path;
    try {
      const found = findArborConfigFile();
      expect(found?.ok).toBe(true);
      if (found?.ok !== true) return;
      const { deployment, secretStore } = providerDeploymentOfConfig(
        found.config,
      );
      expect(deployment.deploymentId).toBe("dep-env");
      expect(deployment.modelRef).toBe("model-openai");
      expect(deployment.endpoint).toBe("https://api.deepseek.com/v1");
      expect(deployment.wireModelName).toBe("deepseek-chat");
      expect(deployment.secretRef).toBe("ARBOR_MODEL_API_KEY");
      expect(deployment.executionPolicyOverrides).toEqual({
        connectTimeoutMs: 10_000,
      });
      // No raw credential ever crosses the config boundary.
      expect(JSON.stringify(deployment)).not.toMatch(/sk-/);
      expect(secretStore._tag).toBe("Env");
    } finally {
      if (priorConfig === undefined) {
        delete process.env.ARBOR_CONFIG;
      } else {
        process.env.ARBOR_CONFIG = priorConfig;
      }
    }
  });

  it("a file-secret config selects the File secret store with its root", () => {
    const { dir } = withConfig("{}");
    const config = {
      provider: {
        deploymentId: "dep-file",
        modelRef: "model-openai",
        endpoint: "http://10.0.0.5:8011/v1",
        wireModelName: "qwen3-8b",
        secret: { kind: "file", ref: "keys/deepseek.key", root: dir },
      },
    } as unknown as ArborProviderConfigFile;
    const { deployment, secretStore } = providerDeploymentOfConfig(config);
    expect(deployment.secretRef).toBe("keys/deepseek.key");
    expect(secretStore).toEqual({ _tag: "File", root: dir });
  });

  it("missing required fields produce a typed validation error", () => {
    const { path } = withConfig(
      JSON.stringify({ provider: { modelRef: "model-openai" } }),
    );
    const priorConfig = process.env.ARBOR_CONFIG;
    process.env.ARBOR_CONFIG = path;
    try {
      const found = findArborConfigFile();
      expect(found?.ok).toBe(false);
      if (found?.ok !== false) return;
      expect(found.error._tag).toBe("ProviderConfigInvalid");
      expect(found.error.reason).toContain("deploymentId");
    } finally {
      if (priorConfig === undefined) {
        delete process.env.ARBOR_CONFIG;
      } else {
        process.env.ARBOR_CONFIG = priorConfig;
      }
    }
  });

  it("malformed JSON produces a typed parse error, never a silent fallback", () => {
    const { path } = withConfig("{ not json");
    const priorConfig = process.env.ARBOR_CONFIG;
    process.env.ARBOR_CONFIG = path;
    try {
      const found = findArborConfigFile();
      expect(found?.ok).toBe(false);
    } finally {
      if (priorConfig === undefined) {
        delete process.env.ARBOR_CONFIG;
      } else {
        process.env.ARBOR_CONFIG = priorConfig;
      }
    }
  });

  it("an unauthentic endpoint may omit the secret entirely (authMode None exempt)", () => {
    const config = {
      provider: {
        deploymentId: "dep-llamacpp",
        modelRef: "model-openai",
        endpoint: "http://127.0.0.1:8011/v1",
        wireModelName: "qwen3-8b-q2k",
      },
    } as unknown as ArborProviderConfigFile;
    const { deployment, secretStore } = providerDeploymentOfConfig(config);
    expect(deployment.secretRef).toBeUndefined();
    expect(secretStore._tag).toBe("Env");
  });
});
