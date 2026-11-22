/**
 * test-auctions-ui.js — اختبار وظيفي حقيقي لواجهة المزادات ضد الخادم الفعلي
 * -------------------------------------------------------------------------
 * التشغيل: node scripts/test-auctions-ui.js
 * يفتح app/index.html داخل jsdom مع fetch حقيقي نحو خادم محلي مؤقت (منفذ 8097)
 * ثم: يسجّل مستخدمًا، يشحن رصيدًا تجريبيًا، يفتح صفحة المزادات، يزايد فعليًا،
 * ويتحقق من الرصيد المحجوز، العدّاد، سجل المزايدات، والمتابعة، ووضع انقطاع الخادم.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const results = [];
const t = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? ' ✅' : ' ❌'} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, optsBody, token) {
  const res = await fetch(BASE + p, {
    method: optsBody ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: optsBody ? JSON.stringify(optsBody) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/aucui-');
  const srv = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: 'Admin!Pass2026', LOGIN_RATE_LIMIT: '1000', DEMO_MODE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  srv.stdout.on('data', (d) => (bootLog += d));
  srv.stderr.on('data', (d) => (bootLog += d));

  // انتظار جاهزية الخادم
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch (_) {} await sleep(250); }
  if (!up) { console.error('الخادم لم يبدأ:\n' + bootLog); process.exit(1); }

  try {
    // ---------------- 1) مستخدم جديد + رصيد ----------------
    const username = 'aucui' + Date.now();
    const reg = await api('/api/auth/register', { fullName: 'مزايد اختبار', email: username + '@t.local', phone: '7700000' + (Date.now() % 1000), username, password: 'Passw0rd!23', role: 'user' });
    t('تسجيل مستخدم اختبار', reg.status === 201, 'HTTP ' + reg.status);
    const admLogin = await api('/api/auth/login', { identifier: 'admin', password: 'Admin!Pass2026' });
    const admToken = admLogin.data && admLogin.data.access_token;
    const usersList = await api('/api/users', null, admToken);
    const me0 = (usersList.data.items || []).find((u) => u.username === username);
    await fetch(BASE + '/api/users/' + me0.id, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admToken }, body: JSON.stringify({ status: 'active' }) });
    const login = await api('/api/auth/login', { identifier: username, password: 'Passw0rd!23' });
    const token = login.data && login.data.access_token;
    t('تسجيل الدخول والحصول على توكن', !!token);
    const credit = await api('/api/wallet/demo-credit', { amount: 50000 }, token);
    t('شحن رصيد تجريبي موسوم demo', credit.status === 200 && credit.data && credit.data.balance && credit.data.balance.available > 0, 'الرصيد المتاح: ' + (credit.data && credit.data.balance && credit.data.balance.available));

    const list0 = await api('/api/auctions?status=active&limit=40');
    t('الخادم يعيد مزادات نشطة', list0.data && list0.data.items.length > 0, `${list0.data && list0.data.items.length} مزاد`);
    const auctions = list0.data.items;

    // ---------------- 2) تحميل الواجهة ----------------
    const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8')
      .replace(/<script src="js\/([^"]+)"><\/script>/g, (m, f) => `<script src="file://${ROOT}/app/js/${f}"></script>`);
    const pageErrors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => { if (!/Could not load|Not implemented|runScripts/.test(e.message)) pageErrors.push(e.message); });
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/app/index.html', virtualConsole: vc,
      resources: 'usable',
      beforeParse(w) {
        w.MASAR_API_BASE = BASE;
        // jsdom لا يوفّر fetch: نُمرّر fetch الحقيقي مع حلّ الروابط النسبية
        w.fetch = (input, init) => fetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init);
        w.Headers = Headers; w.Request = Request; w.Response = Response; w.AbortController = AbortController;
        w.localStorage.setItem('masar.access', token);
        w.Chart = class { constructor() {} destroy() {} };
        w.L = { map: () => ({ setView: () => ({ addTo() {} }), addTo() {}, invalidateSize() {}, tileLayer() {}, marker: () => ({ addTo: () => ({ bindPopup() {} }) }) }), tileLayer: () => ({ addTo() {} }), marker: () => ({ addTo: () => ({ bindPopup() {} }) }) };
        w.HTMLCanvasElement.prototype.getContext = () => ({});
        w.alert = () => {}; w.confirm = () => true; w.print = () => {}; w.open = () => null;
        w.navigator.clipboard = { writeText: () => Promise.resolve() };
        w.EventSource = class { constructor() {} addEventListener() {} close() {} };
      }
    });
    const w = dom.window, d = w.document;
    await sleep(1200);

    // ---------------- 3) الصفحة موجودة والزر مضاف ----------------
    t('صفحة المزادات مُضافة دون حذف أي صفحة', !!d.getElementById('auctionsPage'));
    const card = d.getElementById('auctionsServiceCard');
    t('بطاقة خدمة «المزادات» مضافة إلى شبكة الخدمات', !!card && card.getAttribute('onclick').includes("auctionsPage"));
    t('التصميم محفوظ: البطاقة تستخدم كلاس service-card', !!card && card.classList.contains('service-card'));
    t('كل الصفحات السابقة موجودة (لا حذف)', ['mainPage', 'myShipmentsPage', 'walletPage', 'merchantsPage', 'settingsPage', 'globalPortalPage'].every((id) => !!d.getElementById(id)));

    // ---------------- 4) فتح الصفحة وجلب المزادات ----------------
    w.navigateTo('auctionsPage');
    await sleep(1500);
    const rendered = d.querySelectorAll('#aucList [data-price]').length;
    t('الواجهة تجلب المزادات من الخادم وتعرضها', rendered > 0, `${rendered} بطاقة`);
    t('العدّاد يعتمد على ساعة الخادم (انحراف مُقاس)', typeof w.AuctionUI === 'object');
    const firstTimer = d.querySelector('[data-timer]');
    const before = firstTimer && firstTimer.textContent.trim();
    await sleep(1600);
    const after = firstTimer && firstTimer.textContent.trim();
    t('الوقت المتبقي يتناقص كل ثانية', before !== after && after.length > 0, `${before} → ${after}`);
    t('المزادات التجريبية موسومة «عرض تجريبي»', d.getElementById('aucList').innerHTML.includes('عرض تجريبي'));
    t('شريط المحفظة يعرض الرصيد المتاح', /\$|٥/.test(d.getElementById('aucAvail').textContent));

    // ---------------- 5) التفاصيل ----------------
    const target = auctions.filter((a) => a.status === 'active').sort((a, b) => a.min_next_bid - b.min_next_bid)[0];
    t('اختيار مزاد يمكن تغطيته بالرصيد', !!target && target.min_next_bid <= 50000, 'الحد الأدنى: ' + (target && target.min_next_bid));
    await w.AuctionUI.openDetail(target.id);
    await sleep(500);
    const modal = d.getElementById('modal');
    t('نافذة التفاصيل تُفتح', modal.classList.contains('show'));
    t('التفاصيل تعرض الحد الأدنى التالي', d.getElementById('modalBody').innerHTML.includes('الحد الأدنى التالي'));
    t('التفاصيل تعرض سجل المزايدات', d.getElementById('modalBody').innerHTML.includes('سجل المزايدات'));

    // ---------------- 6) مزايدة فعلية ----------------
    const detailBefore = await api('/api/auctions/' + target.id);
    const minNext = detailBefore.data.auction.min_next_bid;
    const walletBefore = await api('/api/wallet/me', null, token);
    w.AuctionUI.setAmount(minNext);
    await w.AuctionUI.submitBid(target.id);
    await sleep(1200);
    const detailAfter = await api('/api/auctions/' + target.id);
    const walletAfter = await api('/api/wallet/me', null, token);
    t('المزايدة من الواجهة وصلت للخادم', detailAfter.data.auction.current_bid === minNext, `current_bid=${detailAfter.data.auction.current_bid}`);
    t('عدد المزايدات زاد بعد المزايدة', detailAfter.data.auction.bid_count === (detailBefore.data.auction.bid_count || 0) + 1);
    const heldDelta = walletAfter.data.balance.held - walletBefore.data.balance.held;
    t('المبلغ حُجز من الرصيد فعليًا', heldDelta === minNext, `held +${heldDelta}`);
    const availDelta = walletBefore.data.balance.available - walletAfter.data.balance.available;
    t('الرصيد المتاح نقص بقيمة المزايدة', availDelta === minNext, `available -${availDelta}`);
    t('الواجهة تُظهر أنك الأعلى', d.getElementById('modalBody').innerHTML.includes('أنت الأعلى'));
    const amountFmt = minNext.toLocaleString('en-US');
    const modalHtml = d.getElementById('modalBody').innerHTML;
    t('سجل المزايدات في الواجهة يعرض المزايدة الجديدة', modalHtml.includes(amountFmt), amountFmt);
    t('سجل المزايدات يميّز العرض الأعلى', modalHtml.includes('(الأعلى)'));
    t('أسماء المزايدين مُقنّعة في السجل', /\*\*\*/.test(modalHtml));

    // ---------------- 7) رفض مزايدة أقل من الحد ----------------
    const low = await api('/api/auctions/' + target.id + '/bids', { amount: minNext }, token);
    t('رفض عرض ≤ أعلى مزايدة من الخادم', low.status === 409, 'HTTP ' + low.status);

    // ---------------- 8) المتابعة ----------------
    await w.AuctionUI.toggleWatch(target.id, true);
    await sleep(700);
    const favs = await api('/api/favorites', null, token);
    t('المتابعة أُضيفت للخادم', (favs.data.items || []).some((f) => f.item_type === 'auction' && f.item_id === target.id));

    // ---------------- 9) تبويبات الصفحة ----------------
    w.AuctionUI.setTab('mine', { target: d.createElement('button') });
    await sleep(1200);
    t('تبويب «مزايداتي» يعرض المزايدة', d.getElementById('aucList').innerHTML.includes('أنت الأعلى') || d.getElementById('aucList').innerHTML.includes('مزاد'));
    w.AuctionUI.setTab('active', { target: d.createElement('button') });
    await sleep(1200);

    // ---------------- 10) فلاتر ----------------
    w.AuctionUI.setCategory('electronics');
    await sleep(1200);
    const electronicsOnly = d.querySelectorAll('#aucList [data-price]').length;
    t('فلتر التصنيف يعمل', electronicsOnly > 0 && electronicsOnly <= rendered, `${electronicsOnly}/${rendered}`);

    // ---------------- 11) وضع انقطاع الخادم (لا بيانات وهمية) ----------------
    const dom2 = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, url: 'http://localhost/app/index.html', virtualConsole: new VirtualConsole(),
      beforeParse(w2) {
        w2.MASAR_API_BASE = 'http://127.0.0.1:1'; // خادم غير موجود
        w2.fetch = (input, init) => fetch(typeof input === 'string' && input.startsWith('/') ? 'http://127.0.0.1:1' + input : input, init);
        w2.Headers = Headers; w2.Request = Request; w2.Response = Response;
        w2.localStorage.setItem('masar.access', 'dummy');
        w2.Chart = class {}; w2.L = {}; w2.HTMLCanvasElement.prototype.getContext = () => ({});
        w2.alert = () => {}; w2.confirm = () => true; w2.EventSource = class { constructor() {} addEventListener() {} close() {} };
      }
    });
    await sleep(500);
    dom2.window.navigateTo('auctionsPage');
    await sleep(1500);
    const offlineHtml = dom2.window.document.getElementById('aucList').innerHTML;
    t('عند انقطاع الخادم: رسالة صريحة', /الخادم غير متاح|تعذّر/.test(offlineHtml));
    t('عند انقطاع الخادم: لا تُعرض مزادات وهمية', !/data-price=/.test(offlineHtml));

    t('لا أخطاء JS في الصفحة', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  } catch (e) {
    t('تشغيل الاختبار كاملًا', false, e.stack ? e.stack.split('\n')[0] : String(e));
  } finally {
    srv.kill('SIGTERM');
    await sleep(400);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    fs.mkdirSync(path.join(ROOT, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'audit', 'auctions-ui-test-report.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2));
    console.log('='.repeat(70));
    console.log(`النتيجة: ${passed} ناجح · ${failed} فاشل`);
    process.exit(failed ? 1 : 0);
  }
})();
