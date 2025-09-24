package io.spritex.app;

import android.os.Bundle;
import org.apache.cordova.*;
import android.webkit.WebView;

public class MainActivity extends CordovaActivity
{
    @Override
    public void onCreate(Bundle savedInstanceState)
    {
        super.onCreate(savedInstanceState);
        super.init(); // Initialize Cordova

        // enable Cordova apps to be started in the background
        Bundle extras = getIntent().getExtras();
        if (extras != null && extras.getBoolean("cdvStartInBackground", false)) {
            moveTaskToBack(true);
        }

        // Set by <content src="index.html" /> in config.xml
        loadUrl(launchUrl);

        // Get the WebView instance and add the custom JavaScript interface
        if (this.appView != null) {
            WebView webView = (WebView) this.appView.getEngine().getView();
            webView.addJavascriptInterface(new WebAppInterface(this), "Android");
        }
    }
}
