# المسار العالمي اللوجستي — المراحل 0 → 5 (خادم حقيقي + إدارة + إشعارات + جوال + تسعير وتقارير + مساعد ذكي)

> التصميم والهوية والصفحات الأصلية محفوظة — لم يُحذف أي شيء. النسخ الأصلية محفوظة في `backups/`.
> **المرحلة 2 (المزادات)** تعمل فعليًا: مزايدة ذرّية، محفظة ضمان، إغلاق تلقائي، بث لحظي.
> **المرحلة 3** أضافت: خادمًا جاهزًا للنشر (Docker + HTTPS)، لوحة إدارة متكاملة داخل الإعدادات،
> إشعارات على أربع قنوات (داخل التطبيق/SSE + Web Push حقيقي + FCM + APNs)، وتطبيقات أندرويد (APK) وآيفون (Xcode) وPWA.
> **المرحلة 4** أضافت: محرّك قواعد تسعير يُحسب على الخادم ويُطبَّق تلقائيًا على الشحنات، تقارير مالية حقيقية مع تصدير CSV،
> سجل تدقيق متقدّم بفلاتر وتصدير، وطبقة تتبّع شركات شحن تُعلن حالتها بصراحة بلا بيانات مُقلَّدة.
> **المرحلة 5** أضافت: مساعدًا ذكيًا حقيقيًا — استدعاء LLM عبر HTTP (OpenAI / متوافق / Claude / Gemini / Ollama)
> ببيانات المستخدم مُسنَدة، ومحرّك قواعد بديل يعمل دائمًا، وإدارة كاملة له (إعدادات، أسئلة شائعة، إحصاءات، محادثات).

## 0) النشر على الإنترنت (رابط https) — أهم خطوة للإنتاج
الخادم جاهز للسحابة: منفذ ديناميكي (`$PORT`)، استماع على `0.0.0.0`، CORS شامل، فحص صحة `GET /health`،
إغلاق آمن يحفظ البيانات، وملفات نشر جاهزة (`render.yaml`, `Dockerfile`, `railway.json`, `.env.example`).

```bash
git init -b main && git add . && git commit -m "masar-api" && git push -u origin main   # ثم Render → Blueprint
curl -s https://<خدمتك>.onrender.com/health     # يجب: 200 + "persistent": true
```

⚠️ **البيانات ملفات JSON على القرص** — اربط قرصًا دائمًا على `/data` (Render Disk / Railway Volume)
وإلا ضاعت المستخدمون والمزادات والمحفظة عند كل إعادة نشر.
الدليل الكامل بالأوامر: `docs/دليل-النشر-على-الإنترنت.md` · مجلد جاهز للرفع: `masar-server-github.zip`.

## 1) التشغيل

```bash
node server/server.js          # Node 20 أو أحدث — الخادم لا يحتاج أي تبعيات
# ثم افتح: http://localhost:8080
```

متغيّرات اختيارية:

```bash
PORT=8080 HOST=0.0.0.0 DATA_DIR=./data ADMIN_PASSWORD='كلمة-مرور-قوية' \
DEMO_MODE=false LOGIN_RATE_LIMIT=40 node server/server.js
```

| المتغير | المعنى |
|---|---|
| `PORT` / `HOST` | منفذ وعنوان الاستماع (الافتراضي 8080 / 0.0.0.0) |
| `DATA_DIR` | مجلد قاعدة البيانات (افتراضي `./data`) |
| `ADMIN_PASSWORD` | كلمة مرور المدير عند أول إنشاء للقاعدة |
| `DEMO_MODE=false` | يلغي «الشحن التجريبي» للمحفظة تمامًا |
| `LOGIN_RATE_LIMIT` | حد محاولات الدخول لكل IP في 15 دقيقة (افتراضي 40) |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | هوية ومفاتيح إشعارات الويب (تُولَّد تلقائيًا إن لم تُحدَّد) |
| `FCM_SERVICE_ACCOUNT` | ملف/JSON حساب خدمة Firebase لإشعارات أندرويد الأصلية |
| `APNS_KEY_P8` + `APNS_KEY_ID` + `APNS_TEAM_ID` + `APNS_BUNDLE_ID` | مفاتيح إشعارات آيفون الأصلية |
| `VISITOR_SALT` | ملح تجزئة عناوين IP في تتبّع الزوار |

