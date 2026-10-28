package dev.omp.mobile;

import android.webkit.WebView;
import android.webkit.WebViewClient;

final class SplashWebViewClient extends WebViewClient {
    private final Runnable onPageFinished;

    SplashWebViewClient(Runnable onPageFinished) {
        this.onPageFinished = onPageFinished;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        onPageFinished.run();
    }
}
