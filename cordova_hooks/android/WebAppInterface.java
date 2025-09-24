package io.spritex.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import android.util.Log;

public class WebAppInterface {
    Context mContext;
    private static final String LOG_TAG = "WebAppInterface";

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
            Log.d(LOG_TAG, "Download requested for: " + fileName);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType);
            request.setTitle(fileName);
            request.setDescription("Downloading file...");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager dm = (DownloadManager) mContext.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.enqueue(request);
                Log.d(LOG_TAG, "Download enqueued successfully.");
                Toast.makeText(mContext.getApplicationContext(), "Downloading: " + fileName, Toast.LENGTH_LONG).show();
            } else {
                Log.e(LOG_TAG, "DownloadManager service not found.");
                Toast.makeText(mContext.getApplicationContext(), "Error: DownloadManager not available.", Toast.LENGTH_LONG).show();
            }
        } catch (Exception e) {
            Log.e(LOG_TAG, "Error during download", e);
            Toast.makeText(mContext.getApplicationContext(), "Error downloading file: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