### بيانات الدخول الأولى

| المستخدم | كلمة المرور | الدور |
|---|---|---|
| `admin` | `Masar!Admin2026` | مدير عام |

> ⚠️ غيّرها فورًا من: الإعدادات ← الأمان ← تغيير كلمة المرور، ثم احذف `data/BOOTSTRAP_ADMIN.txt`.

## 2) ما الذي يعمل الآن؟

### المرحلة 0 — إصلاح الأعطال المؤكدة
5 دوال كانت تستدعي نفسها (فلاتر شحناتي/الفروع)، `copyToClipboard`، البحث في المساعد الذكي،
`shareShipmentLocation`، وجسر `window.__app`.

### المرحلة 1 — خادم وقاعدة بيانات ومصادقة حقيقية
- خادم Node بلا تبعيات + REST تحت `/api` + تقديم الواجهة.
- تخزين مركزي على القرص في `data/` (كتابة ذرّية + نسخة `.bak`).
- مصادقة: `scrypt`، رموز HMAC-SHA256، Access 20 د + Refresh 30 يومًا قابل للإبطال، حد محاولات، سجل تدقيق.
- صلاحيات على الخادم: `user < agent < support_staff < shipping_staff < branch_manager < super_admin`.
- 37 شحنة تجريبية موسومة `demo:true` + بث SSE + بيانات حية (صرف/طقس/بحر/أخبار/عملات/مؤشرات) بوسم المصدر.
- وضع محلي احتياطي إذا توقف الخادم.

### المرحلة 2 — المزادات الحقيقية (جديد)
- **محفظة ضمان** (`server/lib/wallet.js`): حجز لكل عرض بمرجع مستقل، تحرير عند التجاوز، تحصيل إلى `system:escrow` عند الفوز، كل الحركات مقيّدة في `wallet_entries`.
- **محرّك مزايدة ذرّي** (`server/lib/auctions.js`): قبول/رفض داخل قسم واحد بلا `await`؛ يرفض: أقل من البداية، أقل من أعلى عرض + الزيادة، مزايدة البائع، تجاوز نفسك، مزاد مغلق/مستقبلي، رصيد غير كافٍ (402).
- **مُجدول كل ثانية** يغلق المزادات، يثبّت الفائز، يحصّل المبلغ في الضمان، ويُصدر إشعار «🎉 فزت بالمزاد» أو يُحرّر الحجز إذا لم يُستوفَ سعر الحجز.
- **مكافحة القنص**: عرض في آخر 60 ثانية → تمديد 60 ثانية (حتى 20 مرة).
- **سجل مزايدات ثابت** بأسماء مُقنّعة (`abc***`) + سجل تدقيق (`auction_create/bid/close`).
- **SSE**: `auction_bid` / `auction_closed` / `auction_created` لتحديث السعر والعدّاد لحظيًا.
- **واجهة** (`app/js/auctions.js`): صفحة «المزادات» وزرها في شبكة الخدمات بنفس تصميم النظام — تبويبات (نشطة/قادمة/منتهية/مزايداتي/متابعاتي)، تصنيف، ترتيب، بحث، عدّاد بساعة الخادم، نافذة تفاصيل بسجل المزايدات، متابعة بنجمة، ونموذج **إنشاء مزاد** للموظفين فقط.
- عند انقطاع الخادم: رسالة صريحة — لا مزادات وهمية.

### المرحلة 3 — الخادم الحقيقي والإدارة والإشعارات والتطبيقات
- **خادم جاهز للإنتاج**: `deploy/` (Dockerfile، docker-compose مع HTTPS تلقائي عبر Caddy، systemd، nginx، نسخ احتياطي يومي، healthcheck) + دليل نشر كامل `docs/دليل-الخادم-الحقيقي.md`.
- **لوحة إدارة متكاملة** تظهر كقسم داخل «الإعدادات» ← 🛡️ الإدارة والإشعارات: حالة الخادم · المستخدمون · العملاء · الزوار · الإشعارات · سجل التدقيق.
  (تفعيل/إيقاف فوري، تغيير رتب، إعادة كلمة مرور مؤقتة، إنشاء وحذف ناعم، حجب زوار، إحصاءات زيارة حقيقية، نسخة احتياطية بزر).
