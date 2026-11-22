# دليل النشر على الإنترنت — الحصول على رابط `https://…` وتشغيله مع التطبيق

> الهدف: تشغيل خادم Node.js الحقيقي على الإنترنت برابط HTTPS دائم، ثم لصق الرابط في
> **التطبيق ← الإعدادات ← 🌐 خادم النظام ← عنوان الخادم** (بدل `http://192.168.1.10:8080`).

---

## 0) أولًا: الحقيقة الكاملة عن حفظ البيانات (اقرأ هذا قبل أي شيء)

الخادم **لا يستخدم قاعدة بيانات سحابية خارجية**. يخزّن كل شيء في **ملفات JSON على القرص**
داخل المجلد `DATA_DIR` (افتراضيًا `/data` على السحابة، و`data/` محليًا):

| البيانات | الملف |
|---|---|
| المستخدمون وكلمات المرور (مُشفّرة scrypt) والجلسات | `users.json` · `sessions.json` |
| المزادات والمزايدات | `auctions.json` · `bids.json` |
| المحفظة والقيود والأرصدة | `wallet_accounts.json` · `wallet_entries.json` · `wallet_holds.json` |
| الشحنات والتتبّع والإشعارات والزوار والتدقيق … | ملفات `*.json` أخرى (24 مجموعة) |

الكتابة **ذرّية** (ملف مؤقت ثم rename) مع نسخة `.bak` قبل كل كتابة، وعند وصول `SIGTERM`
(إعادة النشر على Render/Railway) يحفظ الخادم كل المجموعات قبل الخروج. لكن هذا لا يكفي وحده:

> ⚠️ **القاعدة الذهبية: إن لم تربط «قرصًا دائمًا» (Persistent Disk / Volume) بمجلد `/data`
> فستضيع البيانات عند كل إعادة نشر أو نوم للخدمة.** وهذا أهم سبب لضياع البيانات في الاستضافات المجانية.

لذلك:

1. **اربط قرصًا دائمًا بحجم 1GB على `/data`** (الخطوات أدناه تفصّل ذلك لكل منصّة).
2. ضبط `DATA_DIR=/data` و`STORAGE_PERSISTENT=true` (مضبوطان مسبقًا في `render.yaml`).
3. خُذ نسخة احتياطية دورية من **لوحة الإدارة ← الخادم ← ⬇️ نسخة احتياطية**
   (`GET /api/admin/backup`) — أو استخدم `deploy/backup.sh` مع cron.
4. عند النشر على منصّة بلا أقراص دائمة (Codespaces / Vercel-likes) اعتبرها **بيئة تجريبية فقط**.

**ماذا عن قاعدة بيانات سحابية حقيقية؟** لم تُنفَّذ بعد. طبقة التخزين معزولة في
`server/lib/store.js` (واجهة `load/save/insert/update/remove`) لتُستبدل بـ PostgreSQL
عبر نفس الواجهة لاحقًا. أخبرني إن أردت تنفيذ ذلك كمرحلة مستقلة.

---

## 1) ما أُضيف في هذا التجهيز

| البند | الحالة |
|---|---|
| `process.env.PORT \|\| 8080` + الاستماع على `0.0.0.0` | ✅ يعمل |
| CORS لجميع الطلبات (وما قبل الطيران `OPTIONS`) على API والملفات معًا | ✅ يعمل (`CORS_ORIGINS` لتقييده) |
| فحص الصحة `GET /health` و`/healthz` (و`/` عند طلب JSON) — 200 OK | ✅ |
| توضيح التخزين في سجل الإقلاع وفي `/health` + تحذير عند القرص المؤقت | ✅ |
| `render.yaml` · `Dockerfile` · `.dockerignore` · `.gitignore` · `.env.example` · `railway.json` · `Procfile` · `app.json` | ✅ جاهزة في جذر المشروع |
| حقل «عنوان الخادم» في التطبيق يقبل `https://…` بلا منفذ | ✅ جديد في الإعدادات + نافذة الأندرويد |
| إغلاق آمن `SIGTERM` يحفظ البيانات قبل الخروج | ✅ |

### اختبار سريع محليّ (يتأكد أن كل شيء جاهز)
```bash
PORT=8080 DATA_DIR=./data node server/server.js
curl -s localhost:8080/health | head -c 400        # 200 OK + JSON
curl -sI localhost:8080/js/app-config.js | grep -i access-control   # CORS موجود
```

