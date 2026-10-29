package dev.omp.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class UpdateChecker {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long SKIP_MS = 24L * 60L * 60L * 1000L;
    private static final String PREFS = "omp-mobile";
    private static final String KEY_SKIP_VERSION = "update-skip-version";
    private static final String KEY_SKIP_AT = "update-skip-at";

    private final Activity activity;
    private final String baseUrl;

    UpdateChecker(Activity activity, String baseUrl) {
        this.activity = activity;
        String value = baseUrl == null ? "" : baseUrl.trim();
        this.baseUrl = value.endsWith("/") ? value : value + "/";
    }

    void check() {
        check(false);
    }

    void check(boolean manual) {
        if (baseUrl.isEmpty()) return;
        new Thread(() -> {
            try {
                String manifestUrl = baseUrl + "update.json?t=" + System.currentTimeMillis();
                JSONObject manifest = fetchJson(new URL(manifestUrl));
                long remoteCode = manifest.optLong("versionCode", 0L);
                PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
                long currentCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
                String currentName = info.versionName == null ? "" : info.versionName.trim();
                String remoteName = manifest.optString("versionName", "").trim();
                boolean newer;
                if (!currentName.isEmpty() && !remoteName.isEmpty()) {
                    newer = compareVersions(remoteName, currentName) > 0;
                } else {
                    newer = remoteCode > currentCode;
                }
                if (!newer) {
                    if (manual) {
                        showToast(currentName.isEmpty()
                            ? "已是最新版本"
                            : "已是最新版本 " + currentName);
                    }
                    return;
                }
                String skipKey = remoteName.isEmpty() ? String.valueOf(remoteCode) : remoteName;
                SharedPreferences prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
                if (!manual
                    && skipKey.equals(prefs.getString(KEY_SKIP_VERSION, ""))
                    && System.currentTimeMillis() - prefs.getLong(KEY_SKIP_AT, 0L) < SKIP_MS) {
                    return;
                }
                URL apkUrl = new URL(new URL(baseUrl), manifest.getString("apk"));
                if (!"https".equalsIgnoreCase(apkUrl.getProtocol())) {
                    throw new IOException("更新地址必须使用 HTTPS");
                }
                String separator = apkUrl.getQuery() == null ? "?" : "&";
                URL downloadUrl = new URL(apkUrl + separator + "v=" + remoteCode + "&t=" + System.currentTimeMillis());
                String title = remoteName.isEmpty() ? "新版本" : remoteName;
                String notes = manifest.optString("notes", "");
                String message = "将打开浏览器下载新的安装包。\n\n"
                    + (notes.isEmpty() ? "安装前请允许浏览器安装未知应用。" : notes);
                activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                    .setTitle("发现新版本 " + title)
                    .setMessage(message)
                    .setPositiveButton("下载", (dialog, which) -> openInBrowser(downloadUrl))
                    .setNegativeButton("稍后", (dialog, which) -> prefs.edit()
                        .putString(KEY_SKIP_VERSION, skipKey)
                        .putLong(KEY_SKIP_AT, System.currentTimeMillis())
                        .apply())
                    .show());
            } catch (Exception error) {
                if (manual) showToast("检查更新失败，请确认网络");
            }
        }).start();
    }

    private void showToast(String message) {
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }

    private void openInBrowser(URL url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url.toString()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }

    private static int compareVersions(String left, String right) {
        String[] a = left.split("[^0-9]+");
        String[] b = right.split("[^0-9]+");
        int count = Math.max(a.length, b.length);
        for (int i = 0; i < count; i++) {
            long x = parseVersionPart(a, i);
            long y = parseVersionPart(b, i);
            if (x != y) return Long.compare(x, y);
        }
        return 0;
    }

    private static long parseVersionPart(String[] parts, int index) {
        if (index >= parts.length || parts[index].isEmpty()) return 0L;
        try {
            return Long.parseLong(parts[index]);
        } catch (NumberFormatException error) {
            return 0L;
        }
    }

    private static JSONObject fetchJson(URL url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-cache, no-store, max-age=0");
        connection.setRequestProperty("Pragma", "no-cache");
        connection.setRequestProperty("User-Agent", "omp-mobile-updater");
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + status);
            }
            try (InputStream input = connection.getInputStream()) {
                return new JSONObject(readString(input));
            }
        } finally {
            connection.disconnect();
        }
    }

    private static String readString(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
