/**
 * admin.js — إدارة متكاملة: المستخدمون، العملاء، الزوار، الإشعارات، الخادم
 * ----------------------------------------------------------------------
 * كل المنطق هنا (لا في الواجهة) حتى تبقى الصلاحيات والتحقق على الخادم.
 */
'use strict';
const crypto = require('crypto');
const { db, audit, DATA_DIR } = require('./store');
const A = require('./auth');
const wallet = require('./wallet');
const push = require('./push');
const visitors = require('./visitors');

const nowIso = () => new Date().toISOString();
const ROLE_LABEL = {
  user: 'مستخدم', agent: 'وكيل', support_staff: 'دعم فني', shipping_staff: 'موظف شحن',
  branch_manager: 'مدير فرع', warehouse_manager: 'مدير مستودع', super_admin: 'مدير عام'
};
const STAFF_ROLES = ['support_staff', 'shipping_staff', 'branch_manager', 'warehouse_manager', 'super_admin'];
const CLIENT_ROLES = ['user', 'agent'];
const publicUser = (u) => {
  const { password_hash, ...rest } = u;
  return { ...rest, role_label: ROLE_LABEL[u.role] || u.role, kind: STAFF_ROLES.includes(u.role) ? 'staff' : 'client' };
};

// ============================ المستخدمون ============================
function listUsers({ role = null, status = null, q = null, kind = null, page = 1, limit = 50 } = {}) {
  let rows = db.users.all().slice();
  if (role) rows = rows.filter((u) => u.role === role);
  if (kind === 'client') rows = rows.filter((u) => CLIENT_ROLES.includes(u.role));
  if (kind === 'staff') rows = rows.filter((u) => STAFF_ROLES.includes(u.role));
  if (status) rows = rows.filter((u) => u.status === status);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((u) => [u.fullName, u.email, u.phone, u.username].some((f) => String(f || '').toLowerCase().includes(s)));
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = rows.length;
  const from = (Math.max(1, page) - 1) * limit;
  return { total, page, limit, items: rows.slice(from, from + limit).map(publicUser) };
}

function userDetail(id) {
  const u = db.users.byId(id);
  if (!u) throw Object.assign(new Error('المستخدم غير موجود'), { status: 404 });
  return {
    user: publicUser(u),
    wallet: wallet.balance(u.id),
    shipments: db.shipments.find((s) => s.user_id === u.id || s.created_by === u.id).length,
    notifications: db.notifications.find((n) => n.user_id === u.id).length,
    favorites: db.favorites.find((f) => f.user_id === u.id).length,
    sessions: db.sessions.find((s) => s.user_id === u.id && !s.revoked_at).length,
    audit: db.audit.find((a) => a.actor_id === u.id).slice(-10).reverse()
  };
}

function updateUser(id, patch, actor) {
  const u = db.users.byId(id);
  if (!u) throw Object.assign(new Error('المستخدم غير موجود'), { status: 404 });
  const allowed = {};
  if (patch.status && ['active', 'pending', 'suspended', 'deleted'].includes(patch.status)) allowed.status = patch.status;
  if (patch.role && Object.keys(ROLE_LABEL).includes(patch.role)) {
    if (A.ROLE_RANK[actor.role] <= A.ROLE_RANK[patch.role] && actor.id !== u.id) {
      throw Object.assign(new Error('لا يمكنك منح رتبة مساوية أو أعلى من رتبتك'), { status: 403 });
    }
    allowed.role = patch.role;
  }
  ['fullName', 'phone', 'email', 'idNumber', 'commercialReg', 'notes'].forEach((k) => { if (patch[k] !== undefined) allowed[k] = patch[k]; });
  if (patch.lat !== undefined) allowed.lat = patch.lat;
  if (patch.lng !== undefined) allowed.lng = patch.lng;
  const updated = db.users.update(id, allowed);
  if (allowed.status === 'suspended' || allowed.status === 'deleted') revokeAllSessions(id);
  audit(actor, 'admin_user_update', 'user', id, { details: allowed });
  return publicUser(updated);
}

