import { useCallback, useEffect, useRef } from "react";
import { ApiError, type Message, type RoomClient } from "@chat/contract";
import { useLatest } from "../../lib/useLatest";
import { MEDIA_FIELDS, type useMessages } from "./useMessages";

// Keeps the feed's signed media links alive in a tab left open.
//
// A link is signed on an hour grid and dies one to two hours after it is
// minted (mediaQuery in worker/lib/media.ts). The feed gets each row once,
// at boot or from a stream frame, and a reconnect resumes after the last
// delivery number, so old rows never came again: an afternoon later the
// lazy images were broken, clips would not play and documents and
// downloads answered 403 until a reload. Once any row's links are older
// than RENEW_AFTER - before any of them can have died - this reads it
// again by id with every row past BATCH_AFTER and swaps only their media
// fields in. Timers barely run in a hidden tab, so the check also runs
// when the tab comes back into view, when the browser comes back online
// and when the room's stream reopens. A media element that fails to load
// asks for its own row (renewMedia) and retries once.

type Feed = ReturnType<typeof useMessages>;

// A link lives at least an hour; renewing at 50 minutes leaves ten to
// spare. Measured from when this tab got the link, not from its exp, so a
// device clock that is off does not matter.
const RENEW_AFTER = 50 * 60e3;
// When one row is due, every row whose link is past this goes with it.
// Each row has its own time, so in a room with steady media a few more
// crossed RENEW_AFTER every minute and each minute began another re-read:
// up to sixty reads an hour per open tab. Taking the younger ones along
// spaces renewals about twenty minutes apart.
const BATCH_AFTER = 30 * 60e3;
// The longest wait after failed reads. It was RENEW_AFTER: after an hour's
// outage in which the browser still said "online" (the server down, a
// captive wifi), links the server could renew stayed dead for up to fifty
// minutes once it was back. Images and clips ask again by themselves, but
// a download card or a page preview does not.
const HOLD_MAX = 10 * 60e3;
const CHECK_EVERY = 60e3;
// The most ids one read by id takes (MESSAGES_IDS_MAX in worker/limits.ts).
const IDS_MAX = 100;

function hasMedia(m: Message): boolean {
  return MEDIA_FIELDS.some((k) => !!(m[k] && m[k]!.url));
}

type Walk = { ids: Set<number>; done: Promise<void> };

export function useMediaRenewal(opts: {
  client: RoomClient;
  feed: Feed;
  deny: (e: ApiError) => void;
  deniedRef: { current: boolean };
}) {
  const live = useLatest(opts);
  // The re-read under way, and the one queued behind it. One at a time: a
  // failed image used to start its own read of the same rows while the
  // minute's renewal was still reading them.
  const runRef = useRef<Walk | null>(null);
  const nextRef = useRef<Walk | null>(null);
  // After a failed re-read the minute's check waits, twice as long after
  // each failure in a row, up to HOLD_MAX; a re-read that gets through
  // clears it. With the network down every check failed at its first read
  // and the next went out a minute later, for as long as the tab was open.
  // A failed image's own retry (renewMedia) is not held.
  const holdRef = useRef({ until: 0, wait: 0 });

  // Read these rows again by id (GET /messages?ids=), IDS_MAX at a time,
  // one read after another, and hand the fresh links to the feed. A wanted
  // id the answer leaves out is no longer live (deleted, or trimmed from
  // the room) and counts as covered: asking for it again every minute would
  // not change that. Before reads by id, the renewal read the latest page
  // and walked forward page by page for rows delivered late, and a row
  // further on than its walk went was held unread for an hour at a time.
  const reread = useCallback(
    async (ids: number[]) => {
      const { client, feed, deny, deniedRef } = live.current;
      if (deniedRef.current || !ids.length) return;
      const want = [...new Set(ids)].sort((a, b) => a - b);
      const rows: Message[] = [];
      const covered: number[] = [];
      try {
        for (let i = 0; i < want.length; i += IDS_MAX) {
          const chunk = want.slice(i, i + IDS_MAX);
          const d = await client.messagesByIds(chunk);
          rows.push(...(d.messages || []));
          covered.push(...chunk);
        }
        holdRef.current = { until: 0, wait: 0 };
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) deny(e);
        // a network error: what was read still lands; the rest is asked
        // for again once the hold is over
        const wait = Math.min(HOLD_MAX, holdRef.current.wait * 2 || CHECK_EVERY * 2);
        holdRef.current = { until: Date.now() + wait, wait };
      }
      feed.renewLinks(rows, covered);
    },
    [live]
  );

  // Ask for these rows. Ids the re-read under way already covers join it;
  // the rest queue behind it, together with whatever else is asked for
  // meanwhile (failures that come together, every image on screen after a
  // long sleep, share one re-read).
  const ask = useCallback(
    (ids: number[]): Promise<void> => {
      const cur = runRef.current;
      const rest = ids.filter((id) => !cur || !cur.ids.has(id));
      if (!rest.length && cur) return cur.done;
      let q = nextRef.current;
      if (!q) {
        const walk: Walk = { ids: new Set(), done: Promise.resolve() };
        walk.done = (async () => {
          await new Promise((r) => window.setTimeout(r, 50));
          while (runRef.current) await runRef.current.done;
          nextRef.current = null;
          runRef.current = walk;
          try {
            await reread([...walk.ids]);
          } finally {
            runRef.current = null;
          }
        })();
        nextRef.current = walk;
        q = walk;
      }
      for (const id of rest) q.ids.add(id);
      return q.done;
    },
    [reread]
  );

  const renewStale = useCallback(() => {
    const { feed, deniedRef } = live.current;
    if (runRef.current || nextRef.current || deniedRef.current || document.hidden || feed.lastRef.current === null) return;
    // the browser knows it is offline: the online event runs the check
    if (navigator.onLine === false || Date.now() < holdRef.current.until) return;
    const now = Date.now();
    const at = feed.linksAtRef.current;
    const media = feed.messagesRef.current.filter(hasMedia);
    if (!media.some((m) => (at.get(m.id) ?? 0) < now - RENEW_AFTER)) return;
    void ask(media.filter((m) => (at.get(m.id) ?? 0) < now - BATCH_AFTER).map((m) => m.id));
  }, [live, ask]);

  // A failed load asks for its row's links.
  const renewMedia = useCallback((id: number): Promise<void> => ask([id]), [ask]);

  useEffect(() => {
    const timer = window.setInterval(renewStale, CHECK_EVERY);
    const onVisible = () => {
      if (!document.hidden) renewStale();
    };
    // back online, or the stream reopened: a hold from reads that failed
    // while it was down is over
    const onOnline = () => {
      holdRef.current.until = 0;
      renewStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("online", onOnline);
    // The room's stream opened again (useRoomStream): the server answers,
    // so a hold from reads that failed while it was out of reach is over
    // too. The browser fires no online event when it never thought it was
    // offline (the server down, a captive wifi), and links stayed dead for
    // up to HOLD_MAX after the room was back. Every open ends the hold,
    // also on a stream that flaps while reads still fail: an open cannot
    // tell "still down" from "back", and letting only the first open of
    // a hold end it left links dead for the rest of that hold once the
    // room was back. The cost is one renewal read per reconnect.
    window.addEventListener("ac-stream-open", onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("ac-stream-open", onOnline);
    };
  }, [renewStale]);

  return { renewMedia };
}
