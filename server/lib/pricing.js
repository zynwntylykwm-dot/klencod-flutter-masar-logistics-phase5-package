/**
 * pricing.js — محرّك قواعد التسعير (المرحلة 4)
 * ---------------------------------------------
 * قواعد حقيقية تُخزَّن في قاعدة البيانات ويُحسب بها سعر الشحن على الخادم:
 *   match: المصدر/الوجهة/نوع الخدمة/نطاق الوزن/رتبة العميل
 *   rate : رسم ثابت + سعر الكيلو + سعر المتر المكعّب + حد أدنى + زيادة% + خصم%
 * الأسبقية: القاعدة الأكثر تخصيصًا أولًا، ثم الأولوية الرقمية.
 * كل الأسعار بالدولار مع حساب داخلي بالسنت (أعداد صحيحة).
 */
'use strict';
const crypto = require('crypto');
const { db, audit } = require('./store');

const toCents = (v) => Math.round(Number(v || 0) * 100);
const toMoney = (c) => Math.round(Number(c || 0)) / 100;
const nowIso = () => new Date().toISOString();
const SERVICES = ['air', 'sea', 'land'];
const SERVICE_LABEL = { air: 'جوي', sea: 'بحري', land: 'بري' };

function validate(payload) {
  const name = String(payload.name || '').trim();
  if (name.length < 3) throw Object.assign(new Error('اسم القاعدة قصير جدًا'), { status: 400 });
  const rate = payload.rate || {};
  const base = toCents(rate.base_fee);
  const perKg = toCents(rate.per_kg);
  const perCbm = toCents(rate.per_cbm);
  const minCharge = toCents(rate.min_charge);
  if (base < 0 || perKg < 0 || perCbm < 0 || minCharge < 0) throw Object.assign(new Error('لا تُقبل قيم سالبة'), { status: 400 });
  if (base === 0 && perKg === 0 && perCbm === 0) throw Object.assign(new Error('القاعدة بلا أي سعر — أدخل رسمًا أو سعر كيلو على الأقل'), { status: 400 });
  const surcharge = Number(rate.surcharge_pct || 0);
  const discount = Number(rate.discount_pct || 0);
  if (surcharge < 0 || surcharge > 100) throw Object.assign(new Error('نسبة الزيادة بين 0 و100'), { status: 400 });
  if (discount < 0 || discount > 100) throw Object.assign(new Error('نسبة الخصم بين 0 و100'), { status: 400 });
  const match = payload.match || {};
  if (match.service && !SERVICES.includes(match.service)) throw Object.assign(new Error('نوع خدمة غير معروف'), { status: 400 });
  const wMin = match.weight_min_kg === undefined || match.weight_min_kg === null || match.weight_min_kg === '' ? null : Number(match.weight_min_kg);
  const wMax = match.weight_max_kg === undefined || match.weight_max_kg === null || match.weight_max_kg === '' ? null : Number(match.weight_max_kg);
  if (wMin !== null && wMin < 0) throw Object.assign(new Error('الوزن الأدنى غير صالح'), { status: 400 });
  if (wMax !== null && wMin !== null && wMax < wMin) throw Object.assign(new Error('الوزن الأقصى يجب أن يكون أكبر من الأدنى'), { status: 400 });
  return {
    name, active: payload.active !== false,
    priority: Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 0,
    match: {
      origin: match.origin ? String(match.origin).trim() : null,
      dest_port: match.dest_port ? String(match.dest_port).trim() : null,
      service: match.service || null,
      weight_min_kg: wMin, weight_max_kg: wMax,
      client_roles: Array.isArray(match.client_roles) && match.client_roles.length ? match.client_roles : null
    },
    rate: { base_fee: toMoney(base), per_kg: toMoney(perKg), per_cbm: toMoney(perCbm), min_charge: toMoney(minCharge), surcharge_pct: surcharge, discount_pct: discount },
    currency: payload.currency || 'USD',
    notes: payload.notes ? String(payload.notes).slice(0, 500) : null
  };
}

function create(payload, actor) {
  const clean = validate(payload);
  const rule = db.pricing_rules.insert({ id: crypto.randomUUID(), ...clean, created_by: actor.id, created_at: nowIso() });
  audit(actor, 'pricing_rule_create', 'pricing_rule', rule.id, { details: { name: rule.name } });
  return rule;
}

