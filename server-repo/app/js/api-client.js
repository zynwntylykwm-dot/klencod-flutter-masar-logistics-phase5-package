/**
 * api-client.js — طبقة البيانات (المرحلة 1)
 * ------------------------------------------
 * كل اتصال بالخادم يمر من هنا. الواجهة الأصلية تبقى كما هي:
 *  - إن كان الخادم متاحًا: تُقرأ/تُكتب البيانات مركزياً مع مصادقة حقيقية.
 *  - إن لم يكن متاحًا: يعمل النظام بوضعه المحلي السابق دون أي تعطيل.
 */
(function () {
  'use strict';

  const LS_ACCESS = 'masar.access';
  const LS_REFRESH = 'masar.refresh';
  const BASE = (window.MASAR_API_BASE || '').replace(/\/$/, '');

  let accessToken = localStorage.getItem(LS_ACCESS) || null;
  let refreshToken = localStorage.getItem(LS_REFRESH) || null;
  let online = null; // null = لم يُفحص بعد

  function setTokens(t) {
    if (t && t.access_token) { accessToken = t.access_token; localStorage.setItem(LS_ACCESS, accessToken); }
    if (t && t.refresh_token) { refreshToken = t.refresh_token; localStorage.setItem(LS_REFRESH, refreshToken); }
  }
  function clearTokens() {
    accessToken = null; refreshToken = null;
    localStorage.removeItem(LS_ACCESS); localStorage.removeItem(LS_REFRESH);
  }

  class ApiError extends Error {
    constructor(message, status, payload) { super(message); this.status = status; this.payload = payload; }
  }

  async function raw(path, opts) {
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    return { res, data };
  }

  async function request(path, { method = 'GET', body = null, auth = true, retry = true } = {}) {
    const headers = { 'accept': 'application/json' };
    if (body !== null) headers['content-type'] = 'application/json';
    if (auth && accessToken) headers['authorization'] = 'Bearer ' + accessToken;

    let out;
    try {
      out = await raw(path, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
    } catch (e) {
      online = false;
      throw new ApiError('الخادم غير متاح: ' + e.message, 0, null);
    }
    online = true;

    if (out.res.status === 401 && auth && retry && refreshToken) {
      const refreshed = await tryRefresh();
      if (refreshed) return request(path, { method, body, auth, retry: false });
    }
    if (!out.res.ok) throw new ApiError(out.data?.error || 'فشل الطلب (' + out.res.status + ')', out.res.status, out.data);
    return out.data;
  }

  async function tryRefresh() {
    if (!refreshToken) return false;
    try {
      const out = await raw('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }) });
      if (!out.res.ok) { clearTokens(); return false; }
      setTokens(out.data);
      return true;
    } catch (_) { return false; }
  }

  const API = {
    get online() { return online; },
    get hasSession() { return !!accessToken; },
    ApiError,

    async health() {
      try {
        const out = await raw('/api/health', { method: 'GET' });
        online = out.res.ok;
        return out.res.ok ? out.data : null;
      } catch (_) { online = false; return null; }
    },

    async login(identifier, password) {
      const data = await request('/api/auth/login', { method: 'POST', body: { identifier, password }, auth: false });
      setTokens(data); return data;
    },
    async register(payload) {
      return request('/api/auth/register', { method: 'POST', body: payload, auth: false });
    },
    async me() { return request('/api/auth/me'); },
    async changePassword(current_password, new_password) {
      return request('/api/auth/change-password', { method: 'POST', body: { current_password, new_password } });
    },
    async logout() {
      try { await request('/api/auth/logout', { method: 'POST', body: { refresh_token: refreshToken } }); } catch (_) {}
      clearTokens();
    },

    // شحنات
    async shipments(params = {}) {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
      return request('/api/shipments' + (qs ? '?' + qs : ''));
    },
    async createShipment(ship) { return request('/api/shipments', { method: 'POST', body: ship }); },
    async updateShipment(code, patch) { return request('/api/shipments/' + encodeURIComponent(code), { method: 'PATCH', body: patch }); },

    // مستخدمون (إدارة)
    async users() { return request('/api/users'); },
    async patchUser(id, patch) { return request('/api/users/' + id, { method: 'PATCH', body: patch }); },

    // مفضلة وتقييمات
    async favorites() { return request('/api/favorites'); },
    async addFavorite(item_type, item_id, meta) { return request('/api/favorites', { method: 'POST', body: { item_type, item_id, meta } }); },
    async removeFavorite(item_type, item_id) { return request('/api/favorites/' + encodeURIComponent(item_type) + '/' + encodeURIComponent(item_id), { method: 'DELETE' }); },
    async reviews(item_type, item_id) { return request('/api/reviews?' + new URLSearchParams({ item_type, item_id })); },
    async addReview(item_type, item_id, rating, comment) { return request('/api/reviews', { method: 'POST', body: { item_type, item_id, rating, comment } }); },

    // إشعارات
    async notifications() { return request('/api/notifications'); },
    async markNotificationsRead(id) { return request('/api/notifications/read', { method: 'POST', body: id ? { id } : {} }); },

    // بيانات حية
    async live(kind) { return request('/api/live/' + kind, { auth: false }); },

    // إدارة
    async stats() { return request('/api/admin/stats'); },
    async auditLog() { return request('/api/admin/audit'); },
    async importLegacy(payload) { return request('/api/admin/import', { method: 'POST', body: payload }); },

    /** الاشتراك في البث اللحظي (SSE) */
    stream(topics, handlers = {}) {
      if (!accessToken) return null;
      const url = BASE + '/api/stream?topics=' + encodeURIComponent(topics.join(',')) + '&token=' + encodeURIComponent(accessToken);
      let es;
      try { es = new EventSource(url); } catch (_) { return null; }
      es.addEventListener('hello', (e) => { try { handlers.hello && handlers.hello(JSON.parse(e.data)); } catch (_) {} });
      for (const [evt, fn] of Object.entries(handlers)) {
        if (evt === 'hello') continue;
        es.addEventListener(evt, (e) => { try { fn(JSON.parse(e.data)); } catch (_) {} });
      }
      es.onerror = () => { if (handlers.error) handlers.error(); };
      return es;
    }
  };

  window.API = API;
})();
