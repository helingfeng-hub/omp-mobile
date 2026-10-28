package dev.omp.mobile;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URI;

public class MainActivity extends Activity {
    private static final String PREFS = "omp-mobile";
    private static final String KEY_URL = "bridge-url";
    private static final String BG = "#080a0f";
    private static final String PANEL = "#11161f";
    private static final String BORDER = "#33405a";
    private static final String TEXT = "#e8edf7";
    private static final String MUTED = "#8b97ab";
    private static final String ACCENT = "#7c9cff";

    private WebView webView;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor(BG));
        getWindow().setNavigationBarColor(Color.parseColor(BG));
        WebView.setWebContentsDebuggingEnabled(true);

        String saved = prefs.getString(KEY_URL, "");
        if (saved.isEmpty()) {
            showSetup(saved);
        } else {
            showWeb(saved);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable rounded(String fill, String stroke, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(Color.parseColor(fill));
        drawable.setCornerRadius(dp(radiusDp));
        if (stroke != null) drawable.setStroke(dp(1), Color.parseColor(stroke));
        return drawable;
    }

    private TextView label(String text, int sizeSp, String color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(sizeSp);
        view.setTextColor(Color.parseColor(color));
        return view;
    }

    private void showSetup(String current) {
        webView = null;

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(22), dp(30), dp(22), dp(24));
        content.setBackgroundColor(Color.parseColor(BG));

        TextView title = label("omp mobile", 28, TEXT);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        content.addView(title);

        TextView intro = label(
            "连接电脑上的 omp bridge。手机和电脑先加入同一个 Tailscale 网络，再填入 bridge 的 HTTPS 地址。",
            14, MUTED);
        LinearLayout.LayoutParams introParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        introParams.topMargin = dp(10);
        content.addView(intro, introParams);

        TextView urlLabel = label("BRIDGE URL", 11, MUTED);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelParams.topMargin = dp(24);
        content.addView(urlLabel, labelParams);

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://your-host.tailnet.ts.net/");
        input.setText(current);
        input.setTextColor(Color.parseColor(TEXT));
        input.setHintTextColor(Color.parseColor(MUTED));
        input.setBackground(rounded(PANEL, BORDER, 12));
        input.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputParams.topMargin = dp(7);
        content.addView(input, inputParams);

        Button open = new Button(this);
        open.setText("打开控制台");
        open.setAllCaps(false);
        open.setTextSize(16);
        open.setTextColor(Color.parseColor("#081020"));
        open.setBackground(rounded(ACCENT, ACCENT, 12));
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        openParams.topMargin = dp(14);
        open.setOnClickListener(view -> {
            String normalized = normalizeUrl(input.getText().toString());
            if (normalized == null) {
                Toast.makeText(this, "请输入有效的 https:// 地址（Tailscale Serve）", Toast.LENGTH_SHORT).show();
                return;
            }
            prefs.edit().putString(KEY_URL, normalized).apply();
            showWeb(normalized);
        });
        content.addView(open, openParams);

        TextView note = label(
            "不要把这个端口映射到公网。bridge 应只监听 127.0.0.1，并通过 Tailscale Serve 暴露。\n\n进入后长按页面可重新设置地址。",
            12, MUTED);
        LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        noteParams.topMargin = dp(16);
        content.addView(note, noteParams);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor(BG));
        scroll.addView(content);
        setContentView(scroll);
    }

    private String normalizeUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return null;
        if (!value.contains("://")) value = "https://" + value;
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            if (scheme == null || !scheme.equalsIgnoreCase("https")) return null;
            if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
            return value;
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    private void showWeb(String url) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(BG));

        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        view.setWebViewClient(new WebViewClient());
        view.setWebChromeClient(new WebChromeClient());
        view.setOnLongClickListener(v -> {
            showSetup(prefs.getString(KEY_URL, ""));
            return true;
        });
        view.loadUrl(url);
        root.addView(view, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView = view;
        if (!prefs.getBoolean("hint-shown", false)) {
            Toast.makeText(this, "提示：长按页面可修改 bridge 地址", Toast.LENGTH_LONG).show();
            prefs.edit().putBoolean("hint-shown", true).apply();
        }

        setContentView(root);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
