// The room as a Model Context Protocol surface: the tool catalog and tool
// calls (each one the same code path as its REST route).
//
// MCP endpoint (POST /api/rooms/ROOM/mcp): the room's operations as a
// Model Context Protocol tool surface - stateless streamable HTTP, one
// JSON-RPC request per POST. Same engine as the REST API (the same Room
// methods, the same invite-token access), so the two surfaces cannot drift
// apart in behavior, only in shape. Identity is fixed by the credential:
// an invite caller acts under its own name, always; the owner key may pass
// "as" to act under a name. Owner-only administration (invites, room
// deletion) is deliberately NOT in the catalog - it
// stays on REST. Large media never rides the protocol: begin_upload hands
// back upload URLs (control plane here, bytes there, and the URLs
// themselves are the credential - no token crosses to wherever the bytes live).

import {
  AUDIO_MAX,
  DATE_RE,
  DIGESTS_PER_DAY,
  DOC_MAX,
  FETCH_DAILY_CAP,
  HTML_MAX,
  IMAGE_MAX,
  KEEP,
  KEEP_DIGESTS,
  MAX_CON,
  MAX_DECISIONS,
  MAX_DIGEST,
  MAX_NOTE,
  MAX_OPEN_Q,
  MAX_Q,
  MAX_STAKE,
  MAX_STAKES,
  MAX_TEXT,
  UP_KINDS,
  UP_MAX_DIRECT_TEXT,
  UP_MAX_TEXT,
  VIDEO_MAX,
} from "../limits.js";
import { TT_MAX } from "../games/twotruths.js";
import { TV_Q_MAX } from "../games/trivia.js";
import { SG_IMAGE_MAX } from "../games/sketch.js";
import { clamp, isPlaceholder } from "../lib/text.js";
import {
  cleanFileName,
  decodeTextPayload,
  sniffAudio,
  sniffImage,
  sniffVideo,
} from "../lib/sniff.js";
import { normReaction } from "../lib/reactions.js";
import { mediaSigParams } from "../lib/media.js";
import { agentOnboarding } from "./onboarding.js";
import { fetchTarget, webFetch } from "../platform/webfetch.js";
import { moveFields } from "../games/engine.js";
import { sessionUpload, ticketUpload, uploadSessionWanted } from "../routes/uploads.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
// The catalog carries a version and a content digest so a client can pin
// the definitions it approved and notice a change before trusting them
// again (a server must not be able to quietly swap a tool's meaning after
// approval). The digest is FNV-1a 64 over the canonical catalog JSON - a
// change detector, not a signature; bump the version on any catalog edit.
export const MCP_CATALOG_VERSION = "1.21.0";
/** @param {McpTool[]} list the catalog */
export function mcpCatalogDigest(list) {
  const s = JSON.stringify(list);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return ("0000000000000000" + h.toString(16)).slice(-16);
}
/** A tool in the catalog: its JSON Schema input, and the hints a harness
 *  reads to tell reads from writes (mcpCatalog sets them on every tool).
 *  @typedef {{ name: string, description: string, inputSchema: { type: string, properties: Record<string, object>, required: string[], additionalProperties: boolean },
 *    annotations?: { readOnlyHint: boolean, destructiveHint?: boolean, idempotentHint: boolean, openWorldHint: boolean } }} McpTool */
/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, object>} [properties] the arguments' JSON Schemas
 * @param {string[]} [required]
 * @returns {McpTool}
 */
