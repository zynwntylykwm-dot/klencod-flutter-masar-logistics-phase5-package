# ============================================================================
#  Dockerfile — خادم «المسار العالمي اللوجستي» (جاهز للسحابة)
#  ---------------------------------------------------------------------------
#  • الخادم بلا أي حزم خارجية (Node 20 فقط) → الصورة خفيفة وسريعة البناء.
#  • يستمع على 0.0.0.0 ويقرأ المنفذ من $PORT (Render / Railway / Fly / Koyeb).
#  • البيانات في /data — اربط قرصًا دائمًا (Persistent Disk / Volume) هناك.
#
#  بناء وتشغيل محليًا:
#    docker build -t masar-api .
#    docker run -p 8080:8080 -e ADMIN_PASSWORD='كلمة-قوية' -v masar-data:/data masar-api
# ============================================================================
FROM node:20-alpine

RUN apk add --no-cache tzdata curl tini dumb-init && \
    cp /usr/share/zoneinfo/Asia/Aden /etc/localtime && echo "Asia/Aden" > /etc/timezone

WORKDIR /app

# نسخ الكود فقط (لا node_modules ولا بيانات محلية)
COPY package.json ./
COPY server ./server
COPY app ./app

# مستخدم غير جذري + مجلد بيانات
RUN mkdir -p /data && addgroup -S masar && adduser -S masar -G masar && \
    chown -R masar:masar /app /data
USER masar

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TZ=Asia/Aden

EXPOSE 8080
VOLUME ["/data"]

# فحص الصحة المعتمد من منصّات الاستضافة
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/server.js"]
