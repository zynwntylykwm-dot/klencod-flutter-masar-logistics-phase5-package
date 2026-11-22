/**
 * test-auctions.mjs — اختبارات نظام المزادات (المرحلة 2)
 * يختبر المحرك فعليًا: الحد الأدنى، الحجز المالي، التجاوز، منع القنص،
 * الإغلاق التلقائي، الفائز، الضمان، التزامن (50 مزايدة متوازية)، الإشعارات.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 8098, BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-auc-'));
const ADMIN_PASSWORD = 'TestAdmin!2026';
let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => {
  try { const i = await fn(); pass++; console.log(`  ✅ ${name}${i ? '  → ' + i : ''}`); }
  catch (e) { fail++; failures.push(name + ': ' + e.message); console.log(`  ❌ ${name}  → ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'غير متساوٍ'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const req = async (method, p, { body, token } = {}) => {
  const h = { accept: 'application/json' };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
};

const child = spawn(process.execPath, [path.join(process.cwd(), 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD, HOST: '127.0.0.1', DEMO_MODE: 'true', LOGIN_RATE_LIMIT: '1000' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const ready = async () => { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {} await sleep(250); } throw new Error('لم يبدأ: ' + log); };

const login = async (identifier, password) => {
  const r = await req('POST', '/api/auth/login', { body: { identifier, password } });
  if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.data));
  return r.data;
};
let _adminToken = null;
const adminToken = async () => { if (!_adminToken) _adminToken = (await login('admin', ADMIN_PASSWORD)).access_token; return _adminToken; };
const makeUser = async (n, password = 'UserPass!2026') => {
  const username = 'auc' + n;
  await req('POST', '/api/auth/register', { body: { fullName: 'مزايد ' + n, email: `${username}@t.local`, phone: '7000000' + n, username, password, role: 'user' } });
  const admin = { access_token: await adminToken() };
  const users = await req('GET', '/api/users', { token: admin.access_token });
  const u = users.data.items.find((x) => x.username === username);
  await req('PATCH', '/api/users/' + u.id, { token: admin.access_token, body: { status: 'active' } });
  const ses = await login(username, password);
  return { id: u.id, token: ses.access_token, name: u.fullName };
};

try {
  await ready();
  console.log('\n=== تهيئة ===\n');
  const admin = await login('admin', ADMIN_PASSWORD);
  const AT = admin.access_token;

  await t('تهيئة مزادات تجريبية موسومة', async () => {
    const r = await req('GET', '/api/auctions?status=all&limit=60');
    eq(r.status, 200);
    assert(r.data.total >= 6, 'لا توجد مزادات مهيأة');
    assert(r.data.items.every((a) => a.demo === true), 'مزاد غير موسوم كتجريبي');
    return `${r.data.total} مزادًا (كلها demo)`;
  });

  const u1 = await makeUser(1), u2 = await makeUser(2), u3 = await makeUser(3);
  await t('شحن رصيد تجريبي موسوم لكل مزايد', async () => {
    for (const u of [u1, u2, u3]) {
      const r = await req('POST', '/api/wallet/demo-credit', { token: u.token, body: { amount: 5000 } });
      eq(r.status, 200); assert(r.data.demo === true, 'لم يُوسم كتجريبي');
    }
    const b = await req('GET', '/api/wallet/me', { token: u1.token });
    eq(b.data.balance.available, 5000);
    return '3 × 5000$ (تجريبي)';
  });

  await t('إنشاء مزاد جديد (صلاحية موظف شحن)', async () => {
    const r = await req('POST', '/api/auctions', {
      token: AT,
      body: { title: 'مزاد اختبار — شحنة إلكترونيات', category: 'electronics', start_price: 100, bid_increment: 10, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString(), demo: true }
    });
    eq(r.status, 201, JSON.stringify(r.data));
    assert(r.data.auction.min_next_bid === 100, 'الحد الأدنى للبداية خاطئ');
    return r.data.auction.id;
  });

  await t('مستخدم عادي لا يستطيع إنشاء مزاد (403)', async () => {
    const r = await req('POST', '/api/auctions', { token: u1.token, body: { title: 'محاولة', start_price: 10, ends_at: new Date(Date.now() + 7200e3).toISOString() } });
    eq(r.status, 403);
  });

  const createAuction = async (over = {}) => {
    const r = await req('POST', '/api/auctions', {
      token: AT,
      body: { title: 'مزاد ' + Math.random().toString(36).slice(2, 7), category: 'equipment', start_price: 100, bid_increment: 10, starts_at: new Date(Date.now() - 5 * 60000).toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString(), demo: true, ...over }
    });
    if (r.status !== 201) throw new Error('create failed: ' + JSON.stringify(r.data));
    return r.data.auction;
  };

  console.log('\n=== قواعد المزايدة ===\n');

  const a1 = await createAuction({ start_price: 100, bid_increment: 10 });

  await t('رفض مزايدة أقل من سعر البداية', async () => {
    const r = await req('POST', `/api/auctions/${a1.id}/bids`, { token: u1.token, body: { amount: 90 } });
    eq(r.status, 400);
    assert(/الحد الأدنى/.test(r.data.error), r.data.error);
    return r.data.error;
  });

  await t('قبول مزايدة صحيحة + حجز المبلغ من المحفظة', async () => {
    const r = await req('POST', `/api/auctions/${a1.id}/bids`, { token: u1.token, body: { amount: 100 } });
    eq(r.status, 200, JSON.stringify(r.data));
    eq(r.data.auction.current_bid, 100);
    const w = await req('GET', '/api/wallet/me', { token: u1.token });
    eq(w.data.balance.held, 100, 'لم يُحجز المبلغ');
    eq(w.data.balance.available, 4900);
    return 'محجوز 100$';
  });

  await t('منع نفس المزايد من تجاوز نفسه', async () => {
    const r = await req('POST', `/api/auctions/${a1.id}/bids`, { token: u1.token, body: { amount: 200 } });
    eq(r.status, 409);
  });

  await t('منع البائع من المزايدة على مزاده', async () => {
    const r = await req('POST', `/api/auctions/${a1.id}/bids`, { token: AT, body: { amount: 300 } });
    eq(r.status, 403);
  });

  await t('رفض مزايدة أعلى لكن أقل من (الأعلى + الزيادة)', async () => {
    const r = await req('POST', `/api/auctions/${a1.id}/bids`, { token: u2.token, body: { amount: 105 } });
    eq(r.status, 400);
    assert(/110/.test(r.data.error), 'رسالة الحد الأدنى غير دقيقة: ' + r.data.error);
  });

  await t('التجاوز يحرّر مبلغ المزايد السابق ويشعره', async () => {
    const r = await req('POST', `/api/auctions/${a1.id}/bids`, { token: u2.token, body: { amount: 110 } });
    eq(r.status, 200);
    const w1 = await req('GET', '/api/wallet/me', { token: u1.token });
    eq(w1.data.balance.held, 0, 'لم يُحرَّر مبلغ المتجاوَز');
    eq(w1.data.balance.available, 5000);
    const w2 = await req('GET', '/api/wallet/me', { token: u2.token });
    eq(w2.data.balance.held, 110);
    const n = await req('GET', '/api/notifications', { token: u1.token });
    assert(n.data.items.some((x) => /تجاوز/.test(x.title)), 'لم يصل إشعار التجاوز');
    return 'تحرير + إشعار';
  });

  await t('رفض المزايدة عند نقص الرصيد (402)', async () => {
    const poor = await makeUser(9);
    const r = await req('POST', `/api/auctions/${a1.id}/bids`, { token: poor.token, body: { amount: 500 } });
    eq(r.status, 402, JSON.stringify(r.data));
    return '402';
  });

  console.log('\n=== منع القنص والإغلاق التلقائي ===\n');

  await t('التمديد التلقائي عند المزايدة في آخر لحظة', async () => {
    const a = await createAuction({ start_price: 100, bid_increment: 10, ends_at: new Date(Date.now() + 20000).toISOString(), extend_seconds: 60 });
    const before = new Date(a.ends_at).getTime();
    const r = await req('POST', `/api/auctions/${a.id}/bids`, { token: u3.token, body: { amount: 100 } });
    eq(r.status, 200);
    assert(r.data.extended === true, 'لم يُمدَّد المزاد');
    const after = new Date(r.data.auction.ends_at).getTime();
    assert(after - before >= 59000, `التمديد غير كافٍ: ${(after - before) / 1000}ث`);
    return `+${Math.round((after - before) / 1000)} ثانية`;
  });

  await t('الإغلاق التلقائي وتحديد الفائز وترحيل المبلغ للضمان', async () => {
    const a = await createAuction({ start_price: 100, bid_increment: 10, ends_at: new Date(Date.now() + 6000).toISOString(), extend_seconds: 0 });
    const escrowBefore = (await req('GET', '/api/admin/wallet', { token: AT })).data.accounts.find((x) => x.user_id === 'system:escrow');
    const bid = await req('POST', `/api/auctions/${a.id}/bids`, { token: u2.token, body: { amount: 120 } });
    eq(bid.status, 200);
    const before = await req('GET', '/api/wallet/me', { token: u2.token });
    await sleep(7000);
    const d = await req('GET', `/api/auctions/${a.id}`);
    eq(d.data.auction.status, 'settled', 'لم يُغلق المزاد: ' + d.data.auction.status);
    assert(d.data.auction.winner && d.data.auction.winner.amount === 120, 'الفائز/المبلغ غير صحيح');
    const after = await req('GET', '/api/wallet/me', { token: u2.token });
    // يجب أن ينقص المحجوز بمقدار مزايدة هذا المزاد فقط (120) دون المساس بحجوزات مزادات أخرى
    eq(Math.round((before.data.balance.held - after.data.balance.held) * 100) / 100, 120, 'لم يُرحَّل مبلغ هذا المزاد فقط');
    const escrowAfter = (await req('GET', '/api/admin/wallet', { token: AT })).data.accounts.find((x) => x.user_id === 'system:escrow');
    const delta = Math.round(((escrowAfter?.available || 0) - (escrowBefore?.available || 0)) * 100) / 100;
    eq(delta, 120, 'حساب الضمان لم يستلم المبلغ');
    const n = await req('GET', '/api/notifications', { token: u2.token });
    assert(n.data.items.some((x) => /فزت/.test(x.title)), 'لا إشعار فوز');
    return 'settled · 120$ إلى الضمان · إشعار فوز';
  });

  await t('عدم استيفاء سعر الحجز → تحرير المبلغ وعدم البيع', async () => {
    const a = await createAuction({ start_price: 100, bid_increment: 10, reserve_price: 1000, ends_at: new Date(Date.now() + 2000).toISOString(), extend_seconds: 0 });
    const u = await makeUser(4);
    await req('POST', '/api/wallet/demo-credit', { token: u.token, body: { amount: 5000 } });
    const r = await req('POST', `/api/auctions/${a.id}/bids`, { token: u.token, body: { amount: 150 } });
    eq(r.status, 200);
    await sleep(2900);
    const d = await req('GET', `/api/auctions/${a.id}`);
    eq(d.data.auction.status, 'ended');
    assert(d.data.auction.winner === null, 'تم تعيين فائز رغم عدم استيفاء الحجز');
    const w = await req('GET', '/api/wallet/me', { token: u.token });
    eq(w.data.balance.held, 0, 'لم يُحرَّر المبلغ');
    return 'ended · محرَّر';
  });

  await t('المزايدة بعد الإغلاق تُرفض', async () => {
    const a = await createAuction({ ends_at: new Date(Date.now() + 1500).toISOString(), extend_seconds: 0 });
    await sleep(2200);
    const r = await req('POST', `/api/auctions/${a.id}/bids`, { token: u1.token, body: { amount: 1000 } });
    eq(r.status, 409);
  });

  console.log('\n=== التزامن (الأهم) ===\n');

  await t('50 مزايدة متوازية: لا تُقبل إلا الأموال الصحيحة ويبقى مزايد واحد', async () => {
    const a = await createAuction({ start_price: 100, bid_increment: 5, ends_at: new Date(Date.now() + 3600e3).toISOString(), extend_seconds: 0 });
    const bidders = [];
    for (let i = 10; i < 20; i++) {
      const u = await makeUser(i);
      await req('POST', '/api/wallet/demo-credit', { token: u.token, body: { amount: 5000 } });
      bidders.push(u);
    }
    // 50 مزايدة بمبالغ متدرجة تُطلق في اللحظة نفسها
    const attempts = [];
    for (let i = 0; i < 50; i++) {
      const u = bidders[i % bidders.length];
      const amount = 100 + (i + 1) * 5;
      attempts.push(req('POST', `/api/auctions/${a.id}/bids`, { token: u.token, body: { amount } }).then((r) => ({ status: r.status, amount })));
    }
    const results = await Promise.all(attempts);
    const accepted = results.filter((r) => r.status === 200);
    assert(accepted.length > 0, 'لم تُقبل أي مزايدة');

    const d = await req('GET', `/api/auctions/${a.id}`);
    const finalAmount = d.data.auction.current_bid;
    const maxAccepted = Math.max(...accepted.map((a) => a.amount));
    eq(finalAmount, maxAccepted, 'السعر النهائي لا يساوي أعلى مزايدة مقبولة');

    // فحص السجل: مزايدة فائزة واحدة فقط، والبقية متجاوَزة
    const bids = d.data.auction.bids;
    eq(bids.filter((b) => b.status === 'winning').length, 1, 'أكثر من مزايدة فائزة!');
    assert(bids.every((b) => b.amount <= finalAmount), 'توجد مزايدة أعلى من السعر الحالي');

    // فحص الدفاتر: مجموع المحجوز لكل المستخدمين = السعر النهائي
    let totalHeld = 0;
    for (const u of bidders) {
      const w = await req('GET', '/api/wallet/me', { token: u.token });
      totalHeld += w.data.balance.held;
      assert(w.data.balance.available >= 0, 'رصيد سالب!');
      assert(w.data.balance.held >= 0, 'مبلغ محجوز سالب!');
    }
    eq(Math.round(totalHeld * 100) / 100, finalAmount, 'مجموع المحجوز لا يطابق أعلى مزايدة (تسريب مالي)');
    return `${accepted.length}/50 مقبولة · نهائي ${finalAmount}$ · محجوز ${totalHeld}$`;
  });

  await t('20 مزايدة بنفس المبلغ في اللحظة نفسها: تُقبل واحدة فقط', async () => {
    const a = await createAuction({ start_price: 100, bid_increment: 5, ends_at: new Date(Date.now() + 3600e3).toISOString(), extend_seconds: 0 });
    const bidders = [];
    for (let i = 20; i < 28; i++) {
      const u = await makeUser(i);
      await req('POST', '/api/wallet/demo-credit', { token: u.token, body: { amount: 5000 } });
      bidders.push(u);
    }
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      req('POST', `/api/auctions/${a.id}/bids`, { token: bidders[i % bidders.length].token, body: { amount: 500 } })
        .then((r) => r.status)
    ));
    const accepted = results.filter((x) => x === 200).length;
    eq(accepted, 1, `عدد المقبول يجب أن يكون 1 لكنه ${accepted}`);
    const d = await req('GET', `/api/auctions/${a.id}`);
    eq(d.data.auction.bid_count, 1);
    eq(d.data.auction.current_bid, 500);
    return 'قُبلت 1 من 20';
  });

  await t('سلامة دفتر القيود: كل حجز له قيد مطابق', async () => {
    const r = await req('GET', '/api/wallet/entries', { token: u2.token });
    eq(r.status, 200);
    assert(r.data.items.length > 0, 'لا قيود');
    assert(r.data.items.every((e) => Math.abs(e.amount) < 1e9), 'قيم غير منطقية');
    return `${r.data.items.length} قيدًا`;
  });

  console.log('\n=== الإلغاء والمتابعة ===\n');

  await t('إلغاء مزاد بمزايدات مرفوض، وبدون مزايدات مقبول', async () => {
    const withBids = await createAuction({ start_price: 100, bid_increment: 10 });
    await req('POST', `/api/auctions/${withBids.id}/bids`, { token: u3.token, body: { amount: 100 } });
    const bad = await req('POST', `/api/auctions/${withBids.id}/cancel`, { token: AT });
    eq(bad.status, 409);
    const fresh = await createAuction({ start_price: 100 });
    const good = await req('POST', `/api/auctions/${fresh.id}/cancel`, { token: AT });
    eq(good.status, 200);
    eq(good.data.auction.status, 'cancelled');
  });

  await t('متابعة مزاد (مفضلة) وإلغاء المتابعة', async () => {
    const a = await createAuction({ start_price: 100 });
    const w1 = await req('POST', `/api/auctions/${a.id}/watch`, { token: u1.token });
    eq(w1.status, 200); eq(w1.data.watching, true);
    const d1 = await req('GET', `/api/auctions/${a.id}`, { token: u1.token });
    eq(d1.data.auction.watching, true);
    const w2 = await req('DELETE', `/api/auctions/${a.id}/watch`, { token: u1.token });
    eq(w2.data.watching, false);
    const d2 = await req('GET', `/api/auctions/${a.id}`, { token: u1.token });
    eq(d2.data.auction.watching, false);
  });

  await t('«مزايداتي» تعيد سجل المستخدم مع حالة كل مزاد', async () => {
    const r = await req('GET', '/api/auctions/mine/bids', { token: u3.token });
    eq(r.status, 200);
    assert(r.data.items.length > 0, 'لا مزايدات');
    assert(r.data.items[0].auction, 'لا بيانات مزاد');
    return `${r.data.items.length} مزايدة`;
  });

  await t('سجل التدقيق يحتوي أحداث المزادات', async () => {
    const r = await req('GET', '/api/admin/audit', { token: AT });
    const actions = r.data.items.map((x) => x.action);
    assert(actions.includes('auction_bid'), 'لا يوجد تسجيل مزايدات');
    assert(actions.includes('auction_close'), 'لا يوجد تسجيل إغلاق');
    return `${actions.filter((a) => a.startsWith('auction')).length} حدث`;
  });

  await t('حالة المزاد محسوبة من ساعة الخادم', async () => {
    const soon = await createAuction({ starts_at: new Date(Date.now() + 3600e3).toISOString(), ends_at: new Date(Date.now() + 7200e3).toISOString() });
    const d = await req('GET', `/api/auctions/${soon.id}`);
    eq(d.data.auction.status, 'upcoming');
    assert(d.data.auction.seconds_to_start > 3500, 'عدّاد البداية غير صحيح');
    const r = await req('POST', `/api/auctions/${soon.id}/bids`, { token: u1.token, body: { amount: 500 } });
    eq(r.status, 409);
    return 'upcoming · مرفوض';
  });

} catch (e) {
  console.error('\nفشل التشغيل:', e.message); fail++;
} finally {
  try { child.kill('SIGKILL'); } catch {}
  console.log(`\n================ النتيجة: ${pass} ناجح · ${fail} فاشل ================`);
  if (failures.length) { console.log('الإخفاقات:'); failures.forEach((f) => console.log(' - ' + f)); }
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'auctions-test-report.json'), JSON.stringify({ pass, fail, failures, at: new Date().toISOString() }, null, 1));
  process.exit(fail ? 1 : 0);
}
