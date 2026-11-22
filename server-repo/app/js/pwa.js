/**
 * pwa.js — تثبيت التطبيق + تتبّع الزوار + إشعارات الدفع (المرحلة 3)
 * ---------------------------------------------------------------
 * • يسجّل Service Worker (يعمل على أندرويد/iOS عبر «إضافة إلى الشاشة الرئيسية»).
 * • يُسجّل زيارة مجهولة للخادم (معرّف عشوائي محلي، بلا كوكيز إعلانية).
 * • يوفّر MasariPush.enable() لطلب إذن الإشعارات والاشتراك في Web Push.
 */
(function () {
  'use strict';
  const BASE = (window.MASAR_API_BASE || '').replace(/\/$/, '');
  const VKEY = 'masar.visitor_id';
  const got = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  function visitorId() {
    let v = got(VKEY);
    if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
      v = (crypto && crypto.randomUUID ? crypto.randomUUID() : 'v' + Date.now() + Math.random().toString(36).slice(2));
      put(VKEY, v);
    }
    return v;
  }

  async function track(path, screen) {
    try {
      const token = got('masar.access');
      await fetch(BASE + '/api/track/visit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ visitor_id: visitorId(), path: path || location.pathname, screen: screen || null, referrer: document.referrer || null }),
        keepalive: true
      });
    } catch (e) { /* التتبّع لا يجب أن يعطّل الواجهة */ }
  }

  // تتبّع أول تحميل + كل انتقال بين الصفحات
  track(location.pathname + location.search, 'mainPage');
  const origNav = window.navigateTo;
  if (typeof origNav === 'function') {
    window.navigateTo = function (pageId) {
      const r = origNav.apply(this, arguments);
      if (pageId) track('/' + pageId, pageId);
      return r;
    };
  }

  // تسجيل Service Worker (يُفعّل التثبيت والإشعارات)
  let swReg = null;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
    });
  }

  const MasariPush = {
    supported() {
      return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    },
    async isSubscribed() {
      if (!this.supported()) return false;
      try {
        const reg = swReg || (await navigator.serviceWorker.getRegistration());
        if (!reg) return false;
        const sub = await reg.pushManager.getSubscription();
        return !!sub;
      } catch (e) { return false; }
    },
    async enable() {
      if (!this.supported()) throw new Error('هذا المتصفح لا يدعم إشعارات الدفع. جرّب Chrome على أندرويد أو ثبّت التطبيق على الشاشة الرئيسية في iOS 16.4+.');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('لم يُمنح إذن الإشعارات');
      const keyRes = await fetch(BASE + '/api/push/public-key').then((r) => r.json());
      if (!keyRes.ok) throw new Error('تعذّر جلب مفتاح الدفع من الخادم');
      const reg = swReg || (await navigator.serviceWorker.register('sw.js'));
      await navigator.serviceWorker.ready;
      const pad = (s) => {
        s = s.replace(/-/g, '+').replace(/_/g, '/');
        return s + '='.repeat((4 - (s.length % 4)) % 4);
      };
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(atob(pad(keyRes.public_key)), (c) => c.charCodeAt(0))
      });
      const token = got('masar.access');
      const r = await fetch(BASE + '/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ ...sub.toJSON(), platform: navigator.userAgent.includes('Android') ? 'android-web' : 'web' })
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || 'تعذّر حفظ الاشتراك');
      return true;
    },
    async disable() {
      const reg = swReg || (await navigator.serviceWorker.getRegistration());
      if (!reg) return false;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return false;
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await fetch(BASE + '/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (got('masar.access') || '') },
        body: JSON.stringify({ endpoint })
      }).catch(() => {});
      return true;
    }
  };

  window.MasariPush = MasariPush;
  window.MasariTrack = track;
})();
