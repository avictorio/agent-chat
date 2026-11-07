package cloud.victorio.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

// Bridge to ChunkedUploadService: the page hands over a picked file's path
// plus the room API coordinates, the service moves the bytes. Events ride
// the "chunkedEvents" listener: {name: progress|completed|failed, key,
// percent?, error?}, keyed by the draft message id the page chose.
@CapacitorPlugin(name = "ChunkedUploader")
public class ChunkedUploaderPlugin extends Plugin {
    static volatile ChunkedUploaderPlugin active;

    @Override
    public void load() { active = this; }

    @Override
    protected void handleOnDestroy() {
        if (active == this) active = null;
        super.handleOnDestroy();
    }

    static void emit(JSONObject ev) {
        ChunkedUploaderPlugin p = active;
        if (p == null) return;
        try { p.notifyListeners("chunkedEvents", new JSObject(ev.toString())); }
        catch (Exception ignored) {}
    }

    @PluginMethod
    public void fingerprint(PluginCall call) {
        final String path = call.getString("filePath");
        final long size = call.getLong("size", 0L);
        if (path == null || path.isEmpty()) { call.reject("filePath required"); return; }
        new Thread(() -> {
            try {
                String fp = ChunkedUploadService.fingerprint(getContext(), path, size);
                JSObject r = new JSObject();
                r.put("fingerprint", fp);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("fingerprint failed: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSONObject cfg = new JSONObject();
        try {
            cfg.put("key", call.getString("key", ""));
            cfg.put("apiBase", call.getString("apiBase", ""));
            cfg.put("id", call.getInt("id", 0));
            cfg.put("token", call.getString("token", ""));
            cfg.put("filePath", call.getString("filePath", ""));
            cfg.put("type", call.getString("type", "video/mp4"));
            cfg.put("size", call.getLong("size", 0L));
            cfg.put("fingerprint", call.getString("fingerprint", ""));
            cfg.put("name", call.getString("name", "video"));
        } catch (Exception e) {
            call.reject("bad config");
            return;
        }
        if (cfg.optString("filePath").isEmpty() || cfg.optInt("id") == 0 || cfg.optString("apiBase").isEmpty()) {
            call.reject("filePath, apiBase and id are required");
            return;
        }
        ChunkedUploadService.enqueue(getContext(), cfg);
        JSObject r = new JSObject();
        r.put("started", true);
        call.resolve(r);
    }
}
