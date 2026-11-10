#!/usr/bin/env python3
"""Emit the built web app into src/app/ as Worker text modules (M9 cutover).

The production Worker serves its pages as text modules (chat.html,
home.html). This script gives it the React build the same way: dist's
index.html lands at src/app/index.html with the dev stamp replaced by
the __BUILD_ID__ placeholder (the Worker's page() stamps the live id
over it, exactly as for the old pages), and each dist asset lands as a
.txt module indexed by src/app/assets-map.js.

Run after `npm run build` in web/. The emitted files are committed;
re-running after a rebuild refreshes them (stale hashed assets are
removed). Rollback is a git revert of the commit that carries them.
"""
import pathlib
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
DIST = HERE.parent / "app" / "dist"
OUT = HERE.parent.parent / "src" / "app"


def main():
    if not (DIST / "index.html").exists():
        raise SystemExit("app/dist missing - run `npm run build` in web/ first")
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "assets").mkdir(parents=True)

    index_html = (DIST / "index.html").read_bytes()
    assert index_html.count(b'content="next-dev"') == 1, "dev stamp not found in dist index"
    index_html = index_html.replace(b'content="next-dev"', b'content="__BUILD_ID__"')
    (OUT / "index.html").write_bytes(index_html)

    imports = []
    entries = []
    for i, asset in enumerate(sorted((DIST / "assets").iterdir())):
        part_name = "assets/" + asset.name + ".txt"
        (OUT / part_name).write_bytes(asset.read_bytes())
        imports.append('import a%d from "./%s";' % (i, part_name))
        entries.append('"/assets/%s": a%d' % (asset.name, i))
    (OUT / "assets-map.js").write_text(
        "\n".join(imports) + "\nexport default {\n" + ",\n".join(entries) + "\n};\n")
    print("emitted src/app/: index.html + %d asset(s)" % len(entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
