# The schema upgrade test (run.sh): every room in the local state reached the
# latest schema version, with the columns (the mdel and pcid tables, dg.updated, inv.left_ts) the aged room had lost, the
# retired inv.avatar gone, inv.posted backfilled and the results table (gr,
# step 6) holding one row for each ended match; and the holders of its Muse
# hooks (mhh, step 10): WakeA's hook, which OLD_REF's code set, held by
# exactly "pre" in upg-full, and in upg-aged, where WakeA registered again
# with its own token on another link, by exactly "self" after step 10 ran a
# second time there (a backfill that gave "pre" to a hook held already would
# add it); no row left for WakeB, whose hook the key's disconnect turned
# off, and no row for a member without a Muse hook.
import sqlite3, glob, sys, re, os
ROOM_TS = os.path.join(os.path.dirname(__file__), '..', '..', 'worker', 'room', 'Room.ts')
# the latest version is the number of entries in SCHEMA_STEPS
steps = re.search(r'const SCHEMA_STEPS\b.*?= \[([^\]]*)\];', open(ROOM_TS).read()).group(1)
LATEST = str(len([x for x in steps.split(',') if x.strip()]))
state = sys.argv[1]
want = {'m': ['game_id', 'file_name', 'pub_ts', 'draft', 'seq'], 'md': ['mode', 'began'], 'push': ['mode', 'fails', 'fail_ts', 'rest_ts'], 'ut': ['sess'], 'inv': ['invited_by', 'posted', 'avatar_key', 'left_ts'], 'mdel': ['dn', 'id', 'ts', 'who'], 'pcid': ['sender', 'cid', 'msg', 'ts', 'draft'], 'dg': ['updated'], 'gr': ['id', 'type', 'status', 'ended', 'winner', 'winners', 'draw', 'places', 'players', 'pair', 'pub']}
bad = 0
for f in glob.glob(state + '/**/*.sqlite', recursive=True):
    c = sqlite3.connect(f)
    try:
        rn = c.execute("SELECT text FROM m WHERE text LIKE 'hello from the old code in %'").fetchall()
    except Exception:
        continue
    room = rn[0][0].split(' in ')[-1] if rn else '?'
    ver = c.execute("SELECT v FROM cfg WHERE k = 'schema_version'").fetchall()
    cols = {t: [r[1] for r in c.execute("PRAGMA table_info(" + t + ")")] for t in want}
    missing = [t + '.' + col for t, cs in want.items() for col in cs if col not in cols[t]]
    avatar = 'avatar' in cols['inv']
    posted = c.execute("SELECT name, posted FROM inv ORDER BY name").fetchall()
    ended = c.execute("SELECT COUNT(*) FROM gm WHERE status NOT IN ('lobby', 'running')").fetchone()[0]
    results = c.execute("SELECT COUNT(*) FROM gr").fetchone()[0] if 'id' in cols['gr'] else None
    print(room, 'schema_version', ver[0][0] if ver else None, 'missing', missing, 'inv.avatar', avatar, 'posted', posted, 'ended matches', ended, 'results', results)
    if not ver or ver[0][0] != LATEST or missing or avatar or any(p is None for _, p in posted) or results != ended: bad += 1
    has_mhh = bool(c.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mhh'").fetchall())
    holders = sorted(c.execute("SELECT member, holder FROM mhh").fetchall()) if has_mhh else None
    orphans = c.execute("SELECT COUNT(*) FROM mhh WHERE member NOT IN (SELECT member FROM mh WHERE kind = 'muse')").fetchone()[0] if has_mhh else None
    print(room, 'mhh', has_mhh, 'holders', holders, 'rows of no Muse hook', orphans)
    want_holders = [('wakea', 'self')] if room == 'upg-aged' else [('wakea', 'pre')]
    if not has_mhh or holders != want_holders or orphans != 0: bad += 1
print('INSPECT: latest version', LATEST, '-', 'ok' if not bad else str(bad) + ' room(s) wrong')
sys.exit(1 if bad else 0)
