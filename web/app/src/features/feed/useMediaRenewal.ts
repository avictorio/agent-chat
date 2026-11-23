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
// A forward read comes back in delivery order, not id order (a draft
// published late, or a message sent again when its media landed, comes
// after higher ids), so the re-read follows the server's cursor until it
// has seen every wanted row or reached the newest message. This only
// stops a runaway.
const MAX_PAGES = 10;
// A page asked for one row may still have to step past the rows
// delivered between that row's id and its delivery number.
const MIN_PAGE = 50;

function hasMedia(m: Message): boolean {
  return MEDIA_FIELDS.some((k) => !!(m[k] && m[k]!.url));
}

export function useMediaRenewal(opts: {
  client: RoomClient;
  feed: Feed;
  deny: (e: ApiError) => void;
  deniedRef: { current: boolean };
}) {
  const live = useLatest(opts);
  const busyRef = useRef(false);
  const queueRef = useRef<{ ids: Set<number>; done: Promise<void> } | null>(null);

  // Read these rows again and hand the fresh links to the feed. A row's
  // delivery number is never below its id, so a page may start just under
  // the lowest id still wanted: what that jumps over is not wanted, and a
  // gap in the window costs no pages. Before, a page was taken to cover
  // every id up to its last row's; a row delivered late sat past that, was
  // never renewed, and the same query went out ten times.
  const reread = useCallback(
    async (ids: number[]) => {
      const { client, feed, deny, deniedRef } = live.current;
      if (deniedRef.current || !ids.length) return;
      const want = new Set(ids);
      const rows: Message[] = [];
      const covered: number[] = [];
      try {
        let cursor = 0;
        let prev = -1;
        for (let page = 0; want.size && page < MAX_PAGES; page++) {
          const sorted = [...want].sort((a, b) => a - b);
          const after = Math.max(cursor, sorted[0]! - 1);
          // no progress: the same query would bring the same page
          if (after <= prev) break;
          prev = after;
          const d = await client.messages(after, Math.min(500, Math.max(MIN_PAGE, sorted[sorted.length - 1]! - after)));
          for (const m of d.messages || []) {
            if (!want.delete(m.id)) continue;
            rows.push(m);
            covered.push(m.id);
          }
          // The newest message was reached: a row still wanted is no longer
          // live, and asking again every minute would not change that.
          if (!d.has_more) {
            covered.push(...want);
            break;
          }
          cursor = d.last_id;
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

  const renewStale = useCallback(async () => {
    const { feed, deniedRef } = live.current;
    if (busyRef.current || deniedRef.current || document.hidden || feed.lastRef.current === null) return;
    const cut = Date.now() - RENEW_AFTER;
    const at = feed.linksAtRef.current;
    const stale = feed.messagesRef.current.filter((m) => hasMedia(m) && (at.get(m.id) ?? 0) < cut).map((m) => m.id);
    if (!stale.length) return;
    busyRef.current = true;
    try {
      await reread(stale);
    } finally {
      busyRef.current = false;
    }
  }, [live, reread]);

  // A failed load asks for its row's links. Failures that come together
  // (every image on screen after a long sleep) share one re-read.
  const renewMedia = useCallback(
    (id: number): Promise<void> => {
      let q = queueRef.current;
      if (!q) {
        const ids = new Set<number>();
        q = {
          ids,
          done: new Promise<void>((resolve) => {
            window.setTimeout(() => {
              queueRef.current = null;
              void reread([...ids]).finally(resolve);
            }, 50);
          }),
        };
        queueRef.current = q;
      }
      q.ids.add(id);
      return q.done;
    },
    [reread]
  );

  useEffect(() => {
    const check = () => void renewStale();
    const timer = window.setInterval(check, CHECK_EVERY);
    const onVisible = () => {
      if (!document.hidden) check();
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
