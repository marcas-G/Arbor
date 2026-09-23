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

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "项目名称必填"),
  objective: z.string().trim().min(1, "根责任目标必填"),
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

export const stopExecutionSchema = z.object({
  executionId,
  confirmed: z.literal(true, { message: "必须显式确认停止" }),
});

export const grantPermissionSchema = z.object({
  capability: z.string().trim().min(1, "capability 必填"),
  target: z.string().trim(),
  lifetime: z
    .string()
    .regex(
      /^P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/,
      "ISO 8601 时长，如 PT1H",
    ),
});

export const revokePermissionSchema = z.object({
  permissionGrantId: grantId,
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
