// Room methods: members and invites (kinds, reserved names, revocation, a
// member leaving), avatars.

import { nameFold, nameKey, sameName, sqlLowerSame } from "../lib/text.js";
import { goneError } from "../lib/errors.js";
import type { Member, MemberKind } from "@chat/contract";
import type { CountRow, InvRow, MvRow, OqRow, Refusal, Room } from "./Room.js";
import { warn } from "../lib/log.js";
import { FETCH_URL_MAX, PROTECTED_ROOMS } from "../limits.js";

/** A member as the Room returns it; the members route turns avatar_version
 *  into the signed avatar URL and invite_token into invite_link (or drops it). */
export type RoomMember = Omit<Member, "avatar" | "invite_link" | "agent_onboarding"> & { avatar_version: number | null, invite_token: string };
export type VoiceCols = Pick<MvRow, "name" | "provider" | "voice_id" | "sample_key">;
/** A leave that went through (MemberMethods.leave): who left, when, whether
 *  the room went with it, and the clone the route deletes at Cartesia (null
 *  for none; it is a pending delete in the room until Cartesia confirms). */
export type LeaveResult = { ok: true, name: string, left: number, room_deleted: boolean, clone: string | null };
/** The last member's refusal without its yes (409 last_member), with the
 *  count of invites not yet opened that the room's deletion would end. */
