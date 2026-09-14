declare const brand: unique symbol;

export type ProjectId = string & { readonly [brand]: "ProjectId" };
export type WorkspaceId = string & { readonly [brand]: "WorkspaceId" };
export type ChangeId = string & { readonly [brand]: "ChangeId" };
export type VerificationId = string & { readonly [brand]: "VerificationId" };
export type EffectiveResultId = string & { readonly [brand]: "EffectiveResultId" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newProjectId(): ProjectId {
  return crypto.randomUUID() as ProjectId;
}
export function newWorkspaceId(): WorkspaceId {
  return crypto.randomUUID() as WorkspaceId;
}
export function newChangeId(): ChangeId {
  return crypto.randomUUID() as ChangeId;
}
export function newVerificationId(): VerificationId {
  return crypto.randomUUID() as VerificationId;
}
export function newEffectiveResultId(): EffectiveResultId {
  return crypto.randomUUID() as EffectiveResultId;
}
export function asProjectId(s: string): ProjectId | undefined {
  return UUID_RE.test(s) ? (s as ProjectId) : undefined;
}
export function asWorkspaceId(s: string): WorkspaceId | undefined {
  return UUID_RE.test(s) ? (s as WorkspaceId) : undefined;
}
export function asChangeId(s: string): ChangeId | undefined {
  return UUID_RE.test(s) ? (s as ChangeId) : undefined;
}
export function asVerificationId(s: string): VerificationId | undefined {
  return UUID_RE.test(s) ? (s as VerificationId) : undefined;
}
export function asEffectiveResultId(s: string): EffectiveResultId | undefined {
  return UUID_RE.test(s) ? (s as EffectiveResultId) : undefined;
}
