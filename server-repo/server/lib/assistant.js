/**
 * assistant.js — المساعد الذكي الحقيقي (المرحلة 5)
 * -------------------------------------------------
 * المبدأ: لا ادّعاء ذكاء اصطناعي بلا ذكاء اصطناعي.
 *
 * طبقتان:
 *   1) model  — استدعاء HTTP حقيقي لمزوّد LLM (OpenAI / متوافق مع OpenAI / Anthropic /
 *               Google Gemini / Ollama محلي) عند توفّر المفتاح في البيئة أو في الإعدادات.
 *   2) rules  — محرّك قواعد مُسنَد إلى بيانات حقيقية من قاعدة البيانات (شحنات المستخدم،
 *               رصيده، المزادات، قواعد التسعير، قاعدة أسئلة شائعة يديرها المدير).
 *
 * أي إجابة تُرجع دائمًا: engine ('model' | 'rules')، provider، grounded، sources[]
 * وحقل reason صريح عند غياب المزوّد — بلا أي تمويه.
 */
'use strict';
const crypto = require('crypto');
const { db, audit } = require('./store');
const wallet = require('./wallet');
const pricing = require('./pricing');

const nowIso = () => new Date().toISOString();
const ROLE_LABEL = {
  user: 'مستخدم', agent: 'وكيل', support_staff: 'دعم فني', shipping_staff: 'موظف شحن',
  branch_manager: 'مدير فرع', warehouse_manager: 'مدير مستودع', super_admin: 'مدير عام'
};
const STATUS_LABEL = {
  pending: 'بانتظار الشحن', processing: 'قيد التجهيز', shipped: 'تم الشحن',
  in_transit: 'في الطريق', customs: 'في الجمارك', arrived: 'وصلت',
  out_for_delivery: 'قيد التوصيل', delivered: 'تم التسليم', delayed: 'متأخرة', cancelled: 'ملغاة'
};
const SERVICE_LABEL = { air: 'جوي', sea: 'بحري', land: 'بري' };

// ============================ المزوّدون ============================
const PROVIDERS = [
  {
    id: 'openai', name: 'OpenAI', kind: 'openai', env: 'AI_API_KEY', altEnv: ['OPENAI_API_KEY'],
    baseEnv: 'AI_BASE_URL', defaultBase: 'https://api.openai.com/v1', modelEnv: 'AI_MODEL', defaultModel: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openrouter', name: 'OpenRouter (متوافق مع OpenAI)', kind: 'openai', env: 'OPENROUTER_API_KEY',
    baseEnv: null, defaultBase: 'https://openrouter.ai/api/v1', modelEnv: 'OPENROUTER_MODEL', defaultModel: 'openai/gpt-4o-mini',
    docs: 'https://openrouter.ai/keys'
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', env: 'ANTHROPIC_API_KEY',
    baseEnv: null, defaultBase: 'https://api.anthropic.com/v1', modelEnv: 'ANTHROPIC_MODEL', defaultModel: 'claude-3-5-sonnet-latest',
    docs: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'gemini', name: 'Google Gemini', kind: 'gemini', env: 'GEMINI_API_KEY', altEnv: ['GOOGLE_API_KEY'],
    baseEnv: null, defaultBase: 'https://generativelanguage.googleapis.com/v1beta', modelEnv: 'GEMINI_MODEL', defaultModel: 'gemini-1.5-flash',
    docs: 'https://aistudio.google.com/app/apikey'
  },
  {
    id: 'ollama', name: 'Ollama (نموذج محلي)', kind: 'ollama', env: 'OLLAMA_HOST',
    baseEnv: null, defaultBase: 'http://127.0.0.1:11434', modelEnv: 'OLLAMA_MODEL', defaultModel: 'llama3.1',
    docs: 'https://ollama.com — يعمل محليًا بلا مفاتيح ولا إنترنت'
  }
];

const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const envVal = (p) => {
  const keys = [p.env, ...(p.altEnv || [])];
  for (const k of keys) if (k && process.env[k]) return process.env[k];
  return null;
};
const modelFor = (p) => process.env[p.modelEnv] || p.defaultModel;
const baseFor = (p) => (process.env[p.baseEnv] || p.defaultBase || '').replace(/\/$/, '');

function settings() {
  const s = db.settings.all() || {};
  return s.assistant || {};
}
function saveSettings(patch, actor) {
  const all = db.settings.all() || {};
  const cur = all.assistant || {};
  const next = { ...cur, ...patch };
  // تحقق
  if (next.daily_limit !== undefined) {
    const n = Number(next.daily_limit);
    if (!Number.isFinite(n) || n < 1 || n > 1000) throw Object.assign(new Error('الحد اليومي بين 1 و1000'), { status: 400 });
    next.daily_limit = Math.round(n);
  }
  if (next.temperature !== undefined) {
    const t = Number(next.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) throw Object.assign(new Error('الحرارة بين 0 و1'), { status: 400 });
    next.temperature = t;
  }
  if (next.max_tokens !== undefined) {
    const n = Number(next.max_tokens);
    if (!Number.isFinite(n) || n < 64 || n > 4096) throw Object.assign(new Error('أقصى عدد رموز بين 64 و4096'), { status: 400 });
    next.max_tokens = Math.round(n);
  }
  if (next.provider && !['auto', 'rules', ...PROVIDERS.map((p) => p.id)].includes(next.provider)) {
    throw Object.assign(new Error('مزوّد غير معروف'), { status: 400 });
  }
  if (next.system_prompt && String(next.system_prompt).length > 2000) throw Object.assign(new Error('التعليمات أطول من 2000 حرف'), { status: 400 });
  all.assistant = next;
  all.updated_at = nowIso();
  db.settings.replaceAll(all);
  audit(actor, 'assistant_settings_update', 'settings', 'assistant', { details: patch });
  return next;
}

