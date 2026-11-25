import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSetupGate } from "../src/pages/ModelSetupGate.js";

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("model first-run gate", () => {
  it("does not expose project/work interactions before configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ configured: false }))),
    );
    render(
      <ModelSetupGate>
        <button type="button">开始工作</button>
      </ModelSetupGate>,
    );
    expect(await screen.findByLabelText("模型名称")).toBeTruthy();
    expect(screen.queryByText("开始工作")).toBeNull();
    expect(screen.getByLabelText("API Key").getAttribute("type")).toBe(
      "password",
    );
  });

  it("keeps work unavailable when configuration status cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    render(
      <ModelSetupGate>
        <button type="button">开始工作</button>
      </ModelSetupGate>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("开始工作")).toBeNull();
  });

  it("shows failed authentication without pretending configuration succeeded", async () => {
    const fetch = vi.fn((_url: RequestInfo | URL, options?: RequestInit) =>
      Promise.resolve(
        options?.method === "POST"
          ? json({ ok: false, code: "model-setup/authentication-failed" }, 400)
          : json({ configured: false }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <ModelSetupGate>
        <button type="button">开始工作</button>
      </ModelSetupGate>,
    );
    fireEvent.change(await screen.findByLabelText("模型名称"), {
      target: { value: "chosen-model" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "private-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接并保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "服务拒绝了 API Key",
    );
    expect(screen.queryByText("开始工作")).toBeNull();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "连接并保存" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(document.body.textContent).not.toContain("private-key");
  });
});
