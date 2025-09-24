# Example: Android JavaScript Interface for Downloads

To enable downloads from this web application when it's running inside an Android WebView, you need to create a "JavaScript Interface" in your native Android code. This interface will receive the file data from the web app and use the Android `DownloadManager` to handle the download.

Here is a complete example of how to do this.

## 1. Create the JavaScript Interface Class

First, create a new Java class in your Android project. This class will contain the method that the JavaScript code will call.

`WebAppInterface.java`:
```java
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

public class WebAppInterface {
    Context mContext;

    /** Instantiate the interface and set the context */
    WebAppInterface(Context c) {
        mContext = c;
    }

    /**
     * Receives file data from JavaScript and initiates a download.
     * @param url The data URL (base64 encoded) of the file.
     * @param fileName The name to save the file as.
     * @param mimeType The MIME type of the file.
     */
    @JavascriptInterface
    public void downloadFile(String url, String fileName, String mimeType) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType);
            request.setTitle(fileName);
            request.setDescription("Downloading file...");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);

            // Save the file to the public "Downloads" directory
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager dm = (DownloadManager) mContext.getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(request);

            Toast.makeText(mContext.getApplicationContext(), "Downloading File...", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(m.Context.getApplicationContext(), "Error downloading file: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
```

## 2. Attach the Interface to Your WebView

In the `Activity` where you manage your `WebView`, you need to enable JavaScript and attach an instance of your new `WebAppInterface` class to it.

In your `onCreate` method (or wherever you initialize your WebView):
```java
// Assuming 'myWebView' is your WebView instance
WebView myWebView = (WebView) findViewById(R.id.my_webview);

// Enable JavaScript
WebSettings webSettings = myWebView.getSettings();
webSettings.setJavaScriptEnabled(true);

// Add the JavaScript interface, naming it "Android"
// This is the name the JavaScript code will use (e.g., window.Android.downloadFile(...))
myWebView.addJavascriptInterface(new WebAppInterface(this), "Android");

// Load your web application URL
myWebView.loadUrl("https://your-webapp-url.com");
```

## 3. Add Required Permissions

Finally, ensure your app has the necessary permissions to write to external storage and access the internet. Add these to your `AndroidManifest.xml` file:

`AndroidManifest.xml`:
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.your.package.name">

    <!-- Required for downloading files -->
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />

    <!-- Required for the WebView to load web content -->
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        ... >
        ...
    </application>

</manifest>
```
**Note:** For Android 6.0 (API level 23) and higher, you will also need to handle runtime permissions for `WRITE_EXTERNAL_STORAGE`. The code for that is not included here but is a standard part of Android development.

With these changes in your Android project, the download functionality in the web app will now correctly trigger the native download manager.
