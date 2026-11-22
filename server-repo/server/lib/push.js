/**
 * push.js — إشعارات حقيقية متعددة القنوات (المرحلة 3)
 * ---------------------------------------------------
 * القنوات:
 *   1) inapp   — صندوق إشعارات داخل التطبيق (مجموعة notifications) + بث SSE لحظي.
 *   2) webpush — Web Push قياسي (RFC 8030/8290/8291) بمفاتيح VAPID تُولَّد على الخادم.
 *                يعمل على أندرويد (Chrome) وعلى آيفون 16.4+ بعد «إضافة إلى الشاشة الرئيسية».
 *   3) fcm     — Firebase Cloud Messaging (HTTP v1) لتطبيق أندرويد الأصلي.
 *   4) apns    — Apple Push Notification service لتطبيق آيفون الأصلي.
 *
 * القنوات 3 و4 تحتاج مفاتيح من حسابك (Google/Apple). إن لم تكن موجودة
 * تُعيد الحالة `skipped_no_credentials` بصراحة — ولا يُقلَّد الإرسال أبدًا.
 */
'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { db } = require('./store');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');

// ============================ مفاتيح VAPID ============================
// تُولَّد مرة واحدة وتُحفظ في data/vapid.json (أو من متغيرات البيئة).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@almasar.local';

let _vapid = null;
function vapid() {
  if (_vapid) return _vapid;
  try {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      _vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateJwk: JSON.parse(process.env.VAPID_PRIVATE_KEY) };
      return _vapid;
    }
    if (fs.existsSync(VAPID_FILE)) {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      _vapid = { publicKey: saved.public_key, privateJwk: saved.private_jwk };
      return _vapid;
    }
  } catch (e) {
    console.error('[push] تعذّر تحميل مفاتيح VAPID:', e.message);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  const pubB64 = pub.toString('base64url');
  _vapid = { publicKey: pubB64, privateJwk: jwk };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify({ public_key: pubB64, private_jwk: jwk, created_at: new Date().toISOString() }, null, 1), { mode: 0o600 });
    console.log('[push] تم توليد مفاتيح VAPID مرة واحدة في data/vapid.json');
  } catch (e) {
    console.error('[push] تعذّر حفظ مفاتيح VAPID:', e.message);
  }
  return _vapid;
}

function publicVapidKey() { return vapid().publicKey; }

function vapidJwt(audience) {
  const v = vapid();
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT
  }));
  const signingInput = header + '.' + payload;
  const key = crypto.createPrivateKey({ key: v.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

// ============================ تشفير Web Push (RFC 8291) ============================
function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), length));
}

/** يبني جسم الطلب المشفّر لنقطة اشتراك webpush */
function encryptPayload(payloadObj, sub, { salt, asKeys } = {}) {
  const uaPublic = fromB64url(sub.p256dh);         // 65 بايت غير مضغوطة
  const authSecret = fromB64url(sub.auth);          // 16 بايت
  const ecdh = crypto.createECDH('prime256v1');
  let asPublic, asPrivate;
  if (asKeys) { asPrivate = asKeys.privateKey; asPublic = asKeys.publicKey; }
  else {
    ecdh.generateKeys();
    asPublic = ecdh.getPublicKey();                 // غير مضغوطة 65 بايت
    asPrivate = ecdh.getPrivateKey();
  }
  const shared = asKeys ? asKeys.ecdh.computeSecret(uaPublic) : ecdh.computeSecret(uaPublic);

  const authInfo = Buffer.concat([Buffer.from('WebPush: info\x00'), uaPublic, asPublic]);
  const ikm = hkdf(shared, authSecret, authInfo, 32);
  const useSalt = salt || crypto.randomBytes(16);
  const prk = hkdf(ikm, useSalt, 'Content-Encoding: aes128gcm\x00', 32);
  const cek = hkdf(prk, Buffer.alloc(0), 'Content-Encoding: aes128gcm\x00', 16);
  const nonce = hkdf(prk, Buffer.alloc(0), 'Content-Encoding: nonce\x00', 12);

  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payloadObj), 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  return {
    body: Buffer.concat([useSalt, rs, Buffer.from([asPublic.length]), asPublic, ct]),
    salt: useSalt,
    asPublic,
    asPrivate,
    cek,
    nonce
  };
}

