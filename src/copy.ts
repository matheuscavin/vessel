/** A terminal is handed rows, never paragraphs. A program that wraps its own text sends
    each visual row as its own line, and by then a wrap is indistinguishable from a break
    the program meant. This rejoins only the rows that could not have been anything else:
    ones the following word would not have fitted on. */
export function joinWrapped(text: string, cols: number) {
  const lines = text.split("\n");
  if (lines.length < 2) return text;
  // The program's own gutters are unknown, so its widest row stands for its wrap width.
  const width = Math.min(
    cols,
    Math.max(...lines.map((line) => line.trimEnd().length)),
  );
  // Rows that stop well short of the terminal stopped because the text did, not because
  // a margin was reached. Code and command output live down here; wrapped prose does not.
  if (width < cols * 0.6) return text;
  const joined: string[] = [];
  for (const line of lines) {
    const previous = joined[joined.length - 1];
    if (previous !== undefined && continues(previous, line, width))
      joined[joined.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
    else joined.push(line);
  }
  return joined.join("\n");
}
/** Anything that opens a line deliberately: a wrap never produces one. */
const structure = /^\s*([-*+•]\s|\d+[.)]\s|#{1,6}\s|```|[│┃|>])/;
function continues(previous: string, line: string, width: number) {
  const body = line.trim();
  if (!body || !previous.trim() || structure.test(line)) return false;
  const word = body.split(/\s+/)[0];
  return previous.trimEnd().length + 1 + word.length > width;
}
