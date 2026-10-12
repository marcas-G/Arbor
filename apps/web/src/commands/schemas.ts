/**
 * W-08 — Zod browser-input schemas mirroring the FROZEN command payloads
 * (validation only — they never redefine api-contracts semantics; the
 * server remains the sole authority on accepted shapes).
 */
import { z } from "zod";

const workspaceId = z
  .string()
  .regex(/^ws_[A-Za-z0-9_-]+$/, "ws_ 前缀的工作区 ID");
const workId = z.string().regex(/^wrk_[A-Za-z0-9_-]+$/, "wrk_ 前缀的工作 ID");
const executionId = z
  .string()
  .regex(/^exe_[A-Za-z0-9_-]+$/, "exe_ 前缀的执行 ID");
const proposalId = z
  .string()
  .regex(/^fpr_[A-Za-z0-9_-]+$/, "fpr_ 前缀的提案 ID");
const verificationId = z
  .string()
  .regex(/^ver_[A-Za-z0-9_-]+$/, "ver_ 前缀的验证 ID");
const grantId = z.string().regex(/^pgr_[A-Za-z0-9_-]+$/, "pgr_ 前缀的授权 ID");

const isStrictIsoTimestamp = (value: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
};

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "项目名称必填"),
});

export const renameProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "项目名称必填")
    .max(120, "项目名称最多 120 个字符"),
});

export const recordDecisionSchema = z.object({
  proposalId,
  expectedProposalRevision: z.number().int().min(1),
  outcome: z.enum(["Approve", "Reject"]),
});

export const steerWorkSchema = z
  .object({
    workId,
    workspaceId,
    guidance: z.string().trim().min(1, "纠偏内容必填"),
    severity: z.enum(["Normal", "Critical"]),
    criticalConfirmed: z.boolean(),
    expectedWorkRevision: z.number().int().min(0),
  })
  .refine((value) => value.severity !== "Critical" || value.criticalConfirmed, {
    message: "Critical 需显式二次确认",
    path: ["criticalConfirmed"],
  });

export const acceptWorkOutcomeSchema = z.object({
  workId,
  targetWorkRevision: z.number().int().min(0),
  verificationId,
});

export const retryVerificationSchema = z.object({
  workId,
  verificationId,
  expectedWorkRevision: z.number().int().min(0),
  summaryContent: z.string().trim().min(1, "说明必填").max(8192),
  successorVerificationId: verificationId,
  verifierExecutionId: executionId,
});

export const stopExecutionSchema = z.object({
  executionId,
  confirmed: z.literal(true, { message: "必须显式确认停止" }),
});

export const grantPermissionSchema = z.object({
  subjectKind: z.enum(["HumanPrincipal", "WorkspaceAgent", "Execution"]),
  subjectRef: z.string().trim().min(1, "授权主体必填"),
  capability: z.string().trim().min(1, "capability 必填"),
  target: z
    .string()
    .min(1, "授权目标必填；请填写精确的资源 ID")
    .refine((value) => value === value.trim(), "授权目标不能包含首尾空格"),
  expiresAt: z
    .string()
    .min(1, "过期时间必填；GrantPermission 必须有有效期")
    .refine(isStrictIsoTimestamp, "请输入有效的 ISO 时间，并明确包含时区")
    .refine(
      (value) => Date.parse(value) > Date.now(),
      "过期时间必须晚于当前时间",
    ),
});

export const revokePermissionSchema = z.object({
  permissionGrantId: grantId,
});

export const submitHumanMessageSchema = z.object({
  bodyRef: z.string().trim().min(1).max(8192),
});

/** RHF-compatible resolver built from a Zod schema (no extra dependency).
 * Loosely typed to satisfy RHF's Resolver variance across input/output. */
export const zodResolver =
  <Schema extends z.ZodType>(schema: Schema): unknown =>
  (values: unknown) => {
    const result = schema.safeParse(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }
    const errors: Record<string, { message: string }> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "form";
      if (errors[key] === undefined) {
        errors[key] = { message: issue.message };
      }
    }
    return { values: {}, errors };
  };
