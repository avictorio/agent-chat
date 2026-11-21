// Module hooks for the unit tests: the Worker imports its data files
// (worker/data/*.txt, the agent recipe and watcher) as text modules
// (wrangler.toml's Text rule). Node has no such rule, so these load them
// as a default-exported string, the same shape the Worker sees.
//
// The Worker's modules are TypeScript (worker/**/*.ts, erasable syntax
// only) and import each other as "./x.js", as wrangler's bundler and
// TypeScript resolve them. Here a relative ".js" specifier with no such
// file resolves to the ".ts" beside it, and a ".ts" module loads with its
// types stripped (Node's own stripTypeScriptTypes).
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

export async function resolve(specifier, context, next) {
  if (/\.js$/.test(specifier) && /^(\.{1,2}\/|\/|file:)/.test(specifier) && context.parentURL) {
    const js = new URL(specifier, context.parentURL);
    if (js.protocol === "file:" && !existsSync(fileURLToPath(js))) {
      const ts = new URL(js.href.replace(/\.js$/, ".ts"));
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (/\.(txt|md|sh)$/.test(url)) {
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(text) + ";" };
  }
  if (/\.ts$/.test(url) && url.startsWith("file:")) {
    const source = await readFile(new URL(url), "utf8");
    return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source, { mode: "strip", sourceUrl: url }) };
  }
  return next(url, context);
}