/** حالة المزوّدين بصراحة: ready + سبب */
function status() {
  const s = settings();
  const providers = PROVIDERS.map((p) => {
    const key = envVal(p);
    const ready = !!key;
    return {
      id: p.id, name: p.name, kind: p.kind, ready,
      env: p.env, alt_env: p.altEnv || [], docs: p.docs,
      model: modelFor(p),
      base_url: p.id === 'openai' || p.id === 'ollama' ? baseFor(p) : null,
      note: ready ? `مفعّل عبر ${p.env}` : `غير مهيّأ: أضف ${p.env} في بيئة الخادم`
    };
  });
  const forced = s.provider && s.provider !== 'auto' ? s.provider : null;
  let active = null;
  if (forced === 'rules') active = 'rules';
  else if (forced && PROVIDER_BY_ID[forced] && envVal(PROVIDER_BY_ID[forced])) active = forced;
  else {
    const detected = providers.find((p) => p.ready);
    active = detected ? detected.id : 'rules';
  }
  const aiReady = active !== 'rules';
  return {
    engine: aiReady ? 'model' : 'rules',
    active,
    active_name: aiReady ? PROVIDER_BY_ID[active].name : 'محرّك قواعد مبني على بياناتك',
    ai_ready: aiReady,
    providers,
    enabled: s.enabled !== false,
    settings: {
      provider: s.provider || 'auto',
      daily_limit: s.daily_limit ?? 40,
      temperature: s.temperature ?? 0.3,
      max_tokens: s.max_tokens ?? 500,
      system_prompt: s.system_prompt || ''
    },
    reason: aiReady
      ? null
      : 'لا يوجد مفتاح LLM في بيئة الخادم — الإجابات تأتي من محرّك القواعد المبني على بياناتك الحقيقية، وليست من نموذج ذكاء اصطناعي.',
    honest_note: 'المساعد لا يخترع بيانات: كل رقم يخصّ الشحنات أو الرصيد أو الأسعار يُقرأ من قاعدة البيانات.'
  };
}

// ============================ السياق المُسنَد ============================
function userShipments(user, limit = 5) {
  return db.shipments
    .find((s) => s.user_id === user.id || s.created_by === user.id || String(s.receiverPhone || '') === String(user.phone || '\u0000'))
    .slice(-limit)
    .reverse();
}

function context(user) {
  const ships = userShipments(user, 8);
  const bal = wallet.balance(user.id);
  const auctionsOpen = db.auctions.find((a) => a.status === 'live' || a.status === 'active').length;
  const myBids = db.bids.find((b) => b.user_id === user.id).length;
  return {
    user: { id: user.id, name: user.fullName, role: user.role, role_label: ROLE_LABEL[user.role] || user.role },
    wallet: { available: bal.available_cents / 100, held: bal.held_cents / 100, currency: bal.currency || 'USD' },
    shipments: ships.map((s) => ({
      tracking: s.trackingNumber, status: s.status, status_label: STATUS_LABEL[s.status] || s.status,
      from: [s.source, s.sourceCity].filter(Boolean).join(' — '),
      dest: s.destPort || s.destination || null,
      location: s.currentLocation || null,
      progress: s.progress ?? null,
      remaining: s.remaining ?? null,
      cost: s.shippingCost ?? null,
      demo: !!s.demo
    })),
    shipments_total: db.shipments.find((s) => s.user_id === user.id || s.created_by === user.id).length,
    auctions_open: auctionsOpen,
    my_bids: myBids,
    faq: db.assistant_faq.find((f) => f.active !== false).length
  };
}

// ============================ قاعدة الأسئلة الشائعة ============================
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const STOP = new Set(['من', 'في', 'على', 'عن', 'ما', 'هل', 'هو', 'هي', 'الى', 'إلى', 'او', 'أو', 'و', 'the', 'a', 'is', 'what']);

function tokens(s) {
  return norm(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t));
}

function searchFaq(question, limit = 3) {
  const q = tokens(question);
  if (!q.length) return [];
  const scored = [];
  for (const f of db.assistant_faq.find((x) => x.active !== false)) {
    const kws = tokens([f.question, f.answer, (f.keywords || []).join(' ')].join(' '));
    const set = new Set(kws);
    let score = 0; let hits = 0;
    for (const t of q) {
      if (set.has(t)) { score += 2; hits++; }
      else if (kws.some((k) => k.length > 3 && (k.startsWith(t) || t.startsWith(k)))) { score += 1; hits++; }
    }
    if (score > 0) scored.push({ score, hits, item: f });
  }
  scored.sort((a, b) => b.score - a.score || b.hits - a.hits || String(a.item.question).localeCompare(String(b.item.question)));
  return scored.slice(0, limit);
}

