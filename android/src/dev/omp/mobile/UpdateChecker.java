package dev.omp.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

final class UpdateChecker {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long MAX_APK_BYTES = 50L * 1024L * 1024L;

    private final Activity activity;
    private final String baseUrl;

    UpdateChecker(Activity activity, String baseUrl) {
        this.activity = activity;
        String value = baseUrl == null ? "" : baseUrl.trim();
        this.baseUrl = value.endsWith("/") ? value : value + "/";
    }

    void check() {
        if (baseUrl.isEmpty()) return;
        new Thread(() -> {
            try {
                JSONObject manifest = fetchJson(new URL(baseUrl + "update.json"));
                int remoteCode = manifest.getInt("versionCode");
                int currentCode = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0).versionCode;
                if (remoteCode <= currentCode) return;
                String remoteName = manifest.optString("versionName", "新版本");
                String notes = manifest.optString("notes", "");
                activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                    .setTitle("发现新版本 " + remoteName)
                    .setMessage(notes.isEmpty() ? "是否下载并安装更新？" : notes)
                    .setPositiveButton("更新", (dialog, which) -> download(manifest))
                    .setNegativeButton("稍后", null)
                    .show());
            } catch (Exception ignored) {
                // Missing manifest, offline Tailscale, or malformed response: stay silent.
            }
        }).start();
    }

    private void download(JSONObject manifest) {
        final ProgressDialog progress = new ProgressDialog(activity);
        progress.setMessage("正在下载更新…");
        progress.setCancelable(false);
        progress.show();

        new Thread(() -> {
            try {
                String apkPath = manifest.getString("apk");
                URL apkUrl = new URL(new URL(baseUrl), apkPath);
                if (!"https".equalsIgnoreCase(apkUrl.getProtocol())) {
                    throw new IOException("更新地址必须使用 HTTPS");
                }
                String expected = manifest.optString("sha256", "").toLowerCase(Locale.US);
                File target = new File(activity.getCacheDir(), "update.apk");
                downloadFile(apkUrl, target);
                if (!expected.isEmpty() && !sha256(target).equals(expected)) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                    throw new IOException("APK 校验失败");
                }
                activity.runOnUiThread(() -> {
                    progress.dismiss();
                    install(target);
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> {
                    progress.dismiss();
                    Toast.makeText(
                        activity,
                        "更新失败: " + String.valueOf(error.getMessage()),
                        Toast.LENGTH_LONG
                    ).show();
                });
            }
        }).start();
    }

    private void install(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !activity.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(activity, "请允许安装未知应用后重试", Toast.LENGTH_LONG).show();
            Intent settings = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName())
            );
            activity.startActivity(settings);
            return;
        }
        Uri uri = Uri.parse("content://" + ApkProvider.AUTHORITY + "/update.apk");
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }

    private static JSONObject fetchJson(URL url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("Accept", "application/json");
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

    private static void downloadFile(URL url, File target) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("User-Agent", "omp-mobile-updater");
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + status);
            }
            long length = connection.getContentLength();
            if (length > MAX_APK_BYTES) throw new IOException("APK 太大");
            try (InputStream input = connection.getInputStream();
                 OutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[16 * 1024];
                long total = 0;
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_APK_BYTES) throw new IOException("APK 太大");
                    output.write(buffer, 0, read);
                }
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

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        byte[] value = digest.digest();
        StringBuilder text = new StringBuilder(value.length * 2);
        for (byte b : value) text.append(String.format(Locale.US, "%02x", b & 0xff));
        return text.toString();
    }
}
