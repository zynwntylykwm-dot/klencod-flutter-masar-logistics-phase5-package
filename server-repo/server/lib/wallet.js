/**
 * wallet.js — محفظة داخلية بدفتر قيود (Ledger)
 * --------------------------------------------
 * كل حركة مالية تُسجَّل في wallet_entries بشكل غير قابل للتعديل،
 * والأرصدة مشتقة من الأرصدة المحفوظة مع تحقق صارم قبل كل خصم/حجز.
 *
 * الوحدات: السنت (cents) لتفادي أخطاء الفاصلة العائمة.
 * الحالات: available (متاح) / held (محجوز لصالح مزايدة أو طلب).
 */
'use strict';
const crypto = require('crypto');
const { db } = require('./store');

const SYSTEMS = { escrow: 'system:escrow', fees: 'system:fees' };

// مجموعة الحسابات تُدار عبر store مباشرة
const accounts = {
  find: (userId, currency = 'USD') => db.wallet_accounts.findOne((a) => a.user_id === userId && a.currency === currency),
  ensure: (userId, currency = 'USD') => {
    let acc = db.wallet_accounts.findOne((a) => a.user_id === userId && a.currency === currency);
    if (!acc) {
      acc = db.wallet_accounts.insert({
        id: crypto.randomUUID(), user_id: userId, currency,
        available_cents: 0, held_cents: 0, created_at: new Date().toISOString()
      });
    }
    return acc;
  },
  save: (acc) => {
    const i = db.wallet_accounts.all().findIndex((a) => a.id === acc.id);
    if (i === -1) return null;
    db.wallet_accounts.all()[i] = acc;
    db.wallet_accounts.persist();
    return acc;
  }
};

function entry(acc, type, amountCents, opts = {}) {
  const e = db.wallet_entries.insert({
    id: crypto.randomUUID(),
    account_id: acc.id,
    user_id: acc.user_id,
    type,
    amount_cents: Math.round(amountCents),
    available_after_cents: acc.available_cents,
    held_after_cents: acc.held_cents,
    ref_type: opts.ref_type || null,
    ref_id: opts.ref_id || null,
    note: opts.note || null,
    demo: !!opts.demo,
    created_at: new Date().toISOString()
  });
  return e;
}

/** إيداع/شحن رصيد (يتطلب مصدرًا: دفع حقيقي، تحويل إداري، رصيد تجريبي موسوم) */
function credit(userId, cents, opts = {}) {
  const amount = Math.round(Number(cents));
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('المبلغ غير صالح'), { status: 400 });
  const acc = accounts.ensure(userId);
  acc.available_cents += amount;
  accounts.save(acc);
  return { account: acc, entry: entry(acc, 'credit', amount, opts) };
}

/**
 * حجز مبلغ مرتبط بمرجع محدد (مزاد/طلب).
 * كل حجز يُسجَّل كسجل مستقل في wallet_holds حتى يمكن تحريره أو ترحيله بدقة،
 * ولا يختلط بحجوزات المستخدم في مزادات أخرى.
 */
function hold(userId, cents, opts = {}) {
  const amount = Math.round(Number(cents));
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('المبلغ غير صالح'), { status: 400 });
  const acc = accounts.ensure(userId);
  if (acc.available_cents < amount) {
    throw Object.assign(new Error(`الرصيد المتاح غير كافٍ (المتاح ${(acc.available_cents / 100).toFixed(2)} $ والمطلوب ${(amount / 100).toFixed(2)} $)`), { status: 402 });
  }
  acc.available_cents -= amount;
  acc.held_cents += amount;
  accounts.save(acc);
  const holdDoc = db.wallet_holds.insert({
    id: crypto.randomUUID(),
    account_id: acc.id, user_id: userId,
    ref_type: opts.ref_type || 'generic', ref_id: opts.ref_id || null,
    amount_cents: amount, status: 'held',
    created_at: new Date().toISOString()
  });
  return { account: acc, hold: holdDoc, entry: entry(acc, 'hold', amount, opts) };
}

/** تحرير الحجز المرتبط بمرجع محدد (بالمبلغ المحجوز فعليًا لذلك المرجع) */
function releaseRef(userId, opts = {}) {
  const h = findHold(opts.ref_type, opts.ref_id, userId);
  if (!h) return { released_cents: 0 };
  const acc = accounts.ensure(userId);
  acc.held_cents -= h.amount_cents;
  acc.available_cents += h.amount_cents;
  accounts.save(acc);
  db.wallet_holds.update(h.id, { status: 'released', released_at: new Date().toISOString() });
  return { account: acc, released_cents: h.amount_cents, entry: entry(acc, 'release', h.amount_cents, opts) };
}

/** الاحتفاظ بالتوافق: تحرير مبلغ محدد (يُستخدم فقط عند عدم وجود مرجع) */
function release(userId, cents, opts = {}) {
  if (opts.ref_type && opts.ref_id) return releaseRef(userId, opts);
  const amount = Math.round(Number(cents));
  const acc = accounts.ensure(userId);
  const real = Math.min(Math.abs(amount), acc.held_cents);
  acc.held_cents -= real;
  acc.available_cents += real;
  accounts.save(acc);
  return { account: acc, entry: entry(acc, 'release', real, opts) };
}

/** ترحيل حجز مرجع محدد إلى حساب الضمان (عند فوز المزاد) */
function captureToEscrow(userId, opts = {}) {
  const h = findHold(opts.ref_type, opts.ref_id, userId);
  if (!h) return { amount_cents: 0, note: 'لا يوجد حجز لهذا المرجع' };
  const acc = accounts.ensure(userId);
  acc.held_cents -= h.amount_cents;
  accounts.save(acc);
  db.wallet_holds.update(h.id, { status: 'captured', captured_at: new Date().toISOString() });
  const escrow = accounts.ensure(SYSTEMS.escrow);
  escrow.available_cents += h.amount_cents;
  accounts.save(escrow);
  entry(acc, 'capture_escrow', h.amount_cents, opts);
  entry(escrow, 'escrow_in', h.amount_cents, { ...opts, note: 'حجز مبلغ الفائز في المزاد' });
  return { account: acc, amount_cents: h.amount_cents };
}

function findHold(refType, refId, userId) {
  return db.wallet_holds.findOne((h) => h.status === 'held' && h.ref_type === refType && String(h.ref_id) === String(refId) && (!userId || h.user_id === userId));
}

function holds(userId) {
  return db.wallet_holds.find((h) => h.user_id === userId && h.status === 'held');
}

function balance(userId) {
  const acc = accounts.ensure(userId);
  return { available_cents: acc.available_cents, held_cents: acc.held_cents, currency: acc.currency };
}

function entries(userId, limit = 50) {
  const acc = accounts.ensure(userId);
  return db.wallet_entries.find((e) => e.account_id === acc.id).slice().reverse().slice(0, limit);
}

module.exports = { accounts, credit, hold, release, releaseRef, captureToEscrow, findHold, holds, balance, entries, SYSTEMS };
