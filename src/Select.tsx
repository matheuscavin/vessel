import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`select ${className ?? ""}`.trim()}>
      <select {...props}>{children}</select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  );
}
