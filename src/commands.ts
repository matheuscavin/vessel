export const mac = /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = mac ? "⌘" : "Ctrl";
export const commandDefinitions = [
  {
    id: "new-session",
    label: "New session",
    hint: "Start a new context",
    key: "Mod+N",
  },
  {
    id: "quick-session",
    label: "Quick session",
    hint: "Start one in your home directory, no questions",
    key: "Mod+Shift+N",
  },
  {
    id: "new-terminal",
    label: "New terminal",
    hint: "Open a shell in this session",
    key: "Mod+T",
  },
  {
    id: "split-right",
    label: "Split right",
    hint: "Open a pane beside the focused one",
    key: "Mod+Shift+ArrowRight",
  },
  {
    id: "split-down",
    label: "Split down",
    hint: "Open a pane below the focused one",
    key: "Mod+Shift+ArrowDown",
  },
  {
    id: "tabs-layout",
    label: "Show terminals as tabs",
    hint: "Collapse the panes back to one terminal",
    key: "",
  },
  {
    id: "close-terminal",
    label: "Close terminal",
    hint: "End the selected process",
    key: "Mod+W",
  },
  {
    id: "rename-session",
    label: "Rename session",
    hint: "Give this context a name",
    key: "Mod+Shift+R",
  },
  {
    id: "rename-terminal",
    label: "Rename terminal",
    hint: "Give this shell a name",
    key: "",
  },
  {
    id: "duplicate-terminal",
    label: "Duplicate terminal",
    hint: "New shell in the same directory",
    key: "",
  },
  {
    id: "restart-terminal",
    label: "Restart terminal",
    hint: "Restart an exited shell",
    key: "",
  },
  {
    id: "next-terminal",
    label: "Next terminal",
    hint: "Move through terminal tabs",
    key: "Mod+Shift+]",
  },
  {
    id: "previous-terminal",
    label: "Previous terminal",
    hint: "Move through terminal tabs",
    key: "Mod+Shift+[",
  },
  {
    id: "next-session",
    label: "Next session",
    hint: "Move through sessions",
    key: "Mod+Alt+ArrowDown",
  },
  {
    id: "next-workspace",
    label: "Next workspace",
    hint: "Switch working context",
    key: "Mod+Alt+ArrowRight",
  },
  {
    id: "new-workspace",
    label: "New workspace",
    hint: "Separate your projects",
    key: "",
  },
  {
    id: "delete-session",
    label: "Delete session",
    hint: "Remove this session and its terminals",
    key: "",
  },
  {
    id: "delete-workspace",
    label: "Delete workspace",
    hint: "Remove this context and its sessions",
    key: "",
  },
  {
    id: "settings",
    label: "Open settings",
    hint: "Make Vessel yours",
    key: "Mod+,",
  },
  {
    id: "palette",
    label: "Command palette",
    hint: "Find any command",
    key: "Mod+Shift+P",
  },
] as const;
export type CommandId = (typeof commandDefinitions)[number]["id"];
export function matches(event: KeyboardEvent, binding: string) {
  if (!binding) return false;
  const parts = binding.toLowerCase().split("+");
  const key = parts.pop();
  return (
    event.key.toLowerCase() === key &&
    (mac ? event.metaKey : event.ctrlKey) === parts.includes("mod") &&
    event.shiftKey === parts.includes("shift") &&
    event.altKey === parts.includes("alt") &&
    !(mac ? event.ctrlKey : event.metaKey)
  );
}
export function displayKey(key: string) {
  return key
    .replace("Mod", mod)
    .replace("Shift", "⇧")
    .replace("Alt", mac ? "⌥" : "Alt")
    .replaceAll("+", mac ? "" : " + ");
}