function seedFaq() {
  if (db.assistant_faq.all().length) return 0;
  const rows = [
    { question: 'كيف أتتبع شحنتي؟', answer: 'أرسل لي رقم التتبّع (مثال: HDTA6351661) أو افتح صفحة «تتبع الشحنة». التتبّع يعرض الحالة والموقع الحالي ونسبة التقدّم، ويمكن للموظف إضافة تحديثات من لوحة الإدارة ← الشحن والتتبّع.', keywords: ['تتبع', 'شحنة', 'رقم', 'تتبع الشحنة', 'وين'] },
    { question: 'كيف تُحسب تكلفة الشحن؟', answer: 'تُحسب آليًا على الخادم من قواعد التسعير: رسم ثابت + سعر الكيلو × الوزن + سعر المتر المكعّب × الحجم، ثم تُطبَّق نسب الزيادة أو الخصم والحد الأدنى للقيمة. أرسل لي الوزن ونوع الخدمة (جوي/بحري/بري) لأعطيك اقتباسًا فوريًا من نفس المحرّك.', keywords: ['سعر', 'تكلفة', 'كم', 'تسعير', 'حاسبة', 'الشحن'] },
    { question: 'ما الفرق بين الشحن الجوي والبحري؟', answer: 'الجوي أسرع وأغلى (مناسب للشحنات الصغيرة والعاجلة)، والبحري أرخص وأبطأ (مناسب للحاويات والأحجام الكبيرة). القاعدة تُختار تلقائيًا حسب نوع الخدمة والوزن في محرّك التسعير.', keywords: ['جوي', 'بحري', 'بري', 'فرق', 'حاوية'] },
    { question: 'كيف أشحن سيارة من المزاد؟', answer: 'اختر المزاد، ثم أنشئ طلب شحن بري أو بحري حسب الموقع. النظام يدعم مزادات السيارات ويعرض الشحنات المرتبطة بها في صفحة المزادات، مع بوابة دفع محفوظة في المحفظة (الضمان) للمزايدة.', keywords: ['سيارة', 'مزاد', 'شحن سيارة', 'مركبة'] },
    { question: 'كيف تعمل المحفظة الإلكترونية؟', answer: 'المحفظة تعمل بالسنت داخليًا: إيداع، حجز مؤقت للمزايدة (ضمان)، ثم تسوية. يمكنك رؤية الرصيد المتاح والمحجوز وكشف الحركات من صفحة المحفظة. المدفوعات الحقيقية تحتاج ربط بوابة دفع (غير موصولة بعد).', keywords: ['محفظة', 'رصيد', 'ضمان', 'ايداع', 'دفع'] },
    { question: 'ما المستندات المطلوبة للتخليص الجمركي؟', answer: 'عادةً: الفاتورة التجارية، بوليصة الشحن، قائمة التعبئة، وشهادة المنشأ، وقد تُطلب تصاريح إضافية حسب نوع البضاعة (أدوية، أجهزة طبية، مركبات). موظف الشحن يرفع المستندات مع الشحنة.', keywords: ['مستند', 'جمارك', 'تخليص', 'فاتورة', 'بوليصة', 'شهادة'] },
    { question: 'ما هي أوقات العمل وكيف أتواصل مع الدعم؟', answer: 'فريق الدعم يرد في صفحة «الدعم الفني»، ويمكنك إرسال تذكرة من هناك. لأي حالة عاجلة اكتب لي «موظف» وسأحوّلك لمسار الدعم البشري.', keywords: ['دعم', 'تواصل', 'وقت', 'عمل', 'شكوى', 'موظف'] },
    { question: 'هل بياناتي آمنة؟', answer: 'نعم: كلمات المرور مُشفّرة بـ scrypt، والجلسات برموز موقّعة يمكن إبطالها، والصلاحيات مفروضة على الخادم. المساعد لا يرسل رقمك السري ولا كلمة المرور إلى مزوّد الذكاء الاصطناعي؛ يرسل فقط ملخصًا لازمًا للإجابة.', keywords: ['امان', 'خصوصية', 'بيانات', 'سري'] }
  ];
  for (const r of rows) db.assistant_faq.insert({ id: crypto.randomUUID(), active: true, created_at: nowIso(), ...r });
  return rows.length;
}

// ============================ استخراج النيّة (محرّك القواعد) ============================
function extractTracking(msg) {
  const up = String(msg).toUpperCase();
  // 1) الشكل الشائع: حروف ثم أرقام (HDTA6351661 / DHL1234567890)
  let m = up.match(/\b[A-Z]{2,4}\d{5,}[A-Z]{0,2}\b/);
  if (m) return m[0];
  // 2) مركّب: حروف وأرقام متبادلة بطول 8+ ويحتوي رقمًا (P5T1234567)
  m = up.match(/\b(?=[A-Z0-9]{8,}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{2,}[A-Z0-9]{6,}\b/);
  return m ? m[0] : null;
}
function extractWeight(msg) {
  const m = String(msg).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:كجم|كيلو|كغ|kg|كيلوجرام)/i);
  if (m) return Number(m[1]);
  const m2 = String(msg).replace(/,/g, '').match(/(?:وزن|زنة)\D{0,6}(\d+(?:\.\d+)?)/i);
  return m2 ? Number(m2[1]) : null;
}
function extractService(msg) {
  const s = norm(msg);
  if (/جوي|طيران|air/.test(s)) return 'air';
  if (/بحري|حاويه|باخره|sea|حاويات/.test(s)) return 'sea';
  if (/بري|شاحنه|truck|land/.test(s)) return 'land';
  return null;
}
const CBM_RE = /(\d+(?:\.\d+)?)\s*(?:م3|متر مكعب|m3|cbm)/i;

function fmtMoney(v, cur = 'USD') { return `${(Math.round(Number(v) * 100) / 100).toLocaleString('en-US')}$`; }