- **إشعارات** بأربع قنوات: صندوق داخل التطبيق + SSE · **Web Push حقيقي** (VAPID + تشفير RFC 8291 + Service Worker) · FCM · APNs.
  FCM/APNs يحتاجان مفاتيح حسابك، وتظهر حالتهما «غير مهيّأ» بوضوح حتى ذلك الحين.
- **تتبّع الزوار** بلا كوكيز إعلانية: معرّف عشوائي + بصمة IP مجزّأة، وإحصاءات أجهزة/منصّات/أكثر الصفحات.
- **تطبيقات**: `masar-logistics-v1.0.0-phase3.apk` (أندرويد، مبني وموقّع) · مشروع Xcode كامل في `ios/` · وPWA (`manifest.webmanifest` + `sw.js` + أيقونات) تعمل الآن على أندرويد وآيفون.
- **أمان**: `token_version` يُبطل رموز الوصول فورًا عند إعادة كلمة المرور/الإيقاف، وصلاحيات الإدارة تُفرض على الخادم.

### المرحلة 4 — التسعير والتقارير والتتبّع
- **محرّك قواعد التسعير** (`server/lib/pricing.js`): شروط (خدمة/مصدر/وجهة/وزن/رتبة عميل) ومعادلة (رسم + كيلو + م³ ثم زيادة/خصم ثم حد أدنى)،
  اختيار الأكثر تخصّصًا، واقتباس يشرح الحساب سطرًا سطرًا. **يُطبَّق تلقائيًا** عند إنشاء شحنة بدون سعر (`price_quote` محفوظ مع الشحنة).
- **تقارير مالية** (`server/lib/reports.js`): ملخّص 30 يومًا، سلسلة زمنية، أفضل العملاء، وتصدير CSV لأربعة أنواع بترميز UTF-8+BOM.
- **سجل تدقيق متقدّم**: فلاتر (إجراء/منفّذ/كيان/تاريخ/بحث) + ترقيم صفحات + تصدير.
- **شركات الشحن** (`server/lib/carriers.js`): أحداث يدوية حقيقية من موظف الشحن + تكامل 17TRACK/DHL جاهز عند إضافة المفاتيح،
  وأي مزوّد غير مهيّأ يعيد `ready:false` بلا أي أحداث مُقلَّدة.
- **الواجهة**: ثلاثة تبويبات جديدة في لوحة الإدارة (التسعير بمحاكي · التقارير مع CSV · الشحن والتتبّع) + ترقية تبويب السجل.

### النشر والسحابة
GET    /health  |  /healthz  |  / (Accept: application/json)
# المرحلة 5 — المساعد الذكي
- **مزوّدون حقيقيون**: `openai` (`AI_API_KEY`)، `openrouter`، `anthropic` (`ANTHROPIC_API_KEY`)،
  `gemini` (`GEMINI_API_KEY`)، `ollama` (محلي). كل مزوّد يُعلن `ready` صراحةً بالاسم والمفتاح المطلوب.
- **بدون مفاتيح**: يعمل **محرّك قواعد مُسنَد** (تتبّع شحنة حقيقية · اقتباس من محرّك التسعير · رصيد المحفظة ·
  المزادات · الأسئلة الشائعة · تحويل للدعم) ويُعلن للمستخدم أنه ليس نموذجًا.
- **الإسناد**: يُحقن للموديل ملخّص حقيقي (شحنات/رصيد/مزادات) وتُعلَن المصادر في كل رد، وممنوع إرسال كلمات المرور.
- **الفشل بصدق**: مزوّد معطّل → `degraded=true` + سبب + إجابة من القواعد (لا تعليق ولا تلفيق).
- **الإدارة**: تبويب «المساعد الذكي» — حالة المزوّدين، الإعدادات (مزوّد/حد يومي/حرارة/رموز/تعليمات/تشغيل)،
  إحصاءات، أكثر الأسئلة، قاعدة الأسئلة الشائعة (CRUD)، اختبار فوري، وسجل المحادثات.
- **الدليل الكامل**: `docs/دليل-المساعد-الذكي.md`.

## 3) بنية المشروع

