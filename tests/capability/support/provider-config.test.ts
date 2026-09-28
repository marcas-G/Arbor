import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  providerConfigReady,
  resolveProviderConfig,
} from "./provider-config.js";

const ENV_KEYS = [
  "ARBOR_CAPABILITY_PROVIDER_URL",
  "ARBOR_CAPABILITY_MODEL",
  "ARBOR_CAPABILITY_SERVER_BUILD_ID",
  "ARBOR_CAPABILITY_AUTH",
  "ARBOR_CAPABILITY_API_KEY",
  "ARBOR_CAPABILITY_MODEL_REVISION",
  "ARBOR_CAPABILITY_EVIDENCE_DIR",
  "ARBOR_CAPABILITY_CONFIG",
] as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const writeConfig = (value: Record<string, unknown>): string => {
  const directory = mkdtempSync(join(tmpdir(), "arbor-provider-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "capability.config.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  process.env.ARBOR_CAPABILITY_CONFIG = path;
  return path;
};

describe("capability provider config file", () => {
  it("resolves a complete config file with no env", () => {
    const path = writeConfig({
      providerUrl: "http://127.0.0.1:8011/v1",
      model: "qwen-test",
      serverBuildId: "llama.cpp test",
      auth: "none",
    });
    const config = resolveProviderConfig();
    expect(config.baseUrl).toBe("http://127.0.0.1:8011/v1");
    expect(config.model).toBe("qwen-test");
    expect(config.serverBuildId).toBe("llama.cpp test");
    expect(config.authMode).toBe("none");
    expect(config.source.file).toBe(path);
    expect(providerConfigReady(config).ready).toBe(true);
  });

  it("environment variables override file entries", () => {
    writeConfig({
      providerUrl: "http://file.example/v1",
      model: "file-model",
      serverBuildId: "file-build",
    });
    process.env.ARBOR_CAPABILITY_PROVIDER_URL = "http://env.example/v1";
    const config = resolveProviderConfig();
    expect(config.baseUrl).toBe("http://env.example/v1");
    expect(config.model).toBe("file-model");
    expect(config.source.envKeys).toContain("ARBOR_CAPABILITY_PROVIDER_URL");
  });

  it("auth=env resolves the key from apiKeyVar, then literal apiKey", () => {
    writeConfig({
      providerUrl: "http://127.0.0.1:9/v1",
      model: "m",
      serverBuildId: "b",
      auth: "env",
      apiKeyVar: "MY_TEST_PROVIDER_KEY",
      apiKey: "literal-key",
    });
    process.env.MY_TEST_PROVIDER_KEY = "var-key";
    expect(resolveProviderConfig().apiKey).toBe("var-key");
    delete process.env.MY_TEST_PROVIDER_KEY;
    expect(resolveProviderConfig().apiKey).toBe("literal-key");
  });

  it("rejects an invalid auth mode with a precise message", () => {
    writeConfig({
      providerUrl: "http://127.0.0.1:9/v1",
      model: "m",
      serverBuildId: "b",
      auth: "bearer",
    });
    expect(() => resolveProviderConfig()).toThrow(/"none" or "env"/);
  });

  it("reports missing required fields instead of throwing", () => {
    writeConfig({ auth: "none" });
    const readiness = providerConfigReady(resolveProviderConfig());
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual([
      "providerUrl",
      "model",
      "serverBuildId",
    ]);
  });

  it("an invalid config file path is reported, not silently ignored", () => {
    process.env.ARBOR_CAPABILITY_CONFIG = "/nonexistent/capability.config.json";
    expect(() => resolveProviderConfig()).toThrow(/does not exist/);
  });
});
