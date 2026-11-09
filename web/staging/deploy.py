#!/usr/bin/env python3
"""Deploy the staging Worker (victorio-chat-next) through the Workers
Scripts API, using the stored custom.cloudflare credential (a surrogate
here; the real token is swapped in on the approved request).

Why not wrangler: the credential lives in the connector's secure
storage and is never available as an environment variable, so deploys
ride the same approved-request path as the drift-check reads.

Flow: assemble web/staging/.build from web/app/dist (built app embedded
as text modules next to staging/worker.js), PUT the script, attach the
next.chat.victorio.cloud custom domain, done. Verify afterwards with:
  curl https://next.chat.victorio.cloud/api/build   (proxied production)
  curl https://next.chat.victorio.cloud/            (the new app shell)
"""
import json
import pathlib
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT_ID = "cb8c005173d35ee12adb292521a88eae"
ZONE_ID = "74b2143e89e0f35d799c7877cc619677"
SCRIPT = "victorio-chat-next"
HOSTNAME = "next.chat.victorio.cloud"
API = "https://api.cloudflare.com/client/v4"

HERE = pathlib.Path(__file__).resolve().parent
DIST = HERE.parent / "app" / "dist"
BUILD = HERE / ".build"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def call(request):
    add_surrogate_to_request(request, "custom.cloudflare",
                             allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
            return response.status, read_json_response(response)
    except urllib.error.HTTPError as e:
        return e.code, read_json_response(e)


def assemble():
    if not (DIST / "index.html").exists():
        raise SystemExit("app/dist missing — run `npm run build` in web/ first")
    if BUILD.exists():
        import shutil
        shutil.rmtree(BUILD)
    (BUILD / "assets").mkdir(parents=True)
    (BUILD / "worker.js").write_bytes((HERE / "worker.js").read_bytes())
    # Stamp the page with production's current build id, so the staging
    # app's update banner only fires when production deploys something
    # newer (the banner compares this stamp against /api/build, which
    # staging proxies to production). Falls back to the source stamp.
    index_html = (DIST / "index.html").read_bytes()
    try:
        out = subprocess.run(
            ["curl", "-fsS", "https://chat.victorio.cloud/api/build"],
            capture_output=True, timeout=20)
        prod_build = json.loads(out.stdout)["build"]
        index_html = index_html.replace(
            b'content="next-dev"', ('content="%s"' % prod_build).encode())
    except Exception as e:
        print("warning: could not stamp production build id:", e)
    (BUILD / "index.html").write_bytes(index_html)
    imports = []
    entries = []
    for i, asset in enumerate(sorted((DIST / "assets").iterdir())):
        part_name = "assets/" + asset.name + ".txt"
        (BUILD / part_name).write_bytes(asset.read_bytes())
        imports.append('import a%d from "./%s";' % (i, part_name))
        entries.append('"/assets/%s": a%d' % (asset.name, i))
    (BUILD / "assets-map.js").write_text(
        "\n".join(imports) + "\nexport default {\n" + ",\n".join(entries) + "\n};\n")
    files = [("worker.js", "application/javascript+module"),
             ("assets-map.js", "application/javascript+module"),
             ("index.html", "text/plain")]
    files += [("assets/" + p.name, "text/plain")
              for p in sorted((BUILD / "assets").iterdir())]
    return files


def put_script(files):
    boundary = "----chatnext" + secrets.token_hex(12)
    chunks = []
    metadata = {"main_module": "worker.js", "compatibility_date": "2025-04-01",
                "bindings": []}
    chunks.append(("--" + boundary + "\r\nContent-Disposition: form-data; "
                   "name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n"
                   + json.dumps(metadata) + "\r\n").encode())
    for name, ctype in files:
        data = (BUILD / name).read_bytes()
        head = ("--" + boundary + "\r\nContent-Disposition: form-data; name=\""
                + name + "\"; filename=\"" + name + "\"\r\nContent-Type: "
                + ctype + "\r\n\r\n").encode()
        chunks.append(head + data + b"\r\n")
    chunks.append(("--" + boundary + "--\r\n").encode())
    body = b"".join(chunks)
    req = urllib.request.Request(
        API + "/accounts/%s/workers/scripts/%s" % (ACCOUNT_ID, SCRIPT),
        data=body, method="PUT")
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    return call(req)


def put_domain():
    payload = {"hostname": HOSTNAME, "service": SCRIPT,
               "environment": "production", "zone_id": ZONE_ID}
    req = urllib.request.Request(
        API + "/accounts/%s/workers/domains" % ACCOUNT_ID,
        data=json.dumps(payload).encode(), method="PUT")
    req.add_header("Content-Type", "application/json")
    return call(req)


def main():
    files = assemble()
    print("assembled:", ", ".join(n for n, _ in files))
    status, result = put_script(files)
    print("script PUT:", status, "success:", result.get("success"))
    if not result.get("success"):
        print(json.dumps(result.get("errors"), indent=2))
        if status in (401, 403):
            print("The stored token cannot write Workers scripts.")
        return 1
    status, result = put_domain()
    print("domain PUT:", status, "success:", result.get("success"))
    if not result.get("success"):
        print(json.dumps(result.get("errors"), indent=2))
        print("Script is deployed; the hostname attach needs a token with "
              "Workers domains permission or one dashboard action.")
        return 2
    print("deployed: https://" + HOSTNAME)
    return 0


if __name__ == "__main__":
    sys.exit(main())
