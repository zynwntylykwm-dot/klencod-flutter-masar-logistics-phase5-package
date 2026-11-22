package com.almasar.logistics;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * تطبيق «المسار العالمي اللوجستي» — غلاف أندرويد رسمي للواجهة الكاملة.
 *
 * • الواجهة كاملة (HTML/JS) مضمّنة داخل التطبيق، تعمل بلا إنترنت.
 * • تُقدَّم عبر خادم محلي داخلي (http://127.0.0.1) لضمان عمل الجلسة والتخزين المحلي وfetch بشكل صحيح.
 * • عنوان خادم النظام (Node) يُطلب عند أول تشغيل ويُحفظ، ويمكن تغييره من زر ⚙ أعلى الشاشة.
 *   المزايدات والمصادقة والمحفظة تحتاج هذا الخادم؛ بدونه تعمل الواجهة في وضعها المحلي فقط.
 */
public class MainActivity extends Activity {

    private WebView web;
    private AssetServer server;
    private SharedPreferences prefs;
    private String currentOrigin;

    private static final String PREF_SERVER = "masar_server_url";
    private static final String PREF_ASKED = "masar_server_asked";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("masar", MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a2540"));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadsImagesAutomatically(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // الروابط الخارجية تُفتح في المتصفح، والبقية داخل التطبيق
                if (url != null && currentOrigin != null && url.startsWith(currentOrigin)) return false;
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); return true; } catch (Exception ignored) {}
                }
                return false;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // زر إعدادات الخادم (صغير، شبه شفاف، أعلى اليسار)
        TextView gear = new TextView(this);
        gear.setText("⚙");
        gear.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        gear.setTextColor(Color.WHITE);
        gear.setGravity(Gravity.CENTER);
        gear.setBackgroundColor(Color.parseColor("#99123c63"));
        int pad = dp(6);
        gear.setPadding(pad, 0, pad, 0);
        FrameLayout.LayoutParams glp = new FrameLayout.LayoutParams(dp(34), dp(34));
        glp.gravity = Gravity.TOP | Gravity.LEFT;
        glp.leftMargin = dp(8);
        glp.topMargin = dp(30);
        gear.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { askServer(true); }
        });
        root.addView(gear, glp);

        setContentView(root);

        try {
            server = new AssetServer(this, "www");
            currentOrigin = "http://127.0.0.1:" + server.getPort();
            server.start();
        } catch (Exception e) {
            Toast.makeText(this, "تعذّر بدء الخادم الداخلي: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }

        if (!prefs.getBoolean(PREF_ASKED, false)) {
            askServer(false);
        } else {
            loadApp();
        }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private void loadApp() {
        if (currentOrigin == null) return;
        String srv = prefs.getString(PREF_SERVER, "");
        String url = currentOrigin + "/index.html";
        if (srv != null && srv.length() > 0) url += "?srv=" + Uri.encode(srv);
        web.loadUrl(url);
    }

    /**
     * تطبيع عنوان الخادم:
     *  - نطاق عام بلا بروتوكول ⇒ https (ولا يُضاف :8080 إطلاقًا)
     *  - عنوان شبكة محلية / محاكي ⇒ http كما هو
     *  - حذف أي / في النهاية
     */
    private String normalizeServer(String raw) {
        String v = raw == null ? "" : raw.trim();
        if (v.length() == 0) return "";
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        String lower = v.toLowerCase();
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            String host = v.split("/")[0].split(":")[0];
            boolean local = host.startsWith("localhost") || host.startsWith("127.") || host.startsWith("10.")
                    || host.startsWith("192.168.") || host.startsWith("169.254.") || host.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*");
            v = (local ? "http://" : "https://") + v;
        }
        // إزالة المنافذ الافتراضية فقط
        if (v.toLowerCase().startsWith("https://")) v = v.replaceFirst("^https://([^/:]+):443(/|$)", "https://$1$2");
        if (v.toLowerCase().startsWith("http://")) v = v.replaceFirst("^http://([^/:]+):80(/|$)", "http://$1$2");
        // نطاق عام عبر http ⇒ يُرفع إلى https (أندرويد يمنع النص الصريح افتراضيًا)
        if (v.toLowerCase().startsWith("http://")) {
            String host = v.substring(7).split("/")[0].split(":")[0];
            boolean local = host.startsWith("localhost") || host.startsWith("127.") || host.startsWith("10.")
                    || host.startsWith("192.168.") || host.startsWith("169.254.") || host.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*");
            if (!local && host.contains(".")) v = "https://" + v.substring(7);
        }
        return v;
    }

    /** نافذة إدخال عنوان خادم النظام (Node) */
    private void askServer(final boolean canCancel) {
        final EditText input = new EditText(this);
        input.setHint("https://YOUR-SERVICE.onrender.com");
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(prefs.getString(PREF_SERVER, ""));
        input.setTextDirection(View.TEXT_DIRECTION_LTR);
        input.setGravity(Gravity.LEFT);

        new AlertDialog.Builder(this)
                .setTitle("عنوان خادم النظام")
                .setMessage("رابط خادم Node الخاص بنظام «المسار العالمي اللوجستي».\n\n"
                        + "• رابط عام (HTTPS): https://YOUR-SERVICE.onrender.com\n"
                        + "  استبدله برابط خادمك — بدون :8080\n"
                        + "• شبكة محلية: http://192.168.1.10:8080\n"
                        + "• اتركه فارغًا للعمل محليًا بدون خادم.\n\n"
                        + "تحقّق أولًا في المتصفح: الرابط + /health")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("حفظ ومتابعة", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        String v = normalizeServer(input.getText().toString());
                        prefs.edit().putString(PREF_SERVER, v).putBoolean(PREF_ASKED, true).apply();
                        loadApp();
                    }
                })
                .setNeutralButton("بدون خادم الآن", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        prefs.edit().putString(PREF_SERVER, "").putBoolean(PREF_ASKED, true).apply();
                        loadApp();
                    }
                })
                .show();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (web != null) { web.loadUrl("about:blank"); web.destroy(); }
        super.onDestroy();
    }
}
