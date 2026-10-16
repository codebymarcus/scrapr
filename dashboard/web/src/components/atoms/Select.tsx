import styles from "./Select.module.scss";

type SelectOption<T extends string> = {
  value: T;
  label: string;
};

type SelectProps<T extends string> = {
  id: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
};

export function Select<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
}: SelectProps<T>) {
  return (
    <div className={styles.selectWrapper}>
      <select
        id={id}
        className={styles.select}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
