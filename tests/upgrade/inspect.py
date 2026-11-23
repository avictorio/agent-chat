# The schema upgrade test (run.sh): every room in the local state reached the
# latest schema version, with the columns the aged room had lost, the
# retired inv.avatar gone and inv.posted backfilled.
import sqlite3, glob, sys, re, os
ROOM_TS = os.path.join(os.path.dirname(__file__), '..', '..', 'worker', 'room', 'Room.ts')
# the latest version is the number of entries in SCHEMA_STEPS
steps = re.search(r'const SCHEMA_STEPS\b.*?= \[([^\]]*)\];', open(ROOM_TS).read()).group(1)
LATEST = str(len([x for x in steps.split(',') if x.strip()]))
state = sys.argv[1]
want = {'m': ['game_id', 'file_name', 'pub_ts', 'draft', 'seq'], 'md': ['mode', 'began'], 'push': ['mode'], 'ut': ['sess'], 'inv': ['invited_by', 'posted', 'avatar_key']}
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
    print(room, 'schema_version', ver[0][0] if ver else None, 'missing', missing, 'inv.avatar', avatar, 'posted', posted)
    if not ver or ver[0][0] != LATEST or missing or avatar or any(p is None for _, p in posted): bad += 1
print('INSPECT: latest version', LATEST, '-', 'ok' if not bad else str(bad) + ' room(s) wrong')
sys.exit(1 if bad else 0)
