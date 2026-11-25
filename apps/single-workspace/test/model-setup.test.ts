import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSetupError, makeModelSetup } from "../src/model-setup.js";

const directories: string[] = [];
const configuration = () => {
  const root = mkdtempSync(join(tmpdir(), "arbor-model-setup-"));
  directories.push(root);
  const configPath = join(root, "arbor.config.json");
  const requestRestart = vi.fn();
  return {
    configPath,
    requestRestart,
    service: makeModelSetup({
      configPath,
      configured: false,
      loaded: undefined,
      requestRestart,
    }),
  };
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const input = {
  endpoint: "https://provider.example/v1",
  model: "real-model",
  apiKey: "private-key-for-test",
};

describe("first-run model configuration", () => {
  it("checks the real protocol before saving a durable SecretRef and private credential", async () => {
    const { service, configPath, requestRestart } = configuration();
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await service.save(input);
    expect(fetch).toHaveBeenCalledWith(
      `${input.endpoint}/chat/completions`,
      expect.objectContaining({ redirect: "error" }),
    );
    const raw = readFileSync(configPath, "utf8");
    expect(raw).not.toContain(input.apiKey);
    const config = JSON.parse(raw);
    expect(config.runtime).toEqual({
      processExecutionMode: { version: 1, processExecutionMode: "Disabled" },
    });
    const secret = join(
      config.provider.secret.root,
      config.provider.secret.ref,
    );
    expect(readFileSync(secret, "utf8")).toBe(input.apiKey);
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(statSync(config.provider.secret.root).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(
      readFileSync(join(config.provider.secret.root, ".gitignore"), "utf8"),
    ).toBe("*\n");
    expect(service.status()).toEqual({ configured: false, model: null });
    expect(requestRestart).not.toHaveBeenCalled();
    expect(JSON.stringify(service.status())).not.toContain(input.apiKey);
  });

  it("records NativeOsSupportedOnly for a new config only after the launcher has qualified the host", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-model-setup-qualified-"));
    directories.push(root);
    const configPath = join(root, "arbor.config.json");
    const service = makeModelSetup({
      configPath,
      configured: false,
      loaded: undefined,
      firstRunProcessExecutionMode: "NativeOsSupportedOnly",
      requestRestart: vi.fn(),
      checkConnection: async () => {},
    });

    await service.save(input);

    expect(JSON.parse(readFileSync(configPath, "utf8")).runtime).toEqual({
      processExecutionMode: {
        version: 1,
        processExecutionMode: "NativeOsSupportedOnly",
      },
    });
  });

  it("does not save or expose upstream secret-bearing errors on failed authentication", async () => {
    const { service, configPath } = configuration();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(`echo: ${input.apiKey}`, { status: 401 })),
      ),
    );
    let failure: unknown;
    try {
      await service.save(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelSetupError);
    expect((failure as ModelSetupError).code).toBe("authentication-failed");
    expect(String(failure)).not.toContain(input.apiKey);
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects insecure remote endpoints, embedded credentials and query strings before sending a key", async () => {
    const { service } = configuration();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const endpoint of [
      "http://remote.example/v1",
      "https://user:pass@provider.example/v1",
      "https://provider.example/v1?key=secret",
    ]) {
      await expect(service.save({ ...input, endpoint })).rejects.toMatchObject({
        code: "invalid-endpoint",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let a 200 HTML/error reply masquerade as a working model", async () => {
    const { service, configPath } = configuration();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "not a model response" }), {
            status: 200,
          }),
        ),
      ),
    );
    await expect(service.save(input)).rejects.toMatchObject({
      code: "invalid-provider-response",
    });
    expect(existsSync(configPath)).toBe(false);
  });
});
