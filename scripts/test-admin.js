/**
 * test-admin.mjs — اختبارات قبول المرحلة 3 (الخادم الحقيقي + الإدارة + الإشعارات)
 * -----------------------------------------------------------------------------
 * التشغيل: node scripts/test-admin.mjs
 * يشغّل الخادم على منفذ مؤقت مع مجلد بيانات مؤقت، ويغطي:
 *   تتبّع الزوار · إشعارات الويب (VAPID وتشفير RFC 8291) · حملات الإشعارات
 *   إدارة المستخدمين والعملاء · الصلاحيات · سجل التدقيق · حالة الخادم · النسخ الاحتياطي
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const ADMIN_PASSWORD = 'Admin!Pass2026';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-admin-'));

let pass = 0, fail = 0;
const failures = [];
const t = async (name, fn) => {
  try { const info = await fn(); pass++; console.log(`  ✅ ${name}${info ? '  → ' + info : ''}`); }
  catch (e) { fail++; failures.push(name + ': ' + e.message); console.log(`  ❌ ${name}  → ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, { body, token, headers = {} } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, ADMIN_PASSWORD, LOGIN_RATE_LIMIT: '2000' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const ready = async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (_) {}
    await sleep(250);
  }
  throw new Error('الخادم لم يبدأ:\n' + log);
};

(async () => {
  console.log('\n=== اختبارات المرحلة 3: الخادم والإدارة والإشعارات ===\n');
  await ready();

  const admin = (await req('POST', '/api/auth/login', { body: { identifier: 'admin', password: ADMIN_PASSWORD } })).data;

  const mkUser = async (name, role = 'user') => {
    const r = await req('POST', '/api/auth/register', {
      body: { fullName: 'مستخدم ' + name, email: `${name}@t.local`, phone: '77' + Math.floor(Math.random() * 1e7), username: name, password: 'UserPass!2026', role: 'user' }
    });
    assert(r.status === 201, 'فشل التسجيل ' + JSON.stringify(r.data));
    const users = (await req('GET', '/api/admin/users?limit=100', { token: admin.access_token })).data.items;
    const u = users.find((x) => x.username === name);
    if (role !== 'user') await req('PATCH', '/api/admin/users/' + u.id, { token: admin.access_token, body: { role } });
    await req('PATCH', '/api/admin/users/' + u.id, { token: admin.access_token, body: { status: 'active' } });
    const ses = (await req('POST', '/api/auth/login', { body: { identifier: name, password: 'UserPass!2026' } })).data;
    return { id: u.id, token: ses.access_token, username: name };
  };

  // ---------------------------------------------------------------- الزوار
  console.log('\n— تتبّع الزوار —');
  let visitorId = null;
  await t('تسجيل زيارة مجهولة يعيد معرّف زائر', async () => {
    const r = await req('POST', '/api/track/visit', { body: { path: '/index.html', referrer: 'https://google.com', screen: 'mainPage' }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
    assert(r.status === 200 && r.data.ok, 'HTTP ' + r.status);
    visitorId = r.data.visitor_id;
    return visitorId.slice(0, 8) + '…';
  });

  await t('الزيارة المتكررة تُحدّث نفس الزائر ولا تُنشئ زائرًا جديدًا', async () => {
    const before = (await req('GET', '/api/admin/visitors', { token: admin.access_token })).data.total;
    const r1 = await req('POST', '/api/track/visit', { body: { visitor_id: visitorId, path: '/walletPage' } });
    const r2 = await req('POST', '/api/track/visit', { body: { visitor_id: visitorId, path: '/auctionsPage' } });
    assert(r1.data.visitor_id === visitorId && r2.data.visitor_id === visitorId, 'المعرّف تغيّر');
    const after = (await req('GET', '/api/admin/visitors', { token: admin.access_token })).data;
    assert(after.total === before, `عدد الزوار تغيّر ${before} → ${after.total}`);
    const me = after.items.find((v) => v.id === visitorId);
    assert(me.hits >= 3, 'لم تُحتسب الزيارات: ' + me.hits);
    assert(me.pages.includes('/walletPage') && me.pages.includes('/auctionsPage'), 'الصفحات لم تُسجّل');
    return `${me.hits} زيارة · ${me.platform} · ${me.device}`;
  });

  await t('عنوان IP لا يُحفظ صريحًا (بصمة مجزّأة فقط)', async () => {
    const rows = (await req('GET', '/api/admin/visitors', { token: admin.access_token })).data.items;
    const v = rows.find((x) => x.id === visitorId);
    assert(v.ip_hash && /^[a-f0-9]{24}$/.test(v.ip_hash), 'البصمة غير صحيحة');
    assert(!JSON.stringify(v).includes('127.0.0.1'), 'يوجد IP صريح');
    return v.ip_hash.slice(0, 10) + '…';
  });

  await t('إحصاءات الزوار تحسب الأجهزة والصفحات والسلسلة اليومية', async () => {
    const s = (await req('GET', '/api/admin/visitors/stats?days=7', { token: admin.access_token })).data;
    assert(s.total_unique >= 1 && s.total_visits >= 3, 'الإحصاءات خاطئة');
    assert(Array.isArray(s.series) && s.series.length === 7, 'السلسلة اليومية');
    assert(s.by_platform.iOS >= 1 || s.by_device.mobile >= 1, 'لم يُصنّف الجهاز');
    return `${s.total_unique} زائر · ${s.total_visits} زيارة · ${s.top_pages.length} صفحة`;
  });

  await t('حجب زائر يمنع تتبّعه لاحقًا', async () => {
    const b = await req('POST', `/api/admin/visitors/${visitorId}/block`, { token: admin.access_token, body: { blocked: true } });
    assert(b.status === 200 && b.data.visitor.blocked, 'لم يُحجب');
    const after = await req('POST', '/api/track/visit', { body: { visitor_id: visitorId, path: '/mainPage' } });
    assert(after.data.blocked === true, 'الزيارة لم تُرفض');
    await req('POST', `/api/admin/visitors/${visitorId}/block`, { token: admin.access_token, body: { blocked: false } });
    return 'محجوب ثم أُفرج عنه';
  });

  // ---------------------------------------------------------------- Push
  console.log('\n— Web Push —');
  await t('الخادم ينشر مفتاح VAPID العام', async () => {
    const r = await req('GET', '/api/push/public-key');
    assert(r.status === 200 && r.data.public_key.length > 60, 'لا يوجد مفتاح');
    return r.data.public_key.slice(0, 16) + '…';
  });

  const client = await mkUser('client1');
  const staff = await mkUser('staff1', 'shipping_staff');

  await t('اشتراك جهاز يُحفظ ويظهر في حالة المستخدم', async () => {
    const ep = 'https://push.example.com/send/' + crypto.randomUUID();
    const r = await req('POST', '/api/push/subscribe', { token: client.token, body: { endpoint: ep, p256dh: 'BOrV9E7Uq1cW0mKx0Gk1Q8m6m3h0Z0H7Y9yQ3r6T1tK2x8m5n8b1v4c7d0e3f6g9h2i5j8k1l4m7n0o3p6q9r2s5t8u1v4w7x0y3z6', auth: 'q1w2e3r4t5y6u7i8' } });
    assert(r.status === 200, JSON.stringify(r.data));
    const st = (await req('GET', '/api/push/status', { token: client.token })).data;
    assert(st.my_subscriptions === 1, 'لم يُحفظ الاشتراك');
    assert(st.channels.webpush.ready === true, 'قناة الويب غير جاهزة');
    return 'اشتراك واحد محفوظ';
  });

  await t('رفض اشتراك ناقص البيانات', async () => {
    const r = await req('POST', '/api/push/subscribe', { token: client.token, body: { endpoint: 'https://x.test/1' } });
    assert(r.status === 400, 'HTTP ' + r.status);
    return 'HTTP 400';
  });

  await t('تشفير Web Push مطابق للمعيار (RFC 8291): فك التشفير يعيد النص الأصلي', async () => {
    const push = require(path.join(ROOT, 'server', 'lib', 'push.js'));
    // مفتاح جهاز افتراضي (مثل ما يولّده المتصفح)
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const uaPublic = ecdh.getPublicKey();
    const uaPrivate = ecdh.getPrivateKey();
    const auth = crypto.randomBytes(16);
    const sub = { endpoint: 'https://push.example.com/x', p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') };
    const payload = { title: 'مرحبًا', body: 'نص عربي + English 123', url: '/auctionsPage' };
    const enc = push.encryptPayload(payload, sub, { salt: crypto.randomBytes(16) });
    const back = push.decryptForTest(enc.body, sub, uaPrivate);
    assert(back.title === payload.title && back.body === payload.body && back.url === payload.url, 'النص بعد الفك مختلف');
    assert(enc.body.length > 100, 'الجسم صغير');
    return `${enc.body.length} بايت · نص عربي سليم`;
  });

  await t('توقيع VAPID يُنتج JWT صالح الترويسة', async () => {
    const push = require(path.join(ROOT, 'server', 'lib', 'push.js'));
    const jwt = push.vapidJwt('https://push.example.com');
    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert(header.alg === 'ES256' && claims.aud === 'https://push.example.com' && claims.exp > Date.now() / 1000, 'المطالبات خاطئة');
    assert(Buffer.from(s, 'base64url').length === 64, 'طول التوقيع غير صحيح');
    return 'ES256 · توقيع 64 بايت';
  });

  await t('إرسال إشعار تجريبي يحاول الدفع ويسجّل النتيجة بصدق', async () => {
    const r = await req('POST', '/api/push/test', { token: client.token });
    assert(r.status === 200, 'HTTP ' + r.status);
    assert(r.data.subscriptions === 1, 'لم يجد الاشتراك');
    assert(r.data.sent + r.data.failed === 1, 'لم تُسجّل محاولة إرسال');
    return `محاولة واحدة · ناجح ${r.data.sent} · فاشل ${r.data.failed} (نقطة اختبار غير حقيقية)`;
  });

  // ---------------------------------------------------------- حملات الإشعارات
  console.log('\n— حملات الإشعارات —');
  await t('حملة للموظفين فقط تصل للموظفين دون العملاء', async () => {
    const r = await req('POST', '/api/admin/notifications', {
      token: admin.access_token,
      body: { title: 'تعميم إداري', body: 'اجتماع الموظفين الساعة 9', audience: 'staff', channels: ['inapp'] }
    });
    assert(r.status === 201, JSON.stringify(r.data));
    const staffNotes = (await req('GET', '/api/notifications', { token: staff.token })).data.items;
    const clientNotes = (await req('GET', '/api/notifications', { token: client.token })).data.items;
    assert(staffNotes.some((n) => n.title === 'تعميم إداري'), 'الموظف لم يستلم');
    assert(!clientNotes.some((n) => n.title === 'تعميم إداري'), 'العميل استلم إشعار الموظفين');
    return `أُرسلت إلى ${r.data.campaign.target_count} موظف`;
  });

  await t('حملة للعملاء تصل للعملاء فقط', async () => {
    const r = await req('POST', '/api/admin/notifications', {
      token: admin.access_token,
      body: { title: 'عرض للعملاء', body: 'خصم 10% على الشحنات', audience: 'clients', channels: ['inapp'] }
    });
    assert(r.status === 201, 'HTTP ' + r.status);
    const clientNotes = (await req('GET', '/api/notifications', { token: client.token })).data.items;
    assert(clientNotes.some((n) => n.title === 'عرض للعملاء'), 'العميل لم يستلم');
    return `أُرسلت إلى ${r.data.campaign.target_count} عميل`;
  });

  await t('حملة لمستخدم واحد بالمعرّف', async () => {
    const r = await req('POST', '/api/admin/notifications', {
      token: admin.access_token,
      body: { title: 'رسالة شخصية', body: 'شحنتك وصلت', audience: 'users', values: [client.id], channels: ['inapp'] }
    });
    assert(r.status === 201 && r.data.campaign.target_count === 1, 'العدد ' + r.data.campaign.target_count);
    const notes = (await req('GET', '/api/notifications', { token: client.token })).data.items;
    assert(notes.some((n) => n.title === 'رسالة شخصية'), 'لم تُسلَّم');
    return 'مستلم واحد';
  });

  await t('حملة بقناة webpush تُسجّل نتيجة القناة في السجل', async () => {
    const r = await req('POST', '/api/admin/notifications', {
      token: admin.access_token,
      body: { title: 'إشعار ويب', body: 'يعمل على أندرويد وآيفون', audience: 'clients', channels: ['inapp', 'webpush'] }
    });
    assert(r.status === 201, 'HTTP ' + r.status);
    assert(r.data.results.webpush && r.data.results.webpush.subscriptions >= 1, 'لم تُحسب الاشتراكات');
    const logs = (await req('GET', '/api/admin/notifications/log', { token: admin.access_token })).data.items;
    assert(logs.some((l) => l.channel === 'webpush'), 'لا يوجد سجل للقناة');
    return `اشتراكات ${r.data.results.webpush.subscriptions} · محاولات ${r.data.results.webpush.sent + r.data.results.webpush.failed}`;
  });

  await t('قنوات FCM/APNs تُبلّغ بوضوح أنها غير مهيّأة (لا تُقلَّد)', async () => {
    const st = (await req('GET', '/api/admin/server', { token: admin.access_token })).data;
    assert(st.push_channels.fcm.ready === false && st.push_channels.apns.ready === false, 'الحالة غير دقيقة');
    assert(/FCM_SERVICE_ACCOUNT/.test(st.push_channels.fcm.note), 'لا يوجد توضيح');
    return st.push_channels.fcm.note.slice(0, 45) + '…';
  });

  await t('حملة بعنوان قصير تُرفض', async () => {
    const r = await req('POST', '/api/admin/notifications', { token: admin.access_token, body: { title: 'x', body: 'نص' } });
    assert(r.status === 400, 'HTTP ' + r.status);
    return 'HTTP 400';
  });

  // ------------------------------------------------------- إدارة المستخدمين
  console.log('\n— إدارة المستخدمين والعملاء —');
  await t('قائمة المستخدمين تعرض الرتب والحالة', async () => {
    const r = await req('GET', '/api/admin/users?limit=100', { token: admin.access_token });
    assert(r.status === 200 && r.data.items.length >= 3, 'القائمة فارغة');
    const c = r.data.items.find((u) => u.username === 'client1');
    assert(c.role_label === 'مستخدم' && c.kind === 'client' && !c.password_hash, 'بيانات المستخدم غير سليمة');
    return `${r.data.total} مستخدم`;
  });

  await t('فلترة العملاء/الموظفين تعمل', async () => {
    const clients = (await req('GET', '/api/admin/users?kind=client', { token: admin.access_token })).data;
    const staffList = (await req('GET', '/api/admin/users?kind=staff', { token: admin.access_token })).data;
    assert(clients.items.every((u) => u.kind === 'client'), 'فلتر العملاء خاطئ');
    assert(staffList.items.every((u) => u.kind === 'staff'), 'فلتر الموظفين خاطئ');
    return `${clients.total} عميل · ${staffList.total} موظف`;
  });

  await t('إيقاف مستخدم يمنع دخوله فورًا', async () => {
    const tmp = await mkUser('client2');
    const r = await req('PATCH', '/api/admin/users/' + tmp.id, { token: admin.access_token, body: { status: 'suspended' } });
    assert(r.status === 200 && r.data.user.status === 'suspended', 'لم يُوقف');
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'client2', password: 'UserPass!2026' } });
    assert(login.status === 403 || login.status === 401, 'دخل رغم الإيقاف: ' + login.status);
    const me = await req('GET', '/api/auth/me', { token: tmp.token });
    assert(me.status === 401, 'الجلسة القديمة ما زالت صالحة');
    return 'الإيقاف يلغي الجلسات';
  });

  await t('إعادة كلمة المرور تعطي كلمة مؤقتة تعمل مرة واحدة وتسحب الجلسات', async () => {
    const tmp = await mkUser('client3');
    const r = await req('POST', `/api/admin/users/${tmp.id}/reset-password`, { token: admin.access_token });
    assert(r.status === 200 && r.data.temporary_password, 'لا توجد كلمة مؤقتة');
    const oldSession = await req('GET', '/api/auth/me', { token: tmp.token });
    assert(oldSession.status === 401, 'الجلسة القديمة لم تُسحب');
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'client3', password: r.data.temporary_password } });
    assert(login.status === 200, 'الكلمة المؤقتة لا تعمل');
    return 'كلمة مؤقتة صالحة · الجلسات مسحوبة';
  });

  await t('لا يمكن منح رتبة مساوية أو أعلى من رتبة المنفّذ', async () => {
    const bm = await mkUser('branch1', 'branch_manager');
    const r = await req('PATCH', '/api/admin/users/' + client.id, { token: bm.token, body: { role: 'super_admin' } });
    assert(r.status === 403, 'HTTP ' + r.status);
    return 'HTTP 403';
  });

  await t('مستخدم عادي لا يصل إلى لوحة الإدارة (403)', async () => {
    for (const p of ['/api/admin/users', '/api/admin/clients', '/api/admin/visitors', '/api/admin/server', '/api/admin/notifications']) {
      const r = await req('GET', p, { token: client.token });
      assert(r.status === 403, `${p} أعاد ${r.status}`);
    }
    const send = await req('POST', '/api/admin/notifications', { token: client.token, body: { title: 'محاولة', body: 'تجاوز' } });
    assert(send.status === 403, 'أرسل حملة!');
    return 'كل المسارات محمية';
  });

  await t('مدير الفرع يدير المستخدمين لكن لا يحذف حسابًا', async () => {
    const bm = await mkUser('branch2', 'branch_manager');
    const list = await req('GET', '/api/admin/users', { token: bm.token });
    assert(list.status === 200, 'لا يستطيع العرض');
    const del = await req('DELETE', '/api/admin/users/' + client.id, { token: bm.token });
    assert(del.status === 403, 'حذف!: ' + del.status);
    return 'عرض 200 · حذف 403';
  });

  await t('إنشاء مستخدم من اللوحة يعمل ويُسجَّل في التدقيق', async () => {
    const r = await req('POST', '/api/admin/users', {
      token: admin.access_token,
      body: { fullName: 'موظف جديد', username: 'newstaff', password: 'NewStaff!2026', role: 'shipping_staff', phone: '770000111' }
    });
    assert(r.status === 201, JSON.stringify(r.data));
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'newstaff', password: 'NewStaff!2026' } });
    assert(login.status === 200, 'الحساب لا يعمل');
    const audit = (await req('GET', '/api/admin/audit', { token: admin.access_token })).data.items;
    assert(audit.some((a) => a.action === 'admin_user_create'), 'لا يوجد حدث تدقيق');
    return 'الحساب يعمل + تدقيق مسجّل';
  });

  await t('حذف مستخدم = حذف ناعم مع إلغاء الجلسات', async () => {
    const tmp = await mkUser('client4');
    const r = await req('DELETE', '/api/admin/users/' + tmp.id, { token: admin.access_token });
    assert(r.status === 200 && r.data.soft_deleted, 'لم يُحذف');
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'client4', password: 'UserPass!2026' } });
    assert(login.status === 403 || login.status === 401, 'ما زال يستطيع الدخول');
    return 'محذوف ناعمًا';
  });

  await t('قائمة العملاء تُظهر الشحنات والمحفظة لكل عميل', async () => {
    const r = await req('GET', '/api/admin/clients?limit=100', { token: admin.access_token });
    assert(r.status === 200 && r.data.items.length >= 1, 'فارغة');
    const c = r.data.items.find((u) => u.username === 'client1');
    assert(typeof c.shipments === 'number' && typeof c.wallet_available === 'number', 'الحقول ناقصة');
    return `${r.data.total} عميل · أمثلة: ${c.shipments} شحنة`;
  });

  // ------------------------------------------------------ الخادم والنسخ
  console.log('\n— الخادم والنسخ الاحتياطي —');
  await t('حالة الخادم تُرجع إحصاءات حقيقية', async () => {
    const r = await req('GET', '/api/admin/server', { token: admin.access_token });
    assert(r.status === 200, 'HTTP ' + r.status);
    const c = r.data.counts;
    assert(c.users >= 5 && c.shipments >= 0 && c.visitors >= 1, 'الإحصاءات ناقصة');
    assert(r.data.node && r.data.memory_mb > 0 && r.data.uptime_s >= 0, 'بيانات العملية ناقصة');
    return `${c.users} مستخدم · ${c.visitors} زائر · ${r.data.memory_mb}MB · Node ${r.data.node}`;
  });

  await t('النسخة الاحتياطية تحتوي كل المجموعات وتُسجَّل في التدقيق', async () => {
    const r = await req('GET', '/api/admin/backup', { token: admin.access_token });
    assert(r.status === 200, 'HTTP ' + r.status);
    const bundle = JSON.parse(r.text);
    assert(bundle.collections >= 15 && bundle.data.users.length >= 5, 'النسخة ناقصة');
    assert(Array.isArray(bundle.data.campaigns) && bundle.data.campaigns.length >= 4, 'الحملات غير مشمولة');
    const audit = (await req('GET', '/api/admin/audit', { token: admin.access_token })).data.items;
    assert(audit.some((a) => a.action === 'admin_backup'), 'لا يوجد تدقيق للنسخ');
    return `${bundle.collections} مجموعة · ${bundle.data.users.length} مستخدم`;
  });

  await t('سجل التدقيق يحتوي كل عمليات الإدارة', async () => {
    const items = (await req('GET', '/api/admin/audit', { token: admin.access_token })).data.items;
    const need = ['admin_user_update', 'admin_password_reset', 'admin_campaign_send', 'admin_backup', 'admin_visitor_block'];
    const missing = need.filter((a) => !items.some((i) => i.action === a));
    assert(!missing.length, 'ناقص: ' + missing.join(', '));
    return `${items.length} حدثًا`;
  });

  await t('صحة الخدمة تُظهر نسخة المرحلة 3 أو أحدث', async () => {
    const h = await ready();
    assert(/phase(3|4|5)/.test(String(h.version)), 'النسخة: ' + h.version);
    return h.version;
  });
})()
  .catch((e) => { fail++; failures.push('تشغيل الاختبار: ' + e.message); console.error('\nفشل عام:', e.message); })
  .finally(async () => {
    try { child.kill('SIGKILL'); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    console.log('\n======================================================================');
    console.log(`النتيجة: ${pass} ناجح · ${fail} فاشل`);
    if (failures.length) { console.log('الإخفاقات:'); failures.forEach((f) => console.log('  - ' + f)); }
    fs.mkdirSync(path.join(ROOT, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'audit', 'admin-test-report.json'), JSON.stringify({ pass, fail, failures, at: new Date().toISOString() }, null, 1));
    process.exit(fail ? 1 : 0);
  });
