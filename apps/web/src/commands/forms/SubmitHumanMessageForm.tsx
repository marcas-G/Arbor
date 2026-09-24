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
import { submitHumanMessageSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

type MessageValues = { bodyRef: string };

export function SubmitHumanMessageForm({
  actor,
  token,
  projectId,
  targetWorkspaceId,
  onSubmitted,
}: {
  readonly actor: string;
  readonly token?: string | undefined;
  readonly projectId: string;
  readonly targetWorkspaceId: string;
  readonly onSubmitted?: ((receipt: CommandReceiptView) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const idsRef = useRef<{ readonly messageId: string } | null>(null);
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
      idsRef.current = null;
      reset({ bodyRef: "" });
      void queryClient.invalidateQueries({ queryKey: ["view"] });
      onSubmitted?.(receipt);
    },
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) => {
      const ids = idsRef.current ?? { messageId: `msg_${uuidv7()}` };
      idsRef.current = ids;
      void submit("SubmitHumanMessage", projectId, {
        messageId: ids.messageId,
        targetWorkspaceId,
        bodyRef: values.bodyRef,
      });
    })();
  };
  return (
    <form className="arbor-command-form" onSubmit={doSubmit}>
      <Field
        control="textarea"
        label="消息"
        rows={3}
        placeholder="向 Arbor 描述你想让它做的事"
        value={bodyRef}
        onChange={(next) => {
          setValue("bodyRef", next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            doSubmit();
          }
        }}
      />
      {formState.errors.bodyRef ? (
        <p className="arbor-command-error">
          {formState.errors.bodyRef.message}
        </p>
      ) : null}
      <FormFeedback state={state} onRetry={() => doSubmit()} />
      <Button
        variant="primary"
        type="submit"
        disabled={state.phase === "submitting"}
      >
        发送
      </Button>
    </form>
  );
}