function update(id, payload, actor) {
  const rule = db.pricing_rules.byId(id);
  if (!rule) throw Object.assign(new Error('القاعدة غير موجودة'), { status: 404 });
  const merged = { ...rule, ...payload, rate: { ...rule.rate, ...(payload.rate || {}) }, match: { ...rule.match, ...(payload.match || {}) } };
  const clean = validate(merged);
  const out = db.pricing_rules.update(id, clean);
  audit(actor, 'pricing_rule_update', 'pricing_rule', id, { details: { name: clean.name } });
  return out;
}

function remove(id, actor) {
  const rule = db.pricing_rules.byId(id);
  if (!rule) throw Object.assign(new Error('القاعدة غير موجودة'), { status: 404 });
  db.pricing_rules.remove(id);
  audit(actor, 'pricing_rule_delete', 'pricing_rule', id, { details: { name: rule.name } });
  return { ok: true };
}

function list({ active = null, q = null } = {}) {
  let rows = db.pricing_rules.all().slice();
  if (active !== null) rows = rows.filter((r) => !!r.active === !!active);
  if (q) { const s = String(q).toLowerCase(); rows = rows.filter((r) => (r.name || '').toLowerCase().includes(s) || String(r.match && r.match.origin).toLowerCase().includes(s) || String(r.match && r.match.dest_port).toLowerCase().includes(s)); }
  rows.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.name).localeCompare(String(b.name)));
  return rows;
}

/** درجة التخصّص: كم شرطًا تحقّق — الأعلى يفوز */
function specificity(rule, params) {
  const m = rule.match || {};
  let score = 0;
  if (m.origin) score += 2;
  if (m.dest_port) score += 2;
  if (m.service) score += 2;
  if (m.weight_min_kg !== null && m.weight_min_kg !== undefined) score += 1;
  if (m.weight_max_kg !== null && m.weight_max_kg !== undefined) score += 1;
  if (m.client_roles && m.client_roles.length) score += 1;
  return score;
}

function matches(rule, p) {
  const m = rule.match || {};
  if (m.origin && String(p.origin || '').trim() !== m.origin) return false;
  if (m.dest_port && String(p.dest_port || '').trim() !== m.dest_port) return false;
  if (m.service && p.service !== m.service) return false;
  const w = Number(p.weight_kg || 0);
  if (m.weight_min_kg !== null && m.weight_min_kg !== undefined && w < m.weight_min_kg) return false;
  if (m.weight_max_kg !== null && m.weight_max_kg !== undefined && w > m.weight_max_kg) return false;
  if (m.client_roles && m.client_roles.length && p.client_role && !m.client_roles.includes(p.client_role)) return false;
  return true;
}

/** حساب السعر من قاعدة واحدة */
function compute(rule, p) {
  const r = rule.rate;
  const weight = Number(p.weight_kg || 0);
  const cbm = Number(p.volume_cbm || 0);
  const base = toCents(r.base_fee);
  const weightCost = Math.round(toCents(r.per_kg) * weight);
  const volumeCost = Math.round(toCents(r.per_cbm) * cbm);
  const subtotal = base + weightCost + volumeCost;
  const surcharge = Math.round(subtotal * (Number(r.surcharge_pct || 0) / 100));
  const discount = Math.round((subtotal + surcharge) * (Number(r.discount_pct || 0) / 100));
  let total = subtotal + surcharge - discount;
  const minCharge = toCents(r.min_charge);
  const minApplied = minCharge > 0 && total < minCharge;
  if (minApplied) total = minCharge;
  return {
    total_cents: total,
    total: toMoney(total),
    currency: rule.currency || 'USD',
    breakdown: {
      base_fee: toMoney(base),
      weight_kg: weight,
      per_kg: toMoney(toCents(r.per_kg)),
      weight_cost: toMoney(weightCost),
      volume_cbm: cbm,
      per_cbm: toMoney(toCents(r.per_cbm)),
      volume_cost: toMoney(volumeCost),
      subtotal: toMoney(subtotal),
      surcharge_pct: Number(r.surcharge_pct || 0),
      surcharge: toMoney(surcharge),
      discount_pct: Number(r.discount_pct || 0),
      discount: toMoney(discount),
      min_charge: toMoney(minCharge),
      min_applied: minApplied
    }
  };
}