function resetPassword(id, actor, newPassword = null) {
  const u = db.users.byId(id);
  if (!u) throw Object.assign(new Error('المستخدم غير موجود'), { status: 404 });
  const temp = newPassword || crypto.randomBytes(6).toString('base64url').slice(0, 10) + 'aA1';
  db.users.update(id, { password_hash: A.hashPassword(temp), password_reset_at: nowIso() });
  revokeAllSessions(id);
  audit(actor, 'admin_password_reset', 'user', id, {});
  return { username: u.username, temporary_password: temp, note: 'تُعرض مرة واحدة فقط — سلّمها للمستخدم واطلب تغييرها فورًا.' };
}

function revokeAllSessions(userId) {
  const u = db.users.byId(userId);
  if (u) db.users.update(userId, { token_version: (u.token_version || 0) + 1 }); // يُبطل رموز الوصول فورًا
  let n = 0;
  db.sessions.find((s) => s.user_id === userId && !s.revoked_at).forEach((s) => {
    db.sessions.update(s.id, { revoked_at: nowIso() });
    n++;
  });
  return n;
}

function createUser(payload, actor) {
  const need = ['fullName', 'username', 'password'];
  need.forEach((k) => { if (!payload[k]) throw Object.assign(new Error(`الحقل ${k} مطلوب`), { status: 400 }); });
  if (String(payload.password).length < 8) throw Object.assign(new Error('كلمة المرور 8 أحرف على الأقل'), { status: 400 });
  if (db.users.findOne((u) => u.username === payload.username || (payload.email && u.email === payload.email)))
    throw Object.assign(new Error('اسم المستخدم أو البريد مستخدم'), { status: 409 });
  const role = Object.keys(ROLE_LABEL).includes(payload.role) ? payload.role : 'user';
  if (A.ROLE_RANK[role] >= A.ROLE_RANK[actor.role]) throw Object.assign(new Error('لا يمكنك إنشاء مستخدم برتبة مساوية أو أعلى'), { status: 403 });
  const u = db.users.insert({
    id: crypto.randomUUID(), fullName: payload.fullName, username: payload.username,
    email: payload.email || null, phone: payload.phone || null,
    password_hash: A.hashPassword(payload.password), role,
    status: payload.status === 'pending' ? 'pending' : 'active',
    created_by: actor.id, created_at: nowIso()
  });
  wallet.accounts.ensure(u.id);
  audit(actor, 'admin_user_create', 'user', u.id, { details: { role } });
  return publicUser(u);
}

function deleteUser(id, actor) {
  const u = db.users.byId(id);
  if (!u) throw Object.assign(new Error('المستخدم غير موجود'), { status: 404 });
  if (u.id === actor.id) throw Object.assign(new Error('لا يمكنك حذف حسابك الحالي'), { status: 400 });
  if (A.ROLE_RANK[u.role] >= A.ROLE_RANK[actor.role]) throw Object.assign(new Error('لا يمكنك حذف مستخدم برتبة مساوية أو أعلى'), { status: 403 });
  // حذف ناعم: يُعطَّل الحساب ويبقى أثره في السجل والبيانات المرتبطة
  db.users.update(id, { status: 'deleted', deleted_at: nowIso(), deleted_by: actor.id });
  revokeAllSessions(id);
  audit(actor, 'admin_user_delete', 'user', id, {});
  return { ok: true, soft_deleted: true };
}