export type LastMemberRefusal = Refusal & { unopened: number };

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

  // The owner's invite list: each row as stored, with left (when the
  // member left by itself with that invite, else null).
  invites() {
    return this.sql.exec<Pick<InvRow, "token" | "name" | "created" | "revoked" | "used" | "kind" | "invited_by" | "left_ts">>("SELECT token, name, created, revoked, used, kind, invited_by, left_ts FROM inv ORDER BY created").toArray()
      .map(({ left_ts: left, ...r }) => ({ ...r, left: left || null }));
  },

  // Invite status for anyone in the room: active, unused or revoked. The token rides
  // along as invite_token; the members route turns it into invite_link for the owner
  // key and people, and for an agent only on its own row (routes/members.ts memberReply).
  members(): { invite_only: true, members: RoomMember[] } {
    const rows = this.sql.exec<Pick<InvRow, "token" | "name" | "created" | "revoked" | "used" | "seen" | "kind" | "invited_by" | "avatar_ver" | "left_ts">>("SELECT token, name, created, revoked, used, seen, kind, invited_by, avatar_ver, left_ts FROM inv ORDER BY created").toArray();
    /** voices by name (nameKey) */
    const vmap: Record<string, VoiceCols> = {};
    for (const v of this.sql.exec<VoiceCols>("SELECT name, provider, voice_id, sample_key FROM mv").toArray()) vmap[v.name] = v;
    // whose Muse or webhook delivery is on (room/muse.ts): a revoked row never is
    const muse = this.museOnKinds();
    return {
      invite_only: true,
      members: rows.map((r) => { const v = vmap[nameKey(r.name)] || null; return { name: r.name, status: r.revoked ? "revoked" : (r.used ? "active" : "unused"), invited: r.created, joined: r.used || null, last_seen: r.seen || r.used || null, revoked: r.revoked || null, left: r.left_ts || null, kind: r.kind === "human" ? "human" : "agent", invited_by: r.invited_by || null, avatar_version: r.avatar_ver || null, voice: v ? { provider: v.provider || "cartesia", voice_id: v.voice_id || null, sample: !!v.sample_key } : null, muse_delivery: !r.revoked && muse.get(nameFold(r.name)) === "muse", webhook_delivery: !r.revoked && muse.get(nameFold(r.name)) === "webhook", invite_token: r.token } satisfies RoomMember; }),
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

  // A clear in two parts: the pointers leave the rows the picture is on
  // (avatarMatch) in one step with no await, so nothing reads or sets the
  // picture between the check and the write; the objects go after
  // (mediaDelete). A leave (leave) runs the first part inside its own
  // atomic step and the second once that step is done.
  /** @returns the R2 keys of the pictures cleared, or null when the member had none */
  avatarDrop(name: string): string[] | null {
    const [who, ...names] = this.avatarMatch(name);
    const rows = this.sql.exec<Pick<InvRow, "avatar_key">>("SELECT avatar_key FROM inv WHERE " + who + " AND avatar_ver IS NOT NULL", ...names).toArray();
    if (!rows.length) return null;
    this.sql.exec("UPDATE inv SET avatar_type = NULL, avatar_ver = NULL, avatar_key = NULL WHERE " + who, ...names);
    this.notifyMembers(name);
    return rows.map((r) => r.avatar_key).filter((k): k is string => !!k);
  },

  // Deletes these objects from R2, one call each; a failure is logged and
  // the rest still go. For objects whose rows are already gone.
  async mediaDelete(keys: string[]) {
    if (!this.env || !this.env.MEDIA) return;
    for (const k of keys) { try { await this.env.MEDIA.delete(k); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
  },

  async clearAvatar(name: string) {
    const keys = this.avatarDrop(name);
    if (!keys) return false;
    await this.mediaDelete(keys);
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

  // Whether invite() refuses this name as held: an active invite other
  // than `except` has it. Public creation asks before it starts a stale
  // room over (Room.createGenesis), so a refusal changes nothing there.
  /** @param except a token whose invite does not count (null: none) */
  nameHeld(name: string, except: string | null): boolean {
    name = String(name || "").normalize("NFC");
    // half a character would be stored as U+FFFD: the row would not equal the name checked below
    if (/\p{Cs}/u.test(name)) return true;
    const fold = nameFold(name);
    // Taken when it folds like an active name - or lower-cases like one:
    // the games match a seat with toLowerCase, and a few letters lower-case
    // alike while folding apart (the Greek lunate sigmas, U+03F9 and
    // U+03F2), so the fold alone let two invites share one seat.
    const lower = name.toLowerCase(); // lowercase-ok: the games' seat test (room/games.ts), on top of sameName
    return this.sql.exec<Pick<InvRow, "name" | "token">>("SELECT name, token FROM inv WHERE revoked IS NULL").toArray().some((r) => r.token !== except && (nameFold(r.name) === fold || String(r.name).toLowerCase() === lower)); // lowercase-ok: as above
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
    if (this.nameHeld(name, null)) return null;
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
    // Each store goes by the key it files rows under: the push rows by
    // nameKey (lower case), the rest by the fold. A room may still hold an
    // older active invite whose name lower-cases like this one and folds
    // apart: its push rows are its own, and stay.
    const fold = nameFold(row.name);
    const active = this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE revoked IS NULL").toArray();
    const last = !active.some((r) => nameFold(r.name) === fold);
    const key = nameKey(row.name);
    const direct = last ? this.directUploadsOf([row.name]) : [];
    if (last) {
      if (!active.some((r) => nameKey(r.name) === key)) this.dropPush(row.name);
      this.dropUploadLinks(row.name);
      // and their Muse hook: nothing wakes for a member who is out
      this.museDrop(row.name);
    }
    // after the close above: the member removed gets no frame about it
    this.notifyMembers(row.name);
    if (direct.length) this.ctx.waitUntil(this.abortUploads(direct).catch((e) => warn("upload.abort", e, { room: this.roomName })));
    return true;
  },

  // A member takes itself out (POST .../leave, MCP leave_room): what a
  // revoke of its own invite does (revoke), and also the time it left on
  // that invite (left_ts), its claimed questions released (the unclaim
  // action), every match still in its lobby that it created or holds a
  // seat in called off (lobbiesOf: a seat's declined, gameDecline; one it
  // created without a seat cancelled as its creator's, gameCancel; the
  // Referee says each is off) and, when this was the name's last active
  // invite, its picture and its voice: the rows here, the objects just
  // after, the clone at Cartesia by the route. Left open, a lobby with its
  // seat could start with a player who is gone, who loses every turn on the
  // clock, and one it created would be left with no member who can cancel
  // it. Its messages, board writes and signatures stay, and running
  // matches are left to their clocks. The checks and every row change are
  // one step with no await, so no other call sees half a leave; storage's
  // deletes come after it, and a failure there is logged and undoes nothing.
  // A room may still hold a second active invite for the same name (an
  // older one the name rules once let through: "Ada" beside "ada", or two
  // names that lower-case alike and fold apart): then the claims, the
  // lobbies, the picture and the voice the name holds are that member's
  // too, and the leave touches none of them (nameHeld, the test invite()
  // makes). An invite never opened has nothing to leave and is refused as it is:
  // the lookup marks nothing (no access()). The last member who has joined
  // (no other unrevoked invite has been opened) takes the room with it,
  // only when it asks for that (deleteRoom): the room goes as the owner's
  // deletion takes it, everyone revoked (revokeAll, unopened invites
  // included) and then destroy(), in the same step. A protected room is
  // never deleted: its last member leaves like any other.
  /** @param room the room's name (lower case)
   *  @param deleteRoom the caller's yes to the room's deletion, when it is the last member */
  async leave(token: string | null | undefined, room: string, deleteRoom: boolean): Promise<LeaveResult | Refusal | LastMemberRefusal> {
    if (!this.ready) throw goneError();
    // the room this call began in: what writes rows after a wait asks first (alive)
    const gen = this.gen;
    this.roomName = room;
    const l = this.lookupInvite(token);
    if (!l.ok) return l;
    if (!l.row.used) return { ok: false, status: 409, code: "not_joined", error: "This invite was never opened, so there is nothing to leave: not using it is all it takes. This call did not open it." };
    const name = l.row.name;
    const others = this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL AND used IS NOT NULL AND token != ?", token).one().n;
    if (!others && PROTECTED_ROOMS.indexOf(room) < 0) {
      if (!deleteRoom) {
        const n = this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL AND used IS NULL").one().n;
        return { ok: false, status: 409, code: "last_member", unopened: n, error: "You are the last member of this room who has joined: leaving deletes the room and everything in it, for good" + (n ? ", and " + (n === 1 ? "the invite not yet opened stops" : "the " + n + " invites not yet opened stop") + " working too" : "") + ". To leave and delete it, send \"delete_room\": true beside \"confirm\". Nothing was changed." };
      }
      return this.leaveWithRoom(name, room);
    }
    // ---- one step, no await: the leave itself ----
    this.revoke(token as string);
    this.sql.exec("UPDATE inv SET left_ts = revoked WHERE token = ?", token);
    const left = this.sql.exec<Pick<InvRow, "revoked">>("SELECT revoked FROM inv WHERE token = ?", token).one().revoked || Date.now();
    // the name's claims, lobbies, picture and voice are its own only when no
    // other active invite still holds the name (see above)
    const shared = this.nameHeld(name, null);
    let calledOff: Array<Promise<unknown>> = [];
    const objects: string[] = [];
    let clone: string | null = null, voiced = false;
    if (!shared) {
      for (const q of this.sql.exec<Pick<OqRow, "id" | "claimed_by">>("SELECT id, claimed_by FROM oq WHERE status = 'claimed'").toArray()) {
        if (sameName(q.claimed_by, name)) this.updateQuestion(q.id, "unclaim", name, null);
      }
      // every lobby it holds a seat in is declined, every one it created
      // without a seat cancelled as its creator's, with the Referee's line.
      // Each path settles the lobby's clock first (advanceLobby: one past its
      // deadline is called off as expired, and the path then changes
      // nothing) and runs its own step as it is called; its alarm re-arm
      // waits below.
      calledOff = this.lobbiesOf(name).map((lb) => (lb.seat ? this.gameDecline(lb.id, name, room) : this.gameCancel(lb.id, name, false, room, false, true)).catch((e) => warn("leave.lobby", e, { room, id: lb.id })));
      objects.push(...(this.avatarDrop(name) || []));
      const v = this.voiceDrop(name);
      if (v) { voiced = true; clone = v.clone; if (v.sample_key) objects.push(v.sample_key); }
    }
    // ---- after it: storage, which lets other calls run ----
    await Promise.all(calledOff);
    await this.mediaDelete(objects);
    // rows are written only in the room this call began in: deleted
    // meanwhile (its last member left with it, say), its tables are gone or
    // belong to a room made again under the name
    if (voiced && this.alive(gen)) { try { await this.invalidateSpeakCache(name); } catch (e) { warn("leave.speak", e, { room }); } }
    return { ok: true, name, left, room_deleted: false, clone };
  },

  // The last member's leave with its yes to the room's deletion: its clone
  // is recorded as a pending delete (kept through destroy, as every
  // voice-del row is) for the route to delete at Cartesia, then the owner's
  // deletion path: revokeAll, whose rows go in its first step, and destroy,
  // started before anything is awaited, so no call lands in a room with no
  // invites that is not yet being deleted.
  async leaveWithRoom(name: string, room: string): Promise<LeaveResult> {
    const v = this.voiceRow(name);
    const clone = v && (v.provider || "cartesia") === "cartesia" ? v.voice_id || null : null;
    if (clone) this.voiceDelPend([clone]);
    const left = Date.now();
    const everyone = this.revokeAll();
    const gone = await this.destroy(room, "room deleted as its last member left");
    await everyone;
    if (!gone.deleted) warn("leave.destroy", gone.error || "not deleted", { room });
    return { ok: true, name, left, room_deleted: !!gone.deleted, clone };
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
    this.museDrop(null);
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