/** الاقتباس: يختار أفضل قاعدة مطابقة ويشرح الحساب */
function quote(params = {}) {
  const p = {
    origin: params.origin ? String(params.origin).trim() : null,
    dest_port: params.dest_port ? String(params.dest_port).trim() : null,
    service: params.service || null,
    weight_kg: Number(params.weight_kg || 0),
    volume_cbm: Number(params.volume_cbm || 0),
    client_role: params.client_role || null
  };
  if (!(p.weight_kg >= 0) || !Number.isFinite(p.weight_kg)) throw Object.assign(new Error('الوزن غير صالح'), { status: 400 });
  const activeRules = db.pricing_rules.find((r) => r.active);
  const matched = activeRules.filter((r) => matches(r, p))
    .map((r) => ({ rule: r, spec: specificity(r, p) }))
    .sort((a, b) => b.spec - a.spec || (b.rule.priority || 0) - (a.rule.priority || 0));
  if (!matched.length) {
    return { ok: true, matched: false, total: null, currency: 'USD', reason: 'لا توجد قاعدة تسعير مطابقة لهذه الشحنة', candidates: [] };
  }
  const best = matched[0].rule;
  const calc = compute(best, p);
  return {
    ok: true,
    matched: true,
    rule: { id: best.id, name: best.name, priority: best.priority, service: best.match.service || null },
    input: p,
    ...calc,
    alternatives: matched.slice(1, 4).map((m) => ({ rule: { id: m.rule.id, name: m.rule.name }, ...compute(m.rule, p) }))
  };
}

/** الاقتباس من كائن شحنة (يُستخدم عند إنشاء شحنة من الواجهة/الخادم) */
function quoteForShipment(ship, clientRole) {
  return quote({
    origin: ship.source || ship.origin || null,
    dest_port: ship.destPort || ship.dest_port || null,
    service: ship.service || null,
    weight_kg: Number(ship.weight || ship.weight_kg || 0),
    volume_cbm: Number(ship.volume_cbm || 0),
    client_role: clientRole || null
  });
}

/** قواعد افتراضية أولية (قابلة للتعديل والحذف بالكامل) */
function seedDefaults(actor) {
  if (db.pricing_rules.all().length > 0) return 0;
  const defaults = [
    {
      name: 'شحن جوي قياسي (حتى 100 كجم)', priority: 10,
      match: { service: 'air', weight_max_kg: 100 },
      rate: { base_fee: 15, per_kg: 6.5, per_cbm: 0, min_charge: 25, surcharge_pct: 0, discount_pct: 0 },
      notes: 'قاعدة تشغيلية افتراضية — عدّلها حسب أسعارك الفعلية.'
    },
    {
      name: 'شحن جوي ثقيل (أكثر من 100 كجم)', priority: 10,
      match: { service: 'air', weight_min_kg: 100.01 },
      rate: { base_fee: 25, per_kg: 5.2, per_cbm: 0, min_charge: 120, surcharge_pct: 0, discount_pct: 5 },
      notes: 'خصم تلقائي 5% للشحنات الثقيلة.'
    },
    {
      name: 'شحن بحري — حاويات', priority: 8,
      match: { service: 'sea' },
      rate: { base_fee: 40, per_kg: 0.85, per_cbm: 22, min_charge: 90, surcharge_pct: 0, discount_pct: 0 },
      notes: 'يشمل رسم معالجة الميناء.'
    },
    {
      name: 'شحن بري محلي', priority: 6,
      match: { service: 'land' },
      rate: { base_fee: 8, per_kg: 0.35, per_cbm: 0, min_charge: 15, surcharge_pct: 0, discount_pct: 0 },
      notes: null
    },
    {
      name: 'عملاء الوكلاء — خصم عام', priority: 3,
      match: { service: null, client_roles: ['agent'] },
      rate: { base_fee: 0, per_kg: 0.01, per_cbm: 0, min_charge: 1, surcharge_pct: 0, discount_pct: 0 },
      notes: 'قاعدة منخفضة الأسبقية — لا تُطبَّق إلا إن لم توجد قاعدة خدمة مطابقة.'
    }
  ];
  let n = 0;
  for (const d of defaults) { create(d, actor); n++; }
  return n;
}

module.exports = { create, update, remove, list, quote, quoteForShipment, compute, matches, validate, seedDefaults, SERVICES, SERVICE_LABEL };
