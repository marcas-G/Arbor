import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFilePermissionForm } from "../src/commands/forms/WorkspaceFilePermissionForm.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("contextual file permission", () => {
  it("defaults to explicitly granting persistent permission only for this Workspace", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const envelope = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
        requests.push(envelope);
        return new Response(
          JSON.stringify({
            ok: true,
            body: {
              commandId: envelope.commandId,
              resolution: "Committed",
            },
          }),
          { status: 200 },
        );
      }),
    );
    render(
      <WorkspaceFilePermissionForm
        actor="user:local"
        projectId="prj_current"
        workspaceId="ws_current"
        objective="修改 README"
        onSubmitted={vi.fn()}
      />,
    );
    expect(requests).toHaveLength(0);
    expect(screen.getByLabelText("文件修改权限有效期")).toHaveProperty(
      "value",
      "persistent",
    );
    fireEvent.click(screen.getByRole("button", { name: "授权修改项目文件" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      payload: {
        subject: { _tag: "WorkspaceAgent", workspaceId: "ws_current" },
        target: "ws_current",
        capability: "fs:write",
        expiresAt: null,
      },
    });
  });

  it("requires an explicit grant and preserves its exact scope and expiry across transport retries", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const onSubmitted = vi.fn();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1794666000000);
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const envelope = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(envelope);
      if (requests.length === 1) throw new Error("response lost");
      return new Response(
        JSON.stringify({
          ok: true,
          body: {
            commandId: envelope.commandId,
            resolution: "Committed",
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <WorkspaceFilePermissionForm
        actor="user:local"
        projectId="prj_current"
        workspaceId="ws_current"
        objective="修改 README"
        token="local-token"
        onSubmitted={onSubmitted}
      />,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.change(screen.getByLabelText("文件修改权限有效期"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "授权修改项目文件" }));
    await screen.findByRole("alert");
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.getByLabelText("文件修改权限有效期")).toHaveProperty(
      "disabled",
      true,
    );
    expect(requests[0]).toMatchObject({
      commandType: "GrantPermission",
      projectId: "prj_current",
      actor: "user:local",
      payload: {
        issuer: "user:local",
        subject: { _tag: "WorkspaceAgent", workspaceId: "ws_current" },
        capability: "fs:write",
        target: "ws_current",
        expiresAt: new Date(1794666000000 + 8 * 3600000).toISOString(),
      },
    });
    clock.mockReturnValue(1794666000000 + 300000);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(requests[1]?.commandId).toBe(requests[0]?.commandId);
    expect(requests[1]?.payload).toEqual(requests[0]?.payload);
    expect(screen.getByRole("status").textContent).toContain(
      "授权本身不会自动重试",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
