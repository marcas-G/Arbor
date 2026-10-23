import { describe, expect, it } from "vitest";
import { safeHandshakeFailure } from "./functional/support/safe-handshake-failure.js";

describe("safe daemon handshake diagnostics", () => {
  it("retains the numeric wrong-port pair without its handshake details", () => {
    const diagnostic = safeHandshakeFailure(
      new Error(
        'functional daemon bound unexpected port: requested=55522 reported=41877; observed={"pid":42,"nonce":"private-nonce","token":"secret-value"}',
      ),
    );

    expect(diagnostic).toBe(
      "functional daemon bound unexpected port: requested=55522 reported=41877",
    );
    expect(diagnostic).not.toContain("private-nonce");
    expect(diagnostic).not.toContain("secret-value");
  });

  it("keeps other handshake failures classified and discards unrecognized detail", () => {
    expect(
      safeHandshakeFailure(
        new Error(
          'functional daemon exited before listening report: code=86 signal=null; observed={"secret":"secret-value"}',
        ),
      ),
    ).toBe("functional daemon exited before listening report");
    expect(safeHandshakeFailure(new Error("private env=secret-value"))).toBe(
      "functional daemon startup handshake failed",
    );
  });

  it("does not retain invalid or out-of-range port numbers", () => {
    expect(
      safeHandshakeFailure(
        new Error(
          "functional daemon bound unexpected port: requested=0 reported=65536; observed=private",
        ),
      ),
    ).toBe("functional daemon bound unexpected port");
  });
});
