/**
 * test-api.mjs — اختبارات تكامل حقيقية للخادم (المرحلة 1)
 * التشغيل: node scripts/test-api.mjs
 * يبدأ الخادم على منفذ معزول ومجلد بيانات مؤقت، ثم يختبر كل شيء فعليًا عبر HTTP.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-test-'));
const ADMIN_PASSWORD = 'TestAdmin!2026';

let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => {
  try { const info = await fn(); pass++; console.log(`  ✅ ${name}${info ? '  → ' + info : ''}`); }
  catch (e) { fail++; failures.push({ name, error: e.message }); console.log(`  ❌ ${name}  → ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'قيم غير متساوية'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

const req = async (method, path, { body, token, headers = {} } = {}) => {
  const h = { accept: 'application/json', ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
};

// ---------- تشغيل الخادم ----------
const child = spawn(process.execPath, [path.join(process.cwd(), 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD, HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('الخادم لم يبدأ:\n' + serverLog);
};

const cleanup = () => { try { child.kill('SIGKILL'); } catch {} };

try {
  await waitReady();
  console.log('\n=== اختبارات الخادم والمصادقة ===\n');
  let admin, user, userToken, adminToken;

  await t('صحة الخدمة /api/health', async () => {
    const r = await req('GET', '/api/health');
    eq(r.status, 200); assert(r.data.ok, 'ok=false'); return `${r.data.version} · ${r.data.storage}`;
  });

  await t('الواجهة تُقدَّم من الخادم (index.html)', async () => {
    const res = await fetch(BASE + '/');
    const html = await res.text();
    eq(res.status, 200); assert(html.includes('المسار العالمي اللوجستي'), 'محتوى غير متوقع');
    assert(html.includes('js/phase1.js'), 'طبقة المرحلة 1 غير محمّلة');
    return `${(html.length / 1024).toFixed(0)} KB`;
  });

  await t('دخول بكلمة مرور خاطئة يُرفض', async () => {
    const r = await req('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'wrong' } });
    eq(r.status, 401);
  });

  await t('دخول المدير العام يعمل ويُصدر رموزًا', async () => {
    const r = await req('POST', '/api/auth/login', { body: { identifier: 'admin', password: ADMIN_PASSWORD } });
    eq(r.status, 200, 'فشل الدخول: ' + JSON.stringify(r.data));
    assert(r.data.access_token && r.data.refresh_token, 'رموز ناقصة');
    assert(r.data.user.role === 'super_admin', 'دور خاطئ');
    assert(!('password_hash' in r.data.user), 'تسريب hash');
    admin = r.data.user; adminToken = r.data.access_token;
    return 'super_admin · access+refresh';
  });

  await t('كلمة المرور لا تُخزَّن بنص صريح', async () => {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8');
    assert(!raw.includes(ADMIN_PASSWORD), 'كلمة المرور ظاهرة في ملف البيانات!');
    assert(raw.includes('scrypt$'), 'لا يوجد تشفير scrypt');
    return 'scrypt + salt';
  });

  await t('الرمز المزوّر مرفوض', async () => {
    const forged = adminToken.slice(0, -4) + 'aaaa';
    const r = await req('GET', '/api/auth/me', { token: forged });
    eq(r.status, 401);
  });

  await t('‎/api/auth/me يعيد المستخدم', async () => {
    const r = await req('GET', '/api/auth/me', { token: adminToken });
    eq(r.status, 200); eq(r.data.user.username, 'admin');
  });

  await t('رفض الوصول بدون رمز', async () => {
    const r = await req('GET', '/api/shipments');
    eq(r.status, 401);
  });

  console.log('\n=== الشحنات والصلاحيات ===\n');

  await t('إنشاء شحنة (مدير) والتحقق من الحفظ', async () => {
    const r = await req('POST', '/api/shipments', {
      token: adminToken,
      body: { trackingNumber: 'TEST-0001', status: 'shipped', sender: 'مورد اختبار', receiver: 'عميل اختبار', invoiceValue: 5000, goods: 'بضائع اختبار', creationDate: '2026-11-20', weight: 120 }
    });
    eq(r.status, 201, JSON.stringify(r.data));
    const list = await req('GET', '/api/shipments', { token: adminToken });
    assert(list.data.items.some((s) => s.trackingNumber === 'TEST-0001'), 'غير موجودة بعد الإنشاء');
    return 'TEST-0001';
  });

  await t('منع تكرار رقم الشحنة (409)', async () => {
    const r = await req('POST', '/api/shipments', { token: adminToken, body: { trackingNumber: 'TEST-0001' } });
    eq(r.status, 409);
  });

  await t('فلترة الشحنات حسب الحالة والبحث', async () => {
    const byStatus = await req('GET', '/api/shipments?status=shipped', { token: adminToken });
    assert(byStatus.data.items.every((s) => s.status === 'shipped'), 'فلترة الحالة لا تعمل');
    const search = await req('GET', '/api/shipments?q=TEST-0001', { token: adminToken });
    eq(search.data.items.length, 1);
    return `${byStatus.data.total} في الطريق`;
  });

  await t('تسجيل مستخدم جديد → pending', async () => {
    const r = await req('POST', '/api/auth/register', {
      body: { fullName: 'مستخدم اختبار', email: 'u1@test.local', phone: '777000001', username: 'user1', password: 'UserPass!2026', role: 'user' }
    });
    eq(r.status, 201, JSON.stringify(r.data));
    eq(r.data.user.status, 'pending');
    user = r.data.user; return 'بانتظار الموافقة';
  });

  await t('منع الدخول قبل الموافقة (403)', async () => {
    const r = await req('POST', '/api/auth/login', { body: { identifier: 'user1', password: 'UserPass!2026' } });
    eq(r.status, 403);
  });

  await t('موافقة المدير تُفعّل الحساب', async () => {
    const r = await req('PATCH', '/api/users/' + user.id, { token: adminToken, body: { status: 'active' } });
    eq(r.status, 200); eq(r.data.user.status, 'active');
  });

  await t('دخول المستخدم المفعّل يعمل', async () => {
    const r = await req('POST', '/api/auth/login', { body: { identifier: 'user1', password: 'UserPass!2026' } });
    eq(r.status, 200); userToken = r.data.access_token; return 'ok';
  });

  await t('المستخدم العادي لا يستطيع إنشاء شحنة (403)', async () => {
    const r = await req('POST', '/api/shipments', { token: userToken, body: { trackingNumber: 'HACK-1' } });
    eq(r.status, 403);
  });

  await t('المستخدم العادي لا يرى قائمة المستخدمين (403)', async () => {
    const r = await req('GET', '/api/users', { token: userToken });
    eq(r.status, 403);
  });

  await t('محاولة ترقية الذات إلى مدير عبر التسجيل مرفوضة', async () => {
    const r = await req('POST', '/api/auth/register', {
      body: { fullName: 'متسلل', email: 'x@test.local', phone: '777000009', username: 'hacker', password: 'Hacker!2026', role: 'super_admin' }
    });
    eq(r.status, 201);
    eq(r.data.user.role, 'user', 'تم منح دور إداري ذاتيًا!');
  });

  console.log('\n=== المفضلة والتقييمات ===\n');

  await t('إضافة عنصر للمفضلة + منع التكرار', async () => {
    const a = await req('POST', '/api/favorites', { token: userToken, body: { item_type: 'warehouse', item_id: 'UAE-JA-001' } });
    eq(a.status, 201);
    const b = await req('POST', '/api/favorites', { token: userToken, body: { item_type: 'warehouse', item_id: 'UAE-JA-001' } });
    eq(b.status, 200); assert(b.data.duplicate, 'لم يُكتشف التكرار');
    const list = await req('GET', '/api/favorites', { token: userToken });
    eq(list.data.items.length, 1);
  });

  await t('حذف عنصر من المفضلة', async () => {
    const r = await req('DELETE', '/api/favorites/warehouse/UAE-JA-001', { token: userToken });
    eq(r.status, 200);
    const list = await req('GET', '/api/favorites', { token: userToken });
    eq(list.data.items.length, 0);
  });

  await t('تقييم جديد + منع تقييمين لنفس المستخدم (409)', async () => {
    const a = await req('POST', '/api/reviews', { token: userToken, body: { item_type: 'shipment', item_id: 'TEST-0001', rating: 5, comment: 'خدمة ممتازة' } });
    eq(a.status, 201);
    const b = await req('POST', '/api/reviews', { token: userToken, body: { item_type: 'shipment', item_id: 'TEST-0001', rating: 1 } });
    eq(b.status, 409);
    const list = await req('GET', '/api/reviews?item_type=shipment&item_id=TEST-0001');
    eq(list.data.count, 1); eq(list.data.average, 5);
    return 'متوسط 5.0';
  });

  await t('رفض تقييم خارج النطاق 1..5', async () => {
    const r = await req('POST', '/api/reviews', { token: adminToken, body: { item_type: 'shipment', item_id: 'TEST-0001', rating: 9 } });
    eq(r.status, 400);
  });

  console.log('\n=== الرموز والجلسات ===\n');

  await t('تجديد الرمز يعمل ويُبطل القديم', async () => {
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'user1', password: 'UserPass!2026' } });
    const rt = login.data.refresh_token;
    const a = await req('POST', '/api/auth/refresh', { body: { refresh_token: rt } });
    eq(a.status, 200);
    const b = await req('POST', '/api/auth/refresh', { body: { refresh_token: rt } });
    eq(b.status, 401, 'الرمز القديم ما زال صالحًا!');
    const c = await req('GET', '/api/auth/me', { token: a.data.access_token });
    eq(c.status, 200);
  });

  await t('تسجيل الخروج يُبطل رمز التحديث', async () => {
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'user1', password: 'UserPass!2026' } });
    const rt = login.data.refresh_token;
    const out = await req('POST', '/api/auth/logout', { body: { refresh_token: rt } });
    eq(out.status, 200);
    const again = await req('POST', '/api/auth/refresh', { body: { refresh_token: rt } });
    eq(again.status, 401);
  });

  await t('تغيير كلمة المرور يتحقق من الحالية', async () => {
    const bad = await req('POST', '/api/auth/change-password', { token: userToken, body: { current_password: 'wrong', new_password: 'NewPass!2026' } });
    eq(bad.status, 400);
    const good = await req('POST', '/api/auth/change-password', { token: userToken, body: { current_password: 'UserPass!2026', new_password: 'NewPass!2026' } });
    eq(good.status, 200);
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'user1', password: 'NewPass!2026' } });
    eq(login.status, 200);
  });

  await t('تحديد محاولات الدخول (Rate Limit)', async () => {
    const ip = '10.9.9.9';
    let last = 0;
    for (let i = 0; i < 45; i++) {
      const r = await req('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'bad' }, headers: { 'x-forwarded-for': ip } });
      last = r.status;
      if (r.status === 429) break;
    }
    eq(last, 429, 'لم يُفعّل حد المحاولات');
    return '429 بعد محاولات متكررة';
  });

  console.log('\n=== البيانات الحية ===\n');

  await t('أسعار صرف حية من مصدرها مع وسم الوقت', async () => {
    const r = await req('GET', '/api/live/fx');
    if (r.status === 502) return 'تخطٍّ: المصدر غير متاح من هذه الشبكة (' + r.data.error + ')';
    eq(r.status, 200);
    assert(r.data.source, 'لا يوجد وسم مصدر');
    assert(r.data.fetched_at, 'لا يوجد وقت جلب');
    assert(r.data.rates && Object.keys(r.data.rates).length > 0, 'لا أسعار');
    return `${Object.keys(r.data.rates).length} عملة · ${r.data.source.slice(0, 28)}…`;
  });

  await t('طقس الموانئ حي (عدن)', async () => {
    const r = await req('GET', '/api/live/weather');
    if (r.status === 502) return 'تخطٍّ: المصدر غير متاح';
    const aden = r.data.ports.find((p) => p.port_id === 'aden');
    assert(aden && !aden.error, 'لا بيانات لعدن');
    return `${aden.temperature_c}°م · موجة ${aden.wave_height_m ?? '—'} م`;
  });

  await t('أخبار لوجستية حية (RSS)', async () => {
    const r = await req('GET', '/api/live/news');
    if (r.status === 502) return 'تخطٍّ: المصدر غير متاح';
    const n = r.data.feeds.reduce((s, f) => s + f.items.length, 0);
    assert(n > 0, 'لا أخبار');
    return `${n} خبرًا من ${r.data.feeds.length} مصادر`;
  });

  await t('التخزين المؤقت يعمل (cached=true في الطلب الثاني)', async () => {
    const a = await req('GET', '/api/live/fx');
    if (a.status === 502) return 'تخطٍّ';
    const b = await req('GET', '/api/live/fx');
    assert(b.data.cached === true, 'لم يُستخدم التخزين المؤقت');
  });

  console.log('\n=== البث اللحظي والإدارة ===\n');

  await t('SSE يبث حدث إنشاء شحنة لحظيًا', async () => {
    const ctl = new AbortController();
    const res = await fetch(`${BASE}/api/stream?topics=shipments&token=${adminToken}`, { signal: ctl.signal });
    eq(res.status, 200);
    eq(res.headers.get('content-type').split(';')[0], 'text/event-stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (needle, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes(needle)) return true;
      }
      return false;
    };
    assert(await readUntil('event: hello'), 'لم يصل hello');
    await req('POST', '/api/shipments', { token: adminToken, body: { trackingNumber: 'SSE-1', status: 'processing' } });
    const got = await readUntil('event: shipment_created');
    ctl.abort();
    assert(got, 'لم يصل حدث shipment_created');
    return 'hello + shipment_created';
  });

  await t('سجل التدقيق يُسجّل العمليات', async () => {
    const r = await req('GET', '/api/admin/audit', { token: adminToken });
    eq(r.status, 200);
    assert(r.data.items.length > 5, 'السجل فارغ');
    assert(r.data.items.some((x) => x.action === 'login'), 'لا يوجد تسجيل دخول');
    return `${r.data.items.length} حدثًا`;
  });

  await t('إحصاءات الإدارة', async () => {
    const r = await req('GET', '/api/admin/stats', { token: adminToken });
    eq(r.status, 200);
    assert(r.data.users >= 3 && r.data.shipments >= 2, 'أرقام غير منطقية');
    return `${r.data.users} مستخدم · ${r.data.shipments} شحنة · ${r.data.audit_events} حدث`;
  });

  await t('استيراد بيانات النظام القديم (تصدير JSON)', async () => {
    const r = await req('POST', '/api/admin/import', {
      token: adminToken,
      body: { shipments: [{ trackingNumber: 'LEGACY-77', status: 'delivered', invoiceValue: 900 }], systemUsers: [{ username: 'olduser', password: 'OldPass123', fullName: 'قديم', role: 'user' }] }
    });
    eq(r.status, 200);
    eq(r.data.shipments, 1); eq(r.data.users, 1);
    const login = await req('POST', '/api/auth/login', { body: { identifier: 'olduser', password: 'OldPass123' } });
    eq(login.status, 200, 'المستخدم المستورد لا يستطيع الدخول');
  });

  await t('المسارات غير الموجودة ترجع 404', async () => {
    const r = await req('GET', '/api/nope');
    eq(r.status, 404);
  });

} catch (e) {
  console.error('\nفشل تشغيل الاختبارات:', e.message);
  fail++;
} finally {
  cleanup();
  console.log(`\n================ النتيجة: ${pass} ناجح · ${fail} فاشل ================`);
  if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach((f) => console.log(' -', f.name, '=>', f.error)); }
  fs.writeFileSync('/home/user/audit/api-test-report.json', JSON.stringify({ pass, fail, failures, at: new Date().toISOString() }, null, 1));
  process.exit(fail ? 1 : 0);
}
