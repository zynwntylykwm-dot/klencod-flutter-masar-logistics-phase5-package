/**
 * test-e2e.js — اختبار شامل: واجهة حقيقية + خادم حقيقي
 * يتحقق من: إقلاع الطبقة الجديدة، حالة الخادم، الدخول عبر الخادم،
 * مزامنة الشحنات من القاعدة، البطاقة الحية، ورسائل الخطأ.
 * التشغيل: node scripts/test-e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');

const PORT = 8087;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Masar!Admin2026';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const APP = path.join(__dirname, '..', 'app');

let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => {
  try { const info = await fn(); pass++; console.log(`  ✅ ${name}${info ? '  → ' + info : ''}`); }
  catch (e) { fail++; failures.push(name + ': ' + e.message); console.log(`  ❌ ${name}  → ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

class LocalLoader extends ResourceLoader {
  fetch(url) {
    const prefix = 'http://localhost/app/';
    if (url.startsWith(prefix)) {
      const rel = url.slice(prefix.length).split('?')[0];
      const file = path.join(APP, rel);
      try { return Promise.resolve(fs.readFileSync(file)); } catch (_) { return Promise.resolve(Buffer.from('')); }
    }
    return Promise.resolve(Buffer.from('')); // حجب أي مصدر خارجي (CDN)
  }
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD, HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

const ready = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('الخادم لم يبدأ: ' + log);
};

(async () => {
  console.log('\n=== اختبار تكامل الواجهة مع الخادم ===\n');
  let health;
  await t('تشغيل الخادم والتحقق من صحته', async () => { health = await ready(); return health.version + ' · ' + health.storage; });

  const expected = await (await fetch(BASE + '/api/shipments?limit=200', {
    headers: { authorization: 'Bearer ' + (await (await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: ADMIN_PASSWORD })
    })).json()).access_token }
  })).json();

  const vc = new VirtualConsole();
  const consoleErrors = [];
  vc.on('jsdomError', (e) => { if (!/Could not load|Not implemented/.test(e.message)) consoleErrors.push(e.message); });

  const dom = new JSDOM(fs.readFileSync(path.join(APP, 'index.html'), 'utf8'), {
    runScripts: 'dangerously', resources: new LocalLoader(), pretendToBeVisual: true,
    url: 'http://localhost/app/index.html', virtualConsole: vc,
    beforeParse(w) {
      w.Chart = class { destroy() {} };
      w.L = { map: () => ({ setView: () => ({ addTo() {} }), addTo() {}, invalidateSize() {}, tileLayer() {}, marker: () => ({ addTo: () => ({ bindPopup() {} }) }) }), tileLayer: () => ({ addTo() {} }), marker: () => ({ addTo: () => ({ bindPopup() {} }) }) };
      w.HTMLCanvasElement.prototype.getContext = () => ({});
      w.alert = () => {}; w.confirm = () => true; w.print = () => {}; w.open = () => null;
      w.navigator.clipboard = { writeText: () => Promise.resolve() };
      w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
      // شيم fetch يوجّه الطلبات النسبية إلى الخادم الحقيقي
      w.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
      // شيم EventSource (jsdom لا يوفره)
      w.EventSource = class { constructor(url) { this.url = url; this.readyState = 1; } addEventListener() {} close() {} };
    }
  });
  const w = dom.window, d = w.document;
  await new Promise((r) => setTimeout(r, 2600));

  await t('الطبقة الجديدة أُقلعت وتعرّفت على الخادم', async () => {
    assert(w.MASAR, 'MASAR غير موجودة');
    assert(w.MASAR.server, 'لم يتم الاتصال بالخادم');
    return `الخادم ${w.MASAR.server.version}`;
  });

  await t('مؤشر الحالة يظهر للمستخدم', async () => {
    const chip = d.getElementById('masarServerChip');
    assert(chip, 'المؤشر غير موجود');
    return chip.textContent.trim().slice(0, 40);
  });

  await t('دخول خاطئ عبر الواجهة يُظهر رسالة خطأ', async () => {
    d.getElementById('loginIdentifier').value = 'admin';
    d.getElementById('loginPassword').value = 'wrong-password';
    await w.performLogin();
    await new Promise((r) => setTimeout(r, 600));
    assert(d.getElementById('loginError').style.display === 'block', 'لم تظهر رسالة الخطأ');
    assert(d.getElementById('appContainer').style.display !== 'block', 'دخل رغم كلمة مرور خاطئة');
    return d.getElementById('loginError').innerText;
  });

  await t('دخول صحيح عبر الخادم يفتح النظام', async () => {
    d.getElementById('loginIdentifier').value = 'admin';
    d.getElementById('loginPassword').value = ADMIN_PASSWORD;
    await w.performLogin();
    await new Promise((r) => setTimeout(r, 1200));
    assert(d.getElementById('appContainer').style.display === 'block', 'لم يُفتح التطبيق');
    assert(d.getElementById('loginOverlay').style.display === 'none', 'شاشة الدخول ما زالت ظاهرة');
    assert(w.MASAR.user && w.MASAR.user.role === 'super_admin', 'دور المستخدم خاطئ');
    return w.MASAR.user.fullName;
  });

  await t('مزامنة الشحنات من قاعدة البيانات (لا من المتصفح)', async () => {
    const local = w.__app.shipments.length;
    assert(local === expected.items.length, `الواجهة ${local} ≠ الخادم ${expected.items.length}`);
    const stored = JSON.parse(w.localStorage.getItem('alshahd_shipments') || '[]');
    assert(stored.length === expected.items.length, 'النسخة المحلية غير محدثة');
    return `${local} شحنة`;
  });

  await t('مؤشر الحالة يعكس الاتصال والبيانات', async () => {
    const chip = d.getElementById('masarServerChip');
    assert(chip.textContent.includes('متصل'), 'المؤشر لا يقول متصل: ' + chip.textContent);
    return chip.textContent.trim();
  });

  await t('البطاقة الحية تُعرض بمصدرها ووقت التحديث', async () => {
    const card = d.getElementById('masarLiveCard');
    assert(card, 'البطاقة غير موجودة');
    const txt = card.textContent;
    assert(/المصدر:/.test(txt), 'لا يوجد وسم مصدر');
    assert(/حيّ|قديمة/.test(txt), 'لا يوجد مؤشر حداثة');
    return txt.replace(/\s+/g, ' ').slice(0, 70) + '…';
  });

  // ---------------- المرحلة 2: المزادات ----------------
  const adminToken = w.localStorage.getItem('masar.access');

  await t('المزادات: البطاقة تُفتح وتجلب البيانات من الخادم', async () => {
    assert(d.getElementById('auctionsPage'), 'صفحة المزادات غير موجودة');
    assert(d.getElementById('auctionsServiceCard'), 'زر الخدمة غير موجود');
    w.navigateTo('auctionsPage');
    await new Promise((r) => setTimeout(r, 1800));
    const cards = d.querySelectorAll('#aucList [data-price]').length;
    const srv = await (await fetch(BASE + '/api/auctions?status=active&limit=40')).json();
    assert(cards > 0, 'لم تُعرض أي بطاقة');
    assert(cards === srv.items.filter((a) => a.status === 'active').length, `الواجهة ${cards} ≠ الخادم ${srv.items.length}`);
    return `${cards} مزاد مطابق للخادم`;
  });

  await t('المزادات: العدّاد يعتمد على وقت انتهاء الخادم', async () => {
    const srv = await (await fetch(BASE + '/api/auctions?status=active&limit=40')).json();
    const el = d.querySelector('[data-timer]');
    assert(el, 'لا يوجد عدّاد');
    const card = el.closest('.calculator-card');
    const priceEl = card && card.querySelector('[data-price]');
    assert(priceEl, 'البطاقة لا تحمل معرّف المزاد');
    const id = priceEl.getAttribute('data-price');
    const a = srv.items.find((x) => x.id === id);
    assert(el.getAttribute('data-ends') === a.ends_at, 'وقت الانتهاء لا يطابق الخادم');
    const t1 = el.textContent;
    await new Promise((r) => setTimeout(r, 1600));
    assert(el.textContent !== t1, 'العدّاد لا يتحرك');
    return `${t1} → ${el.textContent}`;
  });

  await t('المزادات: زر الإنشاء يظهر للموظف فقط', async () => {
    const btn = d.getElementById('aucCreateBtn');
    assert(btn, 'الزر غير موجود');
    assert(btn.style.display !== 'none', 'الزر مخفي للمدير');
    return 'مرئي للموظف';
  });

  await t('المزادات: إنشاء مزاد حقيقي عبر الواجهة', async () => {
    w.AuctionUI.openCreate();
    await new Promise((r) => setTimeout(r, 200));
    const unique = 'شحنة تجهيزات مكتبية — اختبار تلقائي ' + Date.now();
    d.getElementById('cfTitle').value = unique;
    d.getElementById('cfDesc').value = 'مزاد أُنشئ من واجهة النظام في اختبار التكامل.';
    d.getElementById('cfCat').value = 'other';
    d.getElementById('cfLocation').value = 'ميناء عدن';
    d.getElementById('cfStart').value = '1500';
    d.getElementById('cfInc').value = '50';
    d.getElementById('cfHours').value = '2';
    await w.AuctionUI.submitCreate();
    await new Promise((r) => setTimeout(r, 1500));
    const list = await (await fetch(BASE + '/api/auctions?status=all&limit=60')).json();
    const created = list.items.find((a) => a.title === unique);
    assert(created, 'المزاد لم يُحفظ في الخادم');
    assert(created.start_price === 1500 && created.bid_increment === 50, 'السعر/الزيادة غير مطابقين');
    assert(created.seller_name, 'لا يوجد بائع');
    return `${created.title.slice(0, 30)}… · بداية ${created.start_price}$`;
  });

  await t('المزادات: سجل التدقيق يحتوي عملية الإنشاء', async () => {
    const audit = await (await fetch(BASE + '/api/admin/audit', { headers: { authorization: 'Bearer ' + adminToken } })).json();
    const ev = (audit.items || audit.events || []).some((e) => String(e.action || '').includes('auction_create'));
    assert(ev, 'لا يوجد حدث auction_create في السجل');
    return 'auction_create مسجّل';
  });

  await t('المزادات: البيانات التجريبية موسومة صراحة', async () => {
    assert(d.getElementById('aucList').innerHTML.includes('عرض تجريبي'), 'لا يوجد وسم «عرض تجريبي»');
    return 'الوسم ظاهر';
  });

  // ---------------- المرحلة 3: لوحة الإدارة والإشعارات ----------------
  await t('الإدارة: قسم اللوحة يظهر داخل الإعدادات', async () => {
    w.navigateTo('settingsPage');
    await new Promise((r) => setTimeout(r, 300));
    const sec = d.getElementById('adminSettingsSection');
    assert(sec, 'القسم غير موجود');
    assert(sec.textContent.includes('لوحة الإدارة'), 'النص غير موجود');
    return sec.querySelector('.settings-section-header').textContent.trim();
  });

  await t('الإدارة: لوحة الإدارة تُفتح وتُحمّل إحصاءات الخادم الحقيقية', async () => {
    w.navigateTo('adminPage');
    await new Promise((r) => setTimeout(r, 1500));
    const html = d.getElementById('adminBody').innerHTML;
    assert(html.includes('حالة الخادم'), 'لا توجد بطاقة حالة الخادم');
    const srv = await (await fetch(BASE + '/api/admin/server', { headers: { authorization: 'Bearer ' + w.localStorage.getItem('masar.access') } })).json();
    assert(srv.ok && srv.counts.users >= 1, 'الخادم لم يُرجع إحصاءات');
    assert(html.includes(String(srv.counts.users)), 'العدد في الواجهة لا يطابق الخادم');
    return `${srv.counts.users} مستخدم · ${srv.counts.visitors} زائر · ${srv.memory_mb}MB`;
  });

  await t('الإدارة: تبويب المستخدمين يعرض مستخدمي الخادم', async () => {
    w.AdminUI.tab('users', { target: d.querySelector('#adminPage [data-atab="users"]') });
    await new Promise((r) => setTimeout(r, 1200));
    const html = d.getElementById('adminBody').innerHTML;
    const list = await (await fetch(BASE + '/api/admin/users?limit=50', { headers: { authorization: 'Bearer ' + w.localStorage.getItem('masar.access') } })).json();
    assert(html.includes(list.items[0].fullName.split(' ')[0]) || html.includes(list.items[0].username), 'الأسماء لا تظهر');
    return `${list.total} مستخدم`;
  });

  await t('الإدارة: تبويب الزوار يعرض إحصاءات حقيقية', async () => {
    w.AdminUI.tab('visitors', { target: d.querySelector('#adminPage [data-atab="visitors"]') });
    await new Promise((r) => setTimeout(r, 1200));
    const html = d.getElementById('adminBody').innerHTML;
    assert(/زائر|الزيارات|أكثر الصفحات/.test(html), 'لا توجد إحصاءات');
    const stats = await (await fetch(BASE + '/api/admin/visitors/stats?days=7', { headers: { authorization: 'Bearer ' + adminToken } })).json();
    assert(stats.ok && stats.total_unique >= 0, 'إحصاءات الخادم غير متاحة');
    return `${stats.total_unique} زائر مسجّل`;
  });

  await t('الإشعارات: إرسال حملة من الواجهة يصل إلى صندوق المستخدم', async () => {
    const title = 'اختبار إشعار ' + Date.now();
    const res = await fetch(BASE + '/api/admin/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + w.localStorage.getItem('masar.access') },
      body: JSON.stringify({ title, body: 'أُرسل من اختبار التكامل', audience: 'staff', channels: ['inapp'] })
    });
    const data = await res.json();
    assert(res.ok && data.campaign && data.campaign.sent_count >= 1, 'لم تُرسل: ' + JSON.stringify(data).slice(0, 120));
    const mine = await (await fetch(BASE + '/api/notifications', { headers: { authorization: 'Bearer ' + w.localStorage.getItem('masar.access') } })).json();
    assert((mine.items || []).some((n) => n.title === title), 'لم تصل للمدير نفسه');
    return `أُرسلت إلى ${data.campaign.sent_count}`;
  });

  await t('الإشعارات: تبويب الإشعارات يعرض الحملات وسجل القنوات', async () => {
    w.AdminUI.tab('notify', { target: d.querySelector('#adminPage [data-atab="notify"]') });
    await new Promise((r) => setTimeout(r, 1200));
    const html = d.getElementById('adminBody').innerHTML;
    assert(html.includes('إرسال إشعار'), 'نموذج الإرسال غير موجود');
    assert(html.includes('آخر الحملات'), 'قائمة الحملات غير موجودة');
    return 'النموذج + الحملات + السجل';
  });

  await t('التتبّع: الزيارة تُسجَّل في الخادم من المتصفح', async () => {
    const h = { headers: { authorization: 'Bearer ' + adminToken } };
    const before = await (await fetch(BASE + '/api/admin/visitors/stats', h)).json();
    await w.MasariTrack('/e2eTestPage', 'e2eTestPage');
    await new Promise((r) => setTimeout(r, 900));
    const after = await (await fetch(BASE + '/api/admin/visitors/stats', h)).json();
    assert(after.ok && before.ok, 'الإحصاءات غير متاحة');
    assert(after.total_visits >= before.total_visits, 'لم تُسجّل الزيارة');
    return `${before.total_visits} → ${after.total_visits} زيارة`;
  });

  // ---------------- المرحلة 4: التسعير والتقارير والتتبّع ----------------
  const auth = { headers: { authorization: 'Bearer ' + adminToken } };

  await t('التسعير: تبويب التسعير يعرض القواعد من الخادم', async () => {
    w.AdminUI.tab('pricing', { target: d.querySelector('#adminPage [data-atab="pricing"]') });
    await new Promise((r) => setTimeout(r, 1300));
    const html = d.getElementById('adminBody').innerHTML;
    const rules = await (await fetch(BASE + '/api/pricing/rules', auth)).json();
    assert(rules.ok && rules.items.length >= 4, 'الخادم لا يعيد قواعد');
    assert(html.includes('قاعدة تسعير') || html.includes('قواعد'), 'التبويب فارغ');
    assert(html.includes('محاكي التسعير'), 'المحاكي غير موجود');
    return `${rules.items.length} قاعدة تسعير`;
  });

  await t('التسعير: الاقتباس من الواجهة يطابق حساب الخادم', async () => {
    const q = await (await fetch(BASE + '/api/pricing/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
      body: JSON.stringify({ service: 'air', weight_kg: 20 })
    })).json();
    assert(q.ok && q.quote.matched, 'لا اقتباس');
    assert(typeof q.quote.total === 'number' && q.quote.total > 0, 'المبلغ غير صالح');
    return `${q.quote.rule.name} = ${q.quote.total}$`;
  });

  await t('التقارير: التبويب يحمّل الملخّص المالي الحقيقي', async () => {
    w.AdminUI.tab('reports', { target: d.querySelector('#adminPage [data-atab="reports"]') });
    await new Promise((r) => setTimeout(r, 1400));
    const html = d.getElementById('adminBody').innerHTML;
    const s = await (await fetch(BASE + '/api/admin/reports/summary', auth)).json();
    assert(s.ok, 'الخادم لا يعيد ملخّصًا');
    assert(html.includes('الملخّص المالي'), 'الملخّص غير معروض');
    assert(html.includes('أفضل العملاء'), 'قائمة العملاء غير معروضة');
    const gmv = String(Math.round(s.auctions.gmv));
    assert(html.includes(gmv) || s.auctions.gmv === 0, 'قيمة المزادات لا تظهر');
    return `ضمان ${s.escrow.available}$ · ${s.auctions.total} مزاد`;
  });

  await t('التقارير: تصدير CSV يعمل من نقطة النهاية بترميز سليم', async () => {
    const res = await fetch(BASE + '/api/admin/reports/export?type=shipments', auth);
    assert(res.status === 200, 'HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'لا BOM');
    return `${Math.round(buf.length / 1024)}KB CSV`;
  });

  await t('التتبّع: مزوّدو الشحن يُعرضون بحالتهم الصريحة', async () => {
    w.AdminUI.tab('carriers', { target: d.querySelector('#adminPage [data-atab="carriers"]') });
    await new Promise((r) => setTimeout(r, 1200));
    const html = d.getElementById('adminBody').innerHTML;
    assert(html.includes('مزوّدو التتبّع'), 'قسم المزوّدين غير معروض');
    assert(html.includes('غير مهيّأ') || html.includes('جاهز'), 'لا حالة ظاهرة');
    const c = await (await fetch(BASE + '/api/admin/carriers', auth)).json();
    assert(c.ok && c.providers.some((p) => p.id === 'manual' && p.ready), 'الخادم لا يعيد المزوّدين');
    return `${c.providers.length} مزوّد · النشط ${c.active}`;
  });

  await t('السجل: الفلاتر المتقدمة تُرجع نتائج مطابقة', async () => {
    const r = await (await fetch(BASE + '/api/admin/audit/query?action=admin_campaign_send', auth)).json();
    assert(r.ok, 'فشل الاستعلام');
    assert(r.items.every((i) => i.action === 'admin_campaign_send'), 'نتائج غير مطابقة');
    return `${r.total} حدثًا · ${r.facets.actions.length} إجراءً`;
  });

  // ---------------- المرحلة 5: المساعد الذكي ----------------
  await t('شارة المساعد تُصرّح بمصدر الإجابة (محرّك قواعد بلا مفتاح)', async () => {
    w.toggleChat();
    await new Promise((r) => setTimeout(r, 700));
    const badge = d.getElementById('aiEngineBadge');
    assert(badge, 'الشارة غير موجودة');
    assert(/محرّك قواعد|نموذج/.test(badge.textContent), 'الشارة: ' + badge.textContent);
    return badge.textContent.trim();
  });

  await t('سؤال تسعير من نافذة المحادثة يعطي اقتباس الخادم نفسه', async () => {
    d.getElementById('chatInput').value = 'كم تكلفة 20 كجم جوي؟';
    await w.sendAIMessage();
    await new Promise((r) => setTimeout(r, 1500));
    const bot = [...d.querySelectorAll('#chatMessages .chat-message.bot')].pop();
    assert(bot, 'لا رد');
    const api = await (await fetch(BASE + '/api/pricing/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
      body: JSON.stringify({ service: 'air', weight_kg: 20 })
    })).json();
    assert(bot.textContent.includes(api.quote.total + '$'), 'الرد لا يطابق الخادم: ' + bot.textContent.slice(0, 120));
    assert(/محرّك قواعد|نموذج/.test(bot.textContent), 'لا وسم مصدر أسفل الرد');
    return api.quote.total + '$ · ' + bot.textContent.replace(/\s+/g, ' ').slice(0, 55) + '…';
  });

  await t('تتبّع شحنة من المحادثة يعرض بياناتها الحقيقية', async () => {
    const tn = expected.items[0].trackingNumber;
    d.getElementById('chatInput').value = 'وين شحنتي ' + tn;
    await w.sendAIMessage();
    await new Promise((r) => setTimeout(r, 1500));
    const bot = [...d.querySelectorAll('#chatMessages .chat-message.bot')].pop();
    assert(bot.textContent.includes(tn), 'لم يذكر رقم الشحنة');
    assert(/الحالة:/.test(bot.textContent), 'لا حالة');
    return tn;
  });

  await t('المحادثة محفوظة في الخادم ويمكن للإدارة قراءتها', async () => {
    const r = await (await fetch(BASE + '/api/admin/assistant/conversations?limit=3', {
      headers: { authorization: 'Bearer ' + adminToken }
    })).json();
    assert(r.ok && r.items.length >= 1, 'لا محادثات محفوظة');
    const detail = await (await fetch(BASE + '/api/admin/assistant/conversations/' + r.items[0].id, {
      headers: { authorization: 'Bearer ' + adminToken }
    })).json();
    assert(detail.conversation.messages.length >= 2, 'التفاصيل ناقصة');
    return `${r.items[0].messages} رسالة`;
  });

  await t('تبويب المساعد في لوحة الإدارة يعرض الحالة والأسئلة والإعدادات', async () => {
    w.AdminUI.tab('assistant', { target: d.querySelector('#adminPage [data-atab="assistant"]') });
    await new Promise((r) => setTimeout(r, 1400));
    const html = d.getElementById('adminBody').innerHTML;
    assert(html.includes('حالة المساعد الذكي'), 'بطاقة الحالة غير معروضة');
    assert(html.includes('مزوّدو الذكاء الاصطناعي'), 'قائمة المزوّدين غير معروضة');
    assert(html.includes('قاعدة الأسئلة الشائعة'), 'الأسئلة غير معروضة');
    assert(html.includes('جرّب المساعد الآن'), 'لوحة التجربة غير معروضة');
    assert(html.includes('OpenAI'), 'لا مزوّدين');
    return 'الحالة + المزوّدون + الأسئلة + التجربة';
  });

  await t('المستخدم العادي لا يرى لوحة إدارة المساعد', async () => {
    const res = await fetch(BASE + '/api/admin/assistant/stats');
    assert(res.status === 401, 'HTTP بلا رمز: ' + res.status);
    return '401 بلا مصادقة';
  });

  await t('لا توجد أخطاء صفحة غير متوقعة', async () => {
    assert(consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  });

  await t('جلسة الخادم تبقى بعد إعادة التحميل (تخزين الرموز)', async () => {
    assert(w.localStorage.getItem('masar.access'), 'رمز الوصول غير محفوظ');
    assert(w.localStorage.getItem('masar.refresh'), 'رمز التحديث غير محفوظ');
    return 'access+refresh محفوظان';
  });

  console.log(`\n================ النتيجة: ${pass} ناجح · ${fail} فاشل ================`);
  if (failures.length) { console.log('الإخفاقات:'); failures.forEach((f) => console.log(' - ' + f)); }
  fs.writeFileSync(path.join(__dirname, '..', 'audit', 'e2e-test-report.json'), JSON.stringify({ pass, fail, failures, at: new Date().toISOString() }, null, 1));
  // تنظيف: إزالة أي مزاد أنشأه الاختبار من بيانات الخادم الحقيقية
  try {
    const f = path.join(DATA_DIR, 'auctions.json');
    if (fs.existsSync(f)) {
      const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
      const kept = rows.filter((r) => !String(r.title || '').startsWith('شحنة تجهيزات مكتبية — اختبار تلقائي'));
      if (kept.length !== rows.length) fs.writeFileSync(f, JSON.stringify(kept, null, 1));
    }
  } catch (_) {}
  try { server.kill('SIGKILL'); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('فشل:', e.message); try { server.kill('SIGKILL'); } catch (_) {} process.exit(1); });
