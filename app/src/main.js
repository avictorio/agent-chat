import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Uploader } from "@capgo/capacitor-uploader";
import { PushNotifications } from "@capacitor/push-notifications";
import { SPIKE } from "./spike-config.js";

const logEl = document.getElementById("log");
let logs = [];
try { logs = JSON.parse(localStorage.getItem("spike-log") || "[]"); } catch (e) {}
function render() { logEl.textContent = logs.join("\n"); }
function log(msg) {
  logs.push(new Date().toLocaleTimeString() + "  " + msg);
  if (logs.length > 300) logs = logs.slice(-300);
  try { localStorage.setItem("spike-log", JSON.stringify(logs)); } catch (e) {}
  render();
}
render();

document.getElementById("env").textContent =
  "Platform: " + Capacitor.getPlatform() +
  " · native shell: " + Capacitor.isNativePlatform() +
  " · Uploader: " + (Capacitor.isPluginAvailable("Uploader") ? "available" : "MISSING") +
  " · Filesystem: " + (Capacitor.isPluginAvailable("Filesystem") ? "available" : "MISSING") +
  " · PushNotifications: " + (Capacitor.isPluginAvailable("PushNotifications") ? "available" : "MISSING");

document.getElementById("clearLog").onclick = () => { logs = []; try { localStorage.removeItem("spike-log"); } catch (e) {} render(); };

// One entry point (owner plan, Nov 6): the site home IS the app's home.
// This bundled page only forwards there, and stays behind as the
// Phase 0 diagnostics bench when the owner taps to stay.
let stayDiag = false;
const goHome = () => { if (!stayDiag) location.replace("https://chat.victorio.cloud/"); };
const diagTimer = setTimeout(goHome, 900);
const stayBtn = document.getElementById("stayDiag");
if (stayBtn) stayBtn.onclick = () => {
  stayDiag = true; clearTimeout(diagTimer);
  document.getElementById("diag").hidden = false;
  stayBtn.hidden = true;
  log("diagnostics open; auto-forward cancelled");
};
}
function forgetRoom(room) { saveRooms(loadRooms().filter((x) => x.room !== room)); renderRooms(); }
function enterRoom(room, token) { location.href = "https://chat.victorio.cloud/r/" + room + "#invite=" + token; }
function renderRooms() {
  const box = document.getElementById("rooms");
  if (!box) return;
  const rs = loadRooms();
  box.innerHTML = "";
  if (!rs.length) {
    box.innerHTML = '<p class="dim">No rooms yet on this device. Paste an invite link below and it will live here.</p>';
    return;
  }
  rs.forEach((r) => {
    const row = document.createElement("div"); row.className = "room-row";
    const b = document.createElement("button"); b.className = "room-open"; b.textContent = r.room;
    b.onclick = () => enterRoom(r.room, r.token);
    const x = document.createElement("button"); x.className = "room-x"; x.textContent = "✕";
    x.title = "Forget this room on this device";
    x.onclick = () => forgetRoom(r.room);
    row.appendChild(b); row.appendChild(x); box.appendChild(row);
  });
}
document.getElementById("openRoom").onclick = () => {
  const v = document.getElementById("invite").value.trim();
  const tm = v.match(/invite=([A-Za-z0-9_-]+)/);
  const rm = v.match(/\/r\/([a-z0-9\-_]+)/);
  let tok = tm ? tm[1] : "";
  const room = rm ? rm[1] : SPIKE.room;
  if (!tok) {
    const saved = loadRooms().find((x) => x.room === room);
    if (saved) { enterRoom(saved.room, saved.token); return; }
    if (/^[A-Za-z0-9_-]{8,}$/.test(v)) tok = v;
  }
  if (!tok) { log("open room: no invite token found in that text, and that room is not saved on this device"); return; }
  upsertRoom(room, tok);
  enterRoom(room, tok);
};
renderRooms();

// Upload events are logged persistently - the evidence for the background test.
Uploader.addListener("events", (ev) => {
  log("event " + JSON.stringify(ev).slice(0, 320));
  if (ev.name === "completed") onUploadDone();
});

async function onUploadDone() {
  const id = localStorage.getItem("spike-msg");
  if (!id) return;
  const base = SPIKE.api + "/rooms/" + SPIKE.room;
  const H = { "X-Invite-Token": SPIKE.token, "Content-Type": "application/json" };
  try {
    const r = await fetch(base + "/messages/" + id, { headers: H });
    const m = await r.json();
    log("server check: message " + id + " video = " + JSON.stringify(m.video));
    const pr = await fetch(base + "/messages/" + id + "/publish", { method: "POST", headers: H, body: "{}" });
    log("publish: HTTP " + pr.status + " — the test message is now visible in the throwaway room");
  } catch (e) { log("server check failed: " + e); }
}

function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
  return btoa(s);
}

async function runFitTest() {
  const base = SPIKE.api + "/rooms/" + SPIKE.room;
  const H = { "X-Invite-Token": SPIKE.token, "Content-Type": "application/json" };
  log("fit test: creating draft message…");
  const mr = await fetch(base + "/messages", { method: "POST", headers: H, body: JSON.stringify({ from: SPIKE.name, text: "Background-upload fit test (Phase 0 spike)", draft: true }) });
  const msg = await mr.json();
  if (!msg.id) { log("draft failed: " + JSON.stringify(msg).slice(0, 200)); return; }
  localStorage.setItem("spike-msg", String(msg.id));
  log("draft id " + msg.id + " — building a 30 MB test video on the phone…");
  const SIZE = 30000000, CHUNK = 1000000;
  const head = new Uint8Array(CHUNK);
  head.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  for (let i = 16; i < CHUNK; i++) head[i] = i % 256;
  const headB64 = toB64(head);
  const fileName = "spike-test.mp4";
  await Filesystem.writeFile({ path: fileName, data: headB64, directory: Directory.Cache });
  for (let written = CHUNK; written < SIZE; written += CHUNK) {
    const n = Math.min(CHUNK, SIZE - written);
    await Filesystem.appendFile({ path: fileName, data: n === CHUNK ? headB64 : toB64(head.subarray(0, n)), directory: Directory.Cache });
  }
  const stat = await Filesystem.stat({ path: fileName, directory: Directory.Cache });
  log("test file ready: " + stat.size + " bytes");
  const uri = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
  const up = await Uploader.startUpload({
    filePath: uri.uri,
    serverUrl: base + "/messages/" + msg.id + "/video/stream",
    method: "PUT",
    headers: { "X-Invite-Token": SPIKE.token, "Content-Type": "video/mp4" },
    notificationTitle: "Agent Chat spike upload",
    notificationBody: "Background-upload fit test"
  });
  log("upload started (id " + up.id + ") — SWITCH APPS OR LOCK THE PHONE NOW, come back in a minute");
}
document.getElementById("runTest").onclick = () => { runFitTest().catch((e) => log("fit test error: " + e)); };

document.getElementById("pushCheck").onclick = async () => {
  try {
    PushNotifications.addListener("registration", (t) => log("push registered, token starts " + String(t.value).slice(0, 24) + "…"));
    PushNotifications.addListener("registrationError", (e) => log("push registration error (expected until Phase 2): " + JSON.stringify(e).slice(0, 200)));
    const perm = await PushNotifications.requestPermissions();
    log("push permission: " + JSON.stringify(perm));
    await PushNotifications.register();
    log("push register() called");
  } catch (e) { log("push check error: " + e); }
};
