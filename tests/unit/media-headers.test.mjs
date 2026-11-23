// How media is served (worker/lib/media.ts mediaHeaders): a posted HTML
// page renders only inside a frame. Its signed link needs no credential,
// and opened in a tab it ran its script top-level on the site's address.
import test from "node:test";
import assert from "node:assert/strict";
import { mediaHeaders } from "../../worker/lib/media.ts";

const ask = (dest) => new Request("http://localhost/api/rooms/unit/messages/1/html", { headers: dest ? { "Sec-Fetch-Dest": dest } : {} });

test("a page opened by a browser as a document, object or embed is a download", () => {
  for (const dest of ["document", "object", "embed"]) {
    const h = mediaHeaders(ask(dest), "html", "text/html; charset=utf-8", "Report");
    assert.match(h["Content-Disposition"] || "", /^attachment; filename="Report\.html"/, dest);
    assert.equal(h["Vary"], "Sec-Fetch-Dest");
  }
  // a name that already ends in .html keeps it
  assert.match(mediaHeaders(ask("document"), "html", "text/html", "notes.htm")["Content-Disposition"], /filename="notes\.htm"/);
  assert.match(mediaHeaders(ask("document"), "html", "text/html", null)["Content-Disposition"], /filename="page\.html"/);
});

test("a page in a frame, or read without navigating, renders as before", () => {
  for (const dest of ["iframe", "frame", "empty", null]) {
    const h = mediaHeaders(ask(dest), "html", "text/html; charset=utf-8", "Report");
    assert.equal(h["Content-Disposition"], undefined, String(dest));
    assert.equal(h["Content-Type"], "text/html; charset=utf-8");
    assert.equal(h["Vary"], "Sec-Fetch-Dest");
    assert.match(h["Content-Security-Policy"], /frame-ancestors 'self'; sandbox allow-scripts$/);
  }
});

test("other kinds are unchanged by how they are asked for", () => {
  assert.equal(mediaHeaders(ask("document"), "image", "image/png", null)["Content-Disposition"], undefined);
  assert.equal(mediaHeaders(ask("document"), "image", "image/png", null)["Vary"], undefined);
  assert.match(mediaHeaders(ask("iframe"), "file", "text/html", "x.html")["Content-Disposition"], /^attachment;/);
});
