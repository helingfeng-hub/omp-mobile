package dev.omp.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class ConnectionService extends Service {
    private static final String CHANNEL_ID = "omp-connection";
    private static final String COMPLETE_CHANNEL_ID = "omp-complete";
    private static final int NOTIFICATION_ID = 0x0f11;
    private static final int COMPLETE_NOTIFICATION_ID = 0x0f12;
    private static final String ACTION_STOP = "dev.omp.mobile.STOP_CONNECTION";

    private static final String PREFS = "omp-mobile";
    private static final String KEY_URL = "bridge-url";
    private static final String KEY_TOKEN = "bridge-token";
    private static final String KEY_SESSION = "current-session";
    private static final String KEY_LAST_NOTIFIED = "last-notified";
    private static final long POLL_MS = 4000L;
    private static final long STABLE_MS = 4000L;
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 12000;

    public static volatile boolean running;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Thread monitorThread;
    private String pendingSig = "";
    private String pendingVersion = "";
    private long pendingAt;
    private SharedPreferences prefs;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (MainActivity.backgroundAt == 0L) {
            MainActivity.backgroundAt = System.currentTimeMillis();
        }
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "omp-mobile:connection");
            wakeLock.setReferenceCounted(false);
            try {
                wakeLock.acquire();
            } catch (RuntimeException ignored) {
            }
        }
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wifi != null) {
            wifiLock = wifi.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                "omp-mobile:wifi"
            );
            wifiLock.setReferenceCounted(false);
            try {
                wifiLock.acquire();
            } catch (RuntimeException ignored) {
            }
        }
        createChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        running = true;
        startMonitor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            stopSelf();
            return START_NOT_STICKY;
        }
        startMonitor();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (monitorThread != null) {
            monitorThread.interrupt();
            monitorThread = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    private void startMonitor() {
        if (monitorThread != null && monitorThread.isAlive()) return;
        monitorThread = new Thread(() -> {
            while (running && !Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(POLL_MS);
                } catch (InterruptedException error) {
                    return;
                }
                if (MainActivity.visible) {
                    pendingSig = "";
                    pendingVersion = "";
                    continue;
                }
                try {
                    pollOnce();
                } catch (Exception ignored) {
                    // Offline or bridge restarting: retry on the next tick.
                }
            }
        }, "omp-monitor");
        monitorThread.start();
    }

    private void pollOnce() throws Exception {
        String base = prefs.getString(KEY_URL, "").trim();
        String token = prefs.getString(KEY_TOKEN, "").trim();
        if (token.isEmpty() && !LocalConfig.DEFAULT_TOKEN.isEmpty()) {
            token = LocalConfig.DEFAULT_TOKEN;
        }
        if (base.isEmpty() || token.isEmpty()) return;
        if (!base.endsWith("/")) base += "/";

        String session = prefs.getString(KEY_SESSION, "").trim();
        String endpoint = base + "api/monitor";
        if (!session.isEmpty()) {
            endpoint += "?session=" + URLEncoder.encode(session, StandardCharsets.UTF_8.name());
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "omp-mobile-monitor");
        try {
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return;
            JSONObject data;
            try (InputStream input = connection.getInputStream()) {
                data = new JSONObject(readString(input));
            }
            JSONObject last = data.optJSONObject("last");
            if (last == null) {
                pendingSig = "";
                return;
            }
            if (data.optBoolean("busy", false)) {
                // The agent is still running; wait for the turn to finish.
                pendingSig = "";
                pendingVersion = "";
                return;
            }
            String kind = last.optString("kind", "");
            String text = last.optString("text", "").trim();
            if (!"assistant".equals(kind) || text.isEmpty()) {
                pendingSig = "";
                pendingVersion = "";
                return;
            }
            String ts = last.optString("ts", "");
            String version = data.optString("version", "");
            String sig = ts + "|" + text.hashCode();
            String notified = prefs.getString(KEY_LAST_NOTIFIED, "");
            if (sig.equals(notified)) {
                pendingSig = "";
                return;
            }
            long updatedAt = (long) data.optDouble("updatedAt", 0d);
            long backgroundAt = MainActivity.backgroundAt;
            if (updatedAt > 0 && backgroundAt > 0 && updatedAt < backgroundAt) {
                // Content that finished before the app went to the background is old.
                prefs.edit().putString(KEY_LAST_NOTIFIED, sig).apply();
                pendingSig = "";
                return;
            }
            long now = System.currentTimeMillis();
            if (!sig.equals(pendingSig) || !version.equals(pendingVersion)) {
                pendingSig = sig;
                pendingVersion = version;
                pendingAt = now;
                return;
            }
            if (now - pendingAt < STABLE_MS) return;
            notifyCompletion(data.optString("title", ""), text);
            prefs.edit().putString(KEY_LAST_NOTIFIED, sig).apply();
            pendingSig = "";
        } finally {
            connection.disconnect();
        }
    }

    private void notifyCompletion(String title, String text) {
        String snippet = text.replaceAll("\\s+", " ").trim();
        if (snippet.length() > 160) snippet = snippet.substring(0, 157) + "…";
        if (snippet.isEmpty()) snippet = "会话输出完成";

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE
            : 0;
        PendingIntent openIntent = PendingIntent.getActivity(
            this,
            2,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | immutable
        );

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, COMPLETE_CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder
            .setContentTitle(title.isEmpty() ? "omp 会话" : title)
            .setContentText(snippet)
            .setStyle(new Notification.BigTextStyle().bigText(snippet))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true);

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            manager.notify(COMPLETE_NOTIFICATION_ID, builder.build());
        } catch (Exception ignored) {
            // Notification permission can be denied on Android 13+.
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "omp 连接",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("切到后台或锁屏时保持远程会话连接");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);

        NotificationChannel complete = new NotificationChannel(
            COMPLETE_CHANNEL_ID,
            "omp 会话完成",
            NotificationManager.IMPORTANCE_HIGH
        );
        complete.setDescription("会话输出完成后提醒");
        complete.setShowBadge(true);
        manager.createNotificationChannel(complete);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE
            : 0;
        PendingIntent openIntent = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | immutable
        );

        Intent stop = new Intent(this, ConnectionService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(
            this,
            1,
            stop,
            PendingIntent.FLAG_UPDATE_CURRENT | immutable
        );

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder
            .setContentTitle("omp mobile 保持连接")
            .setContentText("切到后台或锁屏时保持连接，会话完成后提醒")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(openIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "停止后台连接",
                stopIntent
            )
            .build();
    }

    private static String readString(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
