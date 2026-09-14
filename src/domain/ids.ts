declare const brand: unique symbol;

export type ProjectId = string & { readonly [brand]: "ProjectId" };
export type WorkspaceId = string & { readonly [brand]: "WorkspaceId" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newProjectId(): ProjectId {
  return crypto.randomUUID() as ProjectId;
}

export function newWorkspaceId(): WorkspaceId {
  return crypto.randomUUID() as WorkspaceId;
}

export function asProjectId(s: string): ProjectId | undefined {
  return UUID_RE.test(s) ? (s as ProjectId) : undefined;
}

export function asWorkspaceId(s: string): WorkspaceId | undefined {
  return UUID_RE.test(s) ? (s as WorkspaceId) : undefined;
}
