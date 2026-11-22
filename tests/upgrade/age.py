# The schema upgrade test (run.sh): make room upg-aged look like a room an
# older deploy left - drop columns added since, bring back the retired
# inv.avatar, clear the schema version.
import sqlite3, glob, sys
state = sys.argv[1]
found = None
for f in glob.glob(state + '/**/*.sqlite', recursive=True):
    try:
        c = sqlite3.connect(f)
        if c.execute("SELECT 1 FROM m WHERE text = 'hello from the old code in upg-aged'").fetchall(): found = f
        c.close()
    except Exception:
        pass
if not found:
    print('the upg-aged room was not found in', state); sys.exit(1)
c = sqlite3.connect(found)
dropped = 0
for t, col in [('m', 'game_id'), ('m', 'file_name'), ('m', 'pub_ts'), ('md', 'mode'), ('md', 'began'), ('push', 'mode'), ('ut', 'sess'), ('inv', 'invited_by'), ('inv', 'posted')]:
    # an older OLD_REF may not have the column at all
    if col in [r[1] for r in c.execute("PRAGMA table_info(" + t + ")")]:
        c.execute("ALTER TABLE " + t + " DROP COLUMN " + col)
        dropped += 1
if 'avatar' not in [r[1] for r in c.execute("PRAGMA table_info(inv)")]:
    c.execute("ALTER TABLE inv ADD COLUMN avatar BLOB")
c.execute("DELETE FROM cfg WHERE k = 'schema_version'")
c.commit()
print('aged', found.split('/')[-1], '- dropped', dropped, 'columns, inv.avatar back')
c.close()