/** فك التشفير — للاختبار والتحقق الذاتي فقط */
function decryptForTest(body, sub, uaPrivate) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const uaPublic = ecdh.getPublicKey();
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\x00'), uaPublic, asPublic]);
  const ikm = hkdf(shared, fromB64url(sub.auth), authInfo, 32);
  const prk = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\x00', 32);
  const cek = hkdf(prk, Buffer.alloc(0), 'Content-Encoding: aes128gcm\x00', 16);
  const nonce = hkdf(prk, Buffer.alloc(0), 'Content-Encoding: nonce\x00', 12);
  const tag = ct.slice(ct.length - 16);
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(ct.slice(0, ct.length - 16)), dec.final()]);
  return JSON.parse(out.slice(0, out.length - 1).toString('utf8'));
}

/** إرسال إشعار Web Push واحد. يرمي خطأ عند الفشل. */
function sendWebPush(subscription, payloadObj, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = subscription.endpoint;
    let url;
    try { url = new URL(endpoint); } catch (e) { return reject(new Error('نقطة اشتراك غير صحيحة')); }
    const audience = url.origin;
    const jwt = vapidJwt(audience);
    const enc = encryptPayload(payloadObj, subscription);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        'content-length': enc.body.length,
        ttl: String(payloadObj.ttl || 2419200),
        urgency: 'normal',
        authorization: `vapid t=${jwt}, k=${vapid().publicKey}`
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: text });
        else reject(Object.assign(new Error(`خدمة الدفع ردّت ${res.statusCode}: ${text.slice(0, 200)}`), { status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 }));
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('انتهت مهلة خدمة الدفع')));
    req.on('error', reject);
    req.write(enc.body);
    req.end();
  });
}

// ============================ اشتراكات الأجهزة ============================
function saveSubscription(user, body) {
  const endpoint = String(body.endpoint || '').trim();
  const p256dh = String(body.p256dh || body.keys && body.keys.p256dh || '').trim();
  const auth = String(body.auth || body.keys && body.keys.auth || '').trim();
  if (!endpoint || !p256dh || !auth) throw Object.assign(new Error('بيانات اشتراك ناقصة'), { status: 400 });
  if (!/^https?:\/\//.test(endpoint)) throw Object.assign(new Error('نقطة اشتراك غير صحيحة'), { status: 400 });
  const existing = db.push_subscriptions.findOne((s) => s.endpoint === endpoint);
  if (existing) {
    const u = db.push_subscriptions.update(existing.id, { user_id: user.id, p256dh, auth, ua: body.ua || null, active: true });
    return u;
  }
  return db.push_subscriptions.insert({
    id: crypto.randomUUID(), user_id: user.id, endpoint, p256dh, auth,
    ua: body.ua || null, platform: body.platform || 'web', active: true,
    created_at: new Date().toISOString()
  });
}

function removeSubscription(endpoint) {
  const s = db.push_subscriptions.findOne((x) => x.endpoint === endpoint);
  if (!s) return false;
  db.push_subscriptions.remove(s.id);
  return true;
}

function saveDeviceToken(user, body) {
  const token = String(body.token || '').trim();
  const platform = body.platform === 'ios' ? 'ios' : 'android';
  const app = body.app === 'staff' ? 'staff' : 'client';
  if (token.length < 10) throw Object.assign(new Error('رمز جهاز غير صحيح'), { status: 400 });
  const existing = db.device_tokens.findOne((d) => d.token === token);
  if (existing) return db.device_tokens.update(existing.id, { user_id: user.id, platform, app, active: true });
  return db.device_tokens.insert({ id: crypto.randomUUID(), user_id: user.id, token, platform, app, active: true, created_at: new Date().toISOString() });
}

// ============================ FCM (أندرويد) ============================
let _fcmToken = { at: 0, token: null };
function fcmConfig() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, 'utf8'));
    if (!json.client_email || !json.private_key || !json.project_id) return null;
    return json;
  } catch (_) { return null; }
}

