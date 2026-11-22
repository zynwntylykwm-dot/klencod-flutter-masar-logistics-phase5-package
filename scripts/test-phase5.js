/**
 * test-phase5.js — اختبارات قبول المرحلة 5 (المساعد الذكي)
 * -------------------------------------------------------
 * التشغيل: node scripts/test-phase5.js
 *
 * يغطي:
 *  A) الصدق: بلا مفاتيح → لا ادّعاء ذكاء اصطناعي (engine=rules + سبب صريح)
 *  B) محرّك القواعد المُسنَد: تتبّع شحنة حقيقية، تسعير من محرّك التسعير، محفظة،
 *     أسئلة شائعة، واعتراف صريح بعدم المعرفة (دون اختراع بيانات)
 *  C) استدعاء LLM حقيقي عبر HTTP: سيرفر وهمي متوافق مع OpenAI يثبت المسار الكامل
 *     (ترويسة المصادقة + تعليمات النظام + البيانات المُسنَدة + الاستجابة + الرموز)
 *  D) الفشل بصدق: مزوّد معطّل → تراجع إلى القواعد مع degraded=true وسبب
 *  E) المحادثات والحصة والتقييم والصلاحيات والأسئلة الشائعة والإحصاءات
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ADMIN_PASSWORD = 'Admin!Pass2026';
// منافذ حرّة تُختار وقت التشغيل (تمنع تصادم مخلّفات تشغيل سابق)
const net = require('net');
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
let PORT_A, PORT_B, PORT_BAD, PORT_FAIL;
let A_BASE, B_BASE, BAD_BASE, FAIL_BASE;

let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => {
  try { const info = await fn(); pass++; console.log(`  ✅ ${name}${info ? '  → ' + info : ''}`); }
  catch (e) { fail++; failures.push(name + ': ' + e.message); console.log(`  ❌ ${name}  → ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(base, method, p, { body, token, raw = false } = {}) {
  const h = { accept: 'application/json' };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

// ============ سيرفر وهمي متوافق مع OpenAI (لإثبات مسار HTTP الحقيقي) ============
const captured = [];
const mock = http.createServer((rq, rs) => {
  let body = '';
  rq.on('data', (c) => (body += c));
  rq.on('end', () => {
    let parsed = null; try { parsed = JSON.parse(body || '{}'); } catch (_) {}
    captured.push({ url: rq.url, method: rq.method, headers: rq.headers, body: parsed });
    if (rq.url.includes('/fail')) { rs.writeHead(500, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ error: { message: 'عطل مُصطنع للاختبار' } })); }
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({
      id: 'mock-1', model: 'mock-model-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'رد من النموذج الوهمي: شحنتك في الطريق.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 111, completion_tokens: 22 }
    }));
  });
});

const children = [];
function startServer(port, dataDir, extraEnv) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD, LOGIN_RATE_LIMIT: '5000', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.__log = '';
  child.stdout.on('data', (d) => (child.__log += d));
  child.stderr.on('data', (d) => (child.__log += d));
  children.push(child);
  return child;
}

const waitReady = async (base, child) => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return await r.json(); } catch (_) {}
    await sleep(200);
  }
  throw new Error('الخادم لم يبدأ: ' + (child ? child.__log : ''));
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-p5-'));
  [PORT_A, PORT_B, PORT_BAD, PORT_FAIL] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  A_BASE = `http://127.0.0.1:${PORT_A}`;
  B_BASE = `http://127.0.0.1:${PORT_B}`;
  BAD_BASE = `http://127.0.0.1:${PORT_BAD}`;
  FAIL_BASE = `http://127.0.0.1:${PORT_FAIL}`;
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  console.log('\n=== اختبارات المرحلة 5: المساعد الذكي ===');
  console.log(`(مزوّد وهمي متوافق مع OpenAI على http://127.0.0.1:${mockPort}/v1 — لإثبات مسار الاستدعاء الحقيقي)\n`);

  const srvA = startServer(PORT_A, path.join(tmp, 'a'), {});
  const srvB = startServer(PORT_B, path.join(tmp, 'b'), {
    AI_API_KEY: 'test-key-not-real', AI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, AI_MODEL: 'mock-model-1'
  });
  const srvBad = startServer(PORT_BAD, path.join(tmp, 'bad'), {
    AI_API_KEY: 'test-key-not-real', AI_BASE_URL: 'http://127.0.0.1:1/v1', AI_MODEL: 'dead-model'
  });

  const healthA = await waitReady(A_BASE, srvA);
  if (process.env.P5_DEBUG) setTimeout(() => {}, 0);
  await waitReady(B_BASE, srvB);
  await waitReady(BAD_BASE, srvBad);

  const login = async (base, identifier, password) => (await req(base, 'POST', '/api/auth/login', { body: { identifier, password } })).data.access_token;
  const A = await login(A_BASE, 'admin', ADMIN_PASSWORD);
  const B = await login(B_BASE, 'admin', ADMIN_PASSWORD);
  const BAD = await login(BAD_BASE, 'admin', ADMIN_PASSWORD);

  const mkUser = async (base, name, role = 'user', token = A) => {
    await req(base, 'POST', '/api/auth/register', { body: { fullName: 'مستخدم ' + name, email: `${name}@t.local`, phone: '77' + Math.floor(Math.random() * 1e7), username: name, password: 'UserPass!2026', role: 'user' } });
    const users = (await req(base, 'GET', '/api/admin/users?limit=100', { token })).data.items;
    const u = users.find((x) => x.username === name);
    assert(u, 'تعذّر إنشاء المستخدم ' + name);
    if (role !== 'user') await req(base, 'PATCH', '/api/admin/users/' + u.id, { token, body: { role } });
    await req(base, 'PATCH', '/api/admin/users/' + u.id, { token, body: { status: 'active' } });
    const tk = await login(base, name, 'UserPass!2026');
    return { id: u.id, token: tk, username: name };
  };

  const client = await mkUser(A_BASE, 'p5client');
  const other = await mkUser(A_BASE, 'p5other');
  const branch = await mkUser(A_BASE, 'p5branch', 'branch_manager');

  // شحنة حقيقية للمستخدم (تُسعَّر آليًا من المرحلة 4)
  const shipRes = await req(A_BASE, 'POST', '/api/shipments', {
    token: A,
    body: { trackingNumber: 'P5T' + Date.now().toString().slice(-7), user_id: client.id, source: 'الصين', sourceCity: 'شنجهاي', destPort: 'ميناء عدن', weight: 30, service: 'air', goodsType: 'إلكترونيات', goods: 'لابتوبات', receiver: 'عميل اختبار', receiverPhone: '770000000', status: 'shipped', progress: 40, currentLocation: 'ميناء جدة' }
  });
  const tracking = (shipRes.data.shipment || shipRes.data).trackingNumber;
  assert(tracking, 'لم تُنشأ شحنة الاختبار: ' + JSON.stringify(shipRes.data).slice(0, 200));

  // ============================ A) الصدق ============================
  console.log('\n— أ) الصدق في الإعلان عن القدرات —');
  await t('/api/health يعلن نسخة المرحلة 5', async () => {
    assert(String(healthA.version || '').includes('phase5'), 'النسخة: ' + healthA.version);
    return healthA.version;
  });

  await t('بلا مفاتيح: الحالة تُصرّح أن المحرّك قواعد وليس ذكاءً اصطناعيًا', async () => {
    const r = await req(A_BASE, 'GET', '/api/assistant/status', { token: client.token });
    assert(r.status === 200, 'HTTP ' + r.status);
    const s = r.data.status;
    assert(s.ai_ready === false, 'ai_ready يجب أن يكون false');
    assert(s.engine === 'rules', 'engine=' + s.engine);
    assert(/محرّك القواعد|محرّك قواعد/.test(s.reason), 'السبب غير صريح: ' + s.reason);
    assert(s.providers.every((p) => p.ready === false), 'يوجد مزوّد يُعلن جهوزية كاذبة');
    assert(s.providers.every((p) => p.env), 'مزوّد بلا اسم متغيّر بيئة');
    return `${s.providers.length} مزوّد، كلهم غير مهيّأين بصراحة`;
  });

  await t('المساعد يتطلب تسجيل الدخول', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { body: { message: 'مرحبا' } });
    assert(r.status === 401, 'HTTP ' + r.status);
    return '401 بلا رمز';
  });

  await t('رسالة فارغة أو طويلة جدًا تُرفض بـ 400', async () => {
    const e1 = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: '   ' } });
    const e2 = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'ا'.repeat(2100) } });
    assert(e1.status === 400 && e2.status === 400, `الحالات: ${e1.status}/${e2.status}`);
    return 'تحقّق من الطول';
  });

  // ============================ B) محرّك القواعد ============================
  console.log('\n— ب) محرّك القواعد المُسنَد إلى بيانات حقيقية —');
  await t('تحية: رد ترحيبي موسوم engine=rules', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'السلام عليكم' } });
    assert(r.status === 200, 'HTTP ' + r.status);
    assert(r.data.engine === 'rules', 'engine=' + r.data.engine);
    assert(/مرحبًا/.test(r.data.reply), 'لا ترحيب');
    return `engine=${r.data.engine} · ${r.data.latency_ms}ms`;
  });

  await t('تتبّع شحنة حقيقية: يعيد الحالة الفعلية من قاعدة البيانات', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: `وين شحنتي ${tracking}؟` } });
    assert(r.status === 200, 'HTTP ' + r.status);
    assert(r.data.reply.includes(tracking), 'الرد لا يذكر رقم الشحنة');
    assert(r.data.intent === 'tracking', 'intent=' + r.data.intent);
    assert(r.data.sources.some((s) => s.type === 'shipment' && s.ref === tracking), 'المصدر غير مُعلن');
    return `مُسنَد إلى ${tracking}`;
  });

  await t('رقم تتبّع غير موجود: اعتراف صريح بلا اختراع', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'وين شحنتي ZZTEST99999' } });
    assert(r.data.intent === 'tracking_not_found', 'intent=' + r.data.intent);
    assert(/لم أجد/.test(r.data.reply), 'لا اعتراف');
    assert(!/\d{2,}%/.test(r.data.reply), 'يبدو أنه اخترع حالة');
    return 'لا اختراع';
  });

  await t('شحنة عميل آخر: رفض صريح (خصوصية)', async () => {
    const otherShip = await req(A_BASE, 'POST', '/api/shipments', {
      token: A,
      body: { trackingNumber: 'P5O' + Date.now().toString().slice(-7), user_id: other.id, source: 'تركيا', destPort: 'ميناء عدن', weight: 5, service: 'air', goods: 'قطع', receiver: 'آخر', receiverPhone: '771111111' }
    });
    const tn2 = (otherShip.data.shipment || otherShip.data).trackingNumber;
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: `تتبع ${tn2}` } });
    assert(r.data.intent === 'tracking_forbidden', 'intent=' + r.data.intent);
    assert(/ليست ضمن حسابك/.test(r.data.reply), 'لم يرفض');
    return 'حماية بيانات العملاء';
  });

  await t('تسعير: الاقتباس من المساعد يطابق محرّك التسعير تمامًا', async () => {
    const api = (await req(A_BASE, 'POST', '/api/pricing/quote', { token: client.token, body: { service: 'air', weight_kg: 20 } })).data.quote;
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'كم تكلفة شحن 20 كجم جوي؟' } });
    assert(r.data.intent === 'pricing', 'intent=' + r.data.intent);
    const total = api.total.toLocaleString('en-US');
    assert(r.data.reply.includes(total + '$'), `الرد لا يحتوي الإجمالي ${total}$\n${r.data.reply}`);
    assert(r.data.reply.includes(api.rule.name), 'اسم القاعدة غير مذكور');
    assert(r.data.sources.some((s) => s.type === 'pricing_rule'), 'مصدر التسعير غير معلن');
    return `${api.rule.name} · ${total}$`;
  });

  await t('تسعير بلا وزن: يطلب معلومة ناقصة بدل التخمين', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'بكم تكلفة الشحن؟' } });
    assert(r.data.intent === 'pricing_need_input', 'intent=' + r.data.intent);
    assert(/الوزن/.test(r.data.reply), 'لا يطلب الوزن');
    return 'لا تخمين';
  });

  await t('المحفظة: الرصيد مطابق لنقطة النهاية الحقيقية', async () => {
    const w = (await req(A_BASE, 'GET', '/api/wallet/me', { token: client.token })).data;
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'كم رصيدي في المحفظة؟' } });
    assert(r.data.intent === 'wallet', 'intent=' + r.data.intent);
    const avail = Number(w.balance.available).toLocaleString('en-US');
    assert(r.data.reply.includes(avail), `الرصيد ${avail} غير مطابق\n${r.data.reply}`);
    return `متاح ${avail}$`;
  });

  await t('سؤال شائع: يجيب من قاعدة معرفة يديرها المدير', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'ما المستندات المطلوبة للتخليص الجمركي؟' } });
    assert(r.data.intent && r.data.intent.startsWith('faq'), 'intent=' + r.data.intent);
    assert(/بوليصة|فاتورة/.test(r.data.reply), 'إجابة غير ذات صلة');
    return r.data.intent;
  });

  await t('سؤال خارج المعرفة: يعترف بعدم المعرفة ولا يخترع', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'اكتب لي قصيدة قصيرة عن البحر' } });
    assert(r.data.intent === 'unknown', 'intent=' + r.data.intent);
    assert(/لا أستطيع/.test(r.data.reply), 'لا اعتراف');
    assert(r.data.sources.length >= 1, 'يجب أن يعلن مصدر السياق');
    return 'صدق كامل';
  });

  await t('طلب موظف بشري: تحويل صريح لمسار الدعم', async () => {
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'أريد التحدث مع موظف' } });
    assert(r.data.intent === 'handoff', 'intent=' + r.data.intent);
    assert(/الدعم/.test(r.data.reply), 'لا تحويل');
    return 'handoff';
  });

  await t('المحادثات تُحفظ ويُستأنف سياقها', async () => {
    const first = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'مرحبا' } });
    const cid = first.data.conversation_id;
    await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'وكم رصيدي؟', conversation_id: cid } });
    const conv = await req(A_BASE, 'GET', '/api/assistant/conversations/' + cid, { token: client.token });
    assert(conv.status === 200, 'HTTP ' + conv.status);
    assert(conv.data.conversation.messages.length === 4, 'عدد الرسائل ' + conv.data.conversation.messages.length);
    const list = await req(A_BASE, 'GET', '/api/assistant/conversations', { token: client.token });
    assert(list.data.items.some((c) => c.id === cid), 'المحادثة غير ظاهرة في القائمة');
    return `${list.data.items.length} محادثة`;
  });

  await t('محادثة مستخدم آخر: 403', async () => {
    const c = (await req(A_BASE, 'GET', '/api/assistant/conversations', { token: client.token })).data.items[0];
    const r = await req(A_BASE, 'GET', '/api/assistant/conversations/' + c.id, { token: other.token });
    assert(r.status === 403, 'HTTP ' + r.status);
    return '403';
  });

  await t('التقييم (مفيد/غير مفيد) مسجَّل على الرسالة الصحيحة', async () => {
    const conv = (await req(A_BASE, 'GET', '/api/assistant/conversations', { token: client.token })).data.items[0];
    const detail = (await req(A_BASE, 'GET', '/api/assistant/conversations/' + conv.id, { token: client.token })).data.conversation;
    const botMsg = detail.messages.filter((m) => m.role === 'assistant').pop();
    const okRes = await req(A_BASE, 'POST', '/api/assistant/feedback', { token: client.token, body: { message_id: botMsg.id, value: 'up' } });
    assert(okRes.status === 200 && okRes.data.feedback === 'up', 'فشل التقييم');
    const forbidden = await req(A_BASE, 'POST', '/api/assistant/feedback', { token: other.token, body: { message_id: botMsg.id, value: 'down' } });
    assert(forbidden.status === 403, 'HTTP ' + forbidden.status);
    const bad = await req(A_BASE, 'POST', '/api/assistant/feedback', { token: client.token, body: { message_id: botMsg.id, value: 'maybe' } });
    assert(bad.status === 400, 'HTTP ' + bad.status);
    return 'up محفوظ · 403 لغيره · 400 لقيمة خاطئة';
  });

  // ============================ C) مسار LLM الحقيقي ============================
  console.log('\n— ج) استدعاء نموذج عبر HTTP (مزوّد وهمي يثبت المسار) —');
  await t('مع مفتاح: الحالة تُعلن مزوّدًا حقيقيًا جاهزًا', async () => {
    const s = (await req(B_BASE, 'GET', '/api/assistant/status', { token: B })).data.status;
    assert(s.ai_ready === true, 'ai_ready=false');
    assert(s.active === 'openai', 'active=' + s.active);
    assert(s.engine === 'model', 'engine=' + s.engine);
    assert(s.providers.find((p) => p.id === 'openai').ready === true, 'openai غير جاهز');
    assert(s.providers.find((p) => p.id === 'anthropic').ready === false, 'anthropic يجب أن يبقى غير مهيّأ');
    return `النشط: ${s.active_name}`;
  });

  await t('الدردشة تستدعي النموذج فعليًا وتعيد engine=model', async () => {
    captured.length = 0;
    const r = await req(B_BASE, 'POST', '/api/assistant/chat', { token: B, body: { message: 'هل شحنتي وصلت؟' } });
    assert(r.status === 200, 'HTTP ' + r.status + ' ' + r.data.error);
    assert(r.data.engine === 'model', 'engine=' + r.data.engine);
    assert(r.data.provider === 'openai', 'provider=' + r.data.provider);
    assert(r.data.model === 'mock-model-1', 'model=' + r.data.model);
    assert(r.data.reply.includes('النموذج الوهمي'), 'لم يُستخدم رد النموذج');
    assert(r.data.usage.input === 111 && r.data.usage.output === 22, 'الرموز: ' + JSON.stringify(r.data.usage));
    assert(captured.length === 1, 'عدد الاستدعاءات ' + captured.length);
    return `${r.data.model} · ${r.data.usage.input}+${r.data.usage.output} رمز · ${r.data.latency_ms}ms`;
  });

  await t('الطلب الفعلي يحمل المصادقة والتعليمات والبيانات المُسنَدة', async () => {
    const c = captured[0];
    assert(c.url === '/v1/chat/completions', 'المسار: ' + c.url);
    assert(String(c.headers.authorization) === 'Bearer test-key-not-real', 'الترويسة: ' + c.headers.authorization);
    assert(c.body.model === 'mock-model-1', 'الموديل: ' + c.body.model);
    const sys = c.body.messages[0];
    assert(sys.role === 'system', 'أول رسالة ليست system');
    assert(/المسار العالمي اللوجستي/.test(sys.content), 'لا هوية في التعليمات');
    assert(/لا تخترع/.test(sys.content), 'لا تحذير من الاختراع');
    assert(/البيانات المتاحة/.test(sys.content), 'لا حقن للبيانات');
    assert(/رصيد المحفظة/.test(sys.content), 'لا سياق المحفظة');
    assert(c.body.messages[c.body.messages.length - 1].content === 'هل شحنتي وصلت؟', 'الرسالة الأخيرة خاطئة');
    return 'system + facts + user';
  });

  await t('لا تُرسَل كلمة المرور أو تجزئتها إلى المزوّد (خصوصية)', async () => {
    const raw = JSON.stringify(captured.map((c) => c.body));
    assert(!/password/i.test(raw), 'الطلب يحتوي password');
    assert(!/scrypt|salt/i.test(raw), 'الطلب يحتوي تجزئة');
    assert(!/UserPass!2026/.test(raw), 'الطلب يحتوي كلمة مرور');
    return 'لا أسرار في الطلب';
  });

  await t('الرسائل السابقة تُرسل كسياق للمحادثة', async () => {
    const first = await req(B_BASE, 'POST', '/api/assistant/chat', { token: B, body: { message: 'سؤالي الأول' } });
    captured.length = 0;
    await req(B_BASE, 'POST', '/api/assistant/chat', { token: B, body: { message: 'سؤالي الثاني', conversation_id: first.data.conversation_id } });
    const msgs = captured[0].body.messages;
    assert(msgs.some((m) => m.content === 'سؤالي الأول'), 'سياق المحادثة مفقود');
    assert(msgs.some((m) => m.role === 'assistant'), 'ردود المساعد مفقودة من السياق');
    return `${msgs.length} رسالة في السياق`;
  });

  // ============================ D) الفشل بصدق ============================
  console.log('\n— د) مزوّد معطّل: تراجع صريح لا صمت —');
  await t('تعذّر الوصول للمزوّد: إجابة من القواعد + degraded + سبب', async () => {
    const r = await req(BAD_BASE, 'POST', '/api/assistant/chat', { token: BAD, body: { message: 'كم رصيدي؟' } });
    assert(r.status === 200, 'HTTP ' + r.status);
    assert(r.data.engine === 'rules', 'engine=' + r.data.engine);
    assert(r.data.degraded === true, 'degraded يجب أن يكون true');
    assert(/تعذّر/.test(r.data.reason || ''), 'السبب: ' + r.data.reason);
    assert(/محفظتك|رصيد/.test(r.data.reply), 'البديل لم يجب');
    return 'rule-fallback موثّق';
  });

  await t('مزوّد يردّ بخطأ HTTP: يُبلَّغ عنه بدل تلفيقه', async () => {
    // خادم B مربوط بالمزوّد الوهمي؛ نلوّث مسار المزوّد عبر خادم ثالث مربوط بمسار /fail
    const srvFail = startServer(PORT_FAIL, path.join(tmp, 'fail'), { AI_API_KEY: 'k', AI_BASE_URL: `http://127.0.0.1:${mockPort}/fail`, AI_MODEL: 'm' });
    try {
      await waitReady(FAIL_BASE, srvFail);
      const tok = await login(FAIL_BASE, 'admin', ADMIN_PASSWORD);
      const r = await req(FAIL_BASE, 'POST', '/api/assistant/chat', { token: tok, body: { message: 'مرحبا' } });
      assert(r.data.degraded === true, 'لم يُبلَّغ عن العطل');
      assert(/عطل مُصطنع|500/.test(r.data.reason || ''), 'السبب غير مفيد: ' + r.data.reason);
      return 'خطأ المزوّد مكشوف للمستخدم';
    } finally { srvFail.kill('SIGKILL'); }
  });

  // ============================ E) الإدارة والصلاحيات ============================
  console.log('\n— هـ) إعدادات الإدارة والحصة والإحصاءات —');
  await t('المستخدم العادي لا يصل إلى إدارة المساعد (403)', async () => {
    const r1 = await req(A_BASE, 'GET', '/api/admin/assistant/stats', { token: client.token });
    const r2 = await req(A_BASE, 'GET', '/api/admin/assistant/faq', { token: client.token });
    const r3 = await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: branch.token, body: { daily_limit: 5 } });
    assert(r1.status === 403 && r2.status === 403 && r3.status === 403, `الحالات ${r1.status}/${r2.status}/${r3.status}`);
    return '403 للمستخدم ومدير الفرع';
  });

  await t('مدير الفرع يقرأ الحالة والإحصاءات', async () => {
    const s = await req(A_BASE, 'GET', '/api/admin/assistant/status', { token: branch.token });
    const st = await req(A_BASE, 'GET', '/api/admin/assistant/stats', { token: branch.token });
    assert(s.status === 200 && st.status === 200, `HTTP ${s.status}/${st.status}`);
    return `messages=${st.data.stats.messages}`;
  });

  await t('المدير العام يغيّر الإعدادات وتُطبَّق فورًا', async () => {
    const r = await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { daily_limit: 60, temperature: 0.2, max_tokens: 300, provider: 'rules', system_prompt: 'اذكر أن الشحن الجوي أسرع.' } });
    assert(r.status === 200, 'HTTP ' + r.status + ' ' + r.data.error);
    assert(r.data.settings.daily_limit === 60, 'الحد اليومي لم يُحدَّث');
    const s = (await req(A_BASE, 'GET', '/api/assistant/status', { token: client.token })).data.status;
    assert(s.settings.temperature === 0.2 && s.settings.max_tokens === 300, 'الإعدادات غير مطبقة');
    return 'provider=rules · 60/يوم';
  });

  await t('إعداد غير صالح يُرفض بـ 400', async () => {
    const a = await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { daily_limit: 0 } });
    const b = await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { provider: 'bogus' } });
    const c = await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { temperature: 3 } });
    assert(a.status === 400 && b.status === 400 && c.status === 400, `${a.status}/${b.status}/${c.status}`);
    return 'تحقق على الخادم';
  });

  await t('الحصة اليومية تُطبَّق وتُعيد 429 مع التفاصيل', async () => {
    await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { daily_limit: 3 } });
    const u = await mkUser(A_BASE, 'p5quota');
    const r1 = await req(A_BASE, 'POST', '/api/assistant/chat', { token: u.token, body: { message: 'مرحبا' } });
    const r2 = await req(A_BASE, 'POST', '/api/assistant/chat', { token: u.token, body: { message: 'مرحبا' } });
    const r3 = await req(A_BASE, 'POST', '/api/assistant/chat', { token: u.token, body: { message: 'مرحبا' } });
    const r4 = await req(A_BASE, 'POST', '/api/assistant/chat', { token: u.token, body: { message: 'مرحبا' } });
    assert(r1.status === 200 && r2.status === 200 && r3.status === 200, `الأولى ${r1.status}/${r2.status}/${r3.status}`);
    assert(r4.status === 429, 'الرابعة: ' + r4.status);
    assert(r4.data.quota && r4.data.quota.limit === 3, 'تفاصيل الحصة: ' + JSON.stringify(r4.data.quota));
    assert(r1.data.quota.remaining === 2, 'المتبقي الأول: ' + JSON.stringify(r1.data.quota));
    await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { daily_limit: 60 } });
    return '3/يوم ثم 429';
  });

  await t('تعطيل المساعد من الإدارة يوقف الخدمة بـ 503', async () => {
    await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { enabled: false } });
    const r = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'مرحبا' } });
    assert(r.status === 503, 'HTTP ' + r.status);
    await req(A_BASE, 'PATCH', '/api/admin/assistant/settings', { token: A, body: { enabled: true } });
    const r2 = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'مرحبا' } });
    assert(r2.status === 200, 'لم يُعَد التشغيل');
    return 'إيقاف/تشغيل فوري';
  });

  await t('الأسئلة الشائعة: إنشاء/تعديل/حذف بصلاحيات صحيحة', async () => {
    const created = await req(A_BASE, 'POST', '/api/admin/assistant/faq', { token: branch.token, body: { question: 'هل تشحنون إلى جيبوتي؟', answer: 'نعم، عبر خط بحري أسبوعي إلى ميناء جيبوتي ثم نقل بري.', keywords: ['جيبوتي', 'خط'] } });
    assert(created.status === 201, 'HTTP ' + created.status + ' ' + created.data.error);
    const id = created.data.item.id;
    const q = await req(A_BASE, 'POST', '/api/assistant/chat', { token: client.token, body: { message: 'هل تشحنون إلى جيبوتي؟' } });
    assert(q.data.reply.includes('جيبوتي'), 'الإجابة الجديدة لم تُستخدم: ' + q.data.reply.slice(0, 80));
    const patched = await req(A_BASE, 'PATCH', '/api/admin/assistant/faq/' + id, { token: branch.token, body: { answer: 'نعم، خط بحري أسبوعي إلى جيبوتي، ومدة العبور 6 أيام تقريبًا.' } });
    assert(patched.status === 200, 'التعديل: ' + patched.status);
    const delForbidden = await req(A_BASE, 'DELETE', '/api/admin/assistant/faq/' + id, { token: branch.token });
    assert(delForbidden.status === 403, 'الحذف بمدير فرع: ' + delForbidden.status);
    const del = await req(A_BASE, 'DELETE', '/api/admin/assistant/faq/' + id, { token: A });
    assert(del.status === 200, 'الحذف: ' + del.status);
    const shortA = await req(A_BASE, 'POST', '/api/admin/assistant/faq', { token: branch.token, body: { question: 'س', answer: 'قصير' } });
    assert(shortA.status === 400, 'تحقق النص: ' + shortA.status);
    return 'إنشاء 201 · حذف 403→200 · تحقق 400';
  });

  await t('الإحصاءات تعكس الاستخدام الحقيقي', async () => {
    const st = (await req(A_BASE, 'GET', '/api/admin/assistant/stats?days=7', { token: A })).data.stats;
    assert(st.messages > 5, 'الرسائل: ' + st.messages);
    assert(st.by_engine.rules > 0, 'توزيع المحرّكات: ' + JSON.stringify(st.by_engine));
    assert(st.grounded_rate >= 80, 'نسبة الإسناد: ' + st.grounded_rate);
    assert(typeof st.avg_latency_ms === 'number', 'زمن الاستجابة غير محسوب');
    assert(Array.isArray(st.top_questions) && st.top_questions.length > 0, 'أكثر الأسئلة فارغة');
    assert(st.feedback.up >= 1, 'التقييمات: ' + JSON.stringify(st.feedback));
    assert(st.faq_count >= 8, 'عدد الأسئلة: ' + st.faq_count);
    return `${st.messages} ردًا · إسناد ${st.grounded_rate}% · ${st.avg_latency_ms}ms`;
  });

  await t('سجل محادثات الإدارة مع التفاصيل ومصادرها', async () => {
    const list = await req(A_BASE, 'GET', '/api/admin/assistant/conversations?limit=5', { token: A });
    assert(list.status === 200 && list.data.items.length > 0, 'لا محادثات');
    const c = list.data.items[0];
    const detail = await req(A_BASE, 'GET', '/api/admin/assistant/conversations/' + c.id, { token: A });
    assert(detail.status === 200, 'HTTP ' + detail.status);
    assert(detail.data.conversation.messages.length >= 2, 'التفاصيل ناقصة');
    return `${list.data.total} محادثة`;
  });

  await t('اختبار المدير يُنفَّذ ويُوسم admin_test', async () => {
    const before = (await req(A_BASE, 'GET', '/api/admin/assistant/stats', { token: A })).data.stats.messages;
    const r = await req(A_BASE, 'POST', '/api/admin/assistant/test', { token: A, body: { message: 'كم تكلفة 10 كجم بري؟' } });
    assert(r.status === 200 && r.data.reply.includes('$'), 'الاختبار فشل: ' + JSON.stringify(r.data).slice(0, 120));
    const after = (await req(A_BASE, 'GET', '/api/admin/assistant/stats', { token: A })).data.stats.messages;
    assert(after === before + 1, 'لم تُسجَّل الرسالة');
    return 'اختبار حقيقي مسجَّل';
  });

  await t('كل إجراءات الإدارة موثّقة في سجل التدقيق', async () => {
    const r = (await req(A_BASE, 'GET', '/api/admin/audit/query?q=assistant', { token: A })).data;
    const actions = new Set(r.items.map((i) => i.action));
    assert(actions.has('assistant_settings_update'), 'لا تدقيق للإعدادات');
    assert(actions.has('assistant_faq_create') && actions.has('assistant_faq_delete'), 'لا تدقيق للأسئلة');
    return [...actions].join(', ');
  });

  if (process.env.P5_DEBUG) {
    console.log('\n--- سجل خادم B ---\n' + srvB.__log.slice(-2500));
    console.log('\n--- سجل خادم A (آخر) ---\n' + srvA.__log.slice(-800));
    console.log('\n--- طلبات المزوّد الوهمي ---\n' + JSON.stringify(captured.map((c) => c.url)));
  }
  console.log('\n' + '='.repeat(62));
  console.log(`النتيجة: ${pass} ناجح · ${fail} فاشل`);
  if (fail) { console.log('\nالفاشلة:'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(62) + '\n');

  const out = { at: new Date().toISOString(), phase: 5, pass, fail, failures };
  fs.mkdirSync(path.join(ROOT, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'audit', 'phase5-test-report.json'), JSON.stringify(out, null, 2));

  [srvA, srvB, srvBad].forEach((c) => c.kill('SIGKILL'));
  mock.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('خطأ عام في الاختبار:', e);
  try { mock.close(); } catch (_) {}
  for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
  process.exit(1);
});