/** إجابة محرّك القواعد — كل رقم فيها مقروء من قاعدة البيانات */
function rulesReply(message, user, ctx) {
  const msg = String(message || '');
  const s = norm(msg);
  const out = (text, sources = [], intent = 'general') => ({ text, sources, intent });

  if (db.assistant_faq.all().length === 0) seedFaq();

  // 1) تحية
  if (/^(السلام|مرحبا|مرحبتين|اهلا|هلا|هاي|صباح|مساء|hi|hello)/.test(s) && s.length < 40) {
    return out(`مرحبًا ${ctx.user.name} 👋\nأنا المساعد الذكي للمسار العالمي اللوجستي. تكلّم معي طبيعيًا، مثل:\n• «وين شحنتي HDTA6351661؟»\n• «كم تكلفة 20 كجم جوي؟»\n• «كم رصيدي في المحفظة؟»`, [], 'greeting');
  }

  // 2) طلب موظف بشري
  if (/موظف|بشري|انسان|تحدث مع|شكوى|تذكره دعم/.test(s)) {
    return out('تمام — يمكنك فتح «الدعم الفني» من القائمة وإرسال تذكرة، وسيصل تنبيه لفريق الدعم داخل النظام.\n' +
      'وللحالات العاجلة: اذكر رقم الشحنة في التذكرة ليراجعها موظف الشحن فورًا.', [{ type: 'route', ref: 'support' }], 'handoff');
  }

  // 3) تتبّع شحنة — بيانات حقيقية
  const tn = extractTracking(msg);
  if (tn || /تتبع|شحنتي|وين شحنت|حاله الشحنه|وصلت|تاخرت|متى توصل/.test(s)) {
    if (tn) {
      const sh = db.shipments.findOne((x) => String(x.trackingNumber || '').toUpperCase() === tn);
      if (!sh) {
        return out(`لم أجد شحنة برقم التتبّع «${tn}» في النظام.\nتأكّد من الرقم (حروف وأرقام)، أو أرسل لي اسم المستلم. عدد شحناتك المسجّلة: ${ctx.shipments_total}.`,
          [], 'tracking_not_found');
      }
      const mine = sh.user_id === user.id || sh.created_by === user.id;
      if (!mine && !['support_staff', 'shipping_staff', 'branch_manager', 'warehouse_manager', 'super_admin'].includes(user.role)) {
        return out(`الشحنة «${tn}» مسجّلة في النظام لكنها ليست ضمن حسابك، ولا أستطيع عرض بيانات شحنة عميل آخر.\nيمكنك سؤالي عن شحناتك: ${ctx.shipments_total} شحنة.`,
          [{ type: 'shipment', ref: tn }], 'tracking_forbidden');
      }
      const lines = [
        `📦 الشحنة ${sh.trackingNumber}`,
        `• الحالة: ${STATUS_LABEL[sh.status] || sh.status}${sh.progress !== undefined && sh.progress !== null ? ` (${sh.progress}%)` : ''}`,
        sh.currentLocation ? `• الموقع الحالي: ${sh.currentLocation}` : null,
        (sh.source || sh.destPort) ? `• المسار: ${[sh.source, sh.sourceCity].filter(Boolean).join(' — ') || '؟'} ← ${sh.destPort || '؟'}` : null,
        sh.remaining ? `• المتبقي على الشحنة: ${fmtMoney(sh.remaining)}` : null,
        sh.goodsType ? `• نوع البضاعة: ${sh.goodsType}` : null,
        sh.demo ? '• (شحنة تجريبية من بيانات النظام السابق)' : null
      ].filter(Boolean);
      return out(lines.join('\n'), [{ type: 'shipment', ref: sh.trackingNumber }], 'tracking');
    }
    if (!ctx.shipments.length) {
      return out('لا توجد شحنات مسجّلة على حسابك حتى الآن.\nأضف شحنة من صفحة «إضافة شحنة»، أو أرسل رقم التتبّع إن كان لديك.', [], 'tracking_empty');
    }
    const list = ctx.shipments.slice(0, 5).map((x) => `• ${x.tracking} — ${x.status_label}${x.location ? ` — ${x.location}` : ''}`);
    return out(`شحناتك الأخيرة (${ctx.shipments_total} إجمالًا):\n${list.join('\n')}\n\nأرسل رقم التتبّع لتفاصيل كاملة.`,
      ctx.shipments.slice(0, 5).map((x) => ({ type: 'shipment', ref: x.tracking })), 'tracking_list');
  }

  // 4) تسعير — من محرّك التسعير الحقيقي
  const weight = extractWeight(msg);
  const service = extractService(msg);
  const cbm = (msg.match(CBM_RE) || [])[1];
  if (weight || cbm || /سعر|تسعير|تكلفه|اقتباس|كم يكلف|حاسبه/.test(s)) {
    if (!weight && !cbm) {
      return out('أعطني الوزن (كجم) ونوع الخدمة لأحسب لك السعر فورًا من محرّك التسعير، أمثلة:\n• «20 كجم جوي»\n• «حاوية بحري 5 م3»\n• «بري 200 كجم»', [], 'pricing_need_input');
    }
    const q = pricing.quote({
      service: service || (cbm && !weight ? 'sea' : undefined),
      weight_kg: weight || 0,
      volume_cbm: cbm ? Number(cbm) : 0,
      client_role: user.role
    });
    if (!q.matched) {
      return out(`لا توجد قاعدة تسعير مطابقة لهذه الحالة (${q.reason || 'لا قاعدة'}).\nجرّب تحديد نوع الخدمة (جوي/بحري/بري) أو عدّل القواعد من لوحة الإدارة ← التسعير.`, [], 'pricing_no_rule');
    }
    const b = q.breakdown;
    const parts = [`💰 اقتباس من محرّك التسعير — القاعدة: «${q.rule.name}»`];
    parts.push(`• رسم ثابت: ${fmtMoney(b.base_fee)}`);
    if (b.weight_kg) parts.push(`• الوزن: ${b.weight_kg} كجم × ${fmtMoney(b.per_kg)} = ${fmtMoney(b.weight_cost)}`);
    if (b.volume_cbm) parts.push(`• الحجم: ${b.volume_cbm} م³ × ${fmtMoney(b.per_cbm)} = ${fmtMoney(b.volume_cost)}`);
    parts.push(`• المجموع قبل التعديلات: ${fmtMoney(b.subtotal)}`);
    if (b.surcharge) parts.push(`• زيادة ${b.surcharge_pct}%: +${fmtMoney(b.surcharge)}`);
    if (b.discount) parts.push(`• خصم ${b.discount_pct}%: −${fmtMoney(b.discount)}`);
    if (b.min_applied) parts.push(`• طُبِّق الحد الأدنى للقيمة (${fmtMoney(b.min_charge)})`);
    parts.push(`\nالإجمالي: ${fmtMoney(q.total)}`);
    parts.push('(تقدير شحن فقط — لا يشمل الرسوم الجمركية أو الأرضيات.)');
    return out(parts.join('\n'), [{ type: 'pricing_rule', ref: q.rule.id }], 'pricing');
  }

  // 5) المحفظة
  if (/محفظه|رصيد|فلوس|ضمان|ايداع|دفع/.test(s)) {
    return out(`💳 محفظتك:\n• المتاح: ${fmtMoney(ctx.wallet.available, ctx.wallet.currency)}\n• المحجوز (ضمان): ${fmtMoney(ctx.wallet.held, ctx.wallet.currency)}\n\nكشف الحركات من صفحة «المحفظة». المدفوعات الحقيقية تحتاج ربط بوابة دفع، وهي غير موصولة بعد.`,
      [{ type: 'wallet', ref: user.id }], 'wallet');
  }

  // 6) المزادات
  if (/مزاد|مزايده|سياره|مركبه|bid/.test(s)) {
    return out(`🚗 المزادات: هناك ${ctx.auctions_open} مزادًا مفتوحًا الآن، ومشاركاتك ${ctx.my_bids} مزايدة.\nالمزايدة تحتاج رصيدًا متاحًا في المحفظة لتُحجز قيمة الضمان. تفاصيل المزادات من صفحة «المزادات».`,
      [{ type: 'auctions', ref: 'open' }], 'auctions');
  }

  // 7) قاعدة الأسئلة الشائعة
  const faq = searchFaq(msg);
  const confident = faq.length && faq[0].score >= 5 && (faq[0].hits || 0) >= 2;
  if (confident) {
    const best = faq[0].item;
    const more = faq.slice(1).map((f) => `• ${f.item.question}`).join('\n');
    return out(`${best.answer}${more ? `\n\nقد يفيدك أيضًا:\n${more}` : ''}`,
      [{ type: 'faq', ref: best.id }], 'faq');
  }

  // 8) صدق عند عدم المعرفة
  if (faq.length && faq[0].score >= 3) {
    return out(`${faq[0].item.answer}\n\n(إن لم يكن هذا جوابك، وضّح سؤالك أو اكتب «موظف» لتحويلك للدعم.)`,
      [{ type: 'faq', ref: faq[0].item.id }], 'faq_partial');
  }
  return out(`لا أستطيع الإجابة عن هذا السؤال بثقة، ولن أخترع معلومة.\nيمكنني الآن:\n• تتبّع شحنة برقمها\n• حساب تكلفة شحن من محرّك التسعير\n• عرض رصيد المحفظة والمزادات\n• الإجابة عن الأسئلة الشائعة التي يعتمدها فريقك\n\nاكتب «موظف» للتحويل إلى الدعم البشري.`,
    [], 'unknown');
}

