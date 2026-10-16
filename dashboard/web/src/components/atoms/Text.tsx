import type { ElementType, HTMLAttributes, ReactNode } from "react";
import styles from "./Text.module.scss";

type TextVariant =
  | "display"
  | "title"
  | "heading"
  | "subtitle"
  | "body"
  | "small"
  | "caption";
type TextTone = "default" | "secondary" | "positive" | "negative";
type TextWeight = "regular" | "medium" | "semibold" | "bold";
type TextElement = "h1" | "h2" | "h3" | "p" | "span" | "div";

type TextProps = {
  variant?: TextVariant;
  as?: TextElement;
  tone?: TextTone;
  weight?: TextWeight;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children" | "color">;

const DEFAULT_AS: Record<TextVariant, TextElement> = {
  display: "h1",
  title: "h2",
  heading: "h2",
  subtitle: "p",
  body: "p",
  small: "span",
  caption: "span",
};

export function Text({
  variant = "body",
  as,
  tone = "default",
  weight,
  className,
  children,
  ...rest
}: TextProps) {
  const Tag: ElementType = as ?? DEFAULT_AS[variant];

  const classes = [
    styles.text,
    styles[variant],
    styles[`tone-${tone}`],
    weight ? styles[`weight-${weight}`] : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
