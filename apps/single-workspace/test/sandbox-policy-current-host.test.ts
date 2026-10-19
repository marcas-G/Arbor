import { release } from "node:os";
import { describe, expect, it } from "vitest";
import { sandboxPolicyCurrentHostV1 } from "../src/current-sandbox-authority-snapshot-port.js";

describe("P5 trusted current-host tuple identity", () => {
  it("uses the fixed process.platform family mapping and os.release build", () => {
    const osFamily =
      process.platform === "linux"
        ? "Linux"
        : process.platform === "darwin"
          ? "macOS"
          : process.platform === "win32"
            ? "Windows"
            : undefined;
    const host = sandboxPolicyCurrentHostV1();
    if (osFamily === undefined) {
      expect(host).toBeUndefined();
      return;
    }
    expect(host).toEqual({ osFamily, osBuild: release() });
  });
});