// ============================ استدعاء النموذج (HTTP حقيقي) ============================
function systemPrompt(user, ctx, extra) {
  const facts = [
    `اسم المستخدم: ${ctx.user.name} (الدور: ${ctx.user.role_label})`,
    `عدد شحناته: ${ctx.shipments_total}`,
    ctx.shipments.length
      ? 'شحناته الأخيرة:\n' + ctx.shipments.map((s) => `- ${s.tracking}: ${s.status_label}${s.location ? `، الموقع ${s.location}` : ''}${s.progress !== null ? `، التقدّم ${s.progress}%` : ''}${s.remaining !== null ? `، المتبقي ${s.remaining}$` : ''}${s.demo ? ' (تجريبية)' : ''}`).join('\n')
      : 'لا شحنات مسجّلة على حسابه.',
    `رصيد المحفظة: متاح ${ctx.wallet.available}${ctx.wallet.currency}، محجوز ${ctx.wallet.held}${ctx.wallet.currency}`,
    `مزادات مفتوحة: ${ctx.auctions_open} — مزايداته: ${ctx.my_bids}`,
    'قواعد التسعير متاحة عبر محرّك التسعير في النظام عند ذكر الوزن/الخدمة.'
  ].join('\n');

  return [
    'أنت «المساعد الذكي» لنظام المسار العالمي اللوجستي (شركة شحن يمنية: عدن، صنعاء، إب).',
    'أجب بالعربية الفصيحة المبسّطة، بإيجاز (٤ أسطر أو أقل إلا عند الطلب)، وبنبرة مهنية ودودة.',
    'قواعد صارمة:',
    '1) استخدم فقط «البيانات المتاحة» أدناه أو معلومات عامة موثوقة عن الشحن والتخليص.',
    '2) لا تخترع أرقام شحنات أو أرصدة أو أسعارًا أو مواعيد. إن لم تتوفر المعلومة قل ذلك بصراحة واقترح البديل.',
    '3) لا تطلب كلمة المرور أو الرقم السري أو أي بيانات دفع، ولا تعرض بيانات عميل آخر.',
    '4) الأسعار تُحسب حصريًا عبر محرّك التسعير في النظام؛ إن احتجت سعرًا اطلب الوزن ونوع الخدمة.',
    '5) إن طلب المستخدم موظفًا بشريًا أو كانت المشكلة شكوى، وجّهه إلى «الدعم الفني».',
    '6) لا تدّعِ إجراءً نفّذته (لم تُنشئ شحنة ولا حوّلت مالًا). أنت تُجيب وتُرشد فقط.',
    extra ? `تعليمات إضافية من إدارة الشركة: ${extra}` : '',
    '',
    '=== البيانات المتاحة (حقيقية من قاعدة البيانات) ===',
    facts
  ].filter(Boolean).join('\n');
}

