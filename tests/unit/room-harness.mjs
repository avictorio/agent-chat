// The real Room class on an in-memory SQLite database and a stand-in
// bucket, for unit tests of what the Room stores: no Worker, no network,
// thousands of posts in a moment.
import { DatabaseSync } from "node:sqlite";
import { Room } from "../../worker/room/Room.ts";

/**
 * @param {{ put?: (key: string) => Promise<void> | void, before?: (op: string, key: string) => Promise<void> | void, after?: (op: string, key: string) => Promise<void> | void, env?: object }} [hooks]
 *   put runs inside every MEDIA.put, before the object is stored; before and
 *   after run around every storage call (op: put, get, head, delete, create,
 *   part, abort, complete), so a test can hold one call while others run, or make
 *   it throw; env adds bindings and variables to the Room's env
 */
export function makeRoom(hooks = {}) {
  const db = new DatabaseSync(":memory:");
  const bind = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
  const sql = {
    exec(q, ...p) {
      const text = q.trim();
      let rows = [];
      const st = db.prepare(text);
      if (/^\s*(SELECT|WITH|PRAGMA)|RETURNING/i.test(text)) rows = st.all(...p.map(bind)).map((r) => ({ ...r }));
      else st.run(...p.map(bind));
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error("one(): " + rows.length + " rows"); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  /** the bucket: key -> bytes */
  const objects = new Map();
  /** uploads in flight: id -> { key, data } */
  const multipart = new Map();
  let uploads = 0;
  /** a storage call: the hooks run around it */
  const call = async (op, key, fn) => {
    if (hooks.before) await hooks.before(op, key);
    const r = await fn();
    if (hooks.after) await hooks.after(op, key);
    return r;
  };
  const MEDIA = {
    async put(key, value) { return call("put", key, async () => { if (hooks.put) await hooks.put(key); objects.set(key, new Uint8Array(value)); }); },
    async get(key, opts) {
      return call("get", key, async () => {
        const d = objects.get(key);
        if (!d) return null;
        const r = opts && opts.range ? d.subarray(opts.range.offset || 0, (opts.range.offset || 0) + (opts.range.length ?? d.byteLength)) : d;
        return { arrayBuffer: async () => r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength) };
      });
    },
    async head(key) { return call("head", key, async () => { const d = objects.get(key); return d ? { size: d.byteLength } : null; }); },
    async delete(keys) { return call("delete", String(keys), async () => { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); }); },
    async list() { return { objects: [...objects.keys()].map((key) => ({ key })), truncated: false }; },
    async createMultipartUpload(key) {
      return call("create", key, async () => {
        const id = "U" + (++uploads);
        multipart.set(id, { key, data: new Uint8Array(1) });
        return { uploadId: id, key, abort: async () => { multipart.delete(id); } };
      });
    },
    resumeMultipartUpload(key, id) {
      return {
        async abort() { return call("abort", key, async () => { if (!multipart.delete(id)) throw new Error("NoSuchUpload"); }); },
        // parts sent with uploadPart make the object; without any, it is the upload's data
        async uploadPart(n, value) {
          return call("part", key, async () => {
            const m = multipart.get(id);
            if (!m) throw new Error("NoSuchUpload");
            const b = new Uint8Array(value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value);
            (m.parts ||= new Map()).set(n, b);
            return { partNumber: n, etag: "e" + n };
          });
        },
        async complete() {
          return call("complete", key, async () => {
            const m = multipart.get(id);
            if (!m) throw new Error("NoSuchUpload");
            let data = m.data;
            if (m.parts) {
              const ps = [...m.parts.keys()].sort((x, y) => x - y).map((n) => m.parts.get(n));
              data = new Uint8Array(ps.reduce((t, b) => t + b.byteLength, 0));
              let off = 0;
              for (const b of ps) { data.set(b, off); off += b.byteLength; }
            }
            objects.set(key, data);
            multipart.delete(id);
            return {};
          });
        },
      };
    },
  };
  const pending = [];
  const ctx = {
    id: { name: "unit" },
    // deleteAll drops every table, as storage's does (Room.destroy)
    storage: { sql, deleteAll: async () => { for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) db.exec('DROP TABLE "' + t.name + '"'); }, setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} },
    waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
  };
  // the activity log a room delete writes (Room.activityLog)
  const REQUESTS = { put: async () => {}, get: async () => null };
  const env = { REQUESTS, ...(hooks.env || {}), MEDIA };
  const room = new Room(ctx, env);
  room.create();
  const one = (q, ...p) => db.prepare(q).get(...p);
  const all = (q, ...p) => db.prepare(q).all(...p);
  return {
    room, db, objects, multipart, one, all,
    /** adds an active member, invited a month ago: a draft belongs to
     *  the invite that wrote it (hiddenDraft), and tests age drafts by
     *  hand, so the invite has to be older than any of them. kind is the
     *  invite's ("human" or "agent"); left out it is NULL, which access()
     *  reports as an agent */
    member(name, kind) { const at = Date.now() - 30 * 86400000; db.prepare("INSERT INTO inv (token, name, created, used, kind) VALUES (?, ?, ?, ?, ?)").run("tok-" + name, name, at, at, kind === undefined ? null : kind); },
    /** everything handed to waitUntil has finished */
    settled: () => Promise.all(pending.splice(0)),
    /** the next call to sweepDrafts really sweeps (it runs at most every ten minutes) */
    sweepNow() { room._sweptAt = 0; return room.sweepDrafts(); },
    /** a new instance on the same storage, as after an eviction: what is
     *  only in memory is gone (h.room becomes the new one) */
    restart() { this.room = new Room(ctx, env); return this.room; },
  };
}
