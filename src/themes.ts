import type { ITheme } from "@xterm/xterm";
export const themes: Record<
  string,
  {
    bg: string;
    panel: string;
    surface: string;
    accent: string;
    text: string;
    muted: string;
  }
> = {
  Ocean: {
    bg: "#10191e",
    panel: "#141f25",
    surface: "#1c2a30",
    accent: "#8ec9b7",
    text: "#d9e4e3",
    muted: "#7d9399",
  },
  "Deep Sea": {
    bg: "#0a121d",
    panel: "#101b28",
    surface: "#182a3c",
    accent: "#7ab6dd",
    text: "#d6e3ef",
    muted: "#788fa6",
  },
  Coral: {
    bg: "#21181a",
    panel: "#291f22",
    surface: "#382a2e",
    accent: "#efa899",
    text: "#efe0dd",
    muted: "#a78e90",
  },
  Navy: {
    bg: "#141725",
    panel: "#1b1f30",
    surface: "#292e45",
    accent: "#a7b5eb",
    text: "#e0e4f3",
    muted: "#929ab5",
  },
  Amber: {
    bg: "#201c15",
    panel: "#28231b",
    surface: "#373025",
    accent: "#ddbd7d",
    text: "#eae2d1",
    muted: "#a49983",
  },
  Mono: {
    bg: "#161718",
    panel: "#1e1f20",
    surface: "#2b2c2e",
    accent: "#d1d4d6",
    text: "#e3e4e5",
    muted: "#969a9d",
  },
};
// Mirrors COLORS in crates/vessel-core/src/model.rs; the daemon rejects anything outside it.
export const accents = [
  { id: "anchor", label: "Anchor", hex: "#8ec9b7" },
  { id: "lilac", label: "Lilac", hex: "#b7a7db" },
  { id: "sand", label: "Sand", hex: "#d3b18d" },
  { id: "sky", label: "Sky", hex: "#9abbd8" },
  { id: "rose", label: "Rose", hex: "#df8e91" },
  { id: "moss", label: "Moss", hex: "#98c59c" },
] as const;
export function accentHex(color: string | null, fallbackIndex = 0) {
  return (
    accents.find((a) => a.id === color)?.hex ??
    accents[fallbackIndex % accents.length].hex
  );
}
export function terminalTheme(name: string): ITheme {
  const t = themes[name] ?? themes.Ocean;
  return {
    background: t.bg,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: t.accent + "40",
    black: "#26363d",
    red: "#df8e91",
    green: "#98c59c",
    yellow: "#dfc58e",
    blue: "#8eb4da",
    magenta: "#bc9bca",
    cyan: "#89c9c5",
    white: "#d7dfde",
    brightBlack: "#72858c",
    brightRed: "#f6a4a6",
    brightGreen: "#b3ddac",
    brightYellow: "#f2daa6",
    brightBlue: "#acccee",
    brightMagenta: "#d7b5e4",
    brightCyan: "#abe2d9",
    brightWhite: "#f5f7f6",
  };
}