async function httpJson(url, options, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.error?.message || data.error || data.message)) || `HTTP ${res.status}`;
      throw Object.assign(new Error(String(msg).slice(0, 300)), { status: 502, http: res.status, payload: data });
    }
    return data;
  } finally { clearTimeout(t); }
}

/** استدعاء مزوّد حقيقي — يُرجع {text, usage, model} */
async function callProvider(providerId, { system, history, message, temperature, maxTokens }) {
  const p = PROVIDER_BY_ID[providerId];
  if (!p) throw Object.assign(new Error('مزوّد غير معروف'), { status: 400 });
  const key = envVal(p);
  if (!key) throw Object.assign(new Error(`المزوّد ${p.name} غير مهيّأ (${p.env})`), { status: 503 });
  const model = modelFor(p);

  if (p.kind === 'openai') {
    const data = await httpJson(`${baseFor(p)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })), { role: 'user', content: message }]
      })
    });
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw Object.assign(new Error('استجابة فارغة من المزوّد'), { status: 502 });
    return { text, model: data.model || model, usage: { input: data.usage?.prompt_tokens ?? null, output: data.usage?.completion_tokens ?? null }, raw_provider: p.id };
  }

  if (p.kind === 'anthropic') {
    const data = await httpJson(`${baseFor(p)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature, system,
        messages: [...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })), { role: 'user', content: message }]
      })
    });
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (!text) throw Object.assign(new Error('استجابة فارغة من المزوّد'), { status: 502 });
    return { text, model: data.model || model, usage: { input: data.usage?.input_tokens ?? null, output: data.usage?.output_tokens ?? null }, raw_provider: p.id };
  }

  if (p.kind === 'gemini') {
    const contents = [
      ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: message }] }
    ];
    const data = await httpJson(`${baseFor(p)}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature, maxOutputTokens: maxTokens } })
    });
    const text = (data.candidates?.[0]?.content?.parts || []).map((x) => x.text).filter(Boolean).join('\n').trim();
    if (!text) throw Object.assign(new Error('استجابة فارغة من المزوّد'), { status: 502 });
    return { text, model, usage: { input: data.usageMetadata?.promptTokenCount ?? null, output: data.usageMetadata?.candidatesTokenCount ?? null }, raw_provider: p.id };
  }

  if (p.kind === 'ollama') {
    const data = await httpJson(`${baseFor(p)}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, options: { temperature, num_predict: maxTokens },
        messages: [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })), { role: 'user', content: message }]
      })
    });
    const text = data.message?.content;
    if (!text) throw Object.assign(new Error('استجابة فارغة من المزوّد'), { status: 502 });
    return { text, model: data.model || model, usage: { input: data.prompt_eval_count ?? null, output: data.eval_count ?? null }, raw_provider: p.id };
  }

  throw Object.assign(new Error('نوع مزوّد غير مدعوم'), { status: 400 });
}

// ============================ المحادثات ============================
function getOrCreateConversation(user, conversationId, title) {
  if (conversationId) {
    const c = db.assistant_conversations.byId(conversationId);
    if (!c) throw Object.assign(new Error('المحادثة غير موجودة'), { status: 404 });
    if (c.user_id !== user.id) throw Object.assign(new Error('لا تملك هذه المحادثة'), { status: 403 });
    return c;
  }
  return db.assistant_conversations.insert({
    id: crypto.randomUUID(), user_id: user.id,
    title: String(title || 'محادثة جديدة').slice(0, 80),
    engine: null, provider: null, messages: 0,
    created_at: nowIso(), updated_at: nowIso()
  });
}

function historyFor(conversationId, limit = 8) {
  return db.assistant_messages
    .find((m) => m.conversation_id === conversationId)
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }));
}

function todayKey() { return nowIso().slice(0, 10); }

function usageToday(userId) {
  const day = todayKey();
  return db.assistant_messages.find((m) => m.user_id === userId && m.role === 'user' && String(m.created_at).slice(0, 10) === day).length;
}

/**
 * الدالة الرئيسية: chat
 * @returns {Promise<{reply, engine, provider, model, grounded, sources, conversation_id, usage, degraded, reason}>}
 */