// ============================ العملاء ============================
function listClients({ q = null, page = 1, limit = 50, status = null } = {}) {
  let rows = db.users.find((u) => CLIENT_ROLES.includes(u.role));
  if (status) rows = rows.filter((u) => u.status === status);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((u) => [u.fullName, u.email, u.phone, u.username].some((f) => String(f || '').toLowerCase().includes(s)));
  }
  const items = rows.map((u) => {
    const ships = db.shipments.find((s) => s.user_id === u.id || s.created_by === u.id);
    const bal = wallet.balance(u.id);
    return {
      ...publicUser(u),
      shipments: ships.length,
      shipments_delivered: ships.filter((s) => String(s.status || '').includes('تسليم') || String(s.status || '').toLowerCase().includes('deliver')).length,
      wallet_available: bal.available_cents / 100,
      wallet_held: bal.held_cents / 100,
      last_seen: u.last_login_at || null
    };
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = items.length;
  const from = (Math.max(1, page) - 1) * limit;
  return { total, page, limit, items: items.slice(from, from + limit) };
}

// ============================ الإشعارات ============================
function resolveAudience({ audience = 'all', values = [] } = {}) {
  const active = db.users.find((u) => u.status === 'active');
  switch (audience) {
    case 'clients': return active.filter((u) => CLIENT_ROLES.includes(u.role));
    case 'staff': return active.filter((u) => STAFF_ROLES.includes(u.role));
    case 'role': return active.filter((u) => values.includes(u.role));
    case 'users': return active.filter((u) => values.includes(u.id));
    case 'visitors': return []; // الزوار غير المسجّلين لا صندوق لهم — تُستخدم لهم إشعارات الويب فقط
    case 'all':
    default: return active;
  }
}

/**
 * إرسال حملة إشعارات.
 * deps: { notify(user,title,body,link,type) } لضمان البث اللحظي عبر SSE من الطبقة الرئيسية.
 */
async function sendCampaign(payload, actor, deps = {}) {
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  if (title.length < 3) throw Object.assign(new Error('عنوان الإشعار قصير جدًا'), { status: 400 });
  if (body.length < 2) throw Object.assign(new Error('نص الإشعار مطلوب'), { status: 400 });
  const channels = Array.isArray(payload.channels) && payload.channels.length ? payload.channels : ['inapp'];
  const audience = payload.audience || 'all';
  const values = Array.isArray(payload.values) ? payload.values : [];
  const recipients = resolveAudience({ audience, values });
  const link = payload.link || null;
  const type = payload.type || 'admin';

  const campaign = db.campaigns.insert({
    id: crypto.randomUUID(), title, body, link, type, audience, audience_values: values,
    channels, created_by: actor.id, created_by_name: actor.fullName,
    target_count: recipients.length, sent_count: 0, push_results: null,
    status: 'sending', created_at: nowIso()
  });

  // 1) صندوق الإشعارات داخل التطبيق + SSE
  let inapp = 0;
  if (channels.includes('inapp')) {
    for (const u of recipients) {
      if (deps.notify) deps.notify(u.id, title, body, link, type);
      else db.notifications.insert({ id: crypto.randomUUID(), user_id: u.id, type, title, body, link, read_at: null, created_at: nowIso() });
      inapp++;
    }
  }

  // 2) Web Push
  const results = { inapp, webpush: null, fcm: null, apns: null };
  if (channels.includes('webpush')) {
    const ids = new Set(recipients.map((u) => u.id));
    const subs = db.push_subscriptions.find((s) => s.active && (audience === 'all' ? true : ids.has(s.user_id)));
    let sent = 0, failed = 0, gone = 0; const errors = [];
    for (const sub of subs) {
      try {
        await push.sendWebPush(sub, { title, body, url: link || '/', campaign_id: campaign.id, at: nowIso() });
        sent++;
        db.push_subscriptions.update(sub.id, { last_ok_at: nowIso(), fail_count: 0 });
      } catch (e) {
        failed++;
        errors.push(String(e.message).slice(0, 140));
        const fails = (sub.fail_count || 0) + 1;
        if (e.gone) { db.push_subscriptions.update(sub.id, { active: false, fail_count: fails }); gone++; }
        else db.push_subscriptions.update(sub.id, { fail_count: fails, last_error: String(e.message).slice(0, 200) });
      }
    }
    results.webpush = { subscriptions: subs.length, sent, failed, deactivated: gone, errors: errors.slice(0, 3) };
    logChannel(campaign.id, 'webpush', results.webpush);
  }

  // 3) FCM / APNs
  const devices = db.device_tokens.find((d) => d.active);
  const android = devices.filter((d) => d.platform === 'android').map((d) => d.token);
  const ios = devices.filter((d) => d.platform === 'ios').map((d) => d.token);
  if (channels.includes('fcm') && android.length) { results.fcm = await push.sendFcm(android, title, body, { campaign_id: campaign.id, link: link || '' }); logChannel(campaign.id, 'fcm', results.fcm); }
  if (channels.includes('apns') && ios.length) { results.apns = await push.sendApns(ios, title, body, { campaign_id: campaign.id, link: link || '' }); logChannel(campaign.id, 'apns', results.apns); }

  db.campaigns.update(campaign.id, { status: 'sent', sent_count: inapp, push_results: results, sent_at: nowIso() });
  audit(actor, 'admin_campaign_send', 'campaign', campaign.id, { details: { audience, recipients: recipients.length, channels } });
  return { campaign: db.campaigns.byId(campaign.id), results };
}

function logChannel(campaignId, channel, result) {
  db.notify_log.insert({
    id: crypto.randomUUID(), campaign_id: campaignId, channel,
    status: result.status || (result.sent > 0 ? 'sent' : 'failed'),
    sent: result.sent || 0, failed: result.failed || 0,
    detail: result.note || (result.errors && result.errors[0]) || null,
    created_at: nowIso()
  });
}

function listCampaigns({ page = 1, limit = 30 } = {}) {
  const rows = db.campaigns.all().slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = rows.length;
  const from = (Math.max(1, page) - 1) * limit;
  return { total, page, limit, items: rows.slice(from, from + limit) };
}

// ============================ حالة الخادم ============================
function serverStatus({ uptime_s = 0 } = {}) {
  const users = db.users.all();
  const ships = db.shipments.all();
  const mem = process.memoryUsage();
  return {
    version: process.env.APP_VERSION || '1.0.0-phase3',
    uptime_s,
    node: process.version,
    pid: process.pid,
    memory_mb: Math.round(mem.rss / 1048576),
    data_dir: DATA_DIR,
    storage: 'JSON-on-disk',
    counts: {
      users: users.length,
      active_users: users.filter((u) => u.status === 'active').length,
      pending_users: users.filter((u) => u.status === 'pending').length,
      suspended_users: users.filter((u) => u.status === 'suspended').length,
      staff: users.filter((u) => STAFF_ROLES.includes(u.role)).length,
      clients: users.filter((u) => CLIENT_ROLES.includes(u.role)).length,
      visitors: db.visitors.all().length,
      sessions: db.sessions.find((s) => !s.revoked_at).length,
      shipments: ships.length,
      auctions: db.auctions.all().length,
      bids: db.bids.all().length,
      notifications: db.notifications.all().length,
      campaigns: db.campaigns.all().length,
      audit: db.audit.all().length,
      push_subscriptions: db.push_subscriptions.find((s) => s.active).length,
      device_tokens: db.device_tokens.find((d) => d.active).length
    },
    push_channels: push.channelsStatus(),
    live_sources: ['fx', 'weather', 'news', 'crypto', 'macro']
  };
}

function backupBundle() {
  const names = ['users', 'sessions', 'shipments', 'favorites', 'reviews', 'notifications', 'audit', 'auctions', 'bids',
    'wallet_accounts', 'wallet_entries', 'wallet_holds', 'visitors', 'push_subscriptions', 'device_tokens', 'campaigns', 'notify_log'];
  const data = {};
  names.forEach((n) => { data[n] = db[n] ? db[n].all() : []; });
  return { created_at: nowIso(), version: 'phase3', collections: names.length, data };
}

module.exports = {
  ROLE_LABEL, STAFF_ROLES, CLIENT_ROLES, publicUser,
  listUsers, userDetail, updateUser, resetPassword, createUser, deleteUser, revokeAllSessions,
  listClients, resolveAudience, sendCampaign, listCampaigns,
  serverStatus, backupBundle, visitors
};
