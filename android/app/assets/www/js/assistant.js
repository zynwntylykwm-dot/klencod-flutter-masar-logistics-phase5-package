/**
 * assistant.js — عميل المساعد الذكي في الواجهة (المرحلة 5)
 * --------------------------------------------------------
 * - يرسل الرسالة إلى الخادم (/api/assistant/chat) الذي يقرّر: نموذج LLM حقيقي
 *   إن كان المفتاح مضبوطًا، أو محرّك القواعد المُسنَد إلى بيانات المستخدم.
 * - يوضّح للمستخدم مصدر الإجابة (نموذج / محرّك قواعد) ولا يقدّم قواعد على أنها ذكاء اصطناعي.
 * - إذا كان الخادم غير متاح يعود إلى الإجابة المحلية القديمة داخل الصفحة (بلا تعطيل).
 * - يحفظ رقم المحادثة لاستئناف السياق، ويسمح بتقييم كل إجابة.
 */
(function () {
  'use strict';
  const LS_CONV = 'masar.assistant.conv';
  const BASE = (window.MASAR_API_BASE || '').replace(/\/$/, '');
  const getToken = () => localStorage.getItem('masar.access');

  const state = {
    conversationId: localStorage.getItem(LS_CONV) || null,
    lastEngine: null,
    lastMeta: null,
    status: null,
    busy: false
  };

  async function call(path, { method = 'GET', body = null } = {}) {
    const headers = { accept: 'application/json' };
    const token = getToken();
    if (token) headers.authorization = 'Bearer ' + token;
    if (body !== null) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data.error || 'فشل الطلب (' + res.status + ')');
      err.status = res.status; err.payload = data;
      throw err;
    }
    return data;
  }

  async function status() {
    try {
      // قبل تسجيل الدخول: معاينة عامة آمنة (بلا بيانات مستخدم)
      const path = getToken() ? '/api/assistant/status' : '/api/assistant/public';
      const d = await call(path);
      state.status = d.status;
      return d.status;
    }
    catch (_) { state.status = null; return null; }
  }

  async function chat(message) {
    const d = await call('/api/assistant/chat', { method: 'POST', body: { message, conversation_id: state.conversationId } });
    if (d.conversation_id) { state.conversationId = d.conversation_id; localStorage.setItem(LS_CONV, d.conversation_id); }
    state.lastEngine = d.engine; state.lastMeta = d;
    return d;
  }

  async function feedback(messageId, value) {
    return call('/api/assistant/feedback', { method: 'POST', body: { message_id: messageId, value } });
  }

  async function reset() {
    state.conversationId = null; localStorage.removeItem(LS_CONV);
  }

  /** وصف مختصر لمصدر الإجابة — يُعرض أسفل الرد */
  function engineLabel(meta) {
    if (!meta) return '';
    if (meta.degraded) return '⚠️ تعذّر الوصول إلى النموذج — أُجبت من محرّك القواعد المحلي';
    if (meta.engine === 'model') return `🤖 نموذج ${meta.provider}${meta.model ? ' · ' + meta.model : ''}`;
    return '📚 محرّك قواعد مُسنَد إلى بياناتك (لا يوجد مفتاح ذكاء اصطناعي بعد)';
  }

  window.MasarAssistant = { chat, status, feedback, reset, engineLabel, state };
})();