async function chat({ user, message, conversation_id = null, channel = 'web' }) {
  const st = status();
  const s = settings();
  const text = String(message || '').trim();
  if (!text) throw Object.assign(new Error('الرسالة فارغة'), { status: 400 });
  if (text.length > 2000) throw Object.assign(new Error('الرسالة أطول من 2000 حرف'), { status: 400 });
  if (st.enabled === false) throw Object.assign(new Error('المساعد الذكي معطّل من الإدارة'), { status: 503 });

  // الحصة اليومية
  const limit = Number(s.daily_limit ?? 40);
  const used = usageToday(user.id);
  if (used >= limit) {
    throw Object.assign(new Error(`بلغت الحد اليومي (${limit} رسالة). جرّب غدًا أو تواصل مع الدعم.`), { status: 429, quota: { limit, used } });
  }

  const conv = getOrCreateConversation(user, conversation_id, text.slice(0, 60));
  const ctx = context(user);
  const history = historyFor(conv.id);
  const t0 = Date.now();

  let reply = null; let engine = 'rules'; let provider = 'rules'; let model = null;
  let usage = { input: null, output: null }; let degraded = false; let reason = null; let sources = [];

  if (st.ai_ready) {
    try {
      const r = await callProvider(st.active, {
        system: systemPrompt(user, ctx, s.system_prompt),
        history, message: text,
        temperature: s.temperature ?? 0.3, maxTokens: s.max_tokens ?? 500
      });
      reply = r.text.trim();
      engine = 'model'; provider = r.raw_provider; model = r.model; usage = r.usage;
      sources = [{ type: 'user_context', ref: user.id }];
    } catch (e) {
      degraded = true;
      reason = `تعذّر الوصول إلى المزوّد (${st.active}): ${e.message} — تمت الإجابة بمحرّك القواعد المحلي.`;
      console.error('[assistant] فشل المزوّد:', e.message);
    }
  } else {
    reason = st.reason;
  }

  let intent = null;
  if (!reply) {
    const r = rulesReply(text, user, ctx);
    reply = r.text; intent = r.intent; sources = r.sources.concat([{ type: 'user_context', ref: user.id }]);
    engine = 'rules'; provider = 'rules'; model = 'masar-rules-v1';
  }
  // إثراء: إن لم يذكر النموذج رقم الشحنة، أضف مصادر البيانات المستخدمة
  if (engine === 'model' && ctx.shipments.length) sources.push({ type: 'shipments_context', ref: String(ctx.shipments.length) });

  const latency = Date.now() - t0;
  db.assistant_messages.insert({
    id: crypto.randomUUID(), conversation_id: conv.id, user_id: user.id, channel,
    role: 'user', text, created_at: nowIso()
  });
  const assistantMsg = db.assistant_messages.insert({
    id: crypto.randomUUID(), conversation_id: conv.id, user_id: user.id, channel,
    role: 'assistant', text: reply, engine, provider, model, intent,
    grounded: sources.length > 0, sources, latency_ms: latency,
    tokens_in: usage.input, tokens_out: usage.output,
    degraded, reason, feedback: null, created_at: nowIso()
  });
  db.assistant_conversations.update(conv.id, {
    engine, provider, updated_at: nowIso(), messages: (conv.messages || 0) + 2
  });

  return {
    reply, engine, provider, model,
    message_id: assistantMsg.id,
    grounded: sources.length > 0, sources,
    intent, conversation_id: conv.id,
    latency_ms: latency, usage,
    degraded, reason,
    ai_ready: st.ai_ready,
    quota: { limit, used: used + 1, remaining: Math.max(0, limit - used - 1) }
  };
}

function feedback(messageId, value, user) {
  const m = db.assistant_messages.byId(messageId);
  if (!m) throw Object.assign(new Error('الرسالة غير موجودة'), { status: 404 });
  if (m.user_id !== user.id) throw Object.assign(new Error('لا تملك هذه الرسالة'), { status: 403 });
  if (!['up', 'down', null].includes(value)) throw Object.assign(new Error('قيمة تقييم غير صالحة'), { status: 400 });
  db.assistant_messages.update(messageId, { feedback: value });
  return { ok: true, id: messageId, feedback: value };
}

function myConversations(user, limit = 20) {
  return db.assistant_conversations
    .find((c) => c.user_id === user.id)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, limit)
    .map((c) => {
      const msgs = db.assistant_messages.find((m) => m.conversation_id === c.id);
      const last = msgs[msgs.length - 1];
      return { id: c.id, title: c.title, engine: c.engine, provider: c.provider, messages: msgs.length, updated_at: c.updated_at, preview: last ? String(last.text).slice(0, 120) : '' };
    });
}

function conversation(user, id, { isAdmin = false } = {}) {
  const c = db.assistant_conversations.byId(id);
  if (!c) throw Object.assign(new Error('المحادثة غير موجودة'), { status: 404 });
  if (c.user_id !== user.id && !isAdmin) throw Object.assign(new Error('لا تملك هذه المحادثة'), { status: 403 });
  return {
    id: c.id, user_id: c.user_id, title: c.title, engine: c.engine,
    messages: db.assistant_messages.find((m) => m.conversation_id === c.id).map((m) => ({
      id: m.id, role: m.role, text: m.text, engine: m.engine || null, model: m.model || null,
      intent: m.intent || null, sources: m.sources || [], latency_ms: m.latency_ms ?? null,
      feedback: m.feedback ?? null, created_at: m.created_at
    }))
  };
}

