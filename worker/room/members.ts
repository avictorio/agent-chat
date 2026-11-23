// Room methods: members and invites (kinds, reserved names, revocation), avatars.

import { nameFold, nameKey, sameName, sqlLowerSame } from "../lib/text.js";
import { goneError } from "../lib/errors.js";
import type { Member, MemberKind } from "@chat/contract";
import type { CountRow, InvRow, MvRow, Refusal, Room } from "./Room.js";
import { warn } from "../lib/log.js";
import { FETCH_URL_MAX } from "../limits.js";

/** A member as the Room returns it; the members route turns avatar_version
 *  into the signed avatar URL and invite_token into invite_link (or drops it). */
export type RoomMember = Omit<Member, "avatar" | "invite_link" | "agent_onboarding"> & { avatar_version: number | null, invite_token: string };
export type VoiceCols = Pick<MvRow, "name" | "provider" | "voice_id" | "sample_key">;

export const MemberMethods = {
  // The spellings this member's name is stored under in inv, one per
  // invite (revoked ones too, unless only active ones are asked for): a
  // name revoked and invited again in other capitals is one member under
  // two spellings. SQL is handed these exact strings (invMatch) because
  // its lower() folds ASCII only: "Émile" never matched "émile" there.
  invNames(name: string | null | undefined, activeOnly?: boolean): string[] {
    const rows = this.sql.exec<Pick<InvRow, "name">>("SELECT DISTINCT name FROM inv" + (activeOnly ? " WHERE revoked IS NULL" : "")).toArray();
    return rows.map((r) => r.name).filter((n) => sameName(n, name));
  },
  /** "name IN (...)" over this member's inv rows (invNames), and its parameters */
  invMatch(name: string | null | undefined, activeOnly?: boolean): [string, ...string[]] {
    const names = this.invNames(name, activeOnly);
    return ["name IN (" + names.map(() => "?").join(", ") + ")", ...names];
  },
  /** invMatch narrowed to the rows an avatar set, clear or read reaches:
   *  the spellings equal to the name but for A-Z case (sqlLowerSame, which
   *  says why) */
  avatarMatch(name: string): [string, ...string[]] {
    const names = this.invNames(name).filter((n) => sqlLowerSame(n, name));
    return ["name IN (" + names.map(() => "?").join(", ") + ")", ...names];
  },

  // Daily cap on room tool calls (web fetches). The URL is logged cut to
  // FETCH_URL_MAX: fetchTarget refuses longer ones, and the log is loaded
  // on every room_state read (stateData).
  toolTake(limit: number, url?: string | null) {
    this.sql.exec("DELETE FROM tf WHERE ts <= ?", Date.now() - 86400e3);
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM tf").one().n >= limit) return false;
    this.sql.exec("INSERT INTO tf (ts, url) VALUES (?, ?)", Date.now(), url ? url.slice(0, FETCH_URL_MAX) : null);
    return true;
  },
  // Seconds until the oldest fetch in the 24-hour window ages out (the
  // Retry-After of a refused take).
  toolWait() {
    const r = this.sql.exec<{ t: number | null }>("SELECT MIN(ts) AS t FROM tf").one();
    return r.t ? Math.max(1, Math.ceil((r.t + 86400e3 - Date.now()) / 1000)) : 1;
  },

  invites() {
    return this.sql.exec<Pick<InvRow, "token" | "name" | "created" | "revoked" | "used" | "kind">>("SELECT token, name, created, revoked, used, kind FROM inv ORDER BY created").toArray();
  },

  // Invite status for anyone in the room: active, unused or revoked. The token rides
  // along as invite_token; the one caller (GET /members) turns it into invite_link for
  // invite-only rooms (members are trusted there) and strips it otherwise.
  members(): { invite_only: true, members: RoomMember[] } {
    const rows = this.sql.exec<Pick<InvRow, "token" | "name" | "created" | "revoked" | "used" | "seen" | "kind" | "invited_by" | "avatar_ver">>("SELECT token, name, created, revoked, used, seen, kind, invited_by, avatar_ver FROM inv ORDER BY created").toArray();
    /** voices by name (nameKey) */
    const vmap: Record<string, VoiceCols> = {};
    for (const v of this.sql.exec<VoiceCols>("SELECT name, provider, voice_id, sample_key FROM mv").toArray()) vmap[v.name] = v;
    return {
      invite_only: true,
      members: rows.map((r) => { const v = vmap[nameKey(r.name)] || null; return { name: r.name, status: r.revoked ? "revoked" : (r.used ? "active" : "unused"), invited: r.created, joined: r.used || null, last_seen: r.seen || r.used || null, revoked: r.revoked || null, kind: r.kind === "human" ? "human" : "agent", invited_by: r.invited_by || null, avatar_version: r.avatar_ver || null, voice: v ? { provider: v.provider || "cartesia", voice_id: v.voice_id || null, sample: !!v.sample_key } : null, invite_token: r.token } satisfies RoomMember; }),
    };
  },

  // Avatars: one small image per member. The bytes live in R2 only, under
  // avatars/ROOM/<lowercased name>/<ver>; the inv row carries only the
  // pointer (avatar_key, avatar_type, avatar_ver). Streams get a "members"
  // event on change.
  avatarKey(room: string, name: string, ver: number) {
    return "avatars/" + room + "/" + nameKey(name) + "/" + ver;
  },

  async setAvatar(name: string, data: ArrayBuffer, type: string, room: string) {
    const gen = this.gen;
    if (!this.invNames(name).some((n) => sqlLowerSame(n, name))) return null;
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) return "STORE_FAIL";
    const ver = Date.now();
    const key = this.avatarKey(room, name, ver);
    try {
      await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } });
    } catch { return "STORE_FAIL"; }
    // Deleted while the image was stored (Room.fence): a room created
    // since may have a member of this name, who must not get this picture,
    // and the object is nobody's (its key names this upload's moment).
    if (!this.alive(gen)) {
      try { await this.env.MEDIA.delete(key); } catch (e) { warn("media.delete", e, { room: this.roomName }); }
      throw goneError();
    }
    // The picture this one replaces is read now, after the put, with no
    // await before the write: read before it, two sets for one name both
    // saw the same old picture, each deleted only that, and the first
    // one's object stayed in storage with nothing pointing at it, past the
    // room's delete. Whichever upload began later (its ver) is kept and
    // the other object goes, this request's own when a later one has
    // already been recorded; that request's answer then names the picture
    // that stays.
    const [who, ...names] = this.avatarMatch(name);
    const prev = this.sql.exec<Pick<InvRow, "avatar_key" | "avatar_ver">>("SELECT avatar_key, avatar_ver FROM inv WHERE " + who + " AND avatar_key IS NOT NULL ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", ...names).toArray()[0];
    if (prev && prev.avatar_key !== key && prev.avatar_ver != null && prev.avatar_ver > ver) {
      try { await this.env.MEDIA.delete(key); } catch (e) { warn("media.delete", e, { room: this.roomName }); }
      return prev.avatar_ver;
    }
    this.sql.exec("UPDATE inv SET avatar_type = ?, avatar_ver = ?, avatar_key = ? WHERE " + who, type, ver, key, ...names);
    if (prev && prev.avatar_key && prev.avatar_key !== key) { try { await this.env.MEDIA.delete(prev.avatar_key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
    this.notifyMembers(name);
    return ver;
  },

  async clearAvatar(name: string) {
    const [who, ...names] = this.avatarMatch(name);
    const rows = this.sql.exec<Pick<InvRow, "avatar_key">>("SELECT avatar_key FROM inv WHERE " + who + " AND avatar_ver IS NOT NULL", ...names).toArray();
    if (!rows.length) return false;
    this.sql.exec("UPDATE inv SET avatar_type = NULL, avatar_ver = NULL, avatar_key = NULL WHERE " + who, ...names);
    if (this.env && this.env.MEDIA) {
      for (const r of rows) if (r.avatar_key) { try { await this.env.MEDIA.delete(r.avatar_key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
    }
    this.notifyMembers(name);
    return true;
  },

  // The member's avatar pointer, or null; the route streams the bytes
  // from R2.
  getAvatar(name: string) {
    const [who, ...names] = this.avatarMatch(name);
    const r = this.sql.exec<{ avatar_type: string | null, avatar_ver: number, avatar_key: string }>("SELECT avatar_type, avatar_ver, avatar_key FROM inv WHERE " + who + " AND avatar_ver IS NOT NULL AND avatar_key IS NOT NULL ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", ...names).toArray()[0];
    return r ? { key: r.avatar_key, type: r.avatar_type, ver: r.avatar_ver } : null;
  },

  // The holder of an active invite (members can invite others). Null when the token isn't active.
  inviter(token: string | null | undefined) {
    if (!token) return null;
    const row = this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE token = ? AND revoked IS NULL", token).toArray()[0];
    return row ? row.name : null;
  },

  // Invites this member made in the last 24 hours, and active invites overall.
  inviteLoad(name: string | null | undefined) {
    const mine = this.sql.exec<Pick<InvRow, "invited_by" | "created">>("SELECT invited_by, created FROM inv WHERE invited_by IS NOT NULL AND created > ?", Date.now() - 86400e3).toArray().filter((r) => sameName(r.invited_by, name));
    return {
      recent: mine.length,
      // the oldest of those, which ages out first (a refusal's Retry-After)
      oldest: mine.length ? Math.min(...mine.map((r) => r.created)) : null,
      active: this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL").one().n,
    };
  },

  setKind(name: string, kind: MemberKind) {
    const [who, ...names] = this.invMatch(name);
    if (!names.length) return false;
    this.sql.exec("UPDATE inv SET kind = ? WHERE " + who, kind, ...names);
    this.notifyMembers(name);
    return true;
  },

  // "Referee" is the room's game official - the name the DO itself
  // posts match results under. It is reserved: if a member could hold
  // it, their posts and game frames would be indistinguishable from the
  // official's.
  isReservedName(name: unknown) {
    return nameFold(String(name || "").trim()) === "referee";
  },

  // Whether `token` is, right now, an active invite for `member`. A write
  // that leaves a credential behind (an upload link, a push registration)
  // asks this in the same call as the write. The route checked the invite
  // too, but in an earlier call, and it waits on the request's body in
  // between: a body held open let a revoke land in that gap, after which
  // the write went through under the old name - and worked for the old
  // holder once the name was invited again. Asking about the name would
  // not do: by then it may be someone else's.
  /** @returns null when it is, or the refusal */
  inviteStill(token: string | null | undefined, member: string | null | undefined): Refusal | null {
    const l = this.lookupInvite(token);
    if (!l.ok) return l;
    if (nameFold(l.row.name) !== nameFold(String(member || ""))) return { ok: false, status: 403, code: "invite_invalid", error: "This invite is not that member's." };
    return null;
  },

  // limits (a member creating an invite): the day and active caps are
  // checked here, inside the one serialized call, so parallel requests
  // cannot all pass a check made in a separate call.
  /**
   * @param kind "human" or "agent" (the default)
   * @param by the member inviting, or null for the owner
   */
  invite(name: string, kind: string | null | undefined, by: string | null | undefined, limits?: { perDay: number, maxActive: number } | null, byToken?: string | null) {
    name = String(name || "").normalize("NFC");
    if (this.isReservedName(name)) return null;
    // A member inviting is looked up again here, by their own token, in
    // the call that writes: a new invite is the one thing a member must
    // not be able to make on the way out (it would outlive their removal,
    // "revoke everyone" included).
    if (by) {
      const gone = this.inviteStill(byToken, by);
      if (gone) return gone;
    }
    // half a character would be stored as U+FFFD: the row would not equal the name checked below
    if (/\p{Cs}/u.test(name)) return null;
    const fold = nameFold(name);
    // Taken when it folds like an active name - or lower-cases like one:
    // the games match a seat with toLowerCase, and a few letters lower-case
    // alike while folding apart (the Greek lunate sigmas, U+03F9 and
    // U+03F2), so the fold alone let two invites share one seat.
    const lower = name.toLowerCase(); // lowercase-ok: the games' seat test (room/games.ts), on top of sameName
    if (this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE revoked IS NULL").toArray().some((r) => nameFold(r.name) === fold || String(r.name).toLowerCase() === lower)) return null; // lowercase-ok: as above
    if (limits) {
      const load = this.inviteLoad(by);
      if (load.recent >= limits.perDay) return { limit: "day", retry_after: Math.max(1, Math.ceil(((load.oldest || Date.now()) + 86400e3 - Date.now()) / 1000)) };
      if (load.active >= limits.maxActive) return { limit: "active" };
    }
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    // apply takes any array-like; its strict typing wants a number[]
    const token = btoa(String.fromCharCode.apply(null, (bytes as ArrayLike<number>) as number[])).replace(/\+/g, "-").replace(/\//g, "_");
    const created = Date.now();
    // The name has no active invite (checked above), so it starts clean:
    // nothing an earlier holder left under it - a push registration, an
    // upload link - passes to them through the new invite. revoke() drops
    // both already; this is for a row written some way it did not see.
    this.dropPush(name);
    this.dropUploadLinks(name);
    this.sql.exec("INSERT INTO inv (token, name, created, kind, invited_by) VALUES (?, ?, ?, ?, ?)", token, name, created, kind || "agent", by || null);
    // Every change to who is in the room sends a members frame (invite,
    // first open in Room.access, revoke, a changed kind), as an avatar or
    // a voice does. Only those two did: an open page kept its members
    // list and count from its last read, and a revoked member went on
    // looking active to everyone but the revoker.
    this.notifyMembers(name);
    return { token, name, created, revoked: null, kind: kind || "agent", invited_by: by || null };
  },

  revoke(token: string) {
    const row = this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE token = ? AND revoked IS NULL", token).toArray()[0];
    if (!row) return false;
    this.sql.exec("UPDATE inv SET revoked = ? WHERE token = ?", Date.now(), token);
    for (const c of this.clients) if (c.token === token) c.close();
    // A member who is out stops getting pushes (message text included):
    // their browser push subscriptions go with their last invite. So do
    // the upload links they opened: a link is a credential by itself, and
    // it is checked against the name, so one left behind worked again the
    // moment the name was invited anew - for whoever had kept it. Their
    // direct uploads in flight end too, just after: the ones there now
    // (directUploadsOf, abortUploads).
    const fold = nameFold(row.name);
    const last = !this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE revoked IS NULL").toArray().some((r) => nameFold(r.name) === fold);
    const direct = last ? this.directUploadsOf([row.name]) : [];
    if (last) {
      this.dropPush(row.name);
      this.dropUploadLinks(row.name);
    }
    // after the close above: the member removed gets no frame about it
    this.notifyMembers(row.name);
    if (direct.length) this.ctx.waitUntil(this.abortUploads(direct).catch((e) => warn("upload.abort", e, { room: this.roomName })));
    return true;
  },

  // Revoke everyone: every invite, every push registration, every open
  // member stream (owner streams stay), every member's direct upload in
  // flight (directUploadsOf, abortUploads), and the avatar objects in R2 -
  // the inv rows are their only pointers, so a later destroy() could not
  // find them.
  async revokeAll() {
    const avatarKeys = this.sql.exec<{ avatar_key: string }>("SELECT avatar_key FROM inv WHERE avatar_key IS NOT NULL").toArray().map((r) => r.avatar_key);
    const direct = this.directUploadsOf(this.sql.exec<Pick<InvRow, "name">>("SELECT DISTINCT name FROM inv").toArray().map((r) => r.name));
    this.sql.exec("DELETE FROM inv");
    this.sql.exec("DELETE FROM push");
    this.dropUploadLinks(null);
    for (const c of Array.from(this.clients)) if (!c.owner) c.close();
    // the owner's streams are all that is left; no one member changed
    this.notifyMembers(null);
    if (avatarKeys.length && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(avatarKeys); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
    if (direct.length) this.ctx.waitUntil(this.abortUploads(direct).catch((e) => warn("upload.abort", e, { room: this.roomName })));
    return true;
  },

  // The kind of an actor by name: "human" | "agent" from their invite,
  // "non_interactive" for a system actor with no invite (the Referee),
  // null for no actor at all.
  memberKind(name: string | null | undefined): MemberKind | "non_interactive" | null {
    if (!name) return null;
    const [who, ...names] = this.invMatch(name);
    const r = this.sql.exec<Pick<InvRow, "kind">>("SELECT kind FROM inv WHERE " + who + " ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", ...names).toArray()[0];
    return r ? (r.kind === "human" ? "human" : "agent") : "non_interactive";
  },
} satisfies ThisType<Room>;
