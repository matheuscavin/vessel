import test from "node:test";
import assert from "node:assert/strict";
import { joinWrapped } from "../src/copy.ts";

test("rows a word could not have fitted on are rejoined", () => {
  const wrapped = [
    "This is a paragraph that the program wrapped itself at the",
    "width of the terminal, so each row arrived as its own line.",
  ].join("\n");
  assert.equal(
    joinWrapped(wrapped, 80),
    "This is a paragraph that the program wrapped itself at the width of the terminal, so each row arrived as its own line.",
  );
});

test("a break the program meant is kept", () => {
  const text = ["Short line.", "", "Another paragraph."].join("\n");
  assert.equal(joinWrapped(text, 80), text);
});

test("lists, headings and quotes keep their own lines", () => {
  const text = [
    "A sentence long enough to reach the wrap width of this block,",
    "- first item",
    "- second item",
    "# A heading",
    "> quoted",
  ].join("\n");
  assert.equal(joinWrapped(text, 80), text);
});

test("the program's own gutter sets the width, not the terminal", () => {
  const indented = [
    "  Claude wraps inside its own margins, well short of the full",
    "  terminal width, and the rows still belong together.",
  ].join("\n");
  assert.equal(
    joinWrapped(indented, 80),
    "  Claude wraps inside its own margins, well short of the full terminal width, and the rows still belong together.",
  );
});

test("a single line is returned untouched", () => {
  assert.equal(joinWrapped("just one", 80), "just one");
});

test("short rows are left alone", () => {
  const code = ["const a = 1;", "const b = 2;"].join("\n");
  assert.equal(joinWrapped(code, 80), code);
});
