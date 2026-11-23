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
// 403 until a reload. Once any row's links are older than RENEW_AFTER -
// before any of them can have died - this re-reads it with every row past
// BATCH_AFTER and swaps only their media fields in. Timers barely run in a
// hidden tab, so the check also runs when the tab comes back into view,
// and when the browser comes back online. A media element that fails to
// load asks for its own row (renewMedia) and retries once.

type Feed = ReturnType<typeof useMessages>;

// A link lives at least an hour; renewing at 50 minutes leaves ten to
// spare. Measured from when this tab got the link, not from its exp, so a
// device clock that is off does not matter.
const RENEW_AFTER = 50 * 60e3;
// When one row is due, every row whose link is past this goes with it.
// Each row has its own time, so in a room with steady media a few more
// crossed RENEW_AFTER every minute and each minute began another re-read:
// up to sixty large reads an hour per open tab. Taking the younger ones
// along spaces renewals about twenty minutes apart.
const BATCH_AFTER = 30 * 60e3;
// The longest wait after failed reads. It was RENEW_AFTER: after an hour's
// outage in which the browser still said "online" (the server down, a
// captive wifi), links the server could renew stayed dead for up to fifty
// minutes once it was back. Images and clips ask again by themselves, but
// a download card or a page preview does not.
const HOLD_MAX = 10 * 60e3;
const CHECK_EVERY = 60e3;
// The server's largest page.
const PAGE = 500;
// The latest page asks for the rows the feed holds from the lowest wanted
// id up, plus this many it may not have seen (sent while the stream was
// down): a tab renewing its newest thirty rows asked for 500, and the
// server built all of them.
const SLACK = 50;
// How far a forward walk goes for rows older than the latest page: a row
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
  // An id leaves it once a page covers the row or the row leaves the feed.
  // Before, it only grew, and a row that a page had reached since was
  // still skipped, unread, when its link came due again within the hour.
  const farRef = useRef<Map<number, number>>(new Map());
  // After a failed re-read the minute's check waits, twice as long after
  // each failure in a row, up to HOLD_MAX; a re-read that gets through
  // clears it. With the network down every check failed at its first read
  // and the next went out a minute later, for as long as the tab was open.
  // A failed image's own retry (renewMedia) is not held.
  const holdRef = useRef({ until: 0, wait: 0 });

  // Read these rows again and hand the fresh links to the feed.
  //
  // First the latest page: the newest messages by id, which is how the feed
  // loaded them, as many as reach the lowest wanted row (SLACK), so an
  // ordinary renewal is this one request. A wanted row at or above that
  // page's lowest id that is not in it is no longer live. Rows older than
  // the page are found by a forward read from just under the lowest of
  // them, in delivery order: a row's delivery number is never below its
  // id, so what that skips is not wanted, and a row delivered late is
  // reached by following last_id. Before, the walk always went forward,
  // sized its pages from ids (50 rows once past the highest wanted id),
  // and a row delivered 800 messages late was never reached.
  const reread = useCallback(
    async (ids: number[]) => {
      const { client, feed, deny, deniedRef } = live.current;
      if (deniedRef.current || !ids.length) return;
      const want = new Set(ids);
      const rows: Message[] = [];
      const covered: number[] = [];
      const far = farRef.current;
      const onFeed = new Set(feed.messagesRef.current.map((m) => m.id));
      for (const id of [...far.keys()]) if (!onFeed.has(id)) far.delete(id);
      // a page reached it: renewed, or no longer live
      const reached = (id: number) => {
        want.delete(id);
        covered.push(id);
        far.delete(id);
      };
      const take = (list: Message[]) => {
        for (const m of list) {
          if (!want.has(m.id)) continue;
          rows.push(m);
          reached(m.id);
        }
      };
      try {
        const low = Math.min(...want);
        const limit = Math.min(PAGE, feed.messagesRef.current.filter((m) => m.id >= low).length + SLACK);
        const d = await client.messages(undefined, limit);
        const got = d.messages || [];
        take(got);
        // A short page is the whole room. The floor must come from the
        // limit asked for: a full page of fewer than PAGE is not the room.
        const floor = got.length < limit ? -Infinity : Math.min(...got.map((m) => m.id));
        for (const id of [...want]) if (id >= floor) reached(id);
        const now = Date.now();
        for (const id of [...want]) {
          if (now - (far.get(id) ?? -Infinity) >= RENEW_AFTER) continue;
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
            for (const id of [...want]) reached(id);
            break;
          }
          after = f.last_id;
        }
        // Out of pages: these sit further on than a walk goes. Their links
        // count as renewed, so the minute's check leaves them, and the walk
        // for them waits RENEW_AFTER.
        for (const id of want) {
          far.set(id, now);
          covered.push(id);
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
    // back online: a hold from reads that failed while it was down is over
    const onOnline = () => {
      holdRef.current.until = 0;
      renewStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [renewStale]);

  return { renewMedia };
}
