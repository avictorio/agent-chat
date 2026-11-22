// The real Room class on an in-memory SQLite database and a stand-in
// bucket, for unit tests of what the Room stores: no Worker, no network,
// thousands of posts in a moment.
import { DatabaseSync } from "node:sqlite";
import { Room } from "../../worker/room/Room.ts";

/**
 * @param {{ put?: (key: string) => Promise<void> | void }} [hooks] put runs inside every MEDIA.put, before the object is stored
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
  const MEDIA = {
    async put(key, value) { if (hooks.put) await hooks.put(key); objects.set(key, new Uint8Array(value)); },
    async get(key) { const d = objects.get(key); return d ? { arrayBuffer: async () => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) } : null; },
    async head(key) { const d = objects.get(key); return d ? { size: d.byteLength } : null; },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
    async list() { return { objects: [...objects.keys()].map((key) => ({ key })), truncated: false }; },
    async createMultipartUpload(key) { const id = "U" + (++uploads); multipart.set(id, { key, data: new Uint8Array(1) }); return { uploadId: id, key, abort: async () => { multipart.delete(id); } }; },
    resumeMultipartUpload(key, id) {
      return {
        async abort() { if (!multipart.delete(id)) throw new Error("NoSuchUpload"); },
        async complete() { const m = multipart.get(id); if (!m) throw new Error("NoSuchUpload"); objects.set(key, m.data); multipart.delete(id); return {}; },
      };
    },
  };
  const pending = [];
  const ctx = {
    id: { name: "unit" },
    storage: { sql, deleteAll: async () => {}, setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} },
    waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
  };
  const room = new Room(ctx, { MEDIA });
  room.create();
  const one = (q, ...p) => db.prepare(q).get(...p);
  const all = (q, ...p) => db.prepare(q).all(...p);
  return {
    room, db, objects, multipart, one, all,
    /** adds an active member */
    member(name) { db.prepare("INSERT INTO inv (token, name, created, used) VALUES (?, ?, ?, ?)").run("tok-" + name, name, Date.now(), Date.now()); },
    /** everything handed to waitUntil has finished */
    settled: () => Promise.all(pending.splice(0)),
    /** the next call to sweepDrafts really sweeps (it runs at most every ten minutes) */
    sweepNow() { room._sweptAt = 0; return room.sweepDrafts(); },
  };
}
