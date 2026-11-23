import { useCallback, useEffect, useRef } from "react";
import { ApiError, type Message, type RoomClient } from "@chat/contract";
import { useLatest } from "../../lib/useLatest";
import { MEDIA_FIELDS, type useMessages } from "./useMessages";

// Keeps the feed's signed media links alive in a tab left open.
//
// A link is signed on an hour grid and dies one to two hours after it is
// minted (mediaQuery in worker/lib/media.ts). The feed gets each row once,
// at boot or from a stream frame, and a reconnect resumes after the last
// id, so old rows never came again: an afternoon later the lazy images
// were broken, clips would not play and documents and downloads answered
// 403 until a reload. This re-reads the rows whose links are older than
// RENEW_AFTER - before any of them can have died - and swaps only their
// media fields in. Timers barely run in a hidden tab, so the check also
// runs when the tab comes back into view. A media element that fails to
// load asks for its own row (renewMedia) and retries once.

type Feed = ReturnType<typeof useMessages>;

// A link lives at least an hour; renewing at 50 minutes leaves ten to
// spare. Measured from when this tab got the link, not from its exp, so a
// device clock that is off does not matter.
const RENEW_AFTER = 50 * 60e3;
const CHECK_EVERY = 60e3;
// The server's largest page.
const PAGE = 500;
// How far a forward walk goes for rows older than the newest PAGE: a row
// delivered late (a long upload in a busy room) sits past every message
// sent while it uploaded, so the walk must be able to step over them, but
// not over the whole history.
const MAX_PAGES = 4;

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
  // failed image used to start its own walk over the same pages while the
  // minute's renewal was still reading them.
  const runRef = useRef<Walk | null>(null);
  const nextRef = useRef<Walk | null>(null);
  // Rows a forward walk could not reach, and when it gave up. They are
  // walked for again only after RENEW_AFTER: before, the same ten requests
  // went out every minute for as long as the tab was open.
  const farRef = useRef<Map<number, number>>(new Map());

  // Read these rows again and hand the fresh links to the feed.
  //
  // First the latest page: the newest PAGE messages by id, which is how the
  // feed loaded them, so an ordinary renewal is this one request. A wanted
  // row at or above that page's lowest id that is not in it is no longer
  // live. Rows older than the page are found by a forward read from just
  // under the lowest of them, in delivery order: a row's delivery number is
  // never below its id, so what that skips is not wanted, and a row
  // delivered late is reached by following last_id. Before, the walk
  // always went forward, sized its pages from ids (50 rows once past the
  // highest wanted id), and a row delivered 800 messages late was never
  // reached.
  const reread = useCallback(
    async (ids: number[]) => {
      const { client, feed, deny, deniedRef } = live.current;
      if (deniedRef.current || !ids.length) return;
      const want = new Set(ids);
      const rows: Message[] = [];
      const covered: number[] = [];
      const take = (list: Message[]) => {
        for (const m of list) {
          if (!want.delete(m.id)) continue;
          rows.push(m);
          covered.push(m.id);
        }
      };
      try {
        const d = await client.messages(undefined, PAGE);
        const got = d.messages || [];
        take(got);
        const floor = got.length < PAGE ? -Infinity : Math.min(...got.map((m) => m.id));
        for (const id of [...want]) {
          if (id < floor) continue;
          want.delete(id);
          covered.push(id);
        }
        const now = Date.now();
        for (const id of [...want]) {
          if (now - (farRef.current.get(id) ?? -Infinity) >= RENEW_AFTER) continue;
          // given up on within the hour: not walked for again yet
          want.delete(id);
          covered.push(id);
        }
        let after = want.size ? Math.min(...want) - 1 : 0;
        for (let page = 0; want.size && page < MAX_PAGES; page++) {
          const f = await client.messages(after, PAGE);
          take(f.messages || []);
          // The newest message was reached: a row still wanted is no longer
          // live, and asking again every minute would not change that.
          if (!f.has_more || f.last_id <= after) {
            covered.push(...want);
            want.clear();
            break;
          }
          after = f.last_id;
        }
        // Out of pages: these sit further on than a walk goes. Their links
        // count as renewed, so the minute's check leaves them, and the walk
        // for them waits RENEW_AFTER.
        for (const id of want) {
          farRef.current.set(id, now);
          covered.push(id);
        }
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) deny(e);
        // a network error: what was read still lands; the rest is asked
        // for again at the next check
      }
      feed.renewLinks(rows, covered);
    },
    [live]
  );

  // Ask for these rows. Ids the walk under way already covers join it;
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
    const cut = Date.now() - RENEW_AFTER;
    const at = feed.linksAtRef.current;
    const stale = feed.messagesRef.current.filter((m) => hasMedia(m) && (at.get(m.id) ?? 0) < cut).map((m) => m.id);
    if (stale.length) void ask(stale);
  }, [live, ask]);

  // A failed load asks for its row's links.
  const renewMedia = useCallback((id: number): Promise<void> => ask([id]), [ask]);

  useEffect(() => {
    const timer = window.setInterval(renewStale, CHECK_EVERY);
    const onVisible = () => {
      if (!document.hidden) renewStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [renewStale]);

  return { renewMedia };
}