---

## 2) الرفع إلى GitHub (أوامر جاهزة للنسخ واللصق)

في مجلد المشروع `مسار-لوجستي-المرحلة5/` (أو بعد فك الضغط):

```bash
cd مسار-لوجستي-المرحلة5

# 1) تهيئة المستودع
git init -b main
git config user.name  "اسمك"
git config user.email "بريدك@example.com"

# 2) تأكد أن البيانات والأسرار لن تُرفع (يجب ألّا يُطبع أي شيء)
git status --porcelain | grep -E "^(A|\?\?) (data/|\.env$|backups/)" || echo "نظيف ✅"

# 3) أول التزام
git add .
git commit -m "المسار العالمي اللوجستي — خادم Node.js جاهز للنشر (فحص صحة + CORS + إعدادات نشر)"

# 4) اربط مستودعًا جديدًا على GitHub (أنشئه فارغًا بدون README أولًا)
git remote add origin https://github.com/<اسم-حسابك>/masar-api.git
git push -u origin main
```

> بديل عبر GitHub CLI إن كان مثبّتًا:
> ```bash
> gh auth login
> gh repo create masar-api --public --source=. --remote=origin --push
> ```

**تنبيه أمني:** لا تضع كلمة مرور المدير أو أي مفتاح داخل المستودع — استخدم
«Environment Variables» في لوحة المنصّة. و`.gitignore` يحتوي مسبقًا على `data/` و`.env` و`*.keystore`.

### ما أحتاجه لأرفع الكود بنفسي (اختياري)
بيئتي هنا **غير متصلة بـ GitHub** (لا يوجد تطبيق GitHub موصول في هذه المحادثة). إن أردت أن أرفع
المستودع نيابةً عنك، أحتاج:
1. **GitHub Personal Access Token** بصلاحية `repo` فقط (Settings → Developer settings →
   Personal access tokens → Tokens (classic) → Generate new token → اختر `repo`).
2. **اسم المستودع** المرغوب (مثل `masar-api`) وهل يكون **Public أم Private**.
3. اسم حسابك/المؤسسة (owner).

**ثم احذف الرمز فورًا بعد الرفع** — كما نصحت، وهذا هو الإجراء الصحيح.
وإن فضّلت الأمان الكامل: ارفع بنفسك بالأوامر أعلاه (30 ثانية) ولا تشارك أي رمز.

---

## 3) النشر على Render (الأنسب — يدعم قرصًا دائمًا)

