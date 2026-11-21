// Ambient types for checking the Worker's plain JS (npm run check:
// tsconfig.worker.json): the runtime's modules and globals. Not deployed.

// Text modules (wrangler.toml's Text rule): the data files, the agent
// recipe and its watcher script.
declare module "*.txt" { const text: string; export default text; }
declare module "*.md" { const text: string; export default text; }
declare module "*.sh" { const text: string; export default text; }

declare module "cloudflare:workers" {
  export class DurableObject {
    constructor(ctx: any, env: any);
    ctx: any;
    env: any;
  }
}

// A Workers runtime stream that knows its length up front.
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number | bigint);
}

