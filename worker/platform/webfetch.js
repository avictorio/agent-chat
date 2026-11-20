// The room fetch tool: fetch a public page and return it as text.

import { htmlToText } from "../lib/text.js";

export const FETCH_MAX_BYTES = 1000000;

export const FETCH_MAX_TEXT = 20000;

// Room tools: only public http(s) URLs by domain name. No IP addresses, local names, other ports or this site.
export function fetchTarget(s) {
  let u;
  try { u = new URL(String(s || "")); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!h || h.indexOf(".") < 0) return null;
  if (/^[\d.]+$/.test(h) || h.indexOf(":") >= 0 || h.charAt(0) === "[") return null;
  if (/(^|\.)(localhost|local|internal|lan|home|test|invalid|arpa)$/.test(h)) return null;
  if (h === "victorio.cloud" || /\.victorio\.cloud$/.test(h)) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  return u;
}

export async function webFetch(target) {
  let u = target;
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 10000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(u.toString(), { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "user-agent": "chat.victorio.cloud room tools (+https://chat.victorio.cloud/api)", "accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = fetchTarget(new URL(res.headers.get("location"), u).toString());
        if (!next) return { url: u.toString(), status: res.status, error: "Redirected to an address the tool won't fetch" };
        u = next;
        continue;
      }
      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (!/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml))/.test(type)) return { url: u.toString(), status: res.status, content_type: type, error: "Only text, HTML, JSON and XML pages can be fetched" };
      const chunks = []; let size = 0; let cut = false;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > FETCH_MAX_BYTES) { cut = true; try { reader.cancel(); } catch (e) {} break; }
          chunks.push(r.value);
        }
      }
      const buf = new Uint8Array(chunks.reduce(function (n, c) { return n + c.length; }, 0));
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      const body = new TextDecoder().decode(buf);
      const conv = /html/.test(type) ? htmlToText(body) : { title: "", text: body };
      return { url: u.toString(), status: res.status, content_type: type, title: conv.title, text: conv.text.slice(0, FETCH_MAX_TEXT), truncated: cut || conv.text.length > FETCH_MAX_TEXT };
    }
    return { url: u.toString(), error: "Too many redirects" };
  } catch (e) {
    return { url: u.toString(), error: ctl.signal.aborted ? "The page took too long to respond" : "Couldn't fetch the page: " + String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}
