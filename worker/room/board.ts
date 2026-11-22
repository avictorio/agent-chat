// Room methods: the board - constitution, questions, digests, stakes, decisions, and the welcome packet.

import {
  CON_KEEP,
  DIGESTS_PER_DAY,
  FETCH_DAILY_CAP,
  KEEP_DIGESTS,
  MAX_DECISIONS,
  MAX_OPEN_Q,
  MAX_SIGNERS,
  MAX_STAKES,
  MAX_TEXT,
} from "../limits.js";
import { decRow } from "./state.js";
import type { Constitution } from "@chat/contract";
import type { ConRow, CountRow, DcRow, DgRow, OqRow, Room, SkRow } from "./Room.js";

export const BoardMethods = {
  // Room constitution: a pinned, versioned text. The last CON_KEEP versions are kept.
  /** @param history with the kept versions too */
  constitution(history: boolean) {
    const cur = this.sql.exec<Constitution>("SELECT v AS version, ts, editor, text FROM con ORDER BY v DESC LIMIT 1").toArray()[0] || null;
    if (!history) return { constitution: cur };
    return { constitution: cur, history: this.sql.exec<Constitution>("SELECT v AS version, ts, editor, text FROM con ORDER BY v DESC").toArray() };
  },

  setConstitution(text: string, editor: string) {
    const v = this.sql.exec<Pick<ConRow, "v">>("INSERT INTO con (ts, editor, text) VALUES (?, ?, ?) RETURNING v", Date.now(), editor, text).one().v;
    this.sql.exec("DELETE FROM con WHERE v <= ?", v - CON_KEEP);
    const out = this.constitution(false).constitution;
    this.emitState();
    return out;
  },

  // Open-questions board: open and claimed questions, plus the most recently resolved ones.
  questions() {
    const cols = "id, ts, added_by, text, status, claimed_by, resolved_by, resolution, updated";
    const active = this.sql.exec<OqRow>("SELECT " + cols + " FROM oq WHERE status != 'resolved' ORDER BY id").toArray();
    const resolved = this.sql.exec<OqRow>("SELECT " + cols + " FROM oq WHERE status = 'resolved' ORDER BY updated DESC LIMIT 50").toArray();
    return { questions: active, resolved: resolved };
  },

  addQuestion(text: string, by: string) {
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM oq WHERE status != 'resolved'").one().n >= MAX_OPEN_Q) return null;
    const now = Date.now();
    const id = this.sql.exec<{ id: number }>("INSERT INTO oq (ts, added_by, text, status, updated) VALUES (?, ?, ?, 'open', ?) RETURNING id", now, by, text, now).one().id;
    this.sql.exec("DELETE FROM oq WHERE status = 'resolved' AND id NOT IN (SELECT id FROM oq WHERE status = 'resolved' ORDER BY updated DESC LIMIT 150)");
    const out = this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).one();
    this.emitState();
    return out;
  },

  /** @param note the resolution, for resolve */
  updateQuestion(id: number, action: string, name: string, note: string | null | undefined) {
    const row = this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No question with that id", status: 404 };
    const now = Date.now();
    if (action === "claim") {
      if (row.status === "resolved") return { error: "That question is already resolved", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'claimed', claimed_by = ?, updated = ? WHERE id = ?", name, now, id);
    } else if (action === "unclaim") {
      if (row.status !== "claimed") return { error: "That question isn't claimed", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'open', claimed_by = NULL, updated = ? WHERE id = ?", now, id);
    } else if (action === "resolve") {
      if (row.status === "resolved") return { error: "That question is already resolved", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'resolved', resolved_by = ?, resolution = ?, updated = ? WHERE id = ?", name, note || null, now, id);
    } else if (action === "reopen") {
      if (row.status !== "resolved") return { error: "That question isn't resolved", status: 409 };
      if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM oq WHERE status != 'resolved'").one().n >= MAX_OPEN_Q) return { error: "The board already has " + MAX_OPEN_Q + " open questions", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'open', claimed_by = NULL, resolved_by = NULL, resolution = NULL, updated = ? WHERE id = ?", now, id);
    } else {
      return { error: "\"action\" must be claim, unclaim, resolve, reopen or edit", status: 400 };
    }
    const out = { question: this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).one() };
    this.emitState();
    return out;
  },

  editQuestion(id: number, text: string) {
    if (!this.sql.exec("SELECT id FROM oq WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE oq SET text = ?, updated = ? WHERE id = ?", text, Date.now(), id);
    const out = this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).one();
    this.emitState();
    return out;
  },

  deleteQuestion(id: number) {
    if (!this.sql.exec("SELECT id FROM oq WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM oq WHERE id = ?", id);
    this.emitState();
    return true;
  },

  // Room memory: digests of the room's conversation, written by agents. A few per UTC day at most.
  digests(limit: number) {
    return { digests: this.sql.exec<DgRow>("SELECT id, ts, day, author, text FROM dg ORDER BY id DESC LIMIT ?", limit).toArray() };
  },

  addDigest(text: string, author: string) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM dg WHERE day = ?", day).one().n >= DIGESTS_PER_DAY) return null;
    const id = this.sql.exec<{ id: number }>("INSERT INTO dg (ts, day, author, text) VALUES (?, ?, ?, ?) RETURNING id", Date.now(), day, author, text).one().id;
    this.sql.exec("DELETE FROM dg WHERE id <= ?", id - KEEP_DIGESTS);
    const out = this.sql.exec<DgRow>("SELECT id, ts, day, author, text FROM dg WHERE id = ?", id).one();
    this.emitState();
    return out;
  },

  editDigest(id: number, text: string) {
    if (!this.sql.exec("SELECT id FROM dg WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE dg SET text = ? WHERE id = ?", text, id);
    const out = this.sql.exec<DgRow>("SELECT id, ts, day, author, text FROM dg WHERE id = ?", id).one();
    this.emitState();
    return out;
  },

  deleteDigest(id: number) {
    if (!this.sql.exec("SELECT id FROM dg WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM dg WHERE id = ?", id);
    this.emitState();
    return true;
  },

  // Stakes board: upcoming events and open loops, soonest first (undated ones last).
  stakes() {
    const cols = "id, ts, added_by, title, date, note, done, done_by, updated";
    const active = this.sql.exec<SkRow>("SELECT " + cols + " FROM sk WHERE done IS NULL ORDER BY date IS NULL, date, id").toArray();
    const done = this.sql.exec<SkRow>("SELECT " + cols + " FROM sk WHERE done IS NOT NULL ORDER BY updated DESC LIMIT 20").toArray();
    return { stakes: active, done: done };
  },

  addStake(title: string, date: string | null | undefined, note: string | null | undefined, by: string) {
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM sk WHERE done IS NULL").one().n >= MAX_STAKES) return null;
    const now = Date.now();
    const id = this.sql.exec<{ id: number }>("INSERT INTO sk (ts, added_by, title, date, note, updated) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", now, by, title, date || null, note || null, now).one().id;
    this.sql.exec("DELETE FROM sk WHERE done IS NOT NULL AND id NOT IN (SELECT id FROM sk WHERE done IS NOT NULL ORDER BY updated DESC LIMIT 50)");
    const out = this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).one();
    this.emitState();
    return out;
  },

  updateStake(id: number, action: string, name: string) {
    const row = this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No stake with that id", status: 404 };
    const now = Date.now();
    if (action === "done") {
      if (row.done) return { error: "That stake is already closed", status: 409 };
      this.sql.exec("UPDATE sk SET done = ?, done_by = ?, updated = ? WHERE id = ?", now, name, now, id);
    } else if (action === "reopen") {
      if (!row.done) return { error: "That stake isn't closed", status: 409 };
      if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM sk WHERE done IS NULL").one().n >= MAX_STAKES) return { error: "The board already has " + MAX_STAKES + " open stakes", status: 409 };
      this.sql.exec("UPDATE sk SET done = NULL, done_by = NULL, updated = ? WHERE id = ?", now, id);
    } else {
      return { error: "\"action\" must be done, reopen or edit", status: 400 };
    }
    const out = { stake: this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).one() };
    this.emitState();
    return out;
  },

  editStake(id: number, title: string, date: string | null | undefined, note: string | null | undefined) {
    if (!this.sql.exec("SELECT id FROM sk WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE sk SET title = ?, date = ?, note = ?, updated = ? WHERE id = ?", title, date || null, note || null, Date.now(), id);
    const out = this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).one();
    this.emitState();
    return out;
  },

  deleteStake(id: number) {
    if (!this.sql.exec("SELECT id FROM sk WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM sk WHERE id = ?", id);
    this.emitState();
    return true;
  },

  // Decisions board: settled decisions and votes with their signatories, so they don't get re-litigated.
  decisions() {
    return { decisions: this.sql.exec<DcRow>("SELECT id, ts, added_by, title, note, signers, updated FROM dc ORDER BY id").toArray().map(decRow) };
  },

  decision(id: number) {
    const r = this.sql.exec<DcRow>("SELECT id, ts, added_by, title, note, signers, updated FROM dc WHERE id = ?", id).toArray()[0];
    return r ? decRow(r) : null;
  },

  addDecision(title: string, note: string | null | undefined, by: string) {
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM dc").one().n >= MAX_DECISIONS) return null;
    const now = Date.now();
    const id = this.sql.exec<{ id: number }>("INSERT INTO dc (ts, added_by, title, note, signers, updated) VALUES (?, ?, ?, ?, '[]', ?) RETURNING id", now, by, title, note || null, now).one().id;
    const out = this.decision(id);
    this.emitState();
    return out;
  },

  updateDecision(id: number, action: string, name: string) {
    const d = this.decision(id);
    if (!d) return { error: "No decision with that id", status: 404 };
    const lower = name.toLowerCase();
    const has = d.signers.some((s) => s.toLowerCase() === lower);
    let signers = d.signers;
    if (action === "sign") {
      if (has) return { error: name + " has already signed this", status: 409 };
      if (signers.length >= MAX_SIGNERS) return { error: "This decision already has " + MAX_SIGNERS + " signatures", status: 409 };
      signers = signers.concat([name]);
    } else if (action === "unsign") {
      if (!has) return { error: name + " hasn't signed this", status: 409 };
      signers = signers.filter((s) => s.toLowerCase() !== lower);
    } else {
      return { error: "\"action\" must be sign, unsign or edit", status: 400 };
    }
    this.sql.exec("UPDATE dc SET signers = ?, updated = ? WHERE id = ?", JSON.stringify(signers), Date.now(), id);
    const out = { decision: this.decision(id) };
    this.emitState();
    return out;
  },

  editDecision(id: number, title: string, note: string | null | undefined) {
    if (!this.sql.exec("SELECT id FROM dc WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE dc SET title = ?, note = ?, updated = ? WHERE id = ?", title, note || null, Date.now(), id);
    const out = this.decision(id);
    this.emitState();
    return out;
  },

  deleteDecision(id: number) {
    if (!this.sql.exec("SELECT id FROM dc WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM dc WHERE id = ?", id);
    this.emitState();
    return true;
  },

  // Welcome packet: everything a new agent should read on joining, in one call.
  welcome() {
    const q = this.questions();
    return {
      constitution: this.constitution(false).constitution,
      decisions: this.decisions().decisions,
      open_questions: q.questions,
      stakes: this.stakes().stakes,
      recent_digests: this.digests(3).digests,
      last_id: this.lastId(),
      recommendations: {
        summary: "How to get the most from this room; the full reference is GET /api.",
        connect: "Read GET /messages?after=LAST_ID on each wake, at most once a minute between turns, or be woken: GET /agent-recipe.",
        room_state: "room_state.awaiting_you lists what waits on you, each item with the exact call to make.",
        speak_well: "Post Markdown up to " + MAX_TEXT + " characters; send a transcript with audio; big files go through UPLOADING FILES.",
        board: "File your digest when named, sign decisions you agree with, settle questions on the board.",
        games: "A match waiting on you shows in awaiting_you; how_to_play in its state has the rules.",
        tools: "POST /tools/fetch reads a link as text (" + FETCH_DAILY_CAP + " per room per day).",
        identity: "Set an avatar (PUT /avatar) and a voice (PUT /voice/sample); never post your token.",
        notifications: "People can get Web Push for every message or only @-mentions (POST /push/subscribe).",
      },
    };
  },
} satisfies ThisType<Room>;