```
app/
  index.html            ← الواجهة الأصلية (التصميم كما هو) + وسم سكربتات المرحلة 1 و2
  js/api-client.js      ← طبقة البيانات (خادم + بديل محلي)
  js/phase1.js          ← دمج الخادم مع الواجهة دون تغيير صفحاتها
  js/auctions.js        ← واجهة المزادات (المرحلة 2)
  js/admin.js           ← لوحة الإدارة (المرحلة 3)
  js/pwa.js             ← تثبيت التطبيق + تتبّع الزوار + Web Push
  sw.js · manifest.webmanifest · icons/   ← PWA
server/
  server.js             ← الخادم + REST + SSE + مُجدول المزادات
  lib/auth.js           ← scrypt + رموز + صلاحيات + Rate Limit
  lib/store.js          ← تخزين مركزي على القرص
  lib/live.js           ← بوابة المصادر الحية (مع تخزين مؤقت)
  lib/wallet.js         ← محفظة الضمان والقيود (المرحلة 2)
  lib/auctions.js       ← محرّك المزايدة الذرّي والإغلاق (المرحلة 2)
data/                   ← قاعدة البيانات الفعلية (JSON) + لقطة المدير الأولى
  lib/push.js           ← إشعارات (VAPID + تشفير Web Push + FCM + APNs)
  lib/admin.js          ← إدارة المستخدمين/العملاء/الحملات/حالة الخادم
  lib/visitors.js       ← تتبّع الزوار والإحصاءات
  lib/pricing.js        ← محرّك قواعد التسعير (المرحلة 4)
  lib/reports.js        ← التقارير المالية وسجل التدقيق المتقدّم (المرحلة 4)
  lib/carriers.js       ← تكامل شركات الشحن والتتبّع (المرحلة 4)
  lib/assistant.js      ← المساعد الذكي: مزوّدو LLM + محرّك قواعد مُسنَد (المرحلة 5)
scripts/
  test-api.mjs          ← 35 اختبار تكامل API
  test-ui.js            ← 65 اختبار واجهة (jsdom)
  test-e2e.js           ← 23 اختبار تكامل واجهة↔خادم
  test-auctions.mjs     ← 23 اختبار محرّك المزادات
  test-auctions-ui.js   ← 32 اختبار واجهة مزادات ضد خادم حقيقي
  test-admin.js         ← 31 اختبار الإدارة والإشعارات والزوار
  test-phase4.js        ← 23 اختبار التسعير والتقارير والتدقيق والتتبّع
  test-phase5.js        ← 35 اختبار المساعد الذكي (بما فيها مزوّد وهمي يثبت مسار HTTP)
android/                ← مشروع APK (MainActivity + AssetServer) و build-apk.sh
ios/                    ← مشروع آيفون (Swift + XcodeGen) و build-ios.sh
deploy/                 ← Docker + HTTPS + systemd + nginx + نسخ احتياطي
backups/                ← النسخة الأصلية غير المعدّلة
audit/                  ← تقارير الاختبارات (JSON)
docs/                   ← تقارير التحليل والإنجاز (HTML عربي RTL)
```

## 4) الاختبارات

```bash
npm install       # مرة واحدة — jsdom للاختبارات فقط (الخادم لا يحتاج شيئًا)
npm test          # كل الحزم: 309 اختبارات
npm run test:phase2   # المزادات فقط (23 + 32)
npm run test:phase3   # الإدارة والإشعارات (31)
npm run test:phase4   # التسعير والتقارير والتتبّع (23)
npm run test:phase5   # المساعد الذكي (35)
npm run test:deploy   # جاهزية النشر: $PORT/CORS/health/بقاء البيانات/ملفات النشر (22)
```

| الحزمة | العدد | ما تغطيه |
|---|---|---|
| `test:api` | 35 | مصادقة، صلاحيات، CRUD، مفضلة، تقييمات، Rate Limit، SSE، بيانات حية، استيراد |
| `test:ui` | 73 | التنقل في كل الصفحات، 287 معالج زر، الفلاتر، الحاسبة، المحفظة، البوابة، الإعدادات، صفحة المزادات |
| `test:e2e` | 35 | إقلاع الطبقة، دخول، مزامنة، مزادات، لوحة الإدارة، حملة إشعار من الواجهة، تتبّع زيارة |
| `test:auctions` | 23 | محفظة، مزايدة، 50 عرضًا متزامنًا، إغلاق، تمديد، صلاحيات، إشعارات، تدقيق |
| `test:auctions:ui` | 32 | عرض، عدّاد بساعة الخادم، مزايدة فعلية، حجز مال، متابعة، فلاتر، انقطاع الخادم |

