import { el } from "../lib";
// The markdown renderer, ported from src/chat.html (PARITY.md section
// C: ported, not replaced). It builds DOM nodes — text is never parsed
// as HTML, which is the current app's XSS record — and the React side
// appends the resulting fragment into the message's .text element.
// Behavior is transliterated line for line: same block rules, same
// inline grammar, same quirks (underscore emphasis needs word
// boundaries, snake_case stays plain, 2 * 3 * 4 stays arithmetic).

type Parent = HTMLElement | DocumentFragment;


function safeUrl(u: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

const INLINE =
  /\\([\\`*_{}\[\]()#+\-.!~>|])|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^\s*](?:[^*\n]*[^\s*])?)\*|(^|[^A-Za-z0-9_])_([^\s_](?:[^_\n]*[^\s_])?)_(?![A-Za-z0-9])|(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{1,40})/g;

function inline(parent: Parent, s: string, memberSet: Set<string>): void {
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + (m[10] !== undefined ? m[10].length : m[12] !== undefined ? m[12].length : 0);
    if (start > last) parent.appendChild(document.createTextNode(s.slice(last, start)));
    if (m[1] !== undefined) parent.appendChild(document.createTextNode(m[1]));
    else if (m[2] !== undefined) parent.appendChild(el("code", "", m[2]));
    else if (m[3] !== undefined) {
      const u = safeUrl(m[4]!);
      if (u) {
        const a = el("a");
        a.setAttribute("href", u);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        inline(a, m[3], memberSet);
        parent.appendChild(a);
      } else parent.appendChild(document.createTextNode(m[0]));
    } else if (m[5] !== undefined) {
      const a2 = el("a", "", m[5]);
      a2.setAttribute("href", m[5]);
      a2.setAttribute("target", "_blank");
      a2.setAttribute("rel", "noopener noreferrer");
      parent.appendChild(a2);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      const b = el("strong");
      inline(b, m[6] !== undefined ? m[6]! : m[7]!, memberSet);
      parent.appendChild(b);
    } else if (m[8] !== undefined) {
      const d = el("del");
      inline(d, m[8], memberSet);
      parent.appendChild(d);
    } else if (m[13] !== undefined) {
      if (memberSet.has(m[13].toLowerCase()))
        parent.appendChild(el("span", "mention", "@" + m[13]));
      else parent.appendChild(document.createTextNode("@" + m[13]));
    } else {
      const em = el("em");
      inline(em, m[9] !== undefined ? m[9]! : m[11]!, memberSet);
      parent.appendChild(em);
    }
    last = re.lastIndex;
  }
  if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function indentOf(l: string): number {
  return l.match(/^\s*/)![0].replace(/\t/g, "    ").length;
}
function cells(l: string): string[] {
  return l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function md(text: string, memberSet: Set<string>): DocumentFragment {
  const root = document.createDocumentFragment();
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let i = 0;
  let para: HTMLElement | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+.#-]*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim().indexOf(fence[1]!) !== 0) {
        buf.push(lines[i]!);
        i++;
      }
      i++;
      const pre = el("pre", "md-pre");
      pre.appendChild(el("code", "", buf.join("\n")));
      root.appendChild(pre);
      para = null;
      continue;
    }
    if (!line.trim()) {
      para = null;
      i++;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const hn = el("div", "md-h md-h" + Math.min(h[1]!.length, 3));
      inline(hn, h[2]!, memberSet);
      root.appendChild(hn);
      para = null;
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      root.appendChild(el("hr", "md-hr"));
      para = null;
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        q.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      const bq = el("blockquote", "md-quote");
      bq.appendChild(md(q.join("\n"), memberSet));
      root.appendChild(bq);
      para = null;
      continue;
    }
    if (
      line.indexOf("|") >= 0 &&
      i + 1 < lines.length &&
      TABLE_SEP.test(lines[i + 1]!) &&
      lines[i + 1]!.indexOf("|") >= 0
    ) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]!).map((c) =>
        /^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""
      );
      i += 2;
      const wrap = el("div", "md-table-wrap");
      const table = el("table", "md-table");
      const thead = el("thead");
      const tr = el("tr");
      head.forEach((c, k) => {
        const th = el("th");
        if (aligns[k]) th.style.textAlign = aligns[k];
        inline(th, c, memberSet);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
      const tbody = el("tbody");
      while (i < lines.length && lines[i]!.trim() && lines[i]!.indexOf("|") >= 0) {
        const row = el("tr");
        cells(lines[i]!).forEach((c, k) => {
          if (k >= head.length) return;
          const td = el("td");
          if (aligns[k]) td.style.textAlign = aligns[k];
          inline(td, c, memberSet);
          row.appendChild(td);
        });
        tbody.appendChild(row);
        i++;
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      root.appendChild(wrap);
      para = null;
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const base = indentOf(line);
      const ordered = /\d/.test(li[2]!);
      const list = el(ordered ? "ol" : "ul", "md-list") as HTMLElement & { start?: number };
      if (ordered && parseInt(li[2]!, 10) !== 1) list.start = parseInt(li[2]!, 10);
      const items: string[][] = [];
      while (i < lines.length) {
        const L = lines[i]!;
        const mm = LIST_ITEM.exec(L);
        if (!L.trim()) {
          const nx: string | undefined = lines[i + 1];
          if (
            nx !== undefined &&
            nx.trim() &&
            items.length &&
            (indentOf(nx) > base || (LIST_ITEM.test(nx) && indentOf(nx) === base))
          ) {
            items[items.length - 1]!.push("");
            i++;
            continue;
          }
          break;
        }
        const ind = indentOf(L);
        if (mm && ind === base) {
          if (/\d/.test(mm[2]!) !== ordered) break;
          items.push([mm[3]!]);
          i++;
          continue;
        }
        if (ind > base && items.length) {
          items[items.length - 1]!.push(L);
          i++;
          continue;
        }
        break;
      }
      items.forEach((it) => {
        const liEl = el("li");
        inline(liEl, it[0]!, memberSet);
        const rest = it.slice(1);
        while (rest.length && !rest[rest.length - 1]!.trim()) rest.pop();
        if (rest.length) {
          const cut = Math.min(
            ...rest.filter((x) => x.trim()).map(indentOf)
          );
          const sub = rest.map((x) => x.replace(/\t/g, "    ").slice(cut));
          if (LIST_ITEM.test(sub[0]!) || sub.length > 1)
            liEl.appendChild(md(sub.join("\n"), memberSet));
          else {
            liEl.appendChild(el("br"));
            inline(liEl, sub[0]!.trim(), memberSet);
          }
        }
        list.appendChild(liEl);
      });
      root.appendChild(list);
      para = null;
      continue;
    }
    if (para) para.appendChild(el("br"));
    else {
      para = el("p", "md-p");
      root.appendChild(para);
    }
    inline(para, line, memberSet);
    i++;
  }
  return root;
}

// Text for reading aloud: the markdown's words without its symbols.
export function plainText(s: string): string {
  return String(s || "")
    .replace(/^[ \t]*(`{3,}|~{3,}).*$/gm, "")
    .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gm, "")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)[^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, "a link")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/gm, "$1$2")
    .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, "")
    .replace(/[ \t]*\|[ \t]*/g, ", ");
}
