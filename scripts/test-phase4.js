/**
 * test-phase4.js — اختبارات قبول المرحلة 4
 * ----------------------------------------
 * التشغيل: node scripts/test-phase4.js
 * يغطي: محرّك قواعد التسعير (إنشاء/تعديل/حذف/تخصيص/حد أدنى/خصم/صلاحيات)،
 *       التقارير المالية (ملخّص/سلسلة زمنية/أفضل العملاء/تصدير CSV)،
 *       سجل التدقيق المتقدّم (فلاتر/ترقيم/تصدير)، وشركات الشحن (حالة صريحة + أحداث يدوية).
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8101;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const ADMIN_PASSWORD = 'Admin!Pass2026';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-p4-'));

let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => {
  try { const info = await fn(); pass++; console.log(`  ✅ ${name}${info ? '  → ' + info : ''}`); }
  catch (e) { fail++; failures.push(name + ': ' + e.message); console.log(`  ❌ ${name}  → ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, { body, token, raw = false } = {}) {
  const h = { accept: 'application/json' };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
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
  console.log('\n=== اختبارات المرحلة 4: التسعير والتقارير والتتبّع ===\n');
  const health = await ready();
  const admin = (await req('POST', '/api/auth/login', { body: { identifier: 'admin', password: ADMIN_PASSWORD } })).data;
  const A = admin.access_token;

  const mkUser = async (name, role = 'user') => {
    await req('POST', '/api/auth/register', { body: { fullName: 'مستخدم ' + name, email: `${name}@t.local`, phone: '78' + Math.floor(Math.random() * 1e7), username: name, password: 'UserPass!2026', role: 'user' } });
    const users = (await req('GET', '/api/admin/users?limit=100', { token: A })).data.items;
    const u = users.find((x) => x.username === name);
    if (role !== 'user') await req('PATCH', '/api/admin/users/' + u.id, { token: A, body: { role } });
    await req('PATCH', '/api/admin/users/' + u.id, { token: A, body: { status: 'active' } });
    const ses = (await req('POST', '/api/auth/login', { body: { identifier: name, password: 'UserPass!2026' } })).data;
    return { id: u.id, token: ses.access_token, username: name };
  };
  const staff = await mkUser('p4staff', 'shipping_staff');
  const client = await mkUser('p4client');
  const branch = await mkUser('p4branch', 'branch_manager');

  // ============================ التسعير ============================
  console.log('\n— قواعد التسعير —');
  await t('قواعد تسعير افتراضية موجودة وقابلة للتعديل', async () => {
    const r = await req('GET', '/api/pricing/rules', { token: staff.token });
    assert(r.status === 200, 'HTTP ' + r.status);
    assert(r.data.items.length >= 4, 'عدد القواعد ' + r.data.items.length);
    return `${r.data.items.length} قاعدة (مثال: ${r.data.items[0].name})`;
  });

  let customRuleId = null;
  await t('إنشاء قاعدة جديدة (مدير فرع) مع تحقق من المدخلات', async () => {
    const bad = await req('POST', '/api/pricing/rules', { token: branch.token, body: { name: 'قاعدة بلا سعر', rate: {} } });
    assert(bad.status === 400, 'قبلت قاعدة بلا سعر');
    const r = await req('POST', '/api/pricing/rules', {
      token: branch.token,
      body: {
        name: 'عدن — جوي سريع', priority: 20,
        match: { dest_port: 'ميناء عدن', service: 'air' },
        rate: { base_fee: 20, per_kg: 3, min_charge: 50, surcharge_pct: 10, discount_pct: 5 }
      }
    });
    assert(r.status === 201, JSON.stringify(r.data));
    customRuleId = r.data.rule.id;
    assert(r.data.rule.rate.per_kg === 3, 'السعر لم يُحفظ');
    return r.data.rule.name;
  });

  await t('الاقتباس يطبّق القاعدة الأكثر تخصيصًا لا الأعلى أولوية فقط', async () => {
    const r = await req('POST', '/api/pricing/quote', { token: client.token, body: { service: 'air', weight_kg: 10, dest_port: 'ميناء عدن' } });
    assert(r.status === 200, 'HTTP ' + r.status);
    const q = r.data.quote;
    assert(q.matched, 'لا اقتباس');
    assert(q.rule.name === 'عدن — جوي سريع', 'طُبّقت قاعدة أخرى: ' + q.rule.name);
    // الحساب: 20 + (10×3) = 50 → +10% = 55 → -5% = 52.25
    assert(q.total === 52.25, 'المبلغ غير صحيح: ' + q.total);
    return `${q.rule.name} = ${q.total}$ (رسم 20 + 30 كيلو، +10%، -5%)`;
  });

  await t('الحد الأدنى للقيمة يُطبَّق فعليًا', async () => {
    const r = await req('POST', '/api/pricing/quote', { token: client.token, body: { service: 'air', weight_kg: 1, dest_port: 'ميناء عدن' } });
    const q = r.data.quote;
    // 20 + 3 = 23 → +10% = 25.3 → -5% = 24.035 → أقل من الحد الأدنى 50
    assert(q.breakdown.min_applied === true, 'لم يُطبَّق الحد الأدنى');
    assert(q.total === 50, 'المبلغ ' + q.total);
    return `24.035 → 50 (حد أدنى)`;
  });

  await t('الاقتباس يعيد تفصيل الحساب كاملًا', async () => {
    const r = await req('POST', '/api/pricing/quote', { token: client.token, body: { service: 'sea', weight_kg: 200, volume_cbm: 3 } });
    const b = r.data.quote.breakdown;
    assert(b.base_fee > 0 && b.weight_cost > 0 && b.volume_cost > 0, 'التفصيل ناقص');
    assert(b.subtotal === Math.round((b.base_fee + b.weight_cost + b.volume_cost) * 100) / 100, 'المجموع الفرعي غير متسق');
    return `بحري 200كجم/3م³ = ${r.data.quote.total}$ (شامل ${b.volume_cost}$ حجم)`;
  });

  await t('قاعدة معطّلة لا تُستخدم في الاقتباس', async () => {
    await req('PATCH', '/api/pricing/rules/' + customRuleId, { token: branch.token, body: { active: false } });
    const r = await req('POST', '/api/pricing/quote', { token: client.token, body: { service: 'air', weight_kg: 10, dest_port: 'ميناء عدن' } });
    assert(r.data.quote.rule.name !== 'عدن — جوي سريع', 'استُخدمت قاعدة معطّلة');
    await req('PATCH', '/api/pricing/rules/' + customRuleId, { token: branch.token, body: { active: true } });
    return 'تم تجاهلها ثم أُعيد تفعيلها';
  });

  await t('شحنة بلا قاعدة مطابقة تُعلن ذلك بصراحة (بلا سعر مُقلَّد)', async () => {
    await req('PATCH', '/api/pricing/rules/' + customRuleId, { token: branch.token, body: { active: false } });
    const all = (await req('GET', '/api/pricing/rules?active=true', { token: staff.token })).data.items;
    for (const r of all) await req('PATCH', '/api/pricing/rules/' + r.id, { token: branch.token, body: { active: false } });
    const q = await req('POST', '/api/pricing/quote', { token: client.token, body: { service: 'air', weight_kg: 5 } });
    assert(q.data.quote.matched === false && q.data.quote.total === null, 'أعاد سعرًا بلا قاعدة');
    for (const r of all) await req('PATCH', '/api/pricing/rules/' + r.id, { token: branch.token, body: { active: r.active } });
    return q.data.quote.reason;
  });

  await t('إنشاء شحنة بلا سعر يستخدم محرّك التسعير تلقائيًا', async () => {
    const tn = 'P4TEST' + Date.now().toString().slice(-6);
    const r = await req('POST', '/api/shipments', {
      token: staff.token,
      body: { trackingNumber: tn, source: 'الصين', destPort: 'ميناء عدن', weight: 100, service: 'air', status: 'shipped' }
    });
    assert(r.status === 201, JSON.stringify(r.data));
    const ship = r.data.shipment;
    assert(ship.shippingCost > 0, 'لم يُحسب السعر');
    assert(ship.price_quote && ship.price_quote.rule, 'لا يوجد شرح للتسعير');
    return `${ship.trackingNumber} → ${ship.shippingCost}$ (${ship.price_quote.rule.name})`;
  });

  await t('صلاحيات التسعير: الموظف للعرض، المستخدم العادي يُرفض', async () => {
    const read = await req('GET', '/api/pricing/rules', { token: staff.token });
    assert(read.status === 200, 'الموظف لا يستطيع العرض');
    const userRead = await req('GET', '/api/pricing/rules', { token: client.token });
    assert(userRead.status === 403, 'المستخدم العادي يرى القواعد: ' + userRead.status);
    const userCreate = await req('POST', '/api/pricing/rules', { token: client.token, body: { name: 'محاولة', rate: { base_fee: 1 } } });
    assert(userCreate.status === 403, 'أنشأ قاعدة!');
    const staffCreate = await req('POST', '/api/pricing/rules', { token: staff.token, body: { name: 'محاولة موظف', rate: { base_fee: 1 } } });
    assert(staffCreate.status === 403, 'الموظف أنشأ قاعدة دون صلاحية');
    return 'عرض 200 · إنشاء 403 للموظف والمستخدم';
  });

  await t('حذف قاعدة: المدير العام فقط', async () => {
    const byBranch = await req('DELETE', '/api/pricing/rules/' + customRuleId, { token: branch.token });
    assert(byBranch.status === 403, 'مدير الفرع حذف: ' + byBranch.status);
    const byAdmin = await req('DELETE', '/api/pricing/rules/' + customRuleId, { token: A });
    assert(byAdmin.status === 200, 'لم يُحذف');
    return 'حذف 403 لمدير الفرع · 200 للمدير العام';
  });

  // ============================ التقارير ============================
  console.log('\n— التقارير المالية —');
  await t('ملخّص مالي يعكس أرصدة المحافظ والضمان والمزادات', async () => {
    const r = await req('GET', '/api/admin/reports/summary?days=30', { token: A });
    assert(r.status === 200, 'HTTP ' + r.status);
    const s = r.data;
    assert(typeof s.wallet.credits_total === 'number', 'لا مبالغ');
    assert(typeof s.escrow.available === 'number', 'لا يوجد حساب ضمان');
    assert(s.auctions.total >= 6, 'المزادات ناقصة');
    assert(typeof s.shipments.demo === 'number' && typeof s.shipments.real === 'number', 'وسم التجريبي/الحقيقي ناقص');
    assert(s.note && s.note.length > 10, 'لا يوجد توضيح للشفافية');
    return `ضمان ${s.escrow.available}$ · ${s.auctions.total} مزاد · ${s.shipments.total} شحنة (منها ${s.shipments.demo} تجريبية)`;
  });

  await t('السلسلة الزمنية تعيد عدد الأيام المطلوب مع قيم رقمية', async () => {
    const r = await req('GET', '/api/admin/reports/series?days=14', { token: A });
    assert(r.data.series.length === 14, 'الطول ' + r.data.series.length);
    const today = r.data.series[13];
    assert(today.date === new Date().toISOString().slice(0, 10), 'آخر يوم ليس اليوم');
    assert(typeof today.credits === 'number' && typeof today.entries === 'number', 'قيم غير رقمية');
    return `${r.data.series.length} يومًا · قيود اليوم ${today.entries}`;
  });

  await t('أفضل العملاء مرتبون حسب المدفوعات', async () => {
    const r = await req('GET', '/api/admin/reports/top-clients?limit=5', { token: A });
    assert(r.status === 200 && r.data.items.length >= 1, 'لا نتائج');
    const vals = r.data.items.map((x) => x.paid);
    assert(vals.every((v, i) => i === 0 || vals[i - 1] >= v), 'الترتيب غير تنازلي');
    return `${r.data.items.length} عميل · الأعلى ${r.data.items[0].name || r.data.items[0].id}`;
  });

  await t('تصدير CSV للقيود المالية بترميز عربي سليم', async () => {
    const res = await fetch(BASE + '/api/admin/reports/export?type=entries', { headers: { authorization: 'Bearer ' + A } });
    assert(res.status === 200, 'HTTP ' + res.status);
    assert(/text\/csv/.test(res.headers.get('content-type')), 'نوع المحتوى');
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'لا يوجد BOM لـExcel (UTF-8)');
    const text = buf.toString('utf8');
    assert(text.split('\r\n')[0].includes('المبلغ'), 'ترويسة عربية مفقودة');
    return `${text.split('\r\n').length - 1} صفًا · BOM سليم`;
  });

  await t('تصدير أنواع أخرى (شحنات/مزادات/تدقيق) يعمل', async () => {
    const out = [];
    for (const type of ['shipments', 'auctions', 'audit']) {
      const r = await req('GET', '/api/admin/reports/export?type=' + type, { token: A, raw: true });
      assert(r.status === 200 && r.text.split('\r\n').length > 1, 'فشل ' + type);
      out.push(type + ':' + (r.text.split('\r\n').length - 1));
    }
    const bad = await req('GET', '/api/admin/reports/export?type=xxx', { token: A });
    assert(bad.status === 400, 'نوع خاطئ لم يُرفض');
    return out.join(' · ');
  });

  await t('التقارير محجوبة عن المستخدم العادي', async () => {
    for (const p of ['/api/admin/reports/summary', '/api/admin/reports/series', '/api/admin/reports/export?type=audit']) {
      const r = await req('GET', p, { token: client.token });
      assert(r.status === 403, `${p} → ${r.status}`);
    }
    return 'كل مسارات التقارير محمية';
  });

  // ============================ سجل التدقيق ============================
  console.log('\n— سجل التدقيق المتقدّم —');
  await t('الاستعلام مع فلتر إجراء يعيد النتائج المطابقة فقط', async () => {
    const r = await req('GET', '/api/admin/audit/query?action=pricing_rule', { token: A });
    assert(r.status === 200, 'HTTP ' + r.status);
    assert(r.data.items.length >= 2, 'لا نتائج');
    assert(r.data.items.every((i) => String(i.action).includes('pricing_rule')), 'تسرّب نتائج غير مطابقة');
    return `${r.data.total} حدثًا · ${r.data.facets.actions.length} إجراءً متاحًا`;
  });

  await t('الترقيم والفلاتر الزمنية تعمل', async () => {
    const page1 = await req('GET', '/api/admin/audit/query?limit=5&page=1', { token: A });
    const page2 = await req('GET', '/api/admin/audit/query?limit=5&page=2', { token: A });
    assert(page1.data.items.length === 5, 'حجم الصفحة');
    assert(page1.data.items[0].id !== page2.data.items[0].id, 'نفس الصفحة');
    const today = new Date().toISOString().slice(0, 10);
    const ranged = await req('GET', `/api/admin/audit/query?from=${today}&to=${today}`, { token: A });
    assert(ranged.data.total >= 1, 'فلتر التاريخ لا يعمل');
    return `صفحة 1 و2 مختلفتان · أحداث اليوم ${ranged.data.total}`;
  });

  // ============================ شركات الشحن ============================
  console.log('\n— شركات الشحن والتتبّع —');
  await t('حالة المزوّدين صريحة: اليدوي جاهز والبقية تحتاج مفاتيح', async () => {
    const r = await req('GET', '/api/admin/carriers', { token: staff.token });
    assert(r.status === 200, 'HTTP ' + r.status);
    const manual = r.data.providers.find((p) => p.id === 'manual');
    const track17 = r.data.providers.find((p) => p.id === '17track');
    assert(manual.ready === true, 'اليدوي غير جاهز');
    assert(track17.ready === false && /17TRACK_API_KEY/.test(track17.note), 'الملاحظة غير صريحة');
    return `${r.data.providers.length} مزوّد · النشط: ${r.data.active}`;
  });

  await t('إضافة حدث تتبّع يدوي تُحفظ وتُسجَّل في التدقيق', async () => {
    const tn = 'P4TEST' + (Date.now() - 1000).toString().slice(-6);
    await req('POST', '/api/shipments', { token: staff.token, body: { trackingNumber: tn, source: 'الإمارات', destPort: 'ميناء عدن', weight: 50, status: 'shipped' } });
    const r = await req('POST', '/api/admin/carriers/events', {
      token: staff.token,
      body: { tracking_number: tn, status: 'وصلت مركز الفرز', location: 'عدن — المنصورة', note: 'فحص ظاهري سليم' }
    });
    assert(r.status === 201, JSON.stringify(r.data));
    const track = await req('POST', '/api/admin/carriers/track', { token: staff.token, body: { tracking_number: tn } });
    assert(track.data.result.events.length === 1, 'الحدث غير ظاهر');
    const audit = await req('GET', '/api/admin/audit/query?action=carrier_event_add', { token: A });
    assert(audit.data.total >= 1, 'لا تدقيق للحدث');
    return `${track.data.result.events[0].status} · ${track.data.result.note.slice(0, 35)}…`;
  });

  await t('استعلام مزوّد غير مهيّأ يعيد ready:false بلا بيانات وهمية', async () => {
    const r = await req('POST', '/api/admin/carriers/track', { token: staff.token, body: { tracking_number: 'P4TEST000001', provider: 'dhl' } });
    assert(r.status === 200, 'HTTP ' + r.status);
    assert(r.data.result.ready === false, 'ادّعى الجاهزية');
    assert((r.data.result.events || []).length === 0, 'أعاد أحداثًا وهمية');
    return r.data.result.note.slice(0, 60) + '…';
  });

  await t('حدث لشحنة غير موجودة يُرفض 404', async () => {
    const r = await req('POST', '/api/admin/carriers/events', { token: staff.token, body: { tracking_number: 'NOPE-000', status: 'x' } });
    assert(r.status === 404, 'HTTP ' + r.status);
    return 'HTTP 404';
  });

  await t('صحة الخدمة تُظهر نسخة المرحلة 4 أو أحدث', async () => {
    const h = await ready();
    assert(/phase([4-9]|[1-9][0-9])/.test(String(h.version)), 'النسخة: ' + h.version);
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
    fs.writeFileSync(path.join(ROOT, 'audit', 'phase4-test-report.json'), JSON.stringify({ pass, fail, failures, at: new Date().toISOString() }, null, 1));
    process.exit(fail ? 1 : 0);
  });
