import styles from "./TextArea.module.scss";

type TextAreaProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
};

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  rows = 6,
}: TextAreaProps) {
  return (
    <textarea
      id={id}
      className={styles.textarea}
      value={value}
      rows={rows}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
