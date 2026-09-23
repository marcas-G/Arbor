import { type ReactNode, useId } from "react";
import { cx } from "./cx.js";
import styles from "./Field.module.css";

type FieldBase = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
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
    });

/** W-01 formal Field: controlled input | select | textarea with label and
 * optional inline error. */
export function Field(props: FieldProps) {
  const { label, value, onChange, disabled, error } = props;
  const controlId = useId();
  const errorId = `${controlId}-error`;
  const describedBy = error !== undefined ? errorId : undefined;
  const invalid = error !== undefined;
  let control: ReactNode;
  switch (props.control) {
    case "input":
      control = (
        <input
          id={controlId}
          className="arbor-field-control"
          value={value}
          disabled={disabled}
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
          className="arbor-field-control"
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
        <textarea
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
        />
      );
      break;
  }
  return (
    <div className="arbor-field">
      <label className="arbor-field-label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {error === undefined ? null : (
        <p className={cx(["arbor-field-error", styles.error])} id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