| `test:admin` | 31 | زوار، VAPID، تشفير Web Push وفكّه، حملات وجمهور، صلاحيات، إيقاف/إعادة تعيين/حذف، نسخ احتياطي، تدقيق |
| `test:phase4` | 23 | قواعد تسعير واقتباسات وحدود وصلاحيات، سعر تلقائي للشحنة، تقارير وCSV، فلاتر التدقيق، مزوّدو التتبّع |
| `test:phase5` | 35 | صدق الحالة، إسناد الإجابات، مسار LLM عبر HTTP، الخصوصية، التراجع عند الفشل، الحصص والصلاحيات، الأسئلة الشائعة والإحصاءات |
| `test:deploy` | 22 | `$PORT` و`0.0.0.0`، `/health` و`/healthz` و`/`، CORS شامل + OPTIONS + تقييد الأصول، بقاء البيانات بعد إعادة التشغيل، SIGTERM، تحذير القرص المؤقت، ملفات النشر، تطبيع `https://` بلا منفذ |

آخر نتيجة: **309 ناجح · 0 فاشل** (التقارير في `audit/`).

## 5) واجهة API (مختصر)

```
GET    /api/health

POST   /api/auth/register | login | refresh | logout | change-password
GET    /api/auth/me

GET    /api/shipments?status=&q=&from=&to=&page=&limit=
POST   /api/shipments            (shipping_staff+)
PATCH  /api/shipments/:tracking  (shipping_staff+)
DELETE /api/shipments/:tracking  (super_admin)

GET    /api/auctions?status=&category=&q=&sort=&page=&limit=
GET    /api/auctions/:id
POST   /api/auctions             (shipping_staff+)   ← إنشاء مزاد
POST   /api/auctions/:id/bids    ← مزايدة (ذرّية، تحجز من المحفظة)
GET    /api/auctions/:id/bids
POST|DELETE /api/auctions/:id/watch
POST   /api/auctions/:id/cancel  (يرفض الإلغاء عند وجود مزايدات)
GET    /api/auctions/mine/bids

GET    /api/wallet/me | /api/wallet/entries
POST   /api/wallet/demo-credit   ← موسوم demo:true
POST   /api/admin/credit · GET /api/admin/wallet

GET    /api/users                (super_admin)  ·  PATCH /api/users/:id
GET/POST /api/favorites  ·  DELETE /api/favorites/:type/:id
GET/POST /api/reviews
GET    /api/notifications  ·  POST /api/notifications/read
GET    /api/live/fx | weather | news | crypto | macro
GET    /api/stream?topics=shipments,notifications:<id>,auctions   (SSE)
GET    /api/admin/stats | audit  ·  POST /api/admin/import

# المرحلة 3 — تتبّع وإشعارات وإدارة
POST   /api/track/visit | /api/track/ping
GET    /api/push/public-key  ·  POST /api/push/subscribe | unsubscribe | test | device
GET    /api/push/status
GET    /api/admin/server        ← حالة الخادم والإحصاءات وقنوات الإشعار
GET    /api/admin/users?kind=&status=&q=   ·  POST /api/admin/users
GET|PATCH|DELETE /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
GET    /api/admin/clients
GET    /api/admin/visitors | visitors/stats  ·  POST /api/admin/visitors/:id/block
GET|POST /api/admin/notifications  ·  GET /api/admin/notifications/log
GET    /api/admin/backup        ← نسخة JSON كاملة

# المرحلة 4 — تسعير وتقارير وتتبّع
GET    /api/pricing/services
GET    /api/pricing/rules        (shipping_staff+)   ·  POST (branch_manager+)
PATCH  /api/pricing/rules/:id    (branch_manager+)   ·  DELETE (super_admin)
POST   /api/pricing/quote        ← اقتباس سعر بشرح كامل
GET    /api/admin/reports/summary | series | top-clients
GET    /api/admin/reports/export?type=entries|shipments|auctions|audit   (CSV)
GET    /api/admin/audit/query?action=&actor=&entity=&from=&to=&page=
GET    /api/admin/carriers       ·  POST /api/admin/carriers/events | carriers/track

# النشر والسحابة
GET    /health  |  /healthz  |  / (Accept: application/json)
# المرحلة 5 — المساعد الذكي
GET    /api/assistant/public                  ← حالة عامة (قبل الدخول)
GET    /api/assistant/status                  ·  POST /api/assistant/chat
GET    /api/assistant/conversations[/:id]     ·  POST /api/assistant/feedback
GET    /api/admin/assistant/status | stats | conversations
PATCH  /api/admin/assistant/settings          (super_admin)
POST   /api/admin/assistant/test
GET/POST/PATCH/DELETE  /api/admin/assistant/faq[/:id]
```

