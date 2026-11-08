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
    <div className="arbor-inline-error" role="alert">
      <h2 className="arbor-inline-error-title">{title}</h2>
      <p>请检查当前内容或权限，修改后重新提交。</p>
      <details>
        <summary>问题详情</summary>
        <span className="arbor-mono">{rejection}</span>
      </details>
    </div>
  );
}
