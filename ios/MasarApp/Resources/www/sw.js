/**
 * sw.js — Service Worker: تثبيت التطبيق + استقبال إشعارات الدفع
 * ------------------------------------------------------------
 * • تخزين مؤقت لهيكل الواجهة فقط (index.html + ملفات js) للعمل بسرعة وبلا إنترنت.
 * • طلبات /api تمرّ دائمًا إلى الشبكة (لا تُخزَّن بيانات المستخدم أبدًا).
 * • push: يعرض الإشعار، وnotificationclick: يفتح الشاشة المستهدفة.
 */
const CACHE = 'masar-shell-v3';
const SHELL = ['./', './index.html', './js/app-config.js', './js/api-client.js', './js/phase1.js', './js/auctions.js', './js/admin.js', './js/pwa.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/')) return; // الشبكة دائمًا للـAPI
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'المسار العالمي اللوجستي', body: 'لديك إشعار جديد', url: '/' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (_) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    vibrate: [80, 40, 80],
    data: { url: data.url || '/' },
    tag: data.campaign_id || 'masar'
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  }));
});
