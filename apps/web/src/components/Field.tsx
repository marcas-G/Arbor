import { type KeyboardEvent, type ReactNode, useId } from "react";
import { cn } from "../lib/utils.js";
import { Input, inputClassName } from "./ui/input.js";
import { Textarea } from "./ui/textarea.js";

type FieldBase = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  /** W-01: inline validation message, rendered in danger tone below the
   * control and wired via aria-invalid / aria-describedby. */
  readonly error?: string | undefined;
};

export type FieldOption = {
  readonly value: string;
  readonly label: string;
};

export type FieldProps =
  | (FieldBase & {
      readonly control: "input";
      readonly placeholder?: string | undefined;
    })
  | (FieldBase & {
      readonly control: "select";
      readonly options: ReadonlyArray<FieldOption>;
    })
  | (FieldBase & {
      readonly control: "textarea";
      readonly rows?: number | undefined;
      readonly placeholder?: string | undefined;
      readonly onKeyDown?:
        | ((event: KeyboardEvent<HTMLTextAreaElement>) => void)
        | undefined;
    });

/** W-01 formal Field: controlled input | select | textarea with label and
 * optional inline error. */
export function Field(props: FieldProps) {
  const { label, value, onChange, disabled, readOnly, error } = props;
  const controlId = useId();
  const errorId = `${controlId}-error`;
  const describedBy = error !== undefined ? errorId : undefined;
  const invalid = error !== undefined;
  let control: ReactNode;
  switch (props.control) {
    case "input":
      control = (
        <Input
          id={controlId}
          className="arbor-field-control"
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          placeholder={props.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
      break;
    case "select":
      control = (
        <select
          id={controlId}
          className={cn(inputClassName, "arbor-field-control")}
          value={value}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
    case "textarea":
      control = (
        <Textarea
          id={controlId}
          className="arbor-field-control"
          value={value}
          disabled={disabled}
          rows={props.rows}
          placeholder={props.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={props.onKeyDown}
        />
      );
      break;
  }
  return (
    <div className="arbor-field grid gap-ui-1">
      <label
        className="arbor-field-label text-caption font-semibold text-muted-foreground"
        htmlFor={controlId}
      >
        {label}
      </label>
      {control}
      {error === undefined ? null : (
        <p
          className="arbor-field-error m-0 text-small text-destructive"
          id={errorId}
        >
          {error}
        </p>
      )}
    </div>
  );
}
