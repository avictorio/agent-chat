package cloud.victorio.chat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChunkedUploaderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
