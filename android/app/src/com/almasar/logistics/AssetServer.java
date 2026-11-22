package com.almasar.logistics;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Map;

/**
 * AssetServer — خادم HTTP صغير جدًا (محلي فقط) يقدّم ملفات الواجهة من مجلد assets/www
 * على 127.0.0.1 بمنفذ حر. الغرض: أصل (origin) حقيقي للواجهة يعمل مع fetch وlocalStorage
 * وSSE بشكل صحيح، دون أي مكتبة خارجية.
 */
public class AssetServer implements Runnable {

    private final AssetManager assets;
    private final String root;
    private ServerSocket socket;
    private Thread thread;
    private volatile boolean running = false;

    AssetServer(Context ctx, String rootDir) throws IOException {
        this.assets = ctx.getAssets();
        this.root = rootDir;
        this.socket = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        this.socket.setReuseAddress(true);
    }

    int getPort() { return socket.getLocalPort(); }

    void start() {
        running = true;
        thread = new Thread(this, "masar-assets");
        thread.setDaemon(true);
        thread.start();
    }

    void stop() {
        running = false;
        try { if (socket != null) socket.close(); } catch (IOException ignored) {}
    }

    @Override
    public void run() {
        while (running) {
            Socket client;
            try { client = socket.accept(); } catch (IOException e) { break; }
            try { handle(client); } catch (Exception ignored) { }
            finally { try { client.close(); } catch (IOException ignored) {} }
        }
    }

    private void handle(Socket client) throws IOException {
        InputStream in = client.getInputStream();
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        String requestLine = reader.readLine();
        if (requestLine == null) return;
        String path = "/";
        try {
            String[] parts = requestLine.split(" ");
            if (parts.length >= 2) path = parts[1];
        } catch (Exception ignored) {}
        // تجاهل الترويسات
        String line;
        while ((line = reader.readLine()) != null && line.length() > 0) { /* skip */ }

        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.startsWith("/")) path = path.substring(1);

        byte[] body;
        int status = 200;
        String mime = mimeOf(path);
        try {
            body = readAsset(root + "/" + path);
        } catch (IOException e) {
            status = 404;
            mime = "text/plain; charset=utf-8";
            body = "404 — الملف غير موجود".getBytes("UTF-8");
        }

        OutputStream out = client.getOutputStream();
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(status == 200 ? " OK" : " Not Found").append("\r\n");
        h.append("Content-Type: ").append(mime).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Cache-Control: no-cache\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        out.write(body);
        out.flush();
    }

    private byte[] readAsset(String name) throws IOException {
        InputStream is = assets.open(name);
        ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(1024, is.available()));
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return bos.toByteArray();
    }

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("txt", "text/plain; charset=utf-8");
        MIME.put("webmanifest", "application/manifest+json");
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : "";
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }
}