async function fcmAccessToken(cfg) {
  if (_fcmToken.token && Date.now() - _fcmToken.at < 50 * 60e3) return _fcmToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: cfg.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), cfg.private_key).toString('base64url');
  const assertion = `${header}.${claims}.${sig}`;
  const body = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(assertion)}`;
  const res = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
  });
  _fcmToken = { at: Date.now(), token: res.access_token };
  return res.access_token;
}

async function sendFcm(deviceTokens, title, body, data = {}) {
  const cfg = fcmConfig();
  if (!cfg) return { channel: 'fcm', status: 'skipped_no_credentials', sent: 0, failed: 0, note: 'أضف FCM_SERVICE_ACCOUNT لتشغيل إشعارات أندرويد الأصلية' };
  const token = await fcmAccessToken(cfg);
  let sent = 0, failed = 0; const errors = [];
  for (const t of deviceTokens) {
    try {
      await fetchJson(`https://fcm.googleapis.com/v1/projects/${cfg.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token: t, notification: { title, body }, data } })
      });
      sent++;
    } catch (e) { failed++; errors.push(String(e.message).slice(0, 120)); }
  }
  return { channel: 'fcm', status: sent > 0 ? 'sent' : 'failed', sent, failed, errors: errors.slice(0, 3) };
}

// ============================ APNs (آيفون) ============================
function apnsConfig() {
  const key = process.env.APNS_KEY_P8;
  if (!key || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) return null;
  try { return { p8: fs.existsSync(key) ? fs.readFileSync(key, 'utf8') : key, keyId: process.env.APNS_KEY_ID, teamId: process.env.APNS_TEAM_ID, bundle: process.env.APNS_BUNDLE_ID || 'com.almasar.logistics' }; }
  catch (_) { return null; }
}

function apnsJwt(cfg) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: cfg.p8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

async function sendApns(deviceTokens, title, body, data = {}) {
  const cfg = apnsConfig();
  if (!cfg) return { channel: 'apns', status: 'skipped_no_credentials', sent: 0, failed: 0, note: 'أضف APNS_KEY_P8 + APNS_KEY_ID + APNS_TEAM_ID لتشغيل إشعارات آيفون' };
  const jwt = apnsJwt(cfg);
  let sent = 0, failed = 0; const errors = [];
  for (const t of deviceTokens) {
    try {
      const res = await http2Post(`https://api.push.apple.com/3/device/${t}`, {
        authorization: `bearer ${jwt}`,
        'apns-topic': cfg.bundle,
        'apns-push-type': 'alert',
        'apns-priority': '10'
      }, JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, ...data }));
      if (res.status >= 200 && res.status < 300) sent++; else { failed++; errors.push(res.status + ' ' + String(res.body).slice(0, 100)); }
    } catch (e) { failed++; errors.push(String(e.message).slice(0, 120)); }
  }
  return { channel: 'apns', status: sent > 0 ? 'sent' : 'failed', sent, failed, errors: errors.slice(0, 3) };
}

// ============================ أدوات HTTP ============================
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: opts.method || 'GET', hostname: u.hostname, path: u.pathname + u.search,
      headers: opts.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 160)}`), { status: res.statusCode }));
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function http2Post(url, headers, body) {
  return new Promise((resolve, reject) => {
    let http2;
    try { http2 = require('http2'); } catch (e) { return reject(new Error('HTTP/2 غير متاح')); }
    const u = new URL(url);
    const client = http2.connect(u.origin);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST', ':path': u.pathname + u.search,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers
    });
    let status = 0; const chunks = [];
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { client.close(); resolve({ status, body: Buffer.concat(chunks).toString('utf8') }); });
    req.on('error', (e) => { client.close(); reject(e); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  vapid, publicVapidKey, vapidJwt, encryptPayload, decryptForTest, sendWebPush,
  saveSubscription, removeSubscription, saveDeviceToken,
  sendFcm, sendApns, fcmConfig, apnsConfig,
  channelsStatus: () => ({
    inapp: { ready: true, note: 'يعمل دائمًا (داخل التطبيق + SSE)' },
    webpush: { ready: true, note: 'جاهز — مفاتيح VAPID مولّدة على الخادم' },
    fcm: fcmConfig() ? { ready: true, note: 'مهيّأ عبر FCM_SERVICE_ACCOUNT' } : { ready: false, note: 'غير مهيّأ: أضف FCM_SERVICE_ACCOUNT لإشعارات أندرويد الأصلية' },
    apns: apnsConfig() ? { ready: true, note: 'مهيّأ عبر مفاتيح APNs' } : { ready: false, note: 'غير مهيّأ: أضف APNS_KEY_P8/KEY_ID/TEAM_ID لإشعارات آيفون' }
  })
};
