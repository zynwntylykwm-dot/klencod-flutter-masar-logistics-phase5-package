/**
 * app-config.js — إعداد عنوان الخادم (يُستخدم في تطبيق الأندرويد والآيفون والويب)
 * ------------------------------------------------------------------------------
 * يقبل أي شكل من العناوين ويُطبّعه بشكل صحيح:
 *   https://masar-api.onrender.com        → يبقى كما هو (بلا :8080 ولا :443)
 *   masar-api.onrender.com                → https://masar-api.onrender.com   (نطاق ⇒ https)
 *   192.168.1.10:8080                     → http://192.168.1.10:8080        (شبكة محلية ⇒ http)
 *   http://192.168.1.10:8080/             → http://192.168.1.10:8080        (حذف الشرطة الأخيرة)
 *   10.0.2.2:8080                         → http://10.0.2.2:8080            (محاكي أندرويد)
 * لا يُضاف منفذ من تلقاء نفسه إطلاقًا؛ إن أردت 8080 اكتبه صريحًا.
 */
(function () {
  'use strict';
  var KEY = 'masar.api_base';
  var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var set = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };

  var LOOPBACK = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\])/i;

  /** تطبيع عنوان الخادم — الدالة المرجعية الوحيدة */
  function normalize(raw) {
    if (raw === null || raw === undefined) return '';
    var v = String(raw).trim();
    if (!v) return '';
    v = v.replace(/\/+$/, '');                       // لا شرطة في النهاية
    v = v.replace(/^(https?):\/\//i, function (m, p) { return p.toLowerCase() + '://'; });

    var hasScheme = /^https?:\/\//i.test(v);
    if (!hasScheme) {
      // بلا بروتوكول: https للنطاقات العامة، http للشبكة المحلية والمحاكي
      var hostPart = v.split('/')[0].split(':')[0];
      v = (LOOPBACK.test(hostPart) ? 'http://' : 'https://') + v;
    }
    var https = /^https:\/\//i.test(v);

    // حذف المنافذ الافتراضية فقط (:443 لـ https و :80 لـ http) — والإبقاء على أي منفذ آخر
    v = v.replace(/^https:\/\/([^/:]+):443(\/|$)/i, 'https://$1$2');
    v = v.replace(/^http:\/\/([^/:]+):80(\/|$)/i, 'http://$1$2');

    // تحذير: http مع نطاق عام (قد يمنعه Android/iOS) — نرفعه إلى https تلقائيًا إلا لو محليًا
    if (/^http:\/\//i.test(v)) {
      var host = v.slice(7).split('/')[0].split(':')[0];
      if (!LOOPBACK.test(host) && /\./.test(host)) v = 'https://' + v.slice(7);
    }
    return v.replace(/\/+$/, '');
  }

  /** فحص سريع لصلاحية العنوان */
  function validate(raw) {
    var v = normalize(raw);
    if (!v) return { ok: false, value: '', error: 'العنوان فارغ' };
    try {
      var u = new URL(v);
      if (!/^https?:$/.test(u.protocol)) return { ok: false, value: v, error: 'البروتوكول يجب أن يكون http أو https' };
      if (!u.hostname) return { ok: false, value: v, error: 'اسم المضيف مفقود' };
      return { ok: true, value: v, secure: u.protocol === 'https:', host: u.hostname, port: u.port || '' };
    } catch (e) {
      return { ok: false, value: v, error: 'عنوان غير صالح' };
    }
  }

  var param = null;
  try { param = new URLSearchParams(location.search).get('srv'); } catch (e) {}
  if (param) set(KEY, normalize(param));

  var saved = get(KEY);
  if (saved) window.MASAR_API_BASE = normalize(saved);

  window.MASAR_NORMALIZE_SERVER = normalize;
  window.MASAR_VALIDATE_SERVER = validate;
  window.MASAR_SERVER_KEY = KEY;
  window.MASAR_GET_SERVER = function () { return get(KEY) || ''; };

  window.MASAR_SET_SERVER = function (url) {
    if (!url) { try { localStorage.removeItem(KEY); } catch (e) {} window.MASAR_API_BASE = ''; return ''; }
    var clean = normalize(url);
    set(KEY, clean); window.MASAR_API_BASE = clean;
    return clean;
  };

  /** عنوان فحص الصحة للاتصال الحالي */
  window.MASAR_HEALTH_URL = function () { return (window.MASAR_API_BASE || '') + '/health'; };
})();
