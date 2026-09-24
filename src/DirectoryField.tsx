import { useEffect, useId, useRef, useState } from "react";
import { Folder, ChevronRight } from "lucide-react";
import { rpc } from "./api";
interface Suggestion {
  name: string;
  path: string;
}
export function DirectoryField({
  label,
  value,
  onChange,
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const id = useId(),
    input = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]),
    [open, setOpen] = useState(false),
    [index, setIndex] = useState(0),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setIndex(0);
    setLoading(true);
    const timer = setTimeout(() => {
      void rpc<Suggestion[]>({ op: "completeDirectory", path: value })
        .then((items) => {
          if (!cancelled) setSuggestions(items);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${index}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, index, id]);
  const choose = (item: Suggestion) => {
    onChange(item.path);
    setOpen(false);
    input.current?.focus();
  };
  return (
    <div className="directory-field">
      <label htmlFor={id}>{label}</label>
      <div className="directory-input">
        <Folder size={15} />
        <input
          id={id}
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={
            open && suggestions[index] ? `${id}-${index}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          required={required}
          value={value}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setIndex((i) =>
                Math.max(
                  0,
                  Math.min(
                    suggestions.length - 1,
                    i + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (
              open &&
              suggestions[index] &&
              (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey))
            ) {
              e.preventDefault();
              choose(suggestions[index]);
            }
          }}
        />
        <kbd>tab ↹</kbd>
      </div>
      {open && (
        <div
          className="directory-suggestions"
          id={`${id}-list`}
          role="listbox"
          aria-label={`${label} suggestions`}
        >
          {suggestions.map((item, i) => (
            <div
              key={item.path}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === index}
              className={i === index ? "selected" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(item)}
            >
              <Folder size={14} />
              <span>{item.name}</span>
              <ChevronRight size={13} />
            </div>
          ))}
          {!suggestions.length && (
            <div className="suggestion-empty" role="presentation">
              {loading ? "Finding directories…" : "No matching directories"}
            </div>
          )}
          <div className="suggestion-hint" role="presentation">
            ↑ ↓ navigate <span>Tab ↹ complete</span>
          </div>
        </div>
      )}
    </div>
  );
}
