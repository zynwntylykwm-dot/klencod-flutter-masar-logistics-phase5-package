# ============================================================================
# صورة الخادم الحقيقي — المسار العالمي اللوجستي (المرحلة 3)
# الخادم بلا أي تبعيات npm: الصورة لا تحتاج npm install إطلاقًا.
# ============================================================================
FROM node:20-alpine

# منطقة زمنية عربية افتراضية + أدوات فحص بسيطة
RUN apk add --no-cache tzdata curl tini && \
    cp /usr/share/zoneinfo/Asia/Aden /etc/localtime && echo "Asia/Aden" > /etc/timezone

WORKDIR /app

# نسخ الكود فقط (لا node_modules ولا بيانات)
COPY server ./server
COPY app ./app
COPY package.json ./

# مستخدم غير جذري + مجلد بيانات دائم
RUN mkdir -p /data && addgroup -S masar && adduser -S masar -G masar && \
    chown -R masar:masar /app /data
USER masar

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/server.js"]