## 5.b) تشغيل الخادم الحقيقي (نشر)
```bash
cp deploy/.env.example deploy/.env   # DOMAIN + ADMIN_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```
الدليل الكامل: `docs/دليل-الخادم-الحقيقي.md` (VPS، نطاق، HTTPS، نسخ احتياطي، FCM/APNs، قائمة تحقّق أمنية).

## 5.c) التطبيقات
- **أندرويد**: `masar-logistics-v1.0.0-phase5.apk` — ثبّته وأدخل عنوان الخادم. إعادة البناء: `bash android/build-apk.sh`.
- **آيفون**: `ios/` (Swift + project.yml) — على macOS: `brew install xcodegen && bash ios/build-ios.sh`.
- **بلا متجر (يعمل الآن)**: افتح الموقع في المتصفح ← «إضافة إلى الشاشة الرئيسية» (Safari على iOS 16.4+ يدعم الإشعارات).

## 6) ملاحظات صريحة (لا نخفي شيئًا)

- الشحنات الـ37 **تجريبية** ووسمها ظاهر (`بيانات تجريبية (37)` + `demo:true` في API).
- **المال تجريبي موسوم**: رصيد المحفظة يُشحن بضغطة ويُوسم `demo:true` ويظهر كـ«شحن رصيد تجريبي». يُلغى بـ`DEMO_MODE=false`.
- **المزادات الستة المبدئية تجريبية** (`demo:true` + شارة «عرض تجريبي»). المزادات المُنشأة من الواجهة حقيقية ومحفوظة.
- **غير موصول ولم يُقلَّد**: تتبع شركات الشحن (DHL/UPS/FedEx/17TRACK)، بوابة دفع حقيقية، وتحويل مبلغ الفوز من حساب الضمان إلى البائع، والمساعد الذكي على خدمة AI.
- **FCM/APNs**: الكود مبني بالكامل (توقيع RS256/ES256 وإرسال HTTP v1/HTTP2) لكن الإرسال لا يعمل حتى تضيف مفاتيح حسابك؛ تظهر القناة «غير مهيّأ» صراحةً.
- **Docker/nginx/Caddy**: ملفات النشر لم تُشغَّل داخل بيئة البناء (لا Docker فيها) — تُختبر عند أول نشر على سيرفرك.
- **iOS**: البناء يحتاج macOS + Xcode + حساب Apple؛ لم يُختبر هنا.
- **APK**: بُني ووُقّع وتحقّق محتواه، لكن لم يُثبَّت على جهاز/محاكي في بيئة البناء.
- **أعطال قائمة من المرحلة 0 لم تُمسّ**: `portalState is not defined` في مفضلة البوابة، خطأ `analyticsPage`، أزرار تعمل بالإشعار فقط (`filterMerchants`, `searchMerchants`, `sendSupportTicket`, `printShipmentReport`, `simulateBarcodeScan`)، ومعرّفات مكرّرة (`forgotError`, `forgotIdentifier`, `walletTransferAmount`, `portalFavCount`).
- تخزين JSON على القرص مناسب للتشغيل والاختبار والتوسع الصغير؛ للانتقال إلى PostgreSQL تُستبدل `server/lib/store.js` فقط.
- اختبار المتصفح البصري (Playwright) غير مشغّل هنا؛ اختبار المنطق والواجهة تمّ عبر jsdom + خادم حقيقي.

## 7) التالي

- **تفعيل المساعد بنموذج**: أضف `AI_API_KEY` (أو مفتاح أي مزوّد) — الدليل: `docs/دليل-المساعد-الذكي.md`.
- **تفعيل التتبّع الآلي**: أضف `17TRACK_API_KEY` أو `DHL_API_KEY` فتصبح أحداث الشحن تلقائية بدل اليدوية.
- **تفعيل FCM/APNs**: بمجرد إضافة مفاتيحك تصبح إشعارات التطبيقات المثبّتة حيّة.
