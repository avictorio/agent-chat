// What kind of Markdown line this is, worked out in time proportional to
// the line's length.
//
// A message is someone else's text, shown to everyone in the room the
// moment it arrives, so nothing here may take longer on a hostile line
// than on an ordinary one. These used to be single regular expressions
// with neighbouring optional runs (/\s+(.*?)\s*#*\s*$/ for a heading):
// correct, and cubic. One 8,000-character line - "# a", 7,996 spaces, "b"
// - froze every open page of the room for a minute. Each test below reads
// its line a fixed number of times instead. No DOM here, so the unit tests
// run them against the old expressions on ordinary lines and time them on
// hostile ones (tests/unit/mdlines.test.mjs).

/** How deep quotes and lists may nest; deeper lines are shown as plain text.
 *  The renderer calls itself once per level, and a few thousand levels
 *  (one line of ">" characters) overflowed the browser's stack and
 *  crashed the page. */
export const MD_MAX_DEPTH = 12;
/** The longest run of text given inline formatting (links, bold, code).
 *  A message is at most 8,000 characters, so every message line fits;
 *  only a document with one enormous line is shown plain there. */
export const MD_INLINE_MAX = 10000;
/** How long one render may take before the rest is shown as plain text. */
export const MD_BUDGET_MS = 400;

/** "## Title ##" -> { level: 2, text: "Title" }; null when the line is not a heading. */
export function headingOf(line: string): { level: number; text: string } | null {
  const m = /^\s{0,3}(#{1,6})\s/.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length).trim();
  let end = rest.length;
  while (end > 0 && rest[end - 1] === "#") end--;
  return { level: m[1]!.length, text: rest.slice(0, end).trimEnd() };
}

/** The fence that opens a code block ("```" or "~~~", three or more), or null. */
export function fenceOf(line: string): string | null {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return /^[\w+.#-]*$/.test(line.slice(m[0].length).trim()) ? m[1]! : null;
}

/** A horizontal rule: three or more of one of - * _ and nothing else but spaces. */
export function isRule(line: string): boolean {
  if (line.length - line.trimStart().length > 3) return false;
  const marks = line.replace(/\s/g, "");
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(marks);
}

/** The line under a table's header: cells of dashes, with optional colons for alignment. */
export function isTableSep(line: string): boolean {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

// Text for reading aloud: the markdown's words without its symbols. What
// was polynomial here (a table's dash line, a link, the pipes) is done
// line by line with linear tests and a bounded pattern.
export function plainText(s: string): string {
  return String(s || "")
    .split("\n")
    .map((l) => (/^[ \t]*(`{3,}|~{3,})/.test(l) || isDashLine(l) ? "" : l))
    .join("\n")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gm, "")
    .replace(/\[([^[\]\n]+)\]\(([^)\s]{1,2000})(?:\s[^)\n]{0,300})?\)/g, "$1")
    .replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, "a link")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/gm, "$1$2")
    .split("\n")
    .map(pipesToCommas)
    .join("\n");
}

const blank = (c: string | undefined) => c === " " || c === "\t";

// A table row read aloud: the pipes at its ends go, with the spaces
// around them, and each pipe inside becomes ", ". Walked by hand: the
// expressions that did this (/[ \t]*\|[ \t]*$/ and its kin) started
// with an optional run of spaces, so on a long run of spaces with no
// pipe after it they tried every starting point and took quadratic time.
function pipesToCommas(l: string): string {
  if (l.indexOf("|") < 0) return l;
  let s = 0;
  let e = l.length;
  let i = 0;
  while (i < e && blank(l[i])) i++;
  if (l[i] === "|") {
    i++;
    while (i < e && blank(l[i])) i++;
    s = i;
  }
  let j = e;
  while (j > s && blank(l[j - 1])) j--;
  if (j > s && l[j - 1] === "|") {
    j--;
    while (j > s && blank(l[j - 1])) j--;
    e = j;
  }
  const parts = l.slice(s, e).split("|");
  return parts
    .map((part, k) => {
      let a = 0;
      let b = part.length;
      if (k > 0) while (a < b && blank(part[a])) a++;
      if (k < parts.length - 1) while (b > a && blank(part[b - 1])) b--;
      return part.slice(a, b);
    })
    .join(", ");
}

/** A line of only dashes, colons, pipes and spaces with at least one dash: a table's rule, or a plain one. */
function isDashLine(l: string): boolean {
  return l.indexOf("-") >= 0 && /^[ \t:|-]*$/.test(l);
}
