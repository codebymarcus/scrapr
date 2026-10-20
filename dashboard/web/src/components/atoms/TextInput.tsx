import styles from "./TextInput.module.scss";

type TextInputProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "search" | "number";
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
};

export function TextInput({
  id,
  value,
  onChange,
  type = "text",
  min,
  max,
  placeholder,
  disabled,
}: TextInputProps) {
  return (
    <input
      id={id}
      type={type}
      min={min}
      max={max}
      className={styles.input}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
