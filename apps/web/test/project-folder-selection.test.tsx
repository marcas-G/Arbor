import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateProjectForm } from "../src/commands/forms/CreateProjectForm.js";

const json = (body: unknown) =>
  new Response(JSON.stringify({ ok: true, body }), { status: 200 });
const catalog = () =>
  json({
    profiles: [],
    conversationOnlySupported: true,
    directorySelectionSupported: true,
  });
const selected = {
  path: "/projects/中文 工程",
  name: "中文 工程",
  selection: {
    _tag: "Profile",
    resourceProfileRef: "directory-selected",
    version: "v1",
  },
  existingProject: null,
};
const committed = () =>
  json({ commandId: "cmd_server", resolution: "Committed" });

afterEach(() => {
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("project folder selection", () => {
  it("does not create a Project if the form is closed while a directory selection is pending", async () => {
    let finishPreparation: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/project-resources") return catalog();
      return new Promise<Response>((resolveResponse) => {
        finishPreparation = resolveResponse;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const form = render(
      <CreateProjectForm
        actor="user:local"
        token="local"
        onSubmitted={vi.fn()}
        quickStart
      />,
    );
    fireEvent.change(await screen.findByLabelText("项目目录"), {
      target: { value: selected.path },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() => expect(finishPreparation).toBeDefined());
    form.unmount();
    finishPreparation?.(json(selected));
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(fetchMock.mock.calls.some(([url]) => url === "/commands")).toBe(
      false,
    );
  });

  it("registers a selected path but submits only the opaque selector to CreateProject", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/project-resources") return catalog();
      if (url === "/project-directories") return json(selected);
      return committed();
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CreateProjectForm
        actor="user:local"
        token="local"
        onSubmitted={vi.fn()}
        quickStart
      />,
    );
    const path = await screen.findByLabelText("项目目录");
    fireEvent.change(path, { target: { value: selected.path } });
    fireEvent.click(screen.getByLabelText("新建此文件夹"));
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/commands")).toBe(
        true,
      ),
    );
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(
      JSON.parse(
        String(
          calls.find(([url]) => url === "/project-directories")?.[1]?.body,
        ),
      ),
    ).toEqual({ path: selected.path, create: true });
    const envelope = JSON.parse(
      String(calls.find(([url]) => url === "/commands")?.[1]?.body),
    );
    expect(envelope.payload.rootWorkspace.resourceSelection).toEqual(
      selected.selection,
    );
    expect(envelope.payload.name).toBe("中文 工程");
    expect(JSON.stringify(envelope)).not.toContain("/projects/");
    expect(screen.queryByText("Arbor 项目文件")).toBeNull();
  });

  it("opens an existing project without creating a new Project or synthetic receipt", async () => {
    const onSubmitted = vi.fn();
    const onProjectOpened = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/project-resources"
        ? catalog()
        : json({
            ...selected,
            existingProject: {
              projectId: "prj_existing",
              rootWorkspaceId: "ws_root",
              name: "Existing",
              lifecycle: "Open",
            },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CreateProjectForm
        actor="user:local"
        token="local"
        onSubmitted={onSubmitted}
        onProjectOpened={onProjectOpened}
        quickStart
      />,
    );
    fireEvent.change(await screen.findByLabelText("项目目录"), {
      target: { value: selected.path },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() =>
      expect(onProjectOpened).toHaveBeenCalledWith("prj_existing"),
    );
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/commands")).toBe(
      false,
    );
  });

  it("keeps a transport-failed creation identity instead of preparing the directory again", async () => {
    let commandAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/project-resources") return catalog();
      if (String(input) === "/project-directories") return json(selected);
      commandAttempts += 1;
      if (commandAttempts === 1) throw new Error("lost response");
      return committed();
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CreateProjectForm
        actor="user:local"
        token="local"
        onSubmitted={vi.fn()}
        quickStart
      />,
    );
    fireEvent.change(await screen.findByLabelText("项目目录"), {
      target: { value: selected.path },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(commandAttempts).toBe(2));
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const commands = calls
      .filter(([url]) => url === "/commands")
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(commands[1].commandId).toBe(commands[0].commandId);
    expect(commands[1].payload).toEqual(commands[0].payload);
    expect(
      calls.filter(([url]) => url === "/project-directories"),
    ).toHaveLength(1);
  });

  it("browses host directories and selects a folder without creating anything", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/project-resources"
        ? catalog()
        : json({
            path: "/projects",
            parent: "/",
            entries: [{ name: "existing", path: "/projects/existing" }],
            truncated: false,
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CreateProjectForm
        actor="user:local"
        token="local"
        onSubmitted={vi.fn()}
        quickStart
      />,
    );
    await screen.findByLabelText("项目目录");
    fireEvent.click(screen.getByRole("button", { name: "浏览文件夹" }));
    expect(
      await screen.findByRole("button", { name: "existing /" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "使用此文件夹" }));
    expect((screen.getByLabelText("项目目录") as HTMLInputElement).value).toBe(
      "/projects",
    );
    expect(fetchMock.mock.calls.some(([url]) => url === "/commands")).toBe(
      false,
    );
  });
});
