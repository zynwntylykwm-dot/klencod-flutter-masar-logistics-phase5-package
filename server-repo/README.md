# المسار العالمي اللوجستي — الخادم (Node.js)

خادم حقيقي بلا أي تبعيات npm (Node 20+): مصادقة scrypt، شحنات وتتبّع، مزادات، محفظة،
إشعارات (داخلي + SSE + Web Push/FCM/APNs)، تقارير مالية + CSV، تسعير بقواعد، سجل تدقيق، مساعد ذكي.
الواجهة تُخدَّم من `/`، وفحص الصحة من `/health`.

```bash
ADMIN_PASSWORD='كلمة-قوية' PORT=8080 DATA_DIR=./data node server/server.js
```

**النشر:** انظر `README-DEPLOY.md` (Render / Railway / Codespaces / Cloudflare Tunnel).
⚠️ اربط قرصًا دائمًا على `/data` وإلا ضاعت البيانات عند كل نشر.
