import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GrantPermissionForm } from "../src/commands/forms/GrantPermissionForm.js";

/**
 * W-00 proof ④ — GrantPermission issuer restriction (FROZEN):
 * issuer = the current authenticated principal, presented read-only.
 * The user canNOT edit the issuer; no delegated issuance in Web v1.
 */

const committed = () =>
  new Response(
    JSON.stringify({
      ok: true,
      status: 200,
      body: { commandId: "cmd_x", resolution: "Committed" },
    }),
    { status: 200 },
  );

const readBody = (mock: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const call = mock.mock.calls[0] as unknown as [string, { body: string }];
  return JSON.parse(call[1].body) as Record<string, unknown>;
};

describe("Grant issuer read-only restriction", () => {
  it("renders NO editable issuer control", () => {
    render(
      <GrantPermissionForm
        actor="user:lgao"
        projectId="prj_1"
        onSubmitted={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/issuer/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/issuer/i)).toBeNull();
  });

  it("payload issuer is exactly the authenticated actor (never editable input)", async () => {
    const mock = vi.fn(async () => committed());
    vi.stubGlobal("fetch", mock);
    render(
      <GrantPermissionForm
        actor="user:lgao"
        projectId="prj_1"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "授予" }));
    await waitFor(() => expect(mock.mock.calls.length).toBe(1));
    const body = readBody(mock);
    expect(body.actor).toBe("user:lgao");
    const payload = body.payload as Record<string, unknown>;
    expect(payload.issuer).toBe("user:lgao");
    vi.unstubAllGlobals();
  });
});
