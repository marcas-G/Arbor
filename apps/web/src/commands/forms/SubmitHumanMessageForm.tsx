/**
 * P14 `04` §2 — conversation composer: the ONLY input face (root workspace).
 *
 * Frozen submission semantics: messageId is caller-preallocated
 * (`msg_<uuid-v7>`) and held across transport-failure retries (same idempotency
 * anchor as commandId — `useCommandSubmission`); a Committed receipt clears the
 * input and invalidates the view cache (the authoritative Human/Assistant
 * turn only arrives through a `/views` refetch — never inserted locally).
 */
import { useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useRef } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Field } from "../../components/Field.js";
import { cn } from "../../lib/utils.js";
import { submitHumanMessageSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";

type MessageValues = { bodyRef: string };

export function SubmitHumanMessageForm({
  actor,
  token,
  projectId,
  targetWorkspaceId,
  onSubmitted,
  onMessageSubmitted,
}: {
  readonly actor: string;
  readonly token?: string | undefined;
  readonly projectId: string;
  readonly targetWorkspaceId: string;
  readonly onSubmitted?: ((receipt: CommandReceiptView) => void) | undefined;
  readonly onMessageSubmitted?:
    | ((messageId: string, body: string) => void)
    | undefined;
}) {
  const queryClient = useQueryClient();
  const idsRef = useRef<{
    readonly messageId: string;
    readonly bodyRef: string;
  } | null>(null);
  const { handleSubmit, setValue, watch, reset, formState } =
    useForm<MessageValues>({
      resolver: zodResolver(
        submitHumanMessageSchema,
      ) as Resolver<MessageValues>,
      defaultValues: { bodyRef: "" },
    });
  const bodyRef = watch("bodyRef");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted: (receipt) => {
      const submitted = idsRef.current;
      if (submitted !== null) {
        onMessageSubmitted?.(submitted.messageId, submitted.bodyRef);
      }
      idsRef.current = null;
      reset({ bodyRef: "" });
      void queryClient.invalidateQueries({ queryKey: ["view"] });
      onSubmitted?.(receipt);
    },
  });
  const submissionLocked =
    state.phase === "submitting" || state.phase === "transport-failed";
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) => {
      const ids = idsRef.current ?? {
        messageId: `msg_${uuidv7()}`,
        bodyRef: values.bodyRef,
      };
      idsRef.current = ids;
      void submit("SubmitHumanMessage", projectId, {
        messageId: ids.messageId,
        targetWorkspaceId,
        bodyRef: values.bodyRef,
      });
    })();
  };
  return (
    <form
      className={cn(
        "arbor-command-form arbor-conversation-composer",
        "flex flex-col gap-ui-3 gap-ui-2 [&_textarea]:min-h-[76px] [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:leading-[1.55] [&_textarea]:outline-none [&_textarea:focus]:border-0 [&_textarea:focus]:outline-none",
      )}
      onSubmit={doSubmit}
    >
      <Field
        control="textarea"
        label="消息"
        disabled={submissionLocked}
        rows={3}
        placeholder="向 Arbor 描述你想让它做的事"
        value={bodyRef}
        onChange={(next) => {
          setValue("bodyRef", next);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault();
            doSubmit();
          }
        }}
      />
      {formState.errors.bodyRef ? (
        <p
          className={cn(
            "arbor-command-error",
            "m-0 text-small text-destructive",
          )}
        >
          {formState.errors.bodyRef.message}
        </p>
      ) : null}
      <FormFeedback state={state} onRetry={() => doSubmit()} />
      <div
        className={cn(
          "arbor-composer-footer",
          "flex items-center justify-between gap-ui-3 pt-ui-2 border-t border-solid border-border",
        )}
      >
        <span className={cn("arbor-composer-hint", "text-subtle text-caption")}>
          Enter 发送 · Shift + Enter 换行
        </span>
        <Button
          variant="primary"
          type="submit"
          disabled={state.phase === "submitting"}
        >
          发送
        </Button>
      </div>
    </form>
  );
}
