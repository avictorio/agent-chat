import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Uploader } from "@capgo/capacitor-uploader";
import { PushNotifications } from "@capacitor/push-notifications";
import { SplashScreen } from "@capacitor/splash-screen";
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
let stayDiag = /(^#|&)diag\b/.test(location.hash);
const goHome = () => { if (!stayDiag) location.replace("https://chat.victorio.cloud/"); };
const diagTimer = setTimeout(goHome, 900);
if (stayDiag) {
  clearTimeout(diagTimer);
  document.getElementById("splash").hidden = true;
  document.getElementById("diag").hidden = false;
}
const backBtn = document.getElementById("backHome");
if (backBtn) backBtn.onclick = () => location.replace("https://chat.victorio.cloud/");
// The native splash covers the cold start; hand over to the styled
// loading view as soon as it has painted, then forward.
requestAnimationFrame(() => setTimeout(() => { SplashScreen.hide().catch(() => {}); }, 30));
const stayBtn = document.getElementById("stayDiag");
if (stayBtn) stayBtn.onclick = () => {
  stayDiag = true; clearTimeout(diagTimer);
  document.getElementById("splash").hidden = true;
  document.getElementById("diag").hidden = false;
  log("diagnostics open; auto-forward cancelled");
};

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
