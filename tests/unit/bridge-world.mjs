// The Muse bridge in the same process, for unit tests of what a room or an
// agent key asks of it: the bridge's router (worker/bridge/index.ts) and its
// MuseLink and Directory objects on node:sqlite (tests/bridge/helpers/
// fake-do.mjs), with Muse's fetch_vms answered by a stub, as
// muse-wake.test.mjs runs them. A gadget's handover (connect) gives a link
// and a one-time code; status gives the link's room count, which a hook set
// (POST /rooms hooked true) raises and a hook removed lowers. Pass env to
// makeRoom({env}) or makeWorld({env}). Nothing leaves the process. A
// helper, not a test.
import { bridgeFetch } from "../../worker/bridge/index.ts";
import { MuseLink } from "../../worker/bridge/link.ts";
import { Directory } from "../../worker/bridge/directory.ts";
import { generateBridgeKey, seal } from "../../worker/bridge/seal.ts";
import { deps } from "../../worker/bridge/util.ts";
import { FakeNamespace } from "../bridge/helpers/fake-do.mjs";

export async function bridgeWorld() {
  const keys = await generateBridgeKey();
  const env = { MUSE_SEAL_KEY: keys.privateKey };
  env.MUSE_LINK = new FakeNamespace(MuseLink, env);
  env.MUSE_DIRECTORY = new FakeNamespace(Directory, env);
  const saved = { fetch: deps.fetch, log: deps.log };
  const logs = [];
  deps.log = (line) => logs.push(line);
  deps.fetch = async (url, init) => {
    const m = /^Bearer tok-muse-([0-9]+)$/.exec(init.headers.Authorization);
    return m
      ? new Response(JSON.stringify({ vm_list: [{ vm_id: "vm-" + m[1], vm_auth_token: "vmtok-" + m[1], vm_ws_url: "wss://x", default: true }] }))
      : new Response("no", { status: 401 });
  };
  /** every path the bridge was asked, in order */
  const paths = [];
  const call = async (path, body) => {
    paths.push(path);
    const r = await bridgeFetch(new Request("https://muse-bridge" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json() };
  };
  let n = 0;
  return {
    env, logs, call, paths,
    /** a gadget's handover: its link id and its one-time code, unclaimed;
     *  again (a gadget this gave before) hands that gadget over once more,
     *  as its Add rooms does: the same link, a new code */
    async connect(again) {
      const i = again ? again.n : ++n;
      const c = await call("/connect", { sealed: await seal({ accessToken: "tok-muse-" + i, nodeId: "gadget-unit" }, keys.publicKey), termsVersion: "v1" });
      if (c.status !== 200) throw new Error("connect: " + JSON.stringify(c.body));
      return { code: c.body.code, link: c.body.museLinkId, n: i };
    },
    /** how many rooms the bridge counts for a link */
    async rooms(link) { return (await call("/status", { museLinkId: link })).body.rooms; },
    restore: () => Object.assign(deps, saved),
  };
}
