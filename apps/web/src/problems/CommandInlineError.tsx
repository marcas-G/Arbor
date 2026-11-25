import { cn } from "../lib/utils.js";
/**
 * CommandReceiptView TerminalRejected: inline command-panel error. The form
 * stays editable and resubmittable under a new commandId (`03` §5).
 */
export function CommandInlineError({
  rejection,
}: {
  readonly rejection: string;
}) {
  const title =
    rejection === "RevisionConflict"
      ? "版本冲突"
      : rejection === "AuthorityDenied"
        ? "权限拒绝"
        : "操作未完成";
  return (
    <div
      className={cn(
        "arbor-inline-error",
        "flex flex-col gap-ui-1 p-[var(--arbor-space-2)_var(--arbor-space-3)] border border-solid border-destructive rounded-sm text-destructive text-small",
      )}
      role="alert"
    >
      <h2 className={cn("arbor-inline-error-title", "m-0 text-body")}>
        {title}
      </h2>
      <p>请检查当前内容或权限，修改后重新提交。</p>
      <details>
        <summary>问题详情</summary>
        <span className={cn("arbor-mono", "font-mono text-small")}>
          {rejection}
        </span>
      </details>
    </div>
  );
}
