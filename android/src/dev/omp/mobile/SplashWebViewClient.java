package dev.omp.mobile;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPInputStream;

final class SplashWebViewClient extends WebViewClient {
    private static final String COLLAB_HOST = "my.omp.sh";
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 15_000;
    private static final String COLLAB_RULES =
        ".sh-toasts{position:fixed!important;"
        + "top:calc(env(safe-area-inset-top,0px) + 88px)!important;bottom:auto!important;"
        + "left:50%!important;right:auto!important;transform:translateX(-50%)!important;"
        + "z-index:20!important;pointer-events:none!important;"
        + "max-width:calc(100% - 24px)!important}"
        + ".sh-composer{padding:0 12px calc(12px + env(safe-area-inset-bottom,0px))!important}"
        + ".sh-composer-inner{border-radius:18px!important;"
        + "border:1px solid rgba(124,156,255,.22)!important;"
        + "background:linear-gradient(180deg,#151a24,#0d1118)!important;"
        + "box-shadow:0 10px 28px rgba(0,0,0,.45)!important;"
        + "padding:10px 10px 10px 14px!important;gap:10px!important}"
        + ".sh-composer-inner:focus-within{border-color:rgba(124,156,255,.55)!important;"
        + "box-shadow:0 0 0 3px rgba(124,156,255,.16),0 10px 28px rgba(0,0,0,.45)!important}"
        + ".sh-composer-input{font-size:15px!important;line-height:22px!important;"
        + "padding:4px 0!important;field-sizing:content!important;"
        + "max-height:40dvh!important;overflow-y:auto!important}"
        + ".sh-composer-input::placeholder{color:transparent!important;opacity:0!important}"
        + ".sh-composer-input::-webkit-input-placeholder{color:transparent!important;"
        + "opacity:0!important}"
        + ".sh-composer-actions .sh-btn{border-radius:12px!important}";
    private static final String COLLAB_STYLE =
        "<style id=\"omp-mobile-collab\">" + COLLAB_RULES + "</style>";
    private static final String COLLAB_SCRIPT =
        "<script id=\"omp-mobile-collab-js\">(function(){"
        + "function grow(el){"
        + "var max=Math.round(window.innerHeight*0.4);"
        + "el.style.setProperty('height','auto','important');"
        + "var h=Math.min(el.scrollHeight,max);"
        + "el.style.setProperty('height',h+'px','important');}"
        + "var trimmed=new WeakSet();"
        + "function trim(){document.querySelectorAll('.sh-toasts > *').forEach(function(el){"
        + "if(trimmed.has(el))return;trimmed.add(el);"
        + "setTimeout(function(){el.style.setProperty('display','none','important');},750);});}"
        + "function fix(){"
        + "document.querySelectorAll('.sh-toasts').forEach(function(el){"
        + "el.style.setProperty('position','fixed','important');"
        + "el.style.setProperty('top','calc(env(safe-area-inset-top,0px) + 88px)','important');"
        + "el.style.setProperty('bottom','auto','important');"
        + "el.style.setProperty('left','50%','important');"
        + "el.style.setProperty('right','auto','important');"
        + "el.style.setProperty('transform','translateX(-50%)','important');"
        + "el.style.setProperty('z-index','20','important');"
        + "el.style.setProperty('pointer-events','none','important');});"
        + "trim();"
        + "document.querySelectorAll('.sh-composer-input').forEach(function(el){"
        + "el.removeAttribute('placeholder');"
        + "if(el.dataset.ompGrow)return;el.dataset.ompGrow='1';"
        + "el.addEventListener('input',function(){grow(el);"
        + "requestAnimationFrame(function(){grow(el);});});"
        + "grow(el);});}"
        + "var pending=false;"
        + "function schedule(){if(pending)return;pending=true;"
        + "requestAnimationFrame(function(){pending=false;fix();});}"
        + "var observer=new MutationObserver(schedule);"
        + "observer.observe(document.documentElement,{childList:true,subtree:true});"
        + "window.addEventListener('resize',schedule);"
        + "fix();})();</script>";

    private static final String READY_SCRIPT =
        "<script id=\"omp-mobile-ready-js\">(function(){"
        + "var sent=false;"
        + "function ready(){if(sent)return;"
        + "var el=document.querySelector('textarea.sh-composer-input');"
        + "if(!el||el.disabled||el.readOnly)return;"
        + "var ph=(el.getAttribute('placeholder')||'').toLowerCase();"
        + "if(ph.indexOf('waiting for the session')>=0||ph.indexOf('read-only')>=0)return;"
        + "sent=true;try{window.parent.postMessage({type:'omp-collab-ready'},'*')}catch(e){}}"
        + "var observer=new MutationObserver(ready);"
        + "observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,"
        + "attributeFilter:['disabled','readonly','placeholder']});"
        + "setInterval(ready,1000);ready();})();</script>";

    private final Runnable onPageFinished;

    SplashWebViewClient(Runnable onPageFinished) {
        this.onPageFinished = onPageFinished;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        onPageFinished.run();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        try {
            Uri uri = request.getUrl();
            if (uri == null || !"GET".equalsIgnoreCase(request.getMethod())) return null;
            if (!COLLAB_HOST.equalsIgnoreCase(uri.getHost())) return null;
            String path = uri.getPath();
            if (path == null) return null;
            if (path.endsWith(".css")) {
                String css = fetchText(view, uri, "text/css,*/*;q=0.1");
                if (css == null) return null;
                String injected = css + "\n" + COLLAB_RULES;
                return new WebResourceResponse(
                    "text/css",
                    "utf-8",
                    new ByteArrayInputStream(injected.getBytes(StandardCharsets.UTF_8))
                );
            }
            if (!"/".equals(path) && !"/index.html".equals(path)) return null;
            String html = fetchText(view, uri, "text/html,application/xhtml+xml");
            if (html == null || !html.contains("</head>")) return null;
            String injected = html.replace(
                "</head>",
                COLLAB_STYLE + COLLAB_SCRIPT + READY_SCRIPT + "</head>"
            );
            return new WebResourceResponse(
                "text/html",
                "utf-8",
                new ByteArrayInputStream(injected.getBytes(StandardCharsets.UTF_8))
            );
        } catch (Exception error) {
            return null;
        }
    }

    private static String fetchText(WebView view, Uri uri, String accept) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(uri.toString()).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("User-Agent", view.getSettings().getUserAgentString());
        connection.setRequestProperty("Accept", accept);
        connection.setRequestProperty("Accept-Encoding", "identity");
        try {
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            String encoding = connection.getContentEncoding();
            if (encoding != null
                && !"gzip".equalsIgnoreCase(encoding)
                && !"identity".equalsIgnoreCase(encoding)) {
                return null;
            }
            InputStream input = connection.getInputStream();
            if ("gzip".equalsIgnoreCase(encoding)) input = new GZIPInputStream(input);
            try {
                return readAll(input);
            } finally {
                input.close();
            }
        } finally {
            connection.disconnect();
        }
    }

    private static String readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
