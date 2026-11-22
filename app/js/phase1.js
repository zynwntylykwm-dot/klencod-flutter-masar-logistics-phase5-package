/**
 * phase1.js — دمج الخادم مع الواجهة الأصلية (المرحلة 1)
 * ------------------------------------------------------
 * القواعد الحاكمة:
 *  1) لا يُغيَّر أي عنصر تصميم أو صفحة موجودة — كل الإضافات عناصر جديدة صغيرة.
 *  2) كل شيء داخل try/catch: إن فشل أي جزء يعمل النظام المحلي كما كان.
 *  3) لا تُعرض أي بيانات على أنها حقيقية: كل رقم حي يُرفق بمصدره ووقت جلبه.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = () => window.__app;
  const API = window.API;
  if (!API) return;

  let server = null;          // نتيجة /api/health
  let currentUser = null;     // مستخدم الخادم الحالي
  let es = null;              // EventSource
  let lastShipmentsHash = '';

  // ============================ مؤشر الحالة ============================
  function ensureStatusChip() {
    let el = $('masarServerChip');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'masarServerChip';
    el.style.cssText = [
      'position:fixed', 'bottom:86px', 'left:10px', 'z-index:9999',
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'padding:6px 11px', 'border-radius:20px', 'font-size:11px', 'font-weight:700',
      'font-family:Cairo,sans-serif', 'box-shadow:0 4px 14px rgba(0,0,0,.18)',
      'cursor:pointer', 'transition:all .2s', 'direction:rtl'
    ].join(';');
    el.title = 'حالة الاتصال بخادم البيانات';
    el.onclick = () => showServerDetails();
    document.body.appendChild(el);
    return el;
  }

  function paintStatus() {
    const el = ensureStatusChip();
    const ships = (app() && app().shipments) || [];
    const demoCount = ships.filter((s) => s.demo).length;
    if (!server) {
      el.style.background = '#6b7280'; el.style.color = '#fff';
      el.innerHTML = '● وضع محلي — الخادم غير متاح';
      el.title = 'يعمل النظام بالبيانات المحلية في هذا المتصفح فقط';
    } else {
      el.style.background = currentUser ? '#065f46' : '#1a4a7a';
      el.style.color = '#fff';
      const dataNote = ships.length ? (demoCount === ships.length ? ` · بيانات تجريبية (${demoCount})` : ` · ${ships.length} شحنة`) : '';
      el.innerHTML = (currentUser ? '● متصل بالخادم' : '● الخادم متاح — سجّل الدخول') + dataNote;
      el.title = `الخادم ${server.version} · التخزين ${server.storage} · ${server.shipments} شحنة في القاعدة`;
    }
  }

  async function showServerDetails() {
    const lines = [];
    lines.push('<div style="font-size:13px;line-height:2">');
    lines.push(`<b>الخادم:</b> ${server ? 'متاح ✅' : 'غير متاح ⛔'}`);
    if (server) {
      lines.push(`<b>الإصدار:</b> ${server.version}<br><b>التخزين:</b> ${server.storage}<br><b>مدة التشغيل:</b> ${server.uptime_s} ثانية`);
      lines.push(`<b>المستخدمون:</b> ${server.users} · <b>الشحنات:</b> ${server.shipments}`);
      lines.push(`<b>الجلسة:</b> ${currentUser ? currentUser.fullName + ' (' + currentUser.role + ')' : 'غير مسجّل'}`);
    } else {
      lines.push('النظام يعمل الآن محليًا: البيانات محفوظة في هذا المتصفح فقط ولا تُزامَن مع أجهزة أخرى.');
      lines.push('لتشغيل الخادم: <code style="direction:ltr;display:inline-block">node server/server.js</code>');
    }
    lines.push('</div>');
    try {
      $('modalTitle').innerHTML = '🛰️ حالة النظام والبيانات';
      $('modalBody').innerHTML = lines.join('');
      $('modal').classList.add('show');
    } catch (_) { alert(lines.join('').replace(/<[^>]+>/g, '')); }
  }

  // ============================ فتح النظام بعد دخول الخادم ============================
  function openAppAs(user) {
    const a = app(); if (!a) return false;
    currentUser = user;
    a.currentUser = {
      id: user.id, fullName: user.fullName, email: user.email, phone: user.phone,
      role: user.role, status: user.status, username: user.username
    };
    window.userData = window.userData || {};
    window.userData.name = user.fullName;
    window.userData.email = user.email;
    window.userData.phone = user.phone || '';
    window.userData.avatar = (user.fullName || 'م').charAt(0);
    window.userData.memberId = user.id;

    const overlay = $('loginOverlay');
    const container = $('appContainer');
    if (overlay) overlay.style.display = 'none';
    if (container) container.style.display = 'block';

    try { a.applyUserDataToUI(); } catch (_) {}
    try { a.applyPermissions && a.applyPermissions(); } catch (_) {}
    try { if (typeof window.saveUserData === 'function') window.saveUserData(); } catch (_) {}
    try { if (typeof window.refreshAllPages === 'function') window.refreshAllPages(); } catch (_) {}
    try { if (typeof window.showToast === 'function') window.showToast('مرحباً ' + user.fullName + ' (جلسة آمنة عبر الخادم)'); } catch (_) {}
    paintStatus();
    return true;
  }

  // ============================ مزامنة الشحنات ============================
  function hashOf(items) {
    return items.map((s) => s.trackingNumber + ':' + (s.status || '') + ':' + (s.updated_at || s.updatedAt || '')).join('|');
  }

  async function hydrateShipments(silent) {
    if (!currentUser) return;
    try {
      const data = await API.shipments({ limit: 200 });
      const items = data.items || [];
      const h = hashOf(items);
      if (h === lastShipmentsHash) return;
      lastShipmentsHash = h;
      const a = app();
      a.shipments = items;
      a.saveShipments();
      if (typeof window.refreshAllPages === 'function') {
        try { window.refreshAllPages(); } catch (_) {}
      } else {
        try { a.displayShipments('all'); } catch (_) {}
      }
      if (!silent) {
        const demo = items.filter((s) => s.demo).length;
        try { window.showToast(`🔗 تمت مزامنة ${items.length} شحنة من الخادم${demo ? ' (' + demo + ' تجريبية)' : ''}`); } catch (_) {}
      }
      paintStatus();
    } catch (e) {
      if (e.status === 401) { /* الجلسة انتهت */ }
    }
  }

  // ============================ البث اللحظي ============================
  function startRealtime() {
    if (!currentUser || es) return;
    try {
      es = API.stream(['shipments', 'notifications:' + currentUser.id], {
        shipment_created: (msg) => {
          try { window.showToast('📦 شحنة جديدة: ' + (msg.payload?.trackingNumber || '')); } catch (_) {}
          hydrateShipments(true);
        },
        shipment_updated: (msg) => {
          try { window.showToast('🔄 تحديث شحنة: ' + (msg.payload?.trackingNumber || '') + ' — ' + (msg.payload?.status || '')); } catch (_) {}
          hydrateShipments(true);
        },
        notification: (msg) => {
          try {
            const a = app();
            if (a && a.addNotification) a.addNotification('🔔', msg.payload?.title || 'إشعار');
            if (a && a.loadNotifications) a.loadNotifications();
            window.showToast('🔔 ' + (msg.payload?.title || 'إشعار جديد'));
          } catch (_) {}
          // إشعار نظام المتصفح (حقيقي) عند السماح
          try {
            if (window.Notification && Notification.permission === 'granted') {
              new Notification('المسار العالمي اللوجستي', { body: msg.payload?.title || 'إشعار جديد' });
            }
          } catch (_) {}
        },
        error: () => { es = null; }
      });
      if (es && window.Notification && Notification.permission === 'default') {
        // لا نُزعج المستخدم بطلب فوري؛ يُطلب عند أول تفاعل
        document.addEventListener('click', function askOnce() {
          document.removeEventListener('click', askOnce);
          try { Notification.requestPermission(); } catch (_) {}
        }, { once: true });
      }
    } catch (_) { es = null; }
  }

  // ============================ الشريط الحي ============================
  function ago(iso) {
    if (!iso) return 'غير معروف';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'قبل ثوانٍ';
    if (s < 3600) return `قبل ${Math.round(s / 60)} دقيقة`;
    if (s < 86400) return `قبل ${Math.round(s / 3600)} ساعة`;
    return `قبل ${Math.round(s / 86400)} يوم`;
  }

  function liveShell(inner) {
    let card = $('masarLiveCard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'masarLiveCard';
      card.className = 'calculator-card';
      card.style.marginTop = '14px';
      const main = $('mainPage');
      const anchor = $('promoBanner');
      if (main) main.insertBefore(card, anchor ? anchor.nextSibling : main.firstChild);
    }
    card.innerHTML = inner;
    return card;
  }

  function liveHeader(title, fetchedAt, source, stale) {
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <h3 style="margin:0;font-size:14px;">${title}</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:10px;color:${stale ? '#b45309' : '#047857'};background:${stale ? '#fef3c7' : '#d1fae5'};padding:2px 8px;border-radius:20px;">
            ${stale ? '⚠️ بيانات قديمة' : '● حيّ'} · ${ago(fetchedAt)}
          </span>
          <button onclick="window.__masarRefreshLive()" style="background:#0a2540;color:#fff;border:none;border-radius:10px;padding:5px 10px;font-size:11px;cursor:pointer;">تحديث</button>
        </div>
      </div>
      <div style="font-size:10px;color:#6b7280;margin:4px 0 8px;">المصدر: ${source || 'غير معروف'}</div>`;
  }

  async function renderLive() {
    if (!server) return;
    const card = liveShell(`<div style="font-size:12px;color:#6b7280;text-align:center;padding:8px;">⏳ جلب بيانات حية من المصادر…</div>`);
    const parts = [];
    let any = false;

    // أسعار الصرف
    try {
      const fx = await API.live('fx');
      any = true;
      const r = fx.rates || {};
      const pick = (k, label) => r[k] ? `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed #e5e7eb;font-size:12px;"><span>${label}</span><b>${(1 / r[k]).toFixed(2)} ${k}</b></div>` : '';
      parts.push(`<div style="margin-bottom:12px;">
        ${liveHeader('💱 أسعار الصرف (لكل 1 دولار أمريكي)', fx.fetched_at, fx.source, fx.stale)}
        ${pick('YER', '🇾🇪 الريال اليمني')}${pick('SAR', '🇸🇦 الريال السعودي')}${pick('AED', '🇦🇪 الدرهم الإماراتي')}${pick('OMR', '🇴🇲 الريال العماني')}
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;">تاريخ سعر الصرف لدى المصدر: ${fx.rate_date || '—'}${fx.note ? ' · ' + fx.note : ''}</div>
      </div>`);
    } catch (e) {
      parts.push(`<div style="font-size:11px;color:#b91c1c;margin-bottom:8px;">💱 تعذّر جلب أسعار الصرف (${e.message}) — لا تُعرض قيم بديلة.</div>`);
    }

    // طقس ميناء عدن (أقرب ميناء للمستخدم)
    try {
      const w = await API.live('weather');
      any = true;
      const aden = (w.ports || []).find((p) => p.port_id === 'aden') || (w.ports || [])[0];
      if (aden && !aden.error) {
        parts.push(`<div style="margin-bottom:12px;">
          ${liveHeader('🌊 طقس ' + aden.port, w.fetched_at, w.source, w.stale)}
          <div style="display:flex;gap:14px;font-size:12px;flex-wrap:wrap;">
            <span>🌡️ ${aden.temperature_c ?? '—'}°م</span>
            <span>💨 ${aden.wind_kmh ?? '—'} كم/س</span>
            <span>🌊 موجة ${aden.wave_height_m ?? '—'} م</span>
          </div>
          <div style="font-size:10px;color:#9ca3af;margin-top:3px;">وقت الرصد لدى المصدر: ${aden.observed_at || '—'}</div>
        </div>`);
      }
    } catch (e) {
      parts.push(`<div style="font-size:11px;color:#b91c1c;margin-bottom:8px;">🌊 تعذّر جلب بيانات الطقس (${e.message}).</div>`);
    }

    // أخبار لوجستية
    try {
      const n = await API.live('news');
      any = true;
      const items = (n.feeds || []).flatMap((f) => (f.items || []).slice(0, 2).map((i) => ({ ...i, feed: f.feed })));
      if (items.length) {
        parts.push(`<div>
          ${liveHeader('📰 أخبار الشحن والسلاسل اللوجستية', n.fetched_at, n.source, n.stale)}
          ${items.slice(0, 4).map((i) => `
            <a href="${i.link}" target="_blank" rel="noopener noreferrer" style="display:block;font-size:12px;color:#0a2540;text-decoration:none;padding:4px 0;border-bottom:1px dashed #e5e7eb;">
              • ${i.title}
              <span style="display:block;font-size:10px;color:#9ca3af;">${i.feed}${i.pubDate ? ' · ' + new Date(i.pubDate).toLocaleString('ar-EG') : ''}</span>
            </a>`).join('')}
        </div>`);
      }
    } catch (e) {
      parts.push(`<div style="font-size:11px;color:#b91c1c;">📰 تعذّر جلب الأخبار (${e.message}).</div>`);
    }

    card.innerHTML = parts.length ? parts.join('') : `<div style="font-size:12px;color:#b91c1c;">لا توجد بيانات حية متاحة حاليًا.</div>`;
    if (any) { /* تم */ }
  }
  window.__masarRefreshLive = () => { renderLive(); };

  // ============================ اعتراض الدخول والتسجيل ============================
  function wrapLegacy() {
    // تسجيل الدخول: الخادم أولًا، والمحلي كبديل
    const legacyLogin = window.performLogin;
    window.performLogin = async function () {
      const identifier = ($('loginIdentifier')?.value || '').trim();
      const password = $('loginPassword')?.value || '';
      const errDiv = $('loginError');
      const showErr = (m) => { if (errDiv) { errDiv.innerText = m; errDiv.style.display = 'block'; } };

      if (!server) return legacyLogin ? legacyLogin() : undefined;
      if (!identifier || !password) return showErr('الرجاء إدخال اسم المستخدم/البريد/الهاتف وكلمة المرور');

      try {
        const data = await API.login(identifier, password);
        if (errDiv) errDiv.style.display = 'none';
        openAppAs(data.user);
        await hydrateShipments(true);
        startRealtime();
        try { await API.markNotificationsRead(); } catch (_) {}
        return;
      } catch (e) {
        if (e.status === 0) return legacyLogin ? legacyLogin() : undefined; // الخادم سقط → الوضع المحلي
        return showErr(e.message || 'بيانات الدخول غير صحيحة');
      }
    };

    // إنشاء حساب: عبر الخادم عند توفره (يذهب لطلب موافقة)
    const legacyRegister = window.registerNewUser;
    window.registerNewUser = async function () {
      const errDiv = $('registerError');
      const showErr = (m) => { if (errDiv) { errDiv.innerText = m; errDiv.style.display = 'block'; } };
      if (!server) return legacyRegister ? legacyRegister() : undefined;
      const payload = {
        fullName: ($('regFullName')?.value || '').trim(),
        email: ($('regEmail')?.value || '').trim(),
        phone: ($('regPhone')?.value || '').trim(),
        username: ($('regUsername')?.value || '').trim(),
        password: $('regPassword')?.value || '',
        role: $('regRole')?.value || 'user',
        idNumber: ($('regIdNumber')?.value || '').trim(),
        commercialReg: ($('regCommercialReg')?.value || '').trim()
      };
      if ($('regPassword')?.value !== $('regConfirmPassword')?.value) return showErr('كلمة المرور وتأكيدها غير متطابقتين');
      try {
        await API.register(payload);
        if (errDiv) errDiv.style.display = 'none';
        try { window.showToast('✅ تم إنشاء الطلب على الخادم — بانتظار موافقة الإدارة'); } catch (_) {}
        if (typeof window.showLoginForm === 'function') window.showLoginForm();
      } catch (e) {
        if (e.status === 0) return legacyRegister ? legacyRegister() : undefined;
        showErr(e.message);
      }
    };

    // تغيير كلمة المرور من الإعدادات: عبر الخادم إن كان مسجلًا
    const legacyChange = window.changePassword;
    window.changePassword = async function () {
      if (!server || !currentUser) return legacyChange ? legacyChange() : undefined;
      const cur = $('currentPassword')?.value, np = $('newPassword')?.value, cp = $('confirmPassword')?.value;
      if (!cur || !np) return window.showToast('الرجاء ملء جميع الحقول');
      if (np !== cp) return window.showToast('كلمات المرور غير متطابقة');
      try {
        await API.changePassword(cur, np);
        window.showToast('✅ تم تغيير كلمة المرور على الخادم');
        ['currentPassword', 'newPassword', 'confirmPassword'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
      } catch (e) { window.showToast('❌ ' + e.message); }
    };

    // تسجيل الخروج
    const legacyLogout = window.performLogout;
    window.performLogout = async function () {
      try { if (currentUser) await API.logout(); } catch (_) {}
      currentUser = null; es = null;
      if (legacyLogout) legacyLogout();
      paintStatus();
    };
  }

  // ============================ الإقلاع ============================
  async function boot() {
    try {
      server = await API.health();
      paintStatus();
      if (!server) return; // وضع محلي كما كان

      wrapLegacy();

      // جلسة سابقة؟
      if (API.hasSession) {
        try {
          const me = await API.me();
          openAppAs(me.user);
          await hydrateShipments(true);
          startRealtime();
        } catch (_) { /* جلسة منتهية → تبقى شاشة الدخول */ }
      }

      // إعادة المزامنة الدورية
      setInterval(() => {
        if (currentUser && document.visibilityState === 'visible') hydrateShipments(true);
      }, 20000);
      setInterval(() => {
        if (currentUser && document.visibilityState === 'visible') renderLive();
      }, 5 * 60 * 1000);

      // الشريط الحي على الصفحة الرئيسية
      if ($('mainPage')) renderLive();
    } catch (e) {
      console.warn('[phase1] تعذّر الإقلاع:', e.message);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);

  // هوك يستدعيه النظام الأصلي في نهاية سكربته
  window.__phase1Boot = boot;
  window.MASAR = {
    get server() { return server; },
    get user() { return currentUser; },
    get api() { return API; },
    refreshShipments: () => hydrateShipments(false),
    refreshLive: renderLive,
    openAs: openAppAs
  };
})();
