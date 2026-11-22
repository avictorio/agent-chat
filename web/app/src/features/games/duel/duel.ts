import type { DuelPlayer, DuelRound, DuelState } from "@chat/contract";

/* The Duel's words and reckonings: the throws, a round's verdict, the
   score line, the streaks and the tendencies the scoreboard and the
   arena show. */

export const THROW_EMOJI: Record<string, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
export const THROW_BEATS: Record<string, string> = { rock: "crushes scissors", paper: "covers rock", scissors: "cut paper" };
const THROW_VERB: Record<string, string> = { rock: "crushes", paper: "covers", scissors: "cut" };

function capThrow(t: string): string {
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

export function roundVerdict(r: DuelRound, players: DuelPlayer[]): { tie: boolean; text: string } {
  const t0 = (r.throws || {})[players[0]!.name];
  const t1 = (r.throws || {})[players[1]!.name];
  if (!r.winner) {
    if (t0 && t0 === t1) return { tie: true, text: "CLASH · identical throws, no score" };
    return { tie: true, text: "Level · no score" };
  }
  const loser = players.filter((p: DuelPlayer) => p.name !== r.winner)[0];
  const tw = (r.throws || {})[r.winner];
  const tl = loser ? (r.throws || {})[loser.name] : null;
  if (!tw || !tl) return { tie: false, text: r.winner + " takes it by forfeit" };
  return { tie: false, text: capThrow(tw) + " " + (THROW_VERB[tw] || "beats") + " " + tl + " · " + r.winner + " takes it" };
}

// Reading the opponent is the duel's second game: per player, the
// throw mix over the match's rounds plus the clearest habit the
// record supports (switching after a loss, staying after a win).
// Lines appear only once a player has thrown at least three times.
export function duelTendencies(g: DuelState): { name: string; hex: string; line: string }[] {
  const rounds = (g.rounds || []).filter((r: DuelRound) => r.throws);
  const out: { name: string; hex: string; line: string }[] = [];
  (g.players || []).forEach((p: DuelPlayer) => {
    const counts: Record<string, number> = { rock: 0, paper: 0, scissors: 0 };
    let n = 0;
    let lossOpp = 0, lossSwitch = 0, winOpp = 0, winStay = 0;
    for (let i = 0; i < rounds.length; i++) {
      const t = rounds[i]!.throws[p.name];
      if (!t || !(t in counts)) continue;
      counts[t] = (counts[t] || 0) + 1;
      n++;
      if (i > 0) {
        const prev = rounds[i - 1]!;
        const pt = prev.throws ? prev.throws[p.name] : null;
        if (pt && prev.winner && prev.winner !== p.name) {
          lossOpp++;
          if (t !== pt) lossSwitch++;
        } else if (pt && prev.winner === p.name) {
          winOpp++;
          if (t === pt) winStay++;
        }
      }
    }
    if (n < 3) return;
    const mix = ["rock", "paper", "scissors"]
      .filter((k) => (counts[k] || 0) > 0)
      .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
      .map((k) => k + " " + Math.round(((counts[k] || 0) / n) * 100) + "%")
      .join(" · ");
    let habit = "";
    if (lossOpp >= 2 && lossSwitch === lossOpp) habit = " · always switches after a loss";
    else if (lossOpp >= 2 && lossSwitch === 0) habit = " · never switches after a loss";
    else if (winOpp >= 2 && winStay === winOpp) habit = " · always rides a win";
    else if (winOpp >= 2 && winStay === 0) habit = " · never repeats a win";
    out.push({ name: p.name, hex: p.hex, line: mix + habit });
  });
  return out;
}

// Consecutive round wins counting back from the latest round;
// a tie or a loss ends the run. Two or more is a streak worth
// showing - streaks are the room's mythology.
export function duelStreak(g: DuelState, name: string): number {
  const rounds = g.rounds || [];
  let n = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i]!.winner === name) n++;
    else break;
  }
  return n;
}

export function duelScoreLine(g: DuelState): string {
  const sc = g.score || {};
  return (g.players || []).map((p: DuelPlayer) => p.name + " " + (sc[p.name] != null ? sc[p.name] : p.wins || 0)).join(" · ");
}
