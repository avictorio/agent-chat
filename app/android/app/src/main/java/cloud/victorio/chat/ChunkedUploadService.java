package cloud.victorio.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

// Foreground service driving the room API's chunked video upload
// (start / part / finish) for files over the 100 MB single-request cap.
// The draft it fills was created with publish_on_complete, so the server
// posts the message the moment finish verifies - this service never has
// to wake the page. Configs persist in SharedPreferences so a sticky
// restart after process death resumes from the parts the server holds.
public class ChunkedUploadService extends Service {
    private static final String CHANNEL = "uploads";
    private static final int NID = 4207;
    private static final String PREFS = "chunked_uploads";
    private static final Object LOCK = new Object();
    private static final ArrayDeque<JSONObject> QUEUE = new ArrayDeque<>();
    private static boolean draining = false;

    public static void enqueue(Context ctx, JSONObject cfg) {
        persist(ctx, cfg);
        Intent i = new Intent(ctx, ChunkedUploadService.class);
        i.putExtra("cfg", cfg.toString());
        androidx.core.content.ContextCompat.startForegroundService(ctx, i);
    }

    private static void persist(Context ctx, JSONObject cfg) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONObject all = new JSONObject(sp.getString("pending", "{}"));
            all.put(cfg.optString("key"), cfg);
            sp.edit().putString("pending", all.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void unpersist(String key) {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONObject all = new JSONObject(sp.getString("pending", "{}"));
            all.remove(key);
            sp.edit().putString("pending", all.toString()).apply();
        } catch (Exception ignored) {}
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Uploads", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private Notification notification(String text, int percent) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Agent Chat")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true);
        if (percent >= 0) b.setProgress(100, percent, false);
        return b.build();
    }

    private void showNotification(String text, int percent) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NID, notification(text, percent));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NID, notification("Uploading video", 0));
        boolean added = false;
        if (intent != null && intent.hasExtra("cfg")) {
            try {
                JSONObject cfg = new JSONObject(intent.getStringExtra("cfg"));
                synchronized (LOCK) { QUEUE.add(cfg); }
                added = true;
            } catch (Exception ignored) {}
        }
        if (!added) {
            // Sticky restart (or a start with nothing new): resume whatever
            // configs are still persisted from before the process died.
            try {
                SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
                JSONObject all = new JSONObject(sp.getString("pending", "{}"));
                Iterator<String> keys = all.keys();
                synchronized (LOCK) {
                    while (keys.hasNext()) {
                        JSONObject cfg = all.optJSONObject(keys.next());
                        if (cfg != null && !queuedLocked(cfg.optString("key"))) QUEUE.add(cfg);
                    }
                }
            } catch (Exception ignored) {}
        }
        drain();
        return START_STICKY;
    }

    private boolean queuedLocked(String key) {
        for (JSONObject c : QUEUE) if (c.optString("key").equals(key)) return true;
        return false;
    }

    private void drain() {
        synchronized (LOCK) {
            if (draining) return;
            draining = true;
        }
        new Thread(() -> {
            for (;;) {
                JSONObject cfg;
                synchronized (LOCK) { cfg = QUEUE.poll(); }
                if (cfg == null) break;
                runUpload(cfg);
            }
            synchronized (LOCK) { draining = false; }
            stopForeground(true);
            stopSelf();
        }).start();
    }

    private void runUpload(JSONObject cfg) {
        String key = cfg.optString("key");
        String apiBase = cfg.optString("apiBase");
        int id = cfg.optInt("id");
        String token = cfg.optString("token");
        String filePath = cfg.optString("filePath");
        String type = cfg.optString("type", "video/mp4");
        long size = cfg.optLong("size");
        String fp = cfg.optString("fingerprint");
        String name = cfg.optString("name", "video");
        try {
            emit("progress", key, 0, null);
            JSONObject startBody = new JSONObject();
            startBody.put("type", type);
            startBody.put("size", size);
            if (fp != null && !fp.isEmpty()) startBody.put("fingerprint", fp);
            JSONObject sd = postJson(apiBase + "/" + id + "/video/start", startBody, token);
            long partSize = sd.optLong("part_size", 10000000L);
            int parts = sd.optInt("parts", (int) Math.ceil((double) size / (double) partSize));
            Set<Integer> have = new HashSet<>();
            try {
                JSONObject st = getJson(apiBase + "/" + id + "/video/status", token);
                JSONArray rec = st.optJSONArray("received");
                if (rec != null) for (int i = 0; i < rec.length(); i++) have.add(rec.getInt(i));
            } catch (Exception ignored) {}
            long doneBytes = 0;
            for (int n = 1; n <= parts; n++) {
                long plen = Math.min(partSize, size - (long) (n - 1) * partSize);
                if (have.contains(n)) { doneBytes += plen; continue; }
                byte[] data = readRange(this, filePath, (long) (n - 1) * partSize, (int) plen);
                boolean okPut = false;
                Exception lastErr = null;
                for (int attempt = 0; attempt < 3 && !okPut; attempt++) {
                    try { putPart(apiBase + "/" + id + "/video/part?n=" + n, data, token); okPut = true; }
                    catch (Exception e) { lastErr = e; }
                }
                if (!okPut) throw lastErr != null ? lastErr : new IOException("Part " + n + " failed");
                doneBytes += plen;
                int pct = size > 0 ? (int) Math.floor(doneBytes * 100.0 / size) : 100;
                emit("progress", key, pct, null);
                showNotification("Uploading " + name + " - " + pct + "%", pct);
            }
            postJson(apiBase + "/" + id + "/video/finish", new JSONObject(), token);
            unpersist(key);
            emit("completed", key, 100, null);
        } catch (Exception e) {
            unpersist(key);
            emit("failed", key, -1, String.valueOf(e.getMessage()));
        }
    }

    private void emit(String name, String key, int percent, String error) {
        try {
            JSONObject ev = new JSONObject();
            ev.put("name", name);
            ev.put("key", key);
            if (percent >= 0) ev.put("percent", percent);
            if (error != null) ev.put("error", error);
            ChunkedUploaderPlugin.emit(ev);
        } catch (Exception ignored) {}
    }

    // ---- HTTP ----

    private static HttpURLConnection conn(String urlStr, String method, String token) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(30000);
        c.setReadTimeout(180000);
        if (token != null && !token.isEmpty()) c.setRequestProperty("X-Invite-Token", token);
        return c;
    }

    private static String readBody(HttpURLConnection c) throws IOException {
        InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int r;
        while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
        in.close();
        return out.toString("UTF-8");
    }

    private static JSONObject postJson(String urlStr, JSONObject body, String token) throws Exception {
        HttpURLConnection c = conn(urlStr, "POST", token);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes("UTF-8");
        c.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream os = c.getOutputStream()) { os.write(bytes); }
        String resp = readBody(c);
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code + ": " + resp);
        return resp.isEmpty() ? new JSONObject() : new JSONObject(resp);
    }

    private static JSONObject getJson(String urlStr, String token) throws Exception {
        HttpURLConnection c = conn(urlStr, "GET", token);
        String resp = readBody(c);
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code + ": " + resp);
        return resp.isEmpty() ? new JSONObject() : new JSONObject(resp);
    }

    private static void putPart(String urlStr, byte[] data, String token) throws Exception {
        HttpURLConnection c = conn(urlStr, "PUT", token);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/octet-stream");
        c.setFixedLengthStreamingMode(data.length);
        try (OutputStream os = c.getOutputStream()) { os.write(data); }
        String resp = readBody(c);
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code + ": " + resp);
    }

    // ---- file access (plain paths, file:// and content:// URIs) ----

    static InputStream open(Context ctx, String path) throws IOException {
        if (path.startsWith("content://")) return ctx.getContentResolver().openInputStream(Uri.parse(path));
        if (path.startsWith("file://")) path = Uri.parse(path).getPath();
        return new FileInputStream(new File(path));
    }

    static byte[] readRange(Context ctx, String path, long off, int len) throws IOException {
        try (InputStream in = open(ctx, path)) {
            long left = off;
            while (left > 0) {
                long skipped = in.skip(left);
                if (skipped <= 0) {
                    if (in.read() < 0) break;
                    skipped = 1;
                }
                left -= skipped;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream(len);
            byte[] buf = new byte[65536];
            int want = len;
            while (want > 0) {
                int r = in.read(buf, 0, Math.min(buf.length, want));
                if (r < 0) break;
                out.write(buf, 0, r);
                want -= r;
            }
            return out.toByteArray();
        }
    }

    // Same construction as the web composer's fileFingerprint: SHA-256 of
    // the first 64 KB concatenated with the last 64 KB, hex + "-" + size.
    static String fingerprint(Context ctx, String path, long size) throws Exception {
        int edge = (int) Math.min(65536L, size);
        byte[] head = readRange(ctx, path, 0, edge);
        byte[] tail = readRange(ctx, path, Math.max(0L, size - 65536L), edge);
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        md.update(head);
        md.update(tail);
        byte[] d = md.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString() + "-" + size;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