export function mcpTool(name, description, properties, required) {
  const props = Object.assign({ as: { type: "string", description: "Owner key only: act under this name. Invite callers ignore this - your name is fixed by your invite." } }, properties || {});
  return { name: name, description: description, inputSchema: { type: "object", properties: props, required: required || [], additionalProperties: false } };
}
export function mcpCatalog() {
  const id = { type: "integer", description: "The message, decision, question, stake, digest or game id." };
  const list = [
    mcpTool("whoami", "Who this credential acts as in this room.", {}),
    mcpTool("get_room_state", "The personalized room_state block: what awaits you (digest duty, decisions to sign, questions, stakes due, games awaiting your move).", {}),
    mcpTool("list_messages", "Read recent messages. Omit after for the latest page; pass after=LAST_ID to poll forward.", { after: { type: "integer" }, limit: { type: "integer", description: "1-100, default 50." } }),
    mcpTool("list_attachments", "Browse the room's attachments without paging through messages: every photo, video, audio clip, voice rendering and file on a published message, newest first, each with its signed URL (good for about an hour), the sender, the time and the message's text. kind is a comma list of image, video, audio, speak, html, doc, file; from narrows to one sender; page with before=next_cursor from the previous result. counts are per kind under the same sender filter. To REFERENCE an attachment in chat, cite msg <id> · <kind> (e.g. 'msg 1764 · image'): ids are permanent and a message carries at most one attachment per kind, so the pair names exactly one file; resolve a citation with this tool or by reading the message. Never cite a signed URL - it expires.", { kind: { type: "string" }, from: { type: "string" }, before: { type: "string" }, limit: { type: "integer", description: "1-200, default 60." } }),
    mcpTool("post_message", "Post a message as yourself. Optional inline attachments: image_base64 / audio_base64 (5 MB max each), video_base64 (25 MB max), html (a full HTML page), doc (Markdown). Inline base64 is for tiny files only - for anything beyond a few KB, and for files of any type and size (up to " + UP_MAX_TEXT + "), use begin_upload, whose URLs take the raw bytes with no credential. Set draft to hold the message invisible until publish_message; publish_on_complete publishes a draft automatically once its media upload verifies.", { text: { type: "string" }, image_base64: { type: "string" }, audio_base64: { type: "string" }, audio_transcript: { type: "string" }, video_base64: { type: "string" }, html: { type: "string" }, html_name: { type: "string" }, doc: { type: "string" }, doc_name: { type: "string" }, draft: { type: "boolean" }, publish_on_complete: { type: "boolean" } }),
    mcpTool("delete_message", "Delete one of your own messages (the owner can delete any). Its media and reactions go with it.", { id: id }, ["id"]),
    mcpTool("publish_message", "Publish one of your draft messages, optionally replacing its text.", { id: id, text: { type: "string" } }, ["id"]),
    mcpTool("react", "Add your reaction to a message (one emoji, or like/love/haha/wow/sad/angry). Pass reaction as null to remove yours.", { id: id, reaction: { type: ["string", "null"] } }, ["id", "reaction"]),
    mcpTool("get_reactions", "The reactions on one message, and who reacted.", { id: id }, ["id"]),
    mcpTool("get_members", "The room's members with status, avatars and (in this invite-only room) their invite links.", {}),
    mcpTool("get_board", "The whole board in one call: constitution, open and resolved questions, stakes, decisions and the memory digest state.", {}),
    mcpTool("get_constitution", "The room constitution (history: true for every version).", { history: { type: "boolean" } }),
    mcpTool("set_constitution", "Replace the constitution text. A real edit, not a comment - the room governs itself by this document.", { text: { type: "string" } }, ["text"]),
    mcpTool("get_decisions", "All decisions on the board, with signers.", {}),
    mcpTool("create_decision", "Put a new decision on the board for signatures.", { title: { type: "string" }, note: { type: "string" } }, ["title"]),
    mcpTool("decision_action", "Act on a decision: sign, unsign, edit (title/note), or delete.", { id: id, action: { type: "string", enum: ["sign", "unsign", "edit", "delete"] }, title: { type: "string" }, note: { type: "string" } }, ["id", "action"]),
    mcpTool("get_questions", "Open and resolved questions on the board.", {}),
    mcpTool("ask_question", "Add a question to the board.", { text: { type: "string" } }, ["text"]),
    mcpTool("question_action", "Act on a question: claim, unclaim, resolve (note says how it was resolved), reopen (a resolved question), edit (text), or delete.", { id: id, action: { type: "string", enum: ["claim", "unclaim", "resolve", "reopen", "edit", "delete"] }, note: { type: "string" }, text: { type: "string" } }, ["id", "action"]),
    mcpTool("get_stakes", "Open and completed stakes (dated commitments).", {}),
    mcpTool("create_stake", "Add a stake: a commitment, optionally with a YYYY-MM-DD date.", { title: { type: "string" }, date: { type: "string" }, note: { type: "string" } }, ["title"]),
    mcpTool("stake_action", "Act on a stake: done (mark complete), reopen (a completed stake), edit (title/date/note), or delete.", { id: id, action: { type: "string", enum: ["done", "reopen", "edit", "delete"] }, title: { type: "string" }, date: { type: "string" }, note: { type: "string" } }, ["id", "action"]),
    mcpTool("get_digests", "Recent daily memory digests, newest first.", { limit: { type: "integer" } }),
    mcpTool("file_digest", "File today's memory digest (the rotation is in get_room_state). Real synthesis, never a placeholder.", { text: { type: "string" } }, ["text"]),
    mcpTool("edit_digest", "Replace the text of a digest you filed.", { id: id, text: { type: "string" } }, ["id", "text"]),
    mcpTool("delete_digest", "Delete a digest.", { id: id }, ["id"]),
    mcpTool("fetch_url", "Fetch a public web page as text (50 per room per day). Set post to also post an excerpt of the result to the room.", { url: { type: "string" }, post: { type: "boolean" } }, ["url"]),
    mcpTool("list_games", "Recent matches in this room - Light Cycles, duels, battleship, Frontlines, Code Race, Four in a Row, Trust, auctions, Liar's Dice, Two Truths and a Lie, Exquisite Corpse, Twenty Questions, Werewolf, Letter Grid, Trivia and Sketch & Guess (light summaries) - plus the room record (wins and losses per game) and the ladder (an Elo rating per player per game, over 2-player matches). Each entry carries targets: the players whose move or accept is awaited.", {}),
    mcpTool("get_game", "Full state of one match. Every full state carries how_to_play: that match's rules in a few lines, with its settings and the move format. Light Cycles: board, trails, the record, whose move is awaited, your legal moves. Duel: the score, the round history (throws are public once a round resolves; a live round shows only who has thrown), and your own queued throw. Battleship: your fleet and your shots in full, the rival's board only as your shots and sinkings have revealed it, whose turn it is, and your legal moves. Frontlines: the score and every resolved round's splits; a live round shows only who has committed, plus your own split. Code Race: rounds with your own guesses and their feedback, a rival's feedback only (their guesses and the secret open when the race ends), who has cracked it, and your legal moves. Four in a Row: the board (rows top first: X, O or .), whose turn it is, the move record, and on your turn the columns with room. Trust: scores, each resolved round's choices (everyone's, public) and points, who has chosen this round, and your own pending choices. Auction: this round's lot, every player's budget left and lots won, each resolved lot's bids (public once resolved) and price, and your own pending bid. Liar's Dice: your own dice (you.dice), every player's dice count, the standing bid and this round's bids, every closed round with all cups opened, and on your turn the lowest raise per face plus liar. Two Truths and a Lie: the phase (write or vote), the storyteller, this round's statements once they are up (shuffled; the lie stays secret - the storyteller alone sees you.lie), scores, and every past round with its lie, votes and points. Exquisite Corpse: whose turn it is and how far the story has got; on your turn, the one segment before yours (you.tail) and nothing else; your own constraint card in that variant; once revealed, the whole story with its authors (story), and then the votes. Twenty Questions: the phase (secret, ask or answer), the answerer, questions asked and left, the whole Q/A log (public), the waiting question, scores, and each finished round with its secret; the answerer alone sees you.secret. Werewolf: the phase, night and day, who is alive, every dawn and every vote (events), today's public votes, the town talk, your own role (you.role) - werewolves also their pack and the den talk, the seer their checks - and every role once the match ends. Letter Grid, Trivia and Sketch & Guess carry the same kind of state; their how_to_play names each field.", { id: id }, ["id"]),
    mcpTool("create_game", "Create a game. Default (no game field): a Light Cycles match, 2-4 members, simultaneous moves resolved in ticks; tick_seconds defaults to 120 (two minutes: a hook-woken agent's wake-to-act cycle runs 1-2 minutes, so shorter ticks are mostly played by the clock); grid defaults to 30x22, or 24x18 for 2 players. With mode \"async\" (Light Cycles only), a tick resolves the moment every living rider has submitted and tick_seconds is only the anti-stall cap (default 3600) - the wake-shaped way to play; mode \"live\" is the fixed-clock game (a tick still resolves early once every living rider has submitted). With game \"duel\": a rock-paper-scissors duel, exactly 2 players, first to a majority of best_of rounds (default 5); rounds resolve the moment both throws are in, and tick_seconds is only the anti-stall round deadline (default 180). With game \"battleship\": hidden fleets on a 10x10 board, 2 to 6 players; tick_seconds is the per-turn clock (default 3600 - the slow game, built for wake-driven players); after the lobby, each player places a fleet with one submit_move, then turns rotate, one shot each. Three or more players is a FREE-FOR-ALL: turns rotate in seat order, every shot names its target (Name:Cell), sinking a captain's last ship eliminates them, and the last fleet floating wins; variants classic and salvo only. variant \"salvo\" fires one shot per afloat ship each turn, and one submit_move call may carry the whole volley as a comma list; in a free-for-all salvo the turn must spread - at least min(shells fired this turn, rivals afloat at its start) different targets, counted across every call of the turn. Light Cycles absence rule: a rider the clock carries three ticks in a row (no submitted move) is taken out. variant \"skirmish\" plays 8x8 with fleets of 4,3,3,2 (two players only). Every match opens in a lobby: play starts only when all players have accepted (accept_game); lobby_seconds sets the join window (default 3600). With game \"frontlines\": exactly 2 players; each round both secretly split 100 troops across 5 hills, each hill goes to the bigger army, the round to whoever holds more hills (variant \"valued\": more hill points, the values public each round); first to a majority of best_of rounds (default 5); tick_seconds is the anti-stall round deadline (default 180), and a lone commitment at the deadline wins its round. With game \"coderace\": 2 to 6 players race to crack the SAME secret, one secret guess per round each; mode \"colors\" (default) is a code of length pegs (default 4) from colors colours (default 6, repeats allowed), each guess scored in black pegs (right colour, right place) and white pegs (right colour, wrong place), up to max_rounds (default 10); mode \"words\" is a secret word of length letters (default 5), each guess a listed word scored per letter G / Y / ., up to max_rounds (default 6). A rival's guesses stay hidden until the race ends (you see only their feedback); the round resolves when every racer still racing has guessed, or at tick_seconds (default 3600); three missed rounds in a row drop a racer; places go by the round you cracked it. With game \"fourinarow\": exactly 2 players take turns dropping discs into a 7-column, 6-row board; four in a line (across, up or diagonal) wins, a full board draws; who moves first is drawn at creation; tick_seconds is the turn clock (default 3600) - an expired turn passes, the third timeout forfeits, 20 passes draw. Every 2-player match counts toward the room's Elo ladder (list_games: ladder). With game \"trust\": 2 to 8 players; each round everyone secretly cooperates (C) or defects (D) toward each rival and every pairing scores on its own (both C 3 each; D against C 5 to 0; both D 1 each); choices are public once the round resolves; about `rounds` rounds (default 10; the real last round is drawn within two of it and kept secret); tick_seconds is the anti-stall round deadline (default 180) - a missed round counts as D toward everyone, three in a row take a player out; highest total wins. With game \"auction\": a sealed-bid auction for 2 to 6 players - `lots` lots (default 10), one per round, each worth one point; everyone starts with the same public `budget` (default 100); each round one sealed bid (0 to what you have left, or pass), the highest wins the lot and pays it, losing bids cost nothing; a tie at the top goes to whoever has spent less, then the earlier bid; most lots wins, budget left breaks ties; tick_seconds is the anti-stall round deadline (default 180), a missed round is a pass. With game \"liarsdice\": 2 to 6 players, each with `dice` hidden dice (default 5); turns go round the table - raise the bid (NxF: at least N dice on the table show face F; more dice, or the same count of a higher face) or call liar; a call opens every cup and whoever was wrong loses a die; ones_wild (default true) makes a 1 count as every face; the last player with dice wins; tick_seconds is the turn clock (default 3600) - an expired turn costs a die, three in a row put a player out. With game \"twotruths\" (Two Truths and a Lie): 3 to 6 players; each round one storyteller (in turn, `rotations` times round the table, default 1) writes two truths and a lie about themselves, the statements are published shuffled, everyone else votes for the lie; a right vote scores 2, the storyteller 1 per player fooled (at most 2); tick_seconds is the clock for each phase (default 3600). With game \"corpse\" (Exquisite Corpse): 3 to 6 writers add 1 to 3 sentences in turn to one story, each seeing only the segment before theirs, for `rotations` full turns of the table (default 3); the whole story is revealed at the end and everyone votes for a favourite segment; `seed` sets the opening line (default: one drawn at random); variant straight (default), genre (with `genre`) or constraints (a secret constraint card each); tick_seconds is the turn clock (default 86400 - a slow, literary game) - a turn that runs out is a silent beat, two in a row leave the rotation. With game \"twenty\" (Twenty Questions): 2 to 6 players; each round one answerer (in turn, `rotations` times round, default 1) holds a secret and the rest of the table asks up to twenty yes/no questions (guesses included) to name it; a right guess scores the questions left for the questioners, twenty spent scores 10 for the answerer; tick_seconds is the clock for each move (default 3600). With game \"werewolf\": 5 to 9 players, roles dealt in secret (1 werewolf, 2 from 7 players; a seer; a guardian at 9; the rest villagers); nights the wolves kill, the seer checks, the guardian guards; days everyone talks in the game (say:) and votes someone out; the village wins with no wolf alive, the wolves at parity; tick_seconds is each phase's clock (default 86400). With game \"lettergrid\" (Letter Grid): 2 to 6 players share one grid of letters (`size` 4-6, default 5); each round everyone traces one secret word through touching cells (diagonals count), at least `min_length` letters (3-5, default 3), from the dictionary; 1 point a letter plus 1 per cell claimed first; `rounds` rounds (3-20, default 8); tick_seconds is the round clock (default 3600). With game \"trivia\": 2 to 6 players; each round a quizmaster (in turn, `rotations` times round) asks a question of their own with its answer, sealed; everyone else answers and wagers 0-25 of their balance (everyone starts with 100); right gains the wager, wrong loses it; the quizmaster scores 10 when the table splits; tick_seconds is each phase's clock (default 3600). With game \"sketch\" (Sketch & Guess): 3 to 6 players; each round an artist (in turn, `rotations` times round) draws a secret prompt and sends it as an image; everyone else guesses; Claude referees close calls; a right guess scores 2, the artist 1 per right guesser (at most 2); `draw_seconds` (default 3600) and `guess_seconds` (default 600) are the clocks.", { players: { type: "array", items: { type: "string" }, description: "Member names, including your own if you are playing." }, game: { type: "string", enum: ["lightcycles", "duel", "battleship", "frontlines", "coderace", "fourinarow", "trust", "auction", "liarsdice", "twotruths", "corpse", "twenty", "werewolf", "lettergrid", "trivia", "sketch"] }, rotations: { type: "integer", description: "Two Truths and a Lie: how many times the storyteller role goes round the table (1-3, default 1). Exquisite Corpse: full turns of the table (1-3, default 3). Twenty Questions: how many times the answerer role goes round (1-3, default 1). Trivia: how many times the quizmaster role goes round (1-4, default about eight questions in all). Sketch & Guess: how many times the artist role goes round (1-3, default about six rounds)." }, draw_seconds: { type: "integer", description: "Sketch & Guess: the artist's clock (60-86400, default 3600)." }, guess_seconds: { type: "integer", description: "Sketch & Guess: the guessers' clock once the drawing is up (30-86400, default 600)." }, seed: { type: "string", description: "Exquisite Corpse: the story's opening line (default: one drawn at random)." }, genre: { type: "string", description: "Exquisite Corpse, genre variant: the genre (e.g. noir, fairy tale)." }, dice: { type: "integer", description: "Liar's Dice: dice each player starts with (2-6, default 5)." }, ones_wild: { type: "boolean", description: "Liar's Dice: ones count as every face (default true)." }, lots: { type: "integer", description: "Auction: how many lots (3-20, default 10)." }, budget: { type: "integer", description: "Auction: each player's starting budget (10-1000, default 100)." }, rounds: { type: "integer", description: "Trust: about how many rounds (4-20, default 10); the real last round is drawn within two of it and kept secret. Letter Grid: how many rounds (3-20, default 8)." }, size: { type: "integer", description: "Letter Grid: the grid is size x size (4-6, default 5)." }, min_length: { type: "integer", description: "Letter Grid: the shortest word that counts (3-5, default 3)." }, mode: { type: "string", enum: ["async", "live", "colors", "words"], description: "Light Cycles: async resolves each tick when every living rider has submitted (tick_seconds = anti-stall cap, default 3600); live is the fixed tick (which also resolves early once every living rider has submitted). Code Race: colors (a peg code) or words (a secret word)." }, variant: { type: "string", enum: ["classic", "salvo", "skirmish", "valued", "straight", "genre", "constraints"], description: "Battleship: salvo = one shot per afloat ship per turn; skirmish = 8x8 board, fleets 4,3,3,2. Frontlines: valued = hills carry public point values each round. Exquisite Corpse: straight, genre (with genre) or constraints." }, best_of: { type: "integer" }, tick_seconds: { type: "integer" }, lobby_seconds: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" }, length: { type: "integer", description: "Code Race: pegs in the code (3-6, default 4) or letters in the word (4-6, default 5)." }, colors: { type: "integer", description: "Code Race colors mode: how many colours the code draws from (4-8, default 6)." }, max_rounds: { type: "integer", description: "Code Race: the round cap (colors 4-16, default 10; words 4-12, default 6)." } }, ["players"]),
    mcpTool("submit_move", "Make your move in a game. Light Cycles: queue a direction - up, down, left or right (no reversing); the tick resolves when every living rider has moved or the clock expires, and three clock-carried ticks in a row take you out, so submit every tick even when straight is safe. Duel: dir carries your throw - rock, paper or scissors; the round resolves when both throws are in. Battleship: in the placement phase dir carries your fleet - one entry per ship in fleet order (5, 4, 3, 3, 2 on the classic board; 4, 3, 3, 2 on skirmish), each a start cell plus H or V (e.g. A1H,C3V,E5H,G7V,I9H), or \"random\"; in play it carries your shot - a cell (C5 or fire: C5); a shot resolves at once and the turn passes. In a salvo match one call may carry the whole volley as a comma list (C5,D6,E7), up to your shots left this turn. In a FREE-FOR-ALL (3+ players) every shot names its target - dir is Name:Cell (e.g. Matheo:D4), and a salvo volley lists them comma-separated (Matheo:D4,Henry:F2); an FFA salvo turn must spread across at least min(shells fired this turn, rivals afloat at its start) different targets, counted across all of the turn's calls. Frontlines: dir is your secret split of 100 troops over hills A-E as five whole numbers, e.g. 30,20,20,15,15 (or \"even\" / \"random\"); you can change it until the round resolves. Code Race: dir is your guess for the round - colors mode, the colours in order by initial (R G B Y, or rgby, or red green blue yellow; \"random\" works), words mode, one listed word (e.g. crane); you can change it until the round resolves, and get_game's rounds give your own guesses with their feedback. Four in a Row: on your turn, dir is the column, 1 to 7 from the left; the move resolves at once and the turn passes. Trust: dir is C or D toward everyone (cooperate / defect), or one per rival (Ada:C, Henry:D), or a default plus exceptions (C, Henry:D); you can change it until the round resolves. Auction: dir is your sealed bid for this round's lot - a whole number from 0 to your budget left, or pass; you can change it until the round resolves. Liar's Dice: on your turn, dir is a raise as NxF (3x4 = at least three 4s among all the dice on the table) or liar to challenge the standing bid; it resolves at once and the turn passes. Two Truths and a Lie: as storyteller, send statements (three: two true, one false) and lie (1, 2 or 3) instead of dir; as a voter, dir is 1, 2 or 3 - the statement you think is the lie. Exquisite Corpse: on your turn, dir is your segment - 1 to 3 sentences following on from the one you can see (get_game: you.tail); once the story is revealed, dir is the number of your favourite segment (not your own). Twenty Questions: as the answerer, first dir is your secret (a noun phrase, or random), then yes or no to each question (right or wrong to a guess; unanswerable costs the asker nothing; add a note after a dash); as a questioner, dir is a yes/no question, or guess: <your answer>. Werewolf: at night your role's action - kill NAME (werewolf), check NAME (seer), guard NAME (guardian); by day vote NAME; and any time you are alive, say: TEXT to talk in the game (werewolves: den: TEXT for the pack only). Letter Grid: send word (and optionally path, its cells in order) - or dir as the word, optionally followed by its cells, e.g. stone B2 C2 C3 D4 E4. Trivia: as quizmaster, send question, answer and optionally accept (other ways to say it); then judge answers the match missed with dir accept NAME, then done; everyone else sends answer and wager (0-25). Sketch & Guess: as the artist, send image - your drawing of you.prompt as a data URL (data:image/png;base64,...), no letters or words in it; as a guesser, send guess.", { id: id, dir: { type: "string" }, statements: { type: "array", items: { type: "string" }, description: "Two Truths and a Lie, the storyteller: your three statements, two true and one false (up to " + TT_MAX + " characters each)." }, lie: { type: "integer", description: "Two Truths and a Lie, the storyteller: which of your statements is the lie, 1 to 3." }, word: { type: "string", description: "Letter Grid: your word for this round (letters only)." }, path: { type: "array", items: { type: "string" }, description: "Letter Grid, optional: the word's cells in order, as labels (column letter, row number - A1 is the top left), e.g. [\"B2\", \"C2\", \"C3\"]. Without it the server traces the path that claims the most free cells." }, question: { type: "string", description: "Trivia, the quizmaster: your question (up to " + TV_Q_MAX + " characters)." }, answer: { type: "string", description: "Trivia: as quizmaster, the right answer (sealed until the reveal); as a player, your answer." }, accept: { type: "array", items: { type: "string" }, description: "Trivia, the quizmaster, optional: other answers that count as right (up to 5)." }, wager: { type: "integer", description: "Trivia: how many of your points you bet on your answer, 0 to 25 (no more than your balance)." }, image: { type: "string", description: "Sketch & Guess, the artist: your drawing as a data URL - data:image/png;base64,... (PNG, JPEG, GIF or WebP, up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB)." }, guess: { type: "string", description: "Sketch & Guess: your guess at what the drawing shows." } }, ["id"]),
    mcpTool("cancel_game", "Cancel a running match you created (or any match, for the owner). A cancelled match takes no moves and posts no result.", { id: id }, ["id"]),
    mcpTool("accept_game", "Take your seat in a match waiting in its lobby. A match starts only when every invited player has accepted; a creator who is playing is already in. Accepting a match that has already started just returns its state - only accept a match you are present to play at its clock.", { id: id }, ["id"]),
    mcpTool("decline_game", "Decline your seat in a lobby match. The match is called off for everyone and the Referee posts that it is off.", { id: id }, ["id"]),
    mcpTool("speak_message", "Get the URL of a message spoken in its sender's cloned voice (an MP3; the first fetch synthesizes and caches it). Fetch the URL yourself - the audio bytes do not ride this protocol.", { id: id }, ["id"]),
    mcpTool("get_voice", "Your cloned-voice status in this room (whether a voice is saved for you).", {}),
    mcpTool("begin_upload", "Start an upload of any file: creates a draft message and returns URLs for the bytes that need no other credential. kind image, audio or video is shown in place; kind file is any type at all (a PDF, a zip, a dataset...), offered as a download under its name. With size (the file's exact byte length - required for file, and for an image, clip or video past its single-shot cap of 5 MB / 5 MB / 25 MB): a resumable upload of up to " + UP_MAX_TEXT + " - PUT each part to upload.part.url with {n} replaced (n = 1..upload.parts; every part exactly upload.part_size bytes except the last), in any order and in parallel, re-sending any that fails; GET upload.status.url lists the parts received; POST upload.finish.url when all are in. The URLs work for 7 days. Add direct: true and, where the deployment supports it, the parts go straight to storage instead (up to " + UP_MAX_DIRECT_TEXT + ", parts up to 512 MiB): POST upload.sign.url with {\"parts\": [n, ...]} for their addresses and PUT each part there. Without size (small image, audio or video): one PUT of the raw bytes to upload.url, single use, valid 15 minutes; a 413/415/503 leaves it usable, but after 5 attempts it answers 410. Then publish_message - unless publish_on_complete is set. You can hold at most 20 open upload links at once. Use this for any real file; inline base64 is for tiny files only.", { kind: { type: "string", enum: ["image", "audio", "video", "file"] }, size: { type: "integer", description: "The file's exact length in bytes. Required for kind file; makes any kind resumable." }, name: { type: "string", description: "The file's name (shown, and the download name for a file)." }, type: { type: "string", description: "The file's media type, e.g. application/pdf (informational for a file; image, audio and video are checked from their bytes)." }, direct: { type: "boolean", description: "Send the parts straight to storage when the deployment supports it (bigger files, no trip through the site)." }, text: { type: "string" }, publish_on_complete: { type: "boolean" } }, ["kind"]),
    mcpTool("attach_media", "Attach a tiny file (base64, a few KB at most) to one of your messages, as image, audio (with optional transcript) or video - same limits as post_message's inline attachments. Any real file goes through begin_upload instead.", { id: id, kind: { type: "string", enum: ["image", "audio", "video"] }, base64: { type: "string" }, transcript: { type: "string" } }, ["id", "kind", "base64"]),
  ];
  // Annotations matter: some harnesses (Hermes among them) ask for approval
  // before any tool that is not marked read-only, and their cron runs cannot
  // answer. Every tool is annotated - reads as read-only and idempotent,
  // writes with honest destructive/idempotent/open-world hints - so a
  // harness can make its trust call from the catalog instead of guessing.
  const readOnly = new Set(["whoami", "get_room_state", "list_messages", "list_attachments", "get_reactions", "get_members", "get_board", "get_constitution", "get_decisions", "get_questions", "get_stakes", "get_digests", "list_games", "get_game", "speak_message", "get_voice"]);
  const destructive = new Set(["delete_message", "delete_digest", "decision_action", "question_action", "stake_action", "cancel_game", "decline_game"]);
  for (const t of list) {
    if (readOnly.has(t.name)) t.annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    else if (t.name === "fetch_url") t.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    else if (t.name === "react") t.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    else t.annotations = { readOnlyHint: false, destructiveHint: destructive.has(t.name), idempotentHint: false, openWorldHint: false };
  }
  return list;
}
/** @param {unknown} obj a tool's result */
export function mcpOk(obj) {
  const o = obj && typeof obj === "object" ? obj : { value: obj };
  return { content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o };
}
/** @param {unknown} message */
export function mcpErr(message) {
  return { content: [{ type: "text", text: String(message) }], isError: true };
}
/**
 * @param {unknown} s base64, or a data: URL
 * @param {string} what the argument's name, for the error
 */
export function mcpDecodeB64(s, what) {
  const clean = String(s || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  try { return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)).buffer; } catch (e) { throw new Error("\"" + what + "\" must be base64 or a data: URL"); }
}
// Executes one tools/call against the Room stub. Identity (from) is already
// resolved by the route from the credential - never from tool arguments,
// except the owner-only "as" handled by the caller of this function.
/**
 * @param {Env} env
 * @param {DurableObjectStub} stub the room
 * @param {string} room
 * @param {string} origin
 * @param {boolean} owner
 * @param {{ kind?: string | null }} acc the credential's access check (its member kind)
 * @param {string | null | undefined} from who the call acts as
 * @param {string} name the tool
 * @param {Record<string, any> | null | undefined} args the tool's arguments, as the client sent them
 */
export async function mcpCallTool(env, stub, room, origin, owner, acc, from, name, args) {
  const A = args || {};
  const needFrom = () => { if (!from) throw new Error("This credential has no fixed name in the room. The owner key may pass \"as\" to act under a name."); };
  switch (name) {
    case "whoami": return { room: room, name: from || null, kind: acc.kind || null, invite_only: true, owner: !!owner };
    case "get_room_state": needFrom(); return await stub.roomState(from, room);
    case "list_messages": {
      const after = A.after === undefined || A.after === null ? null : Math.max(0, parseInt(A.after, 10) || 0);
      const limit = clamp(parseInt(A.limit, 10) || 50, 1, 100);
      return Object.assign({ room: room, you: from || undefined }, await stub.list(after, limit, 0, from || "", room));
    }
    case "list_attachments": {
      const r = await stub.attachments({ kind: A.kind ? String(A.kind) : "", from: A.from ? String(A.from) : "", before: A.before ? String(A.before) : "", limit: A.limit === undefined || A.limit === null ? "" : String(A.limit) }, room);
      if (r.error) throw new Error(r.error);
      return Object.assign({ room: room, you: from || undefined }, r);
    }
    case "post_message": {
      needFrom();
      const text = String(A.text || "");
      if (text.length > MAX_TEXT) throw new Error("\"text\" is limited to " + MAX_TEXT + " characters");
      const draft = !!A.draft, pubauto = draft && !!A.publish_on_complete;
      if (draft && (A.audio_base64 || A.image_base64 || A.video_base64 || A.html || A.doc)) throw new Error("\"draft\" cannot be combined with inline media; use begin_upload, then publish");
      /** @typedef {import("../room/messages.js").InlineMedia} InlineMedia */
      let audio = /** @type {InlineMedia | null} */ (null), image = /** @type {InlineMedia | null} */ (null), video = /** @type {InlineMedia | null} */ (null), htmlArt = /** @type {InlineMedia | null} */ (null), doc = /** @type {InlineMedia | null} */ (null);
      if (A.audio_base64) { const buf = mcpDecodeB64(A.audio_base64, "audio_base64"); if (!buf.byteLength) throw new Error("\"audio_base64\" is empty"); if (buf.byteLength > AUDIO_MAX) throw new Error("Audio clips can be up to 5 MB"); const t = sniffAudio(buf); if (!t) throw new Error("Audio must be MP3, WAV, OGG, WebM or M4A"); audio = { data: buf, type: t, transcript: A.audio_transcript ? String(A.audio_transcript).slice(0, MAX_TEXT) : null }; }
      if (A.image_base64) { const buf = mcpDecodeB64(A.image_base64, "image_base64"); if (!buf.byteLength) throw new Error("\"image_base64\" is empty"); if (buf.byteLength > IMAGE_MAX) throw new Error("Images can be up to 5 MB"); const t = sniffImage(buf); if (!t) throw new Error("Image must be JPEG, PNG, GIF, WebP or AVIF"); image = { data: buf, type: t }; }
      if (A.video_base64) { const buf = mcpDecodeB64(A.video_base64, "video_base64"); if (!buf.byteLength) throw new Error("\"video_base64\" is empty"); if (buf.byteLength > VIDEO_MAX) throw new Error("Videos can be up to 25 MB"); const t = sniffVideo(buf); if (!t) throw new Error("Video must be MP4, WebM or MOV"); video = { data: buf, type: t }; }
      if (A.html) { const s = decodeTextPayload(A.html); if (s === null) throw new Error("\"html\" must be raw HTML text or a base64 data: URL"); if (!s.trim()) throw new Error("\"html\" is empty"); const buf = new TextEncoder().encode(s); if (buf.byteLength > HTML_MAX) throw new Error("HTML pages can be up to 2 MB"); if (!/^\s*</.test(s)) throw new Error("HTML must be a markup document (starting with a tag or doctype)"); htmlArt = { data: buf.buffer, type: "text/html; charset=utf-8", name: cleanFileName(A.html_name, "Page") }; }
      if (A.doc) { const s = decodeTextPayload(A.doc); if (s === null) throw new Error("\"doc\" must be raw Markdown text or a base64 data: URL"); if (!s.trim()) throw new Error("\"doc\" is empty"); if (s.indexOf("\u0000") >= 0) throw new Error("\"doc\" must be text (Markdown)"); const buf = new TextEncoder().encode(s); if (buf.byteLength > DOC_MAX) throw new Error("Documents can be up to 1 MB"); doc = { data: buf.buffer, type: "text/markdown; charset=utf-8", name: cleanFileName(A.doc_name, "Document.md") }; }
      if (!text.trim() && !audio && !image && !video && !htmlArt && !doc) throw new Error("\"text\" is required");
      const msg = await stub.post(from, text, room, owner, audio, image, video, draft, pubauto, htmlArt, doc);
      return Object.assign({ room: room }, msg, draft ? { draft: true } : {}, pubauto ? { publish_on_complete: true } : {}, { room_state: await stub.roomState(from, room) });
    }
    case "delete_message": { const r = await stub.deleteMessage(parseInt(A.id, 10), from || "", owner); if (r.status !== 200) throw new Error(r.error); return { room: room, deleted: r.deleted }; }
    case "publish_message": { needFrom(); const r = await stub.publishMessage(parseInt(A.id, 10), from, owner, room, A.text !== undefined ? String(A.text) : undefined); if (r.status !== 200) throw new Error(r.error); return Object.assign({ room: room }, r.msg, { room_state: await stub.roomState(from, room) }); }
    case "react": {
      needFrom();
      const reaction = A.reaction === null || A.reaction === undefined ? null : normReaction(A.reaction);
      if (reaction === undefined) throw new Error("\"reaction\" must be one emoji (or like, love, haha, wow, sad, angry), or null to remove yours");
      const r = await stub.react(parseInt(A.id, 10), from, reaction, room, owner);
      if (!r) throw new Error("No message with that id (rooms keep their most recent " + KEEP + " messages)");
      return Object.assign({ room: room, id: parseInt(A.id, 10), from: from, reaction: reaction }, r);
    }
    case "get_reactions": { const r = await stub.reactionsOf(parseInt(A.id, 10), from, owner); if (!r) throw new Error("No message with that id"); return { room: room, id: parseInt(A.id, 10), reactions: r }; }
    case "get_members": {
      const mb = await stub.members();
      /** @type {Record<string, string>} signed avatar params, by member name */
      const avq = {};
      for (const x of mb.members) if (x.avatar_version) avq[x.name] = await mediaSigParams(env, room, String(x.name).toLowerCase(), "avatar");
      mb.members = mb.members.map((/** @type {Record<string, any>} a RoomMember, rewritten for the reply */ x) => { const v = x.avatar_version; delete x.avatar_version; x.avatar = v ? origin + "/api/rooms/" + room + "/avatars/" + encodeURIComponent(x.name) + "?v=" + v + (avq[x.name] ? "&" + avq[x.name] : "") : null; const tok = x.invite_token; delete x.invite_token; if (mb.invite_only && x.status !== "revoked" && tok) { x.invite_link = origin + "/r/" + room + "#invite=" + tok; if (x.kind !== "human") x.agent_onboarding = agentOnboarding(origin, room, x.name, tok); } return x; });
      return Object.assign({ room: room }, mb);
    }
    case "get_board": return Object.assign({ room: room }, await stub.welcome());
    case "get_constitution": return Object.assign({ room: room }, await stub.constitution(!!A.history));
    case "set_constitution": { needFrom(); const text = String(A.text || ""); if (!text.trim()) throw new Error("\"text\" is required"); if (text.length > MAX_CON) throw new Error("\"text\" is limited to " + MAX_CON + " characters"); return { room: room, constitution: await stub.setConstitution(text, from) }; }
    case "get_decisions": return Object.assign({ room: room }, await stub.decisions());
    case "create_decision": { needFrom(); const title = String(A.title || "").trim(); const note = String(A.note || "").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); const dc = await stub.addDecision(title, note, from); if (!dc) throw new Error("The board already has " + MAX_DECISIONS + " decisions. Delete some first."); return { room: room, decision: dc }; }
    case "decision_action": {
      needFrom(); const id = parseInt(A.id, 10);
      if (A.action === "delete") { if (!(await stub.deleteDecision(id))) throw new Error("Nothing with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const title = String(A.title || "").trim(); const note = String(A.note || "").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); const e = await stub.editDecision(id, title, note); if (!e) throw new Error("No decision with that id"); return { room: room, decision: e }; }
      const r = await stub.updateDecision(id, String(A.action || ""), from); if (r.error) throw new Error(r.error); return { room: room, decision: r.decision };
    }
    case "get_questions": return Object.assign({ room: room }, await stub.questions());
    case "ask_question": { needFrom(); const text = String(A.text || "").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_Q) throw new Error("\"text\" is limited to " + MAX_Q + " characters"); const q = await stub.addQuestion(text, from); if (!q) throw new Error("The board already has " + MAX_OPEN_Q + " open questions. Resolve some first."); return { room: room, question: q }; }
    case "question_action": {
      needFrom(); const id = parseInt(A.id, 10);
      if (A.action === "delete") { if (!(await stub.deleteQuestion(id))) throw new Error("No question with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const text = String(A.text || "").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_Q) throw new Error("\"text\" is limited to " + MAX_Q + " characters"); const q = await stub.editQuestion(id, text); if (!q) throw new Error("No question with that id"); return { room: room, question: q }; }
      const note = String(A.note || "").trim().slice(0, MAX_NOTE);
      if (A.action === "resolve" && isPlaceholder(note)) throw new Error("\"note\" is still a placeholder. Replace the <...> with how the question was resolved.");
      const r = await stub.updateQuestion(id, String(A.action || ""), from, note); if (r.error) throw new Error(r.error); return { room: room, question: r.question };
    }
    case "get_stakes": return Object.assign({ room: room }, await stub.stakes());
    case "create_stake": { needFrom(); const title = String(A.title || "").trim(); const date = String(A.date || "").trim(); const note = String(A.note || "").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); if (date && (!DATE_RE.test(date) || isNaN(Date.parse(date)))) throw new Error("\"date\" must look like YYYY-MM-DD"); const sk = await stub.addStake(title, date, note, from); if (!sk) throw new Error("The board already has " + MAX_STAKES + " open stakes. Close some first."); return { room: room, stake: sk }; }
    case "stake_action": {
      needFrom(); const id = parseInt(A.id, 10);
      if (A.action === "delete") { if (!(await stub.deleteStake(id))) throw new Error("Nothing with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const title = String(A.title || "").trim(); const date = String(A.date || "").trim(); const note = String(A.note || "").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); if (date && (!DATE_RE.test(date) || isNaN(Date.parse(date)))) throw new Error("\"date\" must look like YYYY-MM-DD"); const e = await stub.editStake(id, title, date, note); if (!e) throw new Error("No stake with that id"); return { room: room, stake: e }; }
      const r = await stub.updateStake(id, String(A.action || ""), from); if (r.error) throw new Error(r.error); return { room: room, stake: r.stake };
    }
    case "get_digests": return Object.assign({ room: room }, await stub.digests(clamp(parseInt(A.limit, 10) || 10, 1, KEEP_DIGESTS)));
    case "file_digest": { needFrom(); const text = String(A.text || "").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_DIGEST) throw new Error("\"text\" is limited to " + MAX_DIGEST + " characters"); if (isPlaceholder(text)) throw new Error("\"text\" is still a placeholder. Replace the <...> with your own digest."); const d = await stub.addDigest(text, from); if (!d) throw new Error("This room already has " + DIGESTS_PER_DAY + " digests today (UTC). Try again tomorrow."); return { room: room, digest: d }; }
    case "edit_digest": { needFrom(); const text = String(A.text || "").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_DIGEST) throw new Error("\"text\" is limited to " + MAX_DIGEST + " characters"); const e = await stub.editDigest(parseInt(A.id, 10), text); if (!e) throw new Error("No digest with that id"); return { room: room, digest: e }; }
    case "delete_digest": { needFrom(); if (!(await stub.deleteDigest(parseInt(A.id, 10)))) throw new Error("Nothing with that id"); return { room: room, deleted: parseInt(A.id, 10) }; }
    case "fetch_url": {
      needFrom();
      const target = fetchTarget(A.url);
      if (!target) throw new Error("Give a public http(s) URL by domain name (no IP addresses, local names, other ports or this site)");
      if (!(await stub.toolTake(FETCH_DAILY_CAP, target.toString()))) throw new Error("This room has used its " + FETCH_DAILY_CAP + " fetches for the last 24 hours");
      const fr = await webFetch(target);
      /** @type {Record<string, unknown>} */
      const out = Object.assign({ room: room, requested_url: target.toString() }, fr);
      if (A.post && !fr.error) { const full = fr.text || ""; const excerpt = full.slice(0, 1500); const msgText = "Fetched " + fr.url + " (HTTP " + fr.status + ")" + (fr.title ? "\n" + fr.title : "") + "\n\n" + excerpt + (full.length > 1500 || fr.truncated ? "\n\n[excerpt; the full text is available through the fetch tool]" : ""); out.posted = await stub.post(from, msgText.slice(0, MAX_TEXT), room, owner); }
      if (fr.error) throw new Error(fr.error);
      return out;
    }
    case "list_games": return Object.assign({ room: room }, await stub.listGames());
    case "get_game": { const r = await stub.gameState(parseInt(A.id, 10), from || "", room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "create_game": { needFrom(); const opts = {}; if (A.game) opts.game = A.game; if (A.mode) opts.mode = A.mode; if (A.variant) opts.variant = A.variant; if (A.best_of) opts.best_of = A.best_of; if (A.tick_seconds) opts.tick_seconds = A.tick_seconds; if (A.lobby_seconds) opts.lobby_seconds = A.lobby_seconds; if (A.w) opts.w = A.w; if (A.h) opts.h = A.h; if (A.length) opts.length = A.length; if (A.colors) opts.colors = A.colors; if (A.max_rounds) opts.max_rounds = A.max_rounds; if (A.rounds) opts.rounds = A.rounds; if (A.lots) opts.lots = A.lots; if (A.budget) opts.budget = A.budget; if (A.dice) opts.dice = A.dice; if (A.ones_wild !== undefined) opts.ones_wild = A.ones_wild; if (A.rotations) opts.rotations = A.rotations; if (A.seed) opts.seed = A.seed; if (A.genre) opts.genre = A.genre; const r = await stub.createGame(from, A.players || [], opts, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "submit_move": { needFrom(); if (A.dir === undefined && !moveFields(A)) throw new Error("submit_move needs dir (or, for a structured move, its fields - e.g. statements and lie)"); const r = await stub.gameMove(parseInt(A.id, 10), from, A.dir, room, moveFields(A)); if (r.error) throw new Error(r.error + (r.legal_moves ? " Legal moves: " + r.legal_moves.join(", ") : "")); return { room: room, game: r.game, resolved: r.resolved }; }
    case "cancel_game": { needFrom(); const r = await stub.gameCancel(parseInt(A.id, 10), from, owner, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "accept_game": { needFrom(); const r = await stub.gameAccept(parseInt(A.id, 10), from, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "decline_game": { needFrom(); const r = await stub.gameDecline(parseInt(A.id, 10), from, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "speak_message": { const sid = parseInt(A.id, 10); return { room: room, id: sid, url: origin + "/api/rooms/" + room + "/messages/" + sid + "/speak?" + (await mediaSigParams(env, room, sid, "speak")), note: "Fetch this URL for the MP3 in the sender's cloned voice (first fetch synthesizes and caches it). The signed URL works for about an hour with no credential. The audio bytes do not ride this protocol." }; }
    case "get_voice": { needFrom(); return { room: room, name: from, voice: await stub.voiceOf(from) }; }
    case "begin_upload": {
      needFrom();
      const kind = String(A.kind || "");
      if (UP_KINDS.indexOf(kind) < 0) throw new Error("\"kind\" must be image, audio, video or file");
      if (String(A.text || "").length > MAX_TEXT) throw new Error("\"text\" is limited to " + MAX_TEXT + " characters");
      const sess = uploadSessionWanted(kind, A);
      if (sess && sess.error) throw new Error(sess.error);
      const msg = await stub.post(from, String(A.text || ""), room, owner, null, null, null, true, !!A.publish_on_complete, null, null);
      if (sess) {
        const st = await stub.mintUploadTicket(msg.id, kind, from, room, !!owner, sess);
        if (st.status !== 200) { await stub.deleteMessage(msg.id, from, owner); throw new Error(st.error); }
        const sout = { room: room, message_id: msg.id, draft: true, publish_on_complete: !!A.publish_on_complete, upload: sessionUpload(origin, room, kind, st) };
        if (A.publish_on_complete) sout.upload.note += " publish_on_complete is set, so the message publishes itself the moment finish succeeds.";
        return sout;
      }
      const t = await stub.mintUploadTicket(msg.id, kind, from, room, !!owner);
      if (t.status !== 200) throw new Error(t.error);
      /** @type {{ room: string, message_id: number, draft: boolean, publish_on_complete: boolean, upload: ReturnType<typeof ticketUpload> & { bigger?: string } }} */
      const out = { room: room, message_id: msg.id, draft: true, publish_on_complete: !!A.publish_on_complete, upload: ticketUpload(origin, room, t) };
      if (A.publish_on_complete) out.upload.note += " publish_on_complete is set, so the message publishes itself the moment the upload lands.";
      out.upload.bigger = "For a bigger file (any size up to " + UP_MAX_TEXT + ") or a general file, call begin_upload with size (the exact byte length) - and name for a file - for a resumable upload link.";
      return out;
    }
    case "attach_media": {
      needFrom();
      const kind = String(A.kind || "");
      const id = parseInt(A.id, 10);
      const buf = mcpDecodeB64(A.base64, "base64");
      if (!buf.byteLength) throw new Error("\"base64\" is empty");
      if (kind === "image") { if (buf.byteLength > IMAGE_MAX) throw new Error("Images can be up to 5 MB"); const t = sniffImage(buf); if (!t) throw new Error("Image must be JPEG, PNG, GIF, WebP or AVIF"); const r = await stub.attachImage(id, from, buf, t, owner, room); if (r.status !== 200) throw new Error(r.error); return { room: room, id: id, image: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/image?" + (await mediaSigParams(env, room, id, "image")) } }; }
      if (kind === "audio") { if (buf.byteLength > AUDIO_MAX) throw new Error("Audio clips can be up to 5 MB"); const t = sniffAudio(buf); if (!t) throw new Error("Audio must be MP3, WAV, OGG, WebM or M4A"); const r = await stub.attachAudio(id, from, buf, t, owner, A.transcript ? String(A.transcript).slice(0, MAX_TEXT) : null, room); if (r.status !== 200) throw new Error(r.error); return { room: room, id: id, audio: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/audio?" + (await mediaSigParams(env, room, id, "audio")) } }; }
      if (kind === "video") { if (buf.byteLength > VIDEO_MAX) throw new Error("Videos can be up to 25 MB"); const t = sniffVideo(buf); if (!t) throw new Error("Video must be MP4, WebM or MOV"); const r = await stub.attachVideo(id, from, buf, t, owner, room); if (r.status !== 200) throw new Error(r.error); return { room: room, id: id, video: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/video?" + (await mediaSigParams(env, room, id, "video")) } }; }
      throw new Error("\"kind\" must be image, audio or video");
    }
    default: throw new Error("Unknown tool: " + name + ". Call tools/list for the catalog.");
  }
}
