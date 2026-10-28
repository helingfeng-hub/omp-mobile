package dev.omp.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

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
    private long pausedAt;
    private View splashOverlay;
    private boolean splashDone;
    private boolean splashPageReady;
    private long splashStart;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor(BG));
        getWindow().setNavigationBarColor(Color.parseColor(BG));
        WebView.setWebContentsDebuggingEnabled(true);

        String saved = prefs.getString(KEY_URL, "");
        if (saved.isEmpty() && !LocalConfig.DEFAULT_URL.isEmpty()) {
            saved = LocalConfig.DEFAULT_URL;
            prefs.edit().putString(KEY_URL, saved).apply();
        }
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

        Button update = new Button(this);
        update.setText("检查更新");
        update.setAllCaps(false);
        update.setTextSize(15);
        update.setTextColor(Color.parseColor(TEXT));
        update.setBackground(rounded(PANEL, BORDER, 12));
        LinearLayout.LayoutParams updateParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(46));
        updateParams.topMargin = dp(8);
        update.setOnClickListener(view -> {
            String target = normalizeUrl(input.getText().toString());
            if (target == null) {
                Toast.makeText(this, "请先填入有效的 bridge 地址", Toast.LENGTH_SHORT).show();
                return;
            }
            new UpdateChecker(this, target).check();
        });
        content.addView(update, updateParams);

        Button keepAlive = new Button(this);
        keepAlive.setText("后台保活设置");
        keepAlive.setAllCaps(false);
        keepAlive.setTextSize(15);
        keepAlive.setTextColor(Color.parseColor(TEXT));
        keepAlive.setBackground(rounded(PANEL, BORDER, 12));
        LinearLayout.LayoutParams keepAliveParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(46));
        keepAliveParams.topMargin = dp(8);
        keepAlive.setOnClickListener(view -> requestBackgroundKeepAlive());
        content.addView(keepAlive, keepAliveParams);

        TextView note = label(
            "不要把这个端口映射到公网。bridge 应只监听 127.0.0.1，并通过 Tailscale Serve 暴露。\n\n进入后长按页面可重新设置地址。",
            12, MUTED);
        LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        noteParams.topMargin = dp(16);
        content.addView(note, noteParams);

        String version = "?";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        boolean batteryExempt = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            batteryExempt = power != null && power.isIgnoringBatteryOptimizations(getPackageName());
        }
        TextView status = label(
            "版本 " + version
                + " · 后台连接 " + (ConnectionService.running ? "已启用" : "未启用")
                + " · 电池优化 " + (batteryExempt ? "已关闭" : "仍开启"),
            11, MUTED);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusParams.topMargin = dp(10);
        statusParams.bottomMargin = dp(20);
        content.addView(status, statusParams);

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

        view.setWebViewClient(new SplashWebViewClient(() -> {
            splashPageReady = true;
            maybeDismissSplash();
        }));
        view.setWebChromeClient(new WebChromeClient());
        view.setOnLongClickListener(v -> {
            showSetup(prefs.getString(KEY_URL, ""));
            return true;
        });
        root.addView(view, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView = view;
        setContentView(root);
        showSplash(root, view);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            view.post(() ->
                view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false));
        }
        view.loadUrl(url);
        startConnectionService();
        requestNotificationPermission();
        if (!LocalConfig.DEFAULT_TOKEN.isEmpty()) {
            view.postDelayed(() -> injectTokenWhenReady(view, 0), 500);
        }
        if (!prefs.getBoolean("hint-shown", false)) {
            Toast.makeText(this, "提示：长按页面可修改 bridge 地址", Toast.LENGTH_LONG).show();
            prefs.edit().putBoolean("hint-shown", true).apply();
        }
    }

    private void showSplash(FrameLayout root, WebView view) {
        if (splashOverlay != null && splashOverlay.getParent() instanceof ViewGroup) {
            ((ViewGroup) splashOverlay.getParent()).removeView(splashOverlay);
        }
        splashDone = false;
        splashPageReady = false;
        splashStart = SystemClock.elapsedRealtime();

        FrameLayout splash = new FrameLayout(this);
        GradientDrawable background = new GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { Color.parseColor("#111b2e"), Color.parseColor(BG) }
        );
        splash.setBackground(background);
        splash.setClickable(true);

        LinearLayout center = new LinearLayout(this);
        center.setOrientation(LinearLayout.VERTICAL);
        center.setGravity(Gravity.CENTER_HORIZONTAL);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        center.addView(logo, new LinearLayout.LayoutParams(dp(96), dp(96)));

        TextView wordmark = label("omp mobile", 24, TEXT);
        wordmark.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        wordmark.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams wordmarkParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wordmarkParams.topMargin = dp(18);
        center.addView(wordmark, wordmarkParams);

        TextView subtitle = label("远程会话", 12, MUTED);
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subtitleParams.topMargin = dp(6);
        center.addView(subtitle, subtitleParams);

        splash.addView(center, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        ));

        FrameLayout progressWrap = new FrameLayout(this);
        View track = new View(this);
        track.setBackgroundColor(Color.parseColor(BORDER));
        View progress = new View(this);
        progress.setBackgroundColor(Color.parseColor(ACCENT));
        progress.setPivotX(0f);
        progressWrap.addView(track, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        progressWrap.addView(progress, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
            dp(96), dp(2), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        progressParams.bottomMargin = dp(72);
        splash.addView(progressWrap, progressParams);
        progress.setScaleX(0f);
        progress.animate().scaleX(1f).setDuration(900).start();

        root.addView(splash, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splashOverlay = splash;
        view.postDelayed(this::maybeDismissSplash, 900);
        view.postDelayed(this::dismissSplash, 2500);
    }

    private void maybeDismissSplash() {
        if (splashOverlay == null || splashDone) return;
        long elapsed = SystemClock.elapsedRealtime() - splashStart;
        if (!splashPageReady && elapsed < 2500) return;
        if (elapsed < 900) {
            splashOverlay.postDelayed(this::maybeDismissSplash, 900 - elapsed);
            return;
        }
        dismissSplash();
    }

    private void dismissSplash() {
        if (splashOverlay == null || splashDone) return;
        splashDone = true;
        final View overlay = splashOverlay;
        overlay.animate()
            .alpha(0f)
            .setDuration(220)
            .withEndAction(() -> {
                if (overlay.getParent() instanceof ViewGroup) {
                    ((ViewGroup) overlay.getParent()).removeView(overlay);
                }
                if (splashOverlay == overlay) splashOverlay = null;
            })
            .start();
    }

    private void injectTokenWhenReady(WebView view, int attempt) {
        if (LocalConfig.DEFAULT_TOKEN.isEmpty()) return;
        String current = view.getUrl();
        if (view.getProgress() >= 100 && current != null && current.startsWith("https://")) {
            view.evaluateJavascript(
                "localStorage.setItem('omp-mobile.token', " +
                    JSONObject.quote(LocalConfig.DEFAULT_TOKEN) + ");",
                null
            );
            view.postDelayed(() -> view.reload(), 250);
            return;
        }
        if (attempt < 40) {
            view.postDelayed(() -> injectTokenWhenReady(view, attempt + 1), 300);
        }
    }

    private void startConnectionService() {
        Intent service = new Intent(this, ConnectionService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 0x0f12);
        }
    }

    private void requestBackgroundKeepAlive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
            if (manager != null && !manager.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent request = new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())
                );
                startActivity(request);
                return;
            }
        }
        Intent details = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getPackageName())
        );
        startActivity(details);
        Toast.makeText(
            this,
            "ColorOS/OPPO 还需允许后台运行，并关闭耗电限制",
            Toast.LENGTH_LONG
        ).show();
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
        // Keep the WebView running while the app is in the background.
        // The foreground ConnectionService keeps the process/network alive.
        pausedAt = SystemClock.elapsedRealtime();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView == null) return;
        webView.onResume();
        if (pausedAt != 0) {
            long elapsed = SystemClock.elapsedRealtime() - pausedAt;
            pausedAt = 0;
            if (elapsed > 1500) {
                String script =
                    "(function(elapsed){"
                        + "if(window.ompMobileOnResume){window.ompMobileOnResume(elapsed);return;}"
                        + "var frame=document.getElementById('chat-frame');"
                        + "var overlay=document.getElementById('chat-overlay');"
                        + "if(!frame||!overlay||overlay.classList.contains('hidden'))return;"
                        + "try{"
                        + "var url=new URL(frame.src);"
                        + "url.searchParams.set('_reconnect',String(Date.now()));"
                        + "var loading=document.getElementById('chat-loading');"
                        + "if(loading)loading.classList.remove('hidden');"
                        + "frame.src=url.toString();"
                        + "}catch(error){}"
                        + "})(" + elapsed + ")";
                webView.evaluateJavascript(script, null);
            }
        }
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
