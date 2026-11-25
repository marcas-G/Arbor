import { z } from "zod";

const listing = z.object({
  path: z.string(),
  parent: z.string(),
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
  truncated: z.boolean(),
});

const prepared = z.object({
  path: z.string(),
  name: z.string(),
  selection: z.object({
    _tag: z.literal("Profile"),
    resourceProfileRef: z.string(),
    version: z.string(),
  }),
  existingProject: z
    .object({
      projectId: z.string(),
      rootWorkspaceId: z.string(),
      name: z.string(),
      lifecycle: z.enum(["Open", "Closed"]),
    })
    .nullable(),
});

export type ProjectDirectoryListing = z.infer<typeof listing>;
export type PreparedProjectDirectory = z.infer<typeof prepared>;

const messages: Record<string, string> = {
  "invalid-path": "请输入运行 Arbor 服务的机器上的完整目录路径。",
  "not-found": "目录不存在。需要创建时，请勾选“新建此文件夹”。",
  "not-directory": "该路径指向文件，请选择文件夹。",
  "permission-denied": "Arbor 无法访问此目录，请检查权限或选择其他目录。",
  "parent-not-found": "父目录不存在，请先选择已有的存放位置。",
  "registry-unavailable": "无法保存目录选择，请检查 Arbor 数据目录的写入权限。",
  forbidden: "当前用户无权选择此服务的项目目录。",
  unauthenticated: "连接已失效，请重新连接 Arbor。",
};

const request = async <Value>(
  url: string,
  token: string,
  schema: z.ZodType<Value>,
  body?: unknown,
): Promise<Value> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("无法连接 Arbor，请检查连接后重试。");
  }
  const envelope = z
    .object({
      ok: z.boolean(),
      body: z.unknown().optional(),
      problem: z.object({ code: z.string() }).optional(),
    })
    .safeParse(await response.json().catch(() => null));
  if (!envelope.success || !response.ok || !envelope.data.ok) {
    const code = envelope.success
      ? (envelope.data.problem?.code.split("/").at(-1) ?? "")
      : "";
    throw new Error(messages[code] ?? "无法读取或选择项目目录，请重试。");
  }
  const value = schema.safeParse(envelope.data.body);
  if (!value.success) throw new Error("Arbor 返回的目录信息不完整，请重试。");
  return value.data;
};

export const browseProjectDirectories = (token: string, path?: string) =>
  request(
    `/project-directories${path === undefined || path === "" ? "" : `?path=${encodeURIComponent(path)}`}`,
    token,
    listing,
  );

export const prepareProjectDirectory = (
  token: string,
  path: string,
  create: boolean,
) => request("/project-directories", token, prepared, { path, create });
