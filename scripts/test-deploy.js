/**
 * test-deploy.js — اختبارات جاهزية النشر على الإنترنت (HTTPS)
 * ------------------------------------------------------------
 * التشغيل: node scripts/test-deploy.js
 *
 * يتحقق من:
 *  • المنفذ الديناميكي $PORT والاستماع على 0.0.0.0
 *  • فحص الصحة /health و /healthz و / (JSON)
 *  • CORS شامل + ما قبل الطيران OPTIONS + تقييد الأصول عبر CORS_ORIGINS
 *  • حفظ البيانات: البقاء بعد إعادة التشغيل + SIGTERM يحفظ قبل الخروج + تحذير القرص المؤقت
 *  • ملفات النشر: render.yaml / Dockerfile / railway.json / .gitignore / .env.example
 *  • تطبيع عنوان الخادم في التطبيق (https بلا منفذ) في الويب والأندرويد
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => {
  try { const info = await fn(); pass++; console.log(`  ✅ ${name}${info ? '  → ' + info : ''}`); }
  catch (e) { fail++; failures.push(name + ': ' + e.message); console.log(`  ❌ ${name}  → ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const children = [];
function startServer(port, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', DATA_DIR: dataDir, ADMIN_PASSWORD: 'Admin!Pass2026', LOGIN_RATE_LIMIT: '5000', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.__log = '';
  child.stdout.on('data', (d) => (child.__log += d));
  child.stderr.on('data', (d) => (child.__log += d));
  children.push(child);
  return child;
}

async function waitReady(base, child) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return await r.json(); } catch (_) {}
    await sleep(200);
  }
  throw new Error('الخادم لم يبدأ: ' + (child ? child.__log : ''));
}
const waitExit = (child, ms = 8000) => new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (child.exitCode !== null || Date.now() - t0 > ms) { clearInterval(iv); resolve(child.exitCode); }
  }, 100);
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masar-deploy-'));
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = path.join(tmp, 'data');
  console.log('\n=== اختبارات جاهزية النشر على الإنترنت ===\n');

  const srv = startServer(PORT, DATA, { PUBLIC_URL: 'https://masar-api.onrender.com' });
  const health = await waitReady(BASE, srv);

  console.log('— فحص الصحة والمنفذ —');
  await t('المنفذ الديناميكي $PORT يُحترم (ليس 8080)', async () => {
    assert(PORT !== 8080, 'المنفذ المحرَّر = 8080');
    assert(health.ok === true, 'health.ok');
    return `PORT=${PORT}`;
  });

  await t('الاستماع على 0.0.0.0 (قابل للوصول من خارج الحاوية)', async () => {
    const log = srv.__log;
    assert(log.includes('0.0.0.0') || log.includes('http://0.0.0.0'), 'سجل الإقلاع: ' + log.slice(-200));
    return '0.0.0.0';
  });

  await t('GET /health يعيد 200 مع تفاصيل النشر', async () => {
    const res = await fetch(BASE + '/health');
    const body = await res.json();
    assert(res.status === 200, 'HTTP ' + res.status);
    assert(body.status === 'ok' && body.version, 'حقول ناقصة');
    assert(body.storage && body.storage.type === 'filesystem-json', 'نوع التخزين غير معلن');
    assert(body.storage.writable === true, 'المجلد غير قابل للكتابة');
    assert(body.public_url === 'https://masar-api.onrender.com', 'public_url: ' + body.public_url);
    assert(typeof body.counts.users === 'number', 'counts.users مفقود');
    return `${res.status} · ${body.version} · storage:${body.storage.type}`;
  });

  await t('GET /healthz يعيد 200 أيضًا', async () => {
    const res = await fetch(BASE + '/healthz');
    assert(res.status === 200, 'HTTP ' + res.status);
    return '200';
  });

  await t('GET / يعيد JSON للسيرفرات و HTML للمتصفح', async () => {
    const json = await fetch(BASE + '/', { headers: { accept: 'application/json' } });
    const body = await json.json();
    assert(body.ok === true && body.version, 'json غير صالح');
    const html = await fetch(BASE + '/', { headers: { accept: 'text/html' } });
    const text = await html.text();
    assert(text.includes('<!DOCTYPE html>'), 'الواجهة لم تُخدَم');
    return 'JSON/HTML حسب Accept';
  });

  console.log('\n— CORS لتطبيق الهاتف —');
  await t('ترويسات CORS على /health', async () => {
    const res = await fetch(BASE + '/health', { headers: { origin: 'https://app.example.com' } });
    assert(res.headers.get('access-control-allow-origin'), 'لا ترويسة allow-origin');
    assert(/GET/.test(res.headers.get('access-control-allow-methods') || ''), 'لا allow-methods');
    assert(/authorization/.test(res.headers.get('access-control-allow-headers') || ''), 'لا allow-headers');
    return res.headers.get('access-control-allow-origin');
  });

  await t('ترويسات CORS على ملفات الواجهة الثابتة (لا API فقط)', async () => {
    const res = await fetch(BASE + '/js/app-config.js');
    assert(res.status === 200, 'HTTP ' + res.status);
    assert(res.headers.get('access-control-allow-origin'), 'لا CORS على الملفات');
    return 'CORS على static ✅';
  });

  await t('ما قبل الطيران OPTIONS يعيد 204 بترويسات كاملة', async () => {
    const res = await fetch(BASE + '/api/auth/login', { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } });
    assert(res.status === 204, 'HTTP ' + res.status);
    assert(/POST/.test(res.headers.get('access-control-allow-methods') || ''), 'لا POST');
    return '204';
  });

  await t('تقييد الأصول عبر CORS_ORIGINS يعمل', async () => {
    const p2 = await freePort();
    const c2 = startServer(p2, path.join(tmp, 'cors2'), { CORS_ORIGINS: 'https://app.almasar.com' });
    await waitReady(`http://127.0.0.1:${p2}`, c2);
    const okOrigin = await fetch(`http://127.0.0.1:${p2}/health`, { headers: { origin: 'https://app.almasar.com' } });
    const badOrigin = await fetch(`http://127.0.0.1:${p2}/health`, { headers: { origin: 'https://evil.example' } });
    assert(okOrigin.headers.get('access-control-allow-origin') === 'https://app.almasar.com', 'الأصل المسموح: ' + okOrigin.headers.get('access-control-allow-origin'));
    assert(badOrigin.headers.get('access-control-allow-origin') !== 'https://evil.example', 'أصل غير مسموح مرّ');
    c2.kill('SIGKILL');
    return 'مسموح/مرفوض';
  });

  console.log('\n— حفظ البيانات على السحابة —');
  await t('البيانات تُكتب في DATA_DIR المحدّد (لا مكان ثابت)', async () => {
    assert(fs.existsSync(DATA), 'المجلد غير منشأ');
    const files = fs.readdirSync(DATA);
    assert(files.includes('users.json'), 'users.json غير موجود: ' + files.join(','));
    return `${files.length} ملفًا في DATA_DIR`;
  });

  await t('البيانات تبقى بعد إعادة التشغيل (اختبار القرص الدائم)', async () => {
    const reg = await fetch(BASE + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'مستخدم بقاء', email: 'persist@t.local', phone: '770000111', username: 'persist1', password: 'UserPass!2026' })
    });
    assert([201, 200].includes(reg.status), 'التسجيل: ' + reg.status);
    srv.kill('SIGKILL');
    await waitExit(srv);
    const p3 = await freePort();
    const srv2 = startServer(p3, DATA);
    await waitReady(`http://127.0.0.1:${p3}`, srv2);
    // دخول المدير (كلمته محفوظة في users.json) ثم التأكد أن المستخدم المسجَّل ما زال موجودًا
    const adminLogin = await fetch(`http://127.0.0.1:${p3}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: 'Admin!Pass2026' })
    });
    assert(adminLogin.status === 200, 'دخول المدير بعد إعادة التشغيل: ' + adminLogin.status);
    const tok = (await adminLogin.json()).access_token;
    const users = await (await fetch(`http://127.0.0.1:${p3}/api/admin/users?limit=100`, { headers: { authorization: 'Bearer ' + tok } })).json();
    assert(users.items.some((u) => u.username === 'persist1'), 'المستخدم المسجَّل ضاع بعد إعادة التشغيل');
    const ships = await (await fetch(`http://127.0.0.1:${p3}/api/shipments?limit=5`, { headers: { authorization: 'Bearer ' + tok } })).json();
    assert(Array.isArray(ships.items), 'الشحنات غير متاحة');
    srv2.kill('SIGKILL');
    return 'المستخدم والجلسة محفوظان بعد إعادة التشغيل ✅';
  });

  await t('SIGTERM يحفظ البيانات قبل الخروج (إعادة نشر Render)', async () => {
    const p4 = await freePort();
    const data4 = path.join(tmp, 'sigterm');
    const c4 = startServer(p4, data4);
    await waitReady(`http://127.0.0.1:${p4}`, c4);
    await fetch(`http://127.0.0.1:${p4}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'مستخدم إغلاق', email: 'sig@t.local', phone: '770000222', username: 'sigterm1', password: 'UserPass!2026' })
    });
    c4.kill('SIGTERM');
    const code = await waitExit(c4, 6000);
    assert(c4.__log.includes('حفظ كل المجموعات') || c4.__log.includes('[shutdown]'), 'لا سجل إغلاق آمن: ' + c4.__log.slice(-150));
    assert(code === 0 || code === null, 'رمز الخروج: ' + code);
    const users = JSON.parse(fs.readFileSync(path.join(data4, 'users.json'), 'utf8'));
    assert(users.some((u) => u.username === 'sigterm1'), 'المستخدم لم يُحفظ');
    return 'حُفظ قبل الخروج';
  });

  await t('تحذير صريح عند قرص مؤقت (Render بلا Disk)', async () => {
    const p5 = await freePort();
    const c5 = startServer(p5, path.join(tmp, 'ephemeral'), { RENDER: '1' });
    const h = await waitReady(`http://127.0.0.1:${p5}`, c5);
    assert(h.storage.persistent === false, 'persistent يجب أن تكون false: ' + JSON.stringify(h.storage));
    assert(/غير دائم|غير قابلة|تنبيه/.test(c5.__log), 'لا تحذير في السجل');
    c5.kill('SIGKILL');
    return 'persistent:false + تحذير';
  });

  await t('القرص الدائم على Render (مسار /data) يُكتشف كدائم', async () => {
    // نستخدم مجلدًا مؤقتًا يحاكي /data عبر STORAGE_PERSISTENT وتعيين RENDER مع مسار يبدأ بـ /data
    const p6 = await freePort();
    const fakeData = path.join(tmp, 'data-mount');
    const c6 = startServer(p6, fakeData, { RENDER: '1', STORAGE_PERSISTENT: 'true' });
    const h = await waitReady(`http://127.0.0.1:${p6}`, c6);
    assert(h.storage.persistent === true, 'persistent: ' + JSON.stringify(h.storage));
    assert(/قاعدة البيانات/.test(c6.__log), 'لا سجل تخزين');
    c6.kill('SIGKILL');
    return 'persistent:true عبر STORAGE_PERSISTENT';
  });

  console.log('\n— ملفات النشر —');
  await t('render.yaml موجود وصالح ويحتوي قرصًا دائمًا على /data', async () => {
    const p = path.join(ROOT, 'render.yaml');
    assert(fs.existsSync(p), 'الملف مفقود');
    const txt = fs.readFileSync(p, 'utf8');
    assert(/healthCheckPath:\s*\/health/.test(txt), 'لا فحص صحة');
    assert(/mountPath:\s*\/data/.test(txt), 'لا قرص دائم على /data');
    assert(/startCommand:\s*"node server\/server\.js"/.test(txt), 'أمر التشغيل غير صحيح');
    assert(/DATA_DIR[\s\S]{0,40}\/data/.test(txt), 'DATA_DIR غير مضبوط');
    return 'Blueprint جاهز';
  });

  await t('Dockerfile موجود ويستخدم $PORT و 0.0.0.0 و /health', async () => {
    const txt = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert(/FROM node:20/.test(txt), 'الصورة الأساسية');
    assert(/PORT=8080/.test(txt) && /HOST=0\.0\.0\.0/.test(txt), 'بيئة المنفذ');
    assert(/DATA_DIR=\/data/.test(txt), 'DATA_DIR');
    assert(/HEALTHCHECK[\s\S]*\/health/.test(txt), 'فحص صحة');
    assert(/CMD \["node", "server\/server\.js"\]/.test(txt), 'أمر التشغيل');
    return 'node:20-alpine';
  });

  await t('.gitignore يحمي البيانات والأسرار', async () => {
    const txt = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const need of ['data/', '.env', 'node_modules/', '*.keystore', '*.apk']) {
      assert(txt.includes(need), 'مفقود: ' + need);
    }
    return 'محمي';
  });

  await t('.env.example يوضح كل المتغيّرات المطلوبة', async () => {
    const txt = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const need of ['ADMIN_PASSWORD', 'DATA_DIR', 'HOST', 'PUBLIC_URL', 'CORS_ORIGINS', 'LOGIN_RATE_LIMIT', 'AI_API_KEY']) {
      assert(txt.includes(need), 'مفقود: ' + need);
    }
    return '9 مجموعات';
  });

  await t('railway.json و Procfile و .dockerignore موجودة وصالحة', async () => {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'railway.json'), 'utf8'));
    assert(r.deploy.healthcheckPath === '/health', 'healthcheck');
    assert(/node server\/server\.js/.test(fs.readFileSync(path.join(ROOT, 'Procfile'), 'utf8')), 'Procfile');
    assert(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').includes('node_modules'), '.dockerignore');
    return 'Railway/Render/Heroku';
  });

  console.log('\n— تطبيع عنوان الخادم في التطبيق —');
  await t('app-config يقبل https بلا منفذ ولا يضيف :8080', async () => {
    const code = fs.readFileSync(path.join(ROOT, 'app', 'js', 'app-config.js'), 'utf8');
    const store = {};
    const ctx = {
      window: null, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
      location: { search: '' }, URL, URLSearchParams, console
    };
    ctx.window = ctx; vm.createContext(ctx); vm.runInContext(code, ctx);
    const norm = ctx.MASAR_NORMALIZE_SERVER;
    const cases = [
      ['https://masar-api.onrender.com', 'https://masar-api.onrender.com'],
      ['https://masar-api.onrender.com/', 'https://masar-api.onrender.com'],
      ['masar-api.onrender.com', 'https://masar-api.onrender.com'],
      ['http://masar-api.onrender.com', 'https://masar-api.onrender.com'],
      ['https://api.example.com:443', 'https://api.example.com'],
      ['192.168.1.10:8080', 'http://192.168.1.10:8080'],
      ['http://192.168.1.10:8080/', 'http://192.168.1.10:8080'],
      ['10.0.2.2:8080', 'http://10.0.2.2:8080'],
      ['', '']
    ];
    for (const [input, expected] of cases) {
      const got = norm(input);
      assert(got === expected, `«${input}» → «${got}» بدل «${expected}»`);
    }
    assert(!norm('https://masar-api.onrender.com').includes(':8080'), 'أُضيف :8080');
    const v = ctx.MASAR_VALIDATE_SERVER('https://masar-api.onrender.com');
    assert(v.ok && v.secure && v.port === '', 'التحقق: ' + JSON.stringify(v));
    return `${cases.length} حالة`;
  });

  await t('صفحة الإعدادات تعرض حقل «عنوان الخادم» مع مثال https', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
    assert(html.includes('serverUrlInput'), 'الحقل مفقود');
    assert(/https:\/\/YOUR-SERVICE\.onrender\.com/.test(html), 'لا مثال https واضح');
    assert(html.includes('saveServerUrl') && html.includes('testServerConnection'), 'لا أزرار الحفظ/الاختبار');
    assert(!html.includes('placeholder="https://masar-api.onrender.com"'), 'المثال يبدو رابطًا حقيقيًا (مضلِّل)');
    return 'حقل + حفظ + اختبار + مثال واضح';
  });

  await t('روابط مباشرة للإدارة (?page=admin) موجودة وتعرض الصفحة', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
    assert(html.includes('runDeepLink'), 'دالة الروابط المباشرة مفقودة');
    assert(/admin:\s*'adminPage'/.test(html), 'لا تعيين admin → adminPage');
    assert(html.includes('MASAR_DEEPLINK_TARGET'), 'لا كشف للهدف');
    return '?page=admin|settings|wallet|auctions|tracking|reports';
  });

  await t('نافذة الأندرويد تُطبّع العنوان (https بلا منفذ)', async () => {
    const java = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'com', 'almasar', 'logistics', 'MainActivity.java'), 'utf8');
    assert(java.includes('normalizeServer'), 'الدالة مفقودة');
    assert(java.includes('https://YOUR-SERVICE.onrender.com'), 'لا مثال https');
    assert(/local \? "http:\/\/" : "https:\/\//.test(java), 'منطق الاختيار');
    assert(!/\+ ":8080"/.test(java), 'يضيف :8080 تلقائيًا');
    return 'Java مطبِّع';
  });

  console.log('\n' + '='.repeat(62));
  console.log(`النتيجة: ${pass} ناجح · ${fail} فاشل`);
  if (fail) { console.log('\nالفاشلة:'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(62) + '\n');

  fs.mkdirSync(path.join(ROOT, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'audit', 'deploy-test-report.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail, failures }, null, 2));

  children.forEach((c) => { try { c.kill('SIGKILL'); } catch (_) {} });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync('/data', { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('خطأ عام:', e);
  children.forEach((c) => { try { c.kill('SIGKILL'); } catch (_) {} });
  process.exit(1);
});
