import styles from "./TextInput.module.scss";

type TextInputProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "search";
  placeholder?: string;
};

export function TextInput({
  id,
  value,
  onChange,
  type = "text",
  placeholder,
}: TextInputProps) {
  return (
    <input
      id={id}
      type={type}
      className={styles.input}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
