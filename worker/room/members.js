// Room methods: members and invites (kinds, reserved names, revocation), avatars.

import { nameFold } from "../lib/text.js";

/** @satisfies {ThisType<import("./Room.js").Room>} */
export const MemberMethods = {
  // Daily cap on room tool calls (web fetches).
  toolTake(limit, url) {
    this.sql.exec("DELETE FROM tf WHERE ts <= ?", Date.now() - 86400e3);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM tf").one().n >= limit) return false;
    this.sql.exec("INSERT INTO tf (ts, url) VALUES (?, ?)", Date.now(), url || null);
    return true;
  },

  invites() {
    return this.sql.exec("SELECT token, name, created, revoked, used, kind FROM inv ORDER BY created").toArray();
  },

  // Invite status for anyone in the room: active, unused or revoked. The token rides
  // along as invite_token; the one caller (GET /members) turns it into invite_link for
  // invite-only rooms (members are trusted there) and strips it otherwise.
  /** A member as the Room returns it; the members route turns avatar_version
   *  into the signed avatar URL and invite_token into invite_link (or drops it).
   *  @typedef {Omit<import("@chat/contract").Member, "avatar" | "invite_link" | "agent_onboarding"> & { avatar_version: number | null, invite_token: string }} RoomMember */
  /** @returns {{ invite_only: true, members: RoomMember[] }} */
  members() {
    const rows = this.sql.exec("SELECT token, name, created, revoked, used, seen, kind, invited_by, avatar_ver FROM inv ORDER BY created").toArray();
    const vmap = {};
    for (const v of this.sql.exec("SELECT name, provider, voice_id, sample_key FROM mv").toArray()) vmap[v.name] = v;
    return {
      invite_only: true,
      members: rows.map((r) => { const v = vmap[String(r.name).toLowerCase()] || null; return /** @satisfies {RoomMember} */ ({ name: r.name, status: r.revoked ? "revoked" : (r.used ? "active" : "unused"), invited: r.created, joined: r.used || null, last_seen: r.seen || r.used || null, revoked: r.revoked || null, kind: r.kind === "human" ? "human" : "agent", invited_by: r.invited_by || null, avatar_version: r.avatar_ver || null, voice: v ? { provider: v.provider || "cartesia", voice_id: v.voice_id || null, sample: !!v.sample_key } : null, invite_token: r.token }); }),
    };
  },

  // Avatars: one small image per member. The bytes live in R2 (media plan
  // phase D) under avatars/ROOM/<lowercased name>/<ver>; the inv row carries
  // only the pointer (avatar_key, avatar_type, avatar_ver). There is no
  // in-DB copy any more (the blob era ended 2026-11-19). Streams get a
  // "members" event on change.
  avatarKey(room, name, ver) {
    return "avatars/" + room + "/" + String(name).toLowerCase() + "/" + ver;
  },

  async setAvatar(name, data, type, room) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return null;
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) return "STORE_FAIL";
    const prev = this.sql.exec("SELECT avatar_key FROM inv WHERE lower(name) = lower(?) AND avatar_key IS NOT NULL ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", name).toArray()[0];
    const ver = Date.now();
    const key = this.avatarKey(room, name, ver);
    try {
      await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } });
    } catch (e) { return "STORE_FAIL"; }
    this.sql.exec("UPDATE inv SET avatar_type = ?, avatar_ver = ?, avatar_key = ? WHERE lower(name) = lower(?)", type, ver, key, name);
    if (prev && prev.avatar_key && prev.avatar_key !== key) { try { await this.env.MEDIA.delete(prev.avatar_key); } catch (e) {} }
    this.notifyMembers(name);
    return ver;
  },

  async clearAvatar(name) {
    const rows = this.sql.exec("SELECT avatar_key FROM inv WHERE lower(name) = lower(?) AND avatar_ver IS NOT NULL", name).toArray();
    if (!rows.length) return false;
    this.sql.exec("UPDATE inv SET avatar_type = NULL, avatar_ver = NULL, avatar_key = NULL WHERE lower(name) = lower(?)", name);
    if (this.env && this.env.MEDIA) {
      for (const r of rows) if (r.avatar_key) { try { await this.env.MEDIA.delete(r.avatar_key); } catch (e) {} }
    }
    this.notifyMembers(name);
    return true;
  },

  // The member's avatar pointer, or null; the route streams the bytes
  // from R2.
  getAvatar(name) {
    const r = this.sql.exec("SELECT avatar_type, avatar_ver, avatar_key FROM inv WHERE lower(name) = lower(?) AND avatar_ver IS NOT NULL AND avatar_key IS NOT NULL ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", name).toArray()[0];
    return r ? { key: r.avatar_key, type: r.avatar_type, ver: r.avatar_ver } : null;
  },

  // The holder of an active invite (members can invite others). Null when the token isn't active.
  inviter(token) {
    if (!token) return null;
    const row = this.sql.exec("SELECT name FROM inv WHERE token = ? AND revoked IS NULL", token).toArray()[0];
    return row ? row.name : null;
  },

  // Invites this member made in the last 24 hours, and active invites overall.
  inviteLoad(name) {
    return {
      recent: this.sql.exec("SELECT COUNT(*) AS n FROM inv WHERE lower(invited_by) = lower(?) AND created > ?", name, Date.now() - 86400e3).one().n,
      active: this.sql.exec("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL").one().n,
    };
  },

  setKind(name, kind) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return false;
    this.sql.exec("UPDATE inv SET kind = ? WHERE lower(name) = lower(?)", kind, name);
    return true;
  },

  // "Referee" is the room's game official - the name the DO itself
  // posts match results under. It is reserved (2026-11-12, games
  // review): if a member could hold it, their posts and game frames
  // would be indistinguishable from the official's.
  isReservedName(name) {
    return nameFold(String(name || "").trim()) === "referee";
  },

  // limits (a member creating an invite): the day and active caps are
  // checked here, inside the one serialized call, so parallel requests
  // cannot all pass a check made in a separate call.
  invite(name, kind, by, limits) {
    name = String(name || "").normalize("NFC");
    if (this.isReservedName(name)) return null;
    const fold = nameFold(name);
    if (this.sql.exec("SELECT name FROM inv WHERE revoked IS NULL").toArray().some((r) => nameFold(r.name) === fold)) return null;
    if (limits) {
      const load = this.inviteLoad(by);
      if (load.recent >= limits.perDay) return { limit: "day" };
      if (load.active >= limits.maxActive) return { limit: "active" };
    }
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    // apply takes any array-like; its strict typing wants a number[]
    const token = btoa(String.fromCharCode.apply(null, /** @type {number[]} */ (/** @type {ArrayLike<number>} */ (bytes)))).replace(/\+/g, "-").replace(/\//g, "_");
    const created = Date.now();
    this.sql.exec("INSERT INTO inv (token, name, created, kind, invited_by) VALUES (?, ?, ?, ?, ?)", token, name, created, kind || "agent", by || null);
    return { token, name, created, revoked: null, kind: kind || "agent", invited_by: by || null };
  },

  revoke(token) {
    const row = this.sql.exec("SELECT name FROM inv WHERE token = ? AND revoked IS NULL", token).toArray()[0];
    if (!row) return false;
    this.sql.exec("UPDATE inv SET revoked = ? WHERE token = ?", Date.now(), token);
    for (const c of this.clients) if (c.token === token) c.close();
    // A member who is out stops getting pushes (message text included):
    // their browser push subscriptions go with their last invite.
    const fold = nameFold(row.name);
    if (!this.sql.exec("SELECT name FROM inv WHERE revoked IS NULL").toArray().some((r) => nameFold(r.name) === fold)) this.dropPush(row.name);
    this.emitState();
    return true;
  },

  // Revoke everyone: every invite, every push registration, every open
  // member stream (owner streams stay), and the avatar objects in R2 -
  // the inv rows are their only pointers, so a later destroy() could not
  // find them.
  async unlock() {
    const avatarKeys = this.sql.exec("SELECT avatar_key FROM inv WHERE avatar_key IS NOT NULL").toArray().map((r) => r.avatar_key);
    this.sql.exec("DELETE FROM inv");
    this.sql.exec("DELETE FROM push");
    for (const c of Array.from(this.clients)) if (!c.owner) c.close();
    if (avatarKeys.length && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(avatarKeys); } catch (e) {} }
    return true;
  },

  // The kind of an actor by name: "human" | "agent" from their invite,
  // "non_interactive" for a system actor with no invite (the Referee),
  // null for no actor at all.
  memberKind(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    const r = this.sql.exec("SELECT kind FROM inv WHERE lower(name) = ? ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", n).toArray()[0];
    return r ? (r.kind === "human" ? "human" : "agent") : "non_interactive";
  },
};
