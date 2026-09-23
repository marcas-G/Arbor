import { type ReactNode, useId } from "react";

type FieldBase = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
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

export function Field(props: FieldProps) {
  const { label, value, onChange, disabled } = props;
  const controlId = useId();
  const handleChange = (next: string): void => {
    onChange(next);
  };
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
          onChange={(event) => handleChange(event.target.value)}
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
          onChange={(event) => handleChange(event.target.value)}
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
          onChange={(event) => handleChange(event.target.value)}
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
    </div>
  );
}
