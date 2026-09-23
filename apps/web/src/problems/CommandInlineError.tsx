/**
 * CommandReceiptView TerminalRejected: inline command-panel error. The form
 * stays editable and resubmittable under a new commandId (`03` §5).
 */
export function CommandInlineError({
  rejection,
}: {
  readonly rejection: string;
}) {
  return (
    <div className="arbor-inline-error" role="alert">
      <p>
        <span className="arbor-mono">{rejection}</span>
      </p>
      <p>命令被终态拒绝：可修改后重新提交（将生成新的 commandId）。</p>
    </div>
  );
}