### الطريقة A: Blueprint من `render.yaml` (الأسهل)
1. ادخل [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
2. اختر مستودعك `masar-api` → **Apply**.
3. سيُنشئ Render:
   - خدمة Web باسم `masar-api`، أمر التشغيل `node server/server.js`.
   - **قرص دائم** `masar-data` على `/data` بحجم 1GB.
   - فحص الصحة على `/health`.
4. بعد الإنشاء افتح الخدمة → **Environment** وأضف:
   | المفتاح | القيمة |
   |---|---|
   | `ADMIN_PASSWORD` | كلمة مرور قوية للمدير العام (تُستخدم عند أول تشغيل) |
   | `PUBLIC_URL` | `https://masar-api.onrender.com` (رابطك الفعلي) |
   | `AI_API_KEY` | *(اختياري)* لتفعيل المساعد الذكي بنموذج حقيقي |
5. اضغط **Manual Deploy → Deploy latest commit**، وانتظر حتى يظهر `Live`.
6. افتح `https://masar-api.onrender.com/health` → يجب أن ترى:
   ```json
   {"ok":true,"status":"ok","version":"1.0.0-phase5","storage":{"dir":"/data","writable":true,"persistent":true}}
   ```
7. **أول دخول:** اسم المستخدم `admin`، وكلمة المرور = قيمة `ADMIN_PASSWORD`. ثم غيّرها فورًا.

### الطريقة B: Web Service يدوي (Docker)
- **New +** → **Web Service** → اختر المستودع → Runtime: **Docker**.
- أضف **Disk**: Name `masar-data`، Mount Path `/data`، Size `1GB`.
- Environment: `DATA_DIR=/data` · `STORAGE_PERSISTENT=true` · `ADMIN_PASSWORD=…` · `PUBLIC_URL=…` · `HOST=0.0.0.0`.
- Health Check Path: `/health`.

> ملاحظة الخطة المجانية: خدمة Render المجانية تنام بعد خمول ~15 دقيقة (أول طلب يستغرق ~30 ثانية)
> **ولا تدعم القرص الدائم** → البيانات ستضيع. للاستخدام الجدّي استخدم خطة Starter مع Disk.

---

## 4) النشر على Railway (سريع، يدعم Volumes)

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → اختر `masar-api`.
2. Railway سيقرأ `Dockerfile` و`railway.json` تلقائيًا.
3. **+ New → Volume** → Mount Path: `/data`.
4. **Variables**:
   ```
   DATA_DIR=/data
   STORAGE_PERSISTENT=true
   ADMIN_PASSWORD=كلمة-قوية
   HOST=0.0.0.0
   NODE_ENV=production
   PUBLIC_URL=https://<اسم-الخدمة>.up.railway.app
   ```
5. **Settings → Networking → Generate Domain** → ستحصل على رابط `https://…up.railway.app`.
6. تحقّق: `https://<اسم-الخدمة>.up.railway.app/health`.

---

## 5) النشر على GitHub Codespaces (تجريبي فقط — بلا حفظ دائم)

```bash
# داخل Codespace بعد فتح المستودع
ADMIN_PASSWORD='كلمة-قوية' PORT=8080 node server/server.js
# ثم علامة Ports → انقر يمين على 8080 → Port Visibility: Public
# ستحصل على رابط مثل: https://<اسم>-8080.app.github.dev
```
⚠️ الرابط يتوقف عند إيقاف الـ Codespace، و`data/` داخله مؤقت — **لا تستخدمه للإنتاج**.

---

## 6) ربط التطبيق بالرابط العام

> ⚠️ **تنبيه مهم:** `https://masar-api.onrender.com` في الأمثلة أدناه هو **مثال توضيحي فقط**،
> ولا يوجد عليه خادم حتى تنشره أنت. لا تلصقه في التطبيق قبل أن تُنشئ خدمتك وتتأكد من
> `https://<رابطك>/health` في المتصفح.

### في التطبيق (أندرويد/آيفون/PWA)
**الإعدادات ← 🌐 خادم النظام ← عنوان الخادم** → الصق رابط خدمتك الفعلي، مثل:
```
https://<اسم-خدمتك>.onrender.com
```
ثم **💾 حفظ واختبار** — سيعرض التطبيق:
- ✅ الخادم متصل · زمن الاستجابة · الإصدار · عدد المستخدمين · نوع التخزين (دائم/مؤقت).

الحقل يقبل بلا لبس:
| تُدخل | يُحفظ كـ |
|---|---|
| `https://<اسم-خدمتك>.onrender.com` | كما هو (بلا منفذ) |
| `masar-api.onrender.com` | `https://masar-api.onrender.com` |
| `https://api.example.com:443` | `https://api.example.com` |
| `192.168.1.10:8080` | `http://192.168.1.10:8080` |

**لا يُضاف `:8080` تلقائيًا لأي رابط عام إطلاقًا.**

### في نافذة الأندرويد الأولى
تظهر عند أول تشغيل: الصق نفس الرابط، وستُطبَّع القيمة تلقائيًا بنفس القواعد.
ويمكن تغييرها لاحقًا من زر ⚙️ أعلى التطبيق.

---

## 7) قائمة تحقّق بعد النشر

- [ ] `https://…/health` يعيد 200 و`"persistent": true`.
- [ ] دخول `admin` بكلمة المرور التي وضعتها.
- [ ] إنشاء شحنة تجريبية ← إعادة نشر الخدمة (Redeploy) ← الشحنة **ما زالت موجودة** (اختبار القرص الدائم).
- [ ] فتح التطبيق بـ `https` والتأكد من مؤشر «متصل» أعلى الشاشة.
- [ ] تنزيل نسخة احتياطية من لوحة الإدارة وحفظها خارج السيرفر.
- [ ] تعطيل `DEMO_MODE`/البيانات التجريبية عند الجدّية (التقارير تفصل `demo` تلقائيًا).

---

## 8) حلّ المشكلات الشائعة

| العَرَض | السبب | الحل |
|---|---|---|
| التطبيق: «لا استجابة» | رابط خاطئ أو خدمة نائمة | افتح `/health` في المتصفح؛ انتظر إيقاظ الخدمة (خطة مجانية) |
| يعمل الرابط في المتصفح ولا يعمل في التطبيق | `http://` مع نطاق عام (يمنعه أندرويد/iOS) | استخدم `https://` — التطبيق يرفعه تلقائيًا |
| البيانات تختفي بعد كل نشر | لا يوجد قرص دائم | اربط Disk/Volume على `/data` واضبط `DATA_DIR=/data` |
| `EADDRINUSE` | منفذ ثابت مكتوب يدويًا | لا تُمرّر `PORT`؛ استخدم `$PORT` الذي توفره المنصّة |
| `429` عند الدخول | `LOGIN_RATE_LIMIT` منخفض | ارفعه إلى 60 أو انتظر دقيقة |
| فشل `git push` بسبب حجم كبير | رُفعت `node_modules` أو `data` | `git rm -r --cached node_modules data` ثم أعد الالتزام |

---

## 9) الملفات ذات الصلة

| الملف | الغرض |
|---|---|
| `render.yaml` | نشر Blueprint كامل مع قرص دائم وفحص صحة |
| `Dockerfile` | صورة Node 20 alpine تعمل على أي منصّة حاويات |
| `railway.json` | إعداد Railway (Dockerfile + healthcheck + volume) |
| `Procfile` | أمر التشغيل لمنصّات Heroku-like |
| `.env.example` | كل المتغيّرات المطلوبة والاختيارية |
| `.gitignore` / `.dockerignore` | منع رفع البيانات والأسرار |
| `deploy/` | Caddy + nginx + systemd + سكربتات نسخ احتياطي وفحص صحة (نشر على VPS) |

---

## 10) أرخص وأسرع طريق لرابط HTTPS حقيقي اليوم (Cloudflare Tunnel / ngrok)

إن لم تُرد النشر على استضافة الآن وأردت رابطًا عامًا **يشير إلى خادمك أنت** (البيانات تبقى على جهازك — لا ضياع):

### أ) Cloudflare Tunnel (مجاني، بلا حساب للاستخدام السريع)
```bash
# 1) شغّل خادمك محليًا
ADMIN_PASSWORD='كلمة-قوية' PORT=8080 node server/server.js

# 2) في نافذة أخرى — نزّل cloudflared ثم:
cloudflared tunnel --url http://localhost:8080
# سيظهر لك سطر مثل:
#   https://random-words-here.trycloudflare.com
```
انسخ الرابط الذي يظهر، وافتح في المتصفح: `<الرابط>/health` — إن أعاد 200 فالصقه في التطبيق.
> الرابط مؤقت ويتغيّر عند كل تشغيل. اشترِ نطاقًا (~10$/سنة) واربطه بـ Cloudflare للحصول على رابط ثابت.

### ب) ngrok
```bash
ngrok http 8080
# Forwarding: https://xxxx-xx.ngrok-free.app -> http://localhost:8080
```

### ج) الشبكة المحلية (أسرع اختبار، بلا إنترنت)
```bash
node server/server.js                       # على الكمبيوتر
# اعرف عنوان الكمبيوتر:
#   Windows: ipconfig   |   Linux/Mac: hostname -I
# ثم في التطبيق: http://192.168.1.10:8080   (أو 10.0.2.2:8080 لمحاكي أندرويد)
```

| الطريق | الرابط | دائم؟ | البيانات |
|---|---|---|---|
| Cloudflare Tunnel | `https://….trycloudflare.com` | مؤقت (يتغيّر) | على جهازك ✅ |
| ngrok | `https://….ngrok-free.app` | مؤقت (مجاني) | على جهازك ✅ |
| Render / Railway | `https://<اسمك>.onrender.com` | دائم | على قرص دائم ✅ (يجب ربطه) |
| شبكة محلية | `http://192.168.x.x:8080` | محلي فقط | على جهازك ✅ |

### اختبار قبل اللصق في التطبيق
افتح في متصفح الهاتف: `<الرابط>/health` → يجب أن ترى JSON فيه `"ok":true` و`"version":"1.0.0-phase5"`.
إن ظهرت صفحة Cloudflare 502/1033 أو خطأ ← الخادم غير مشغّل أو الرابط انتهى.
