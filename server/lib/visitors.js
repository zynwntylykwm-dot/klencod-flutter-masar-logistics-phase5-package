/**
 * visitors.js — تتبّع الزوار والمستخدمين النشطين (المرحلة 3)
 * --------------------------------------------------------
 * يُسجّل زيارة مجهولة الهوية مع:
 *   • معرّف زائر عشوائي يُحفظ في متصفحه (لا كوكيز تتبّع إعلانية)
 *   • بصمة IP مُجزّأة (sha256 + ملح) — لا يُحفظ عنوان IP الصريح
 *   • الصفحات التي زارها (آخر 20) وعدد الزيارات وأول/آخر ظهور
 *   • ربط بالحساب إن كان مسجّل الدخول
 */
'use strict';
const crypto = require('crypto');
const { db } = require('./store');

const SALT = process.env.VISITOR_SALT || 'masar-visitors-v1';
const hashIp = (ip) => crypto.createHash('sha256').update(SALT + '|' + String(ip || '')).digest('hex').slice(0, 24);
const nowIso = () => new Date().toISOString();

function deviceOf(ua = '') {
  const s = String(ua).toLowerCase();
  if (/ipad|tablet/.test(s)) return 'tablet';
  if (/iphone|android|mobile/.test(s)) return 'mobile';
  if (/bot|crawler|spider/.test(s)) return 'bot';
  return 'desktop';
}

function platformOf(ua = '') {
  const s = String(ua).toLowerCase();
  if (/iphone|ipad|ios/.test(s)) return 'iOS';
  if (/android/.test(s)) return 'Android';
  if (/windows/.test(s)) return 'Windows';
  if (/mac os|macintosh/.test(s)) return 'macOS';
  if (/linux/.test(s)) return 'Linux';
  return 'أخرى';
}

/** تسجيل زيارة (يُستدعى من /api/track/visit) */
function track({ visitor_id, path, referrer, ua, ip, user_id, screen } = {}) {
  const id = (visitor_id && /^[A-Za-z0-9_-]{8,64}$/.test(String(visitor_id))) ? String(visitor_id) : crypto.randomUUID();
  const cleanPath = String(path || '/').slice(0, 200);
  const existing = db.visitors.byId(id);
  if (existing) {
    if (existing.blocked) return { visitor: existing, blocked: true };
    const pages = Array.isArray(existing.pages) ? existing.pages.slice() : [];
    if (cleanPath && pages[pages.length - 1] !== cleanPath) pages.push(cleanPath);
    const v = db.visitors.update(id, {
      last_seen: nowIso(),
      hits: (existing.hits || 1) + 1,
      pages: pages.slice(-20),
      user_id: user_id || existing.user_id || null,
      screen: screen || existing.screen || null,
      last_referrer: referrer || existing.last_referrer || null
    });
    return { visitor: v, created: false };
  }
  const v = db.visitors.insert({
    id,
    first_seen: nowIso(),
    last_seen: nowIso(),
    hits: 1,
    pages: cleanPath ? [cleanPath] : [],
    referrer: referrer || null,
    last_referrer: referrer || null,
    ua: String(ua || '').slice(0, 300),
    ip_hash: hashIp(ip),
    device: deviceOf(ua),
    platform: platformOf(ua),
    user_id: user_id || null,
    screen: screen || null,
    blocked: false,
    created_at: nowIso()
  });
  return { visitor: v, created: true };
}

function list({ q = null, page = 1, limit = 50, blocked = null, device = null } = {}) {
  let rows = db.visitors.all().slice();
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((v) => (v.id || '').toLowerCase().includes(s) || (v.pages || []).some((p) => p.toLowerCase().includes(s)) || (v.platform || '').toLowerCase().includes(s));
  }
  if (blocked !== null) rows = rows.filter((v) => !!v.blocked === !!blocked);
  if (device) rows = rows.filter((v) => v.device === device);
  rows.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  const total = rows.length;
  const from = (Math.max(1, page) - 1) * limit;
  return { total, page, limit, items: rows.slice(from, from + limit) };
}

function stats(days = 14) {
  const rows = db.visitors.all();
  const dayKey = (iso) => String(iso).slice(0, 10);
  const today = dayKey(nowIso());
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    series.push({ date: d, visits: rows.filter((v) => dayKey(v.last_seen) === d).reduce((s, v) => s + (v.hits || 1), 0), unique: rows.filter((v) => dayKey(v.last_seen) === d).length });
  }
  const pageCount = {};
  rows.forEach((v) => (v.pages || []).forEach((p) => { pageCount[p] = (pageCount[p] || 0) + 1; }));
  const top_pages = Object.entries(pageCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([path, hits]) => ({ path, hits }));
  const by = (k) => rows.reduce((acc, v) => { const key = v[k] || 'غير معروف'; acc[key] = (acc[key] || 0) + 1; return acc; }, {});
  const active5 = rows.filter((v) => Date.now() - new Date(v.last_seen).getTime() < 5 * 60e3).length;
  return {
    total_unique: rows.length,
    total_visits: rows.reduce((s, v) => s + (v.hits || 1), 0),
    today_unique: rows.filter((v) => dayKey(v.last_seen) === today).length,
    active_now: active5,
    logged_in: rows.filter((v) => v.user_id).length,
    anonymous: rows.filter((v) => !v.user_id).length,
    blocked: rows.filter((v) => v.blocked).length,
    by_device: by('device'),
    by_platform: by('platform'),
    top_pages,
    series
  };
}

function setBlocked(id, blocked) {
  const v = db.visitors.byId(id);
  if (!v) throw Object.assign(new Error('الزائر غير موجود'), { status: 404 });
  return db.visitors.update(id, { blocked: !!blocked });
}

module.exports = { track, list, stats, setBlocked, hashIp, deviceOf, platformOf };