// ============================ الإحصاءات (إدارة) ============================
function stats({ days = 30 } = {}) {
  const since = Date.now() - days * 86400000;
  const msgs = db.assistant_messages.find((m) => m.role === 'assistant' && new Date(m.created_at).getTime() >= since);
  const users = db.assistant_messages.find((m) => m.role === 'user' && new Date(m.created_at).getTime() >= since);
  const byEngine = msgs.reduce((a, m) => { a[m.engine || 'rules'] = (a[m.engine || 'rules'] || 0) + 1; return a; }, {});
  const byIntent = msgs.reduce((a, m) => { if (m.intent) a[m.intent] = (a[m.intent] || 0) + 1; return a; }, {});
  const lat = msgs.map((m) => m.latency_ms).filter((x) => typeof x === 'number');
  const fb = msgs.filter((m) => m.feedback);
  const topQ = {};
  for (const m of users) {
    const k = String(m.text).trim().slice(0, 60);
    topQ[k] = (topQ[k] || 0) + 1;
  }
  const topQuestions = Object.entries(topQ).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([q, n]) => ({ q, n }));
  return {
    days,
    messages: msgs.length,
    questions: users.length,
    conversations: new Set(msgs.map((m) => m.conversation_id)).size,
    users: new Set(msgs.map((m) => m.user_id)).size,
    today: usageTodayAll(),
    by_engine: byEngine,
    by_intent: byIntent,
    degraded: msgs.filter((m) => m.degraded).length,
    grounded_rate: msgs.length ? Math.round((msgs.filter((m) => m.grounded).length / msgs.length) * 100) : 0,
    avg_latency_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    feedback: { up: fb.filter((m) => m.feedback === 'up').length, down: fb.filter((m) => m.feedback === 'down').length },
    tokens: {
      input: msgs.reduce((a, m) => a + (m.tokens_in || 0), 0),
      output: msgs.reduce((a, m) => a + (m.tokens_out || 0), 0)
    },
    top_questions: topQuestions,
    faq_count: db.assistant_faq.find((f) => f.active !== false).length
  };
}

function usageTodayAll() {
  const day = todayKey();
  return db.assistant_messages.find((m) => m.role === 'user' && String(m.created_at).slice(0, 10) === day).length;
}

function adminConversations({ page = 1, limit = 20, engine = null, q = null } = {}) {
  let rows = db.assistant_conversations.all().slice();
  if (engine) rows = rows.filter((c) => c.engine === engine);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((c) => String(c.title).toLowerCase().includes(s) || String(c.user_id).includes(s));
  }
  rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const total = rows.length;
  const from = (Math.max(1, page) - 1) * limit;
  return {
    total, page, limit,
    items: rows.slice(from, from + limit).map((c) => {
      const u = db.users.byId(c.user_id);
      const msgs = db.assistant_messages.find((m) => m.conversation_id === c.id);
      return {
        id: c.id, title: c.title, user: u ? u.fullName : 'مستخدم محذوف', user_role: u ? u.role : null,
        engine: c.engine, provider: c.provider, messages: msgs.length, updated_at: c.updated_at
      };
    })
  };
}

// ============================ الأسئلة الشائعة (إدارة) ============================
function listFaq({ q = null, active = null } = {}) {
  let rows = db.assistant_faq.all().slice();
  if (active !== null && active !== undefined) rows = rows.filter((f) => (f.active !== false) === (active === true || active === 'true'));
  if (q) {
    const t = tokens(q);
    rows = rows.filter((f) => {
      const hay = tokens([f.question, f.answer, (f.keywords || []).join(' ')].join(' '));
      return t.every((x) => hay.some((h) => h.includes(x) || x.includes(h)));
    });
  }
  return rows.sort((a, b) => String(a.question).localeCompare(String(b.question)));
}

function createFaq(payload, actor) {
  const question = String(payload.question || '').trim();
  const answer = String(payload.answer || '').trim();
  if (question.length < 5) throw Object.assign(new Error('السؤال قصير جدًا'), { status: 400 });
  if (answer.length < 10) throw Object.assign(new Error('الإجابة قصيرة جدًا'), { status: 400 });
  if (answer.length > 2000) throw Object.assign(new Error('الإجابة أطول من 2000 حرف'), { status: 400 });
  const kw = Array.isArray(payload.keywords) ? payload.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 12) : [];
  const doc = db.assistant_faq.insert({
    id: crypto.randomUUID(), question, answer, keywords: kw,
    active: payload.active !== false, created_by: actor.id, created_at: nowIso()
  });
  audit(actor, 'assistant_faq_create', 'assistant_faq', doc.id, { details: { question } });
  return doc;
}

function updateFaq(id, payload, actor) {
  const f = db.assistant_faq.byId(id);
  if (!f) throw Object.assign(new Error('السؤال غير موجود'), { status: 404 });
  const patch = {};
  if (payload.question !== undefined) {
    const q = String(payload.question).trim();
    if (q.length < 5) throw Object.assign(new Error('السؤال قصير جدًا'), { status: 400 });
    patch.question = q;
  }
  if (payload.answer !== undefined) {
    const a = String(payload.answer).trim();
    if (a.length < 10) throw Object.assign(new Error('الإجابة قصيرة جدًا'), { status: 400 });
    patch.answer = a.slice(0, 2000);
  }
  if (payload.keywords !== undefined) patch.keywords = (Array.isArray(payload.keywords) ? payload.keywords : []).map((k) => String(k).trim()).filter(Boolean).slice(0, 12);
  if (payload.active !== undefined) patch.active = !!payload.active;
  const out = db.assistant_faq.update(id, patch);
  audit(actor, 'assistant_faq_update', 'assistant_faq', id, { details: patch });
  return out;
}

function removeFaq(id, actor) {
  const f = db.assistant_faq.byId(id);
  if (!f) throw Object.assign(new Error('السؤال غير موجود'), { status: 404 });
  db.assistant_faq.remove(id);
  audit(actor, 'assistant_faq_delete', 'assistant_faq', id, { details: { question: f.question } });
  return { ok: true };
}

module.exports = {
  PROVIDERS, status, settings, saveSettings, context, chat, feedback,
  myConversations, conversation, stats, adminConversations,
  listFaq, createFaq, updateFaq, removeFaq, seedFaq,
  rulesReply, searchFaq, callProvider, usageToday,
  STATUS_LABEL, ROLE_LABEL, SERVICE_LABEL
};
