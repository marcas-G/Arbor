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

  it("retains the numeric readiness deadline without the response details", () => {
    const diagnostic = safeHandshakeFailure(
      new Error(
        'functional daemon HTTP readiness timed out after 1500ms; last=HTTP readiness returned 503 with secret="private-value"',
      ),
    );

    expect(diagnostic).toBe(
      "functional daemon HTTP readiness timed out after 1500ms",
    );
    expect(diagnostic).not.toContain("private-value");
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

  it("keeps the most specific readiness cause through nested startup wrappers", () => {
    const original = new Error(
      "functional daemon exited before HTTP readiness; exitCode=23; sentinel=private-value",
    );
    const onceWrapped = new Error(
      "functional daemon startup failed: readiness handshake; exitCode=23",
      { cause: original },
    );
    const multiplyWrapped = new Error("fixture initialization failed", {
      cause: onceWrapped,
    });

    expect(safeHandshakeFailure(original)).toBe(
      "functional daemon exited before HTTP readiness",
    );
    expect(safeHandshakeFailure(onceWrapped)).toBe(
      "functional daemon exited before HTTP readiness",
    );
    expect(safeHandshakeFailure(multiplyWrapped)).toBe(
      "functional daemon exited before HTTP readiness",
    );
    expect(safeHandshakeFailure(multiplyWrapped)).not.toContain(
      "private-value",
    );
  });

  it("retains only safe requested/reported ports through a wrapper cause", () => {
    const source = new Error(
      'functional daemon bound unexpected port: requested=55522 reported=41877; observed={"token":"secret-value"}',
    );
    const wrapped = new Error("restart child failed to start", {
      cause: new Error("fixture startup failed", { cause: source }),
    });

    expect(safeHandshakeFailure(wrapped)).toBe(
      "functional daemon bound unexpected port: requested=55522 reported=41877",
    );
    expect(safeHandshakeFailure(wrapped)).not.toContain("secret-value");
  });

  it("retains a safe readiness timeout value through a wrapper cause", () => {
    const wrapped = new Error("fixture startup failed", {
      cause: new Error(
        "functional daemon HTTP readiness timed out after 1500ms; last=private-value",
      ),
    });

    expect(safeHandshakeFailure(wrapped)).toBe(
      "functional daemon HTTP readiness timed out after 1500ms",
    );
    expect(safeHandshakeFailure(wrapped)).not.toContain("private-value");
  });

  it("terminates safely on a cyclic cause chain", () => {
    const wrapper = new Error("fixture startup failed; token=secret-value");
    const source = new Error(
      "functional daemon exited before HTTP readiness; secret=private-value",
    );
    Object.defineProperty(wrapper, "cause", { value: source });
    Object.defineProperty(source, "cause", { value: wrapper });

    expect(safeHandshakeFailure(wrapper)).toBe(
      "functional daemon exited before HTTP readiness",
    );
    expect(safeHandshakeFailure(wrapper)).not.toContain("secret");
    expect(safeHandshakeFailure(wrapper)).not.toContain("private-value");
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
