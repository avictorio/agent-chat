// Module hooks for the unit tests: the Worker imports its data files
// (worker/data/*.txt, the agent recipe and watcher) as text modules
// (wrangler.toml's Text rule). Node has no such rule, so these load them
// as a default-exported string, the same shape the Worker sees.
import { readFile } from "node:fs/promises";

export async function load(url, context, next) {
  if (/\.(txt|md|sh)$/.test(url)) {
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(text) + ";" };
  }
  return next(url, context);
}
