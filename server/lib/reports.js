/**
 * reports.js — تقارير مالية وتشغيلية حقيقية (المرحلة 4)
 * ----------------------------------------------------
 * كل الأرقام محسوبة من البيانات الفعلية على الخادم:
 *   wallet_entries (القيود المالية) · wallet_accounts (الأرصدة) · auctions/bids (مبيعات المزاد)
 *   shipments (قيم الفواتير والمدفوعات) · campaigns/notifications (النشاط)
 * وتُوسم بيانات الشحنات التجريبية بوسم `demo` حتى لا تُخلط بالأرقام الحقيقية.
 */
'use strict';
const { db } = require('./store');

const toMoney = (cents) => Math.round(Number(cents || 0)) / 100;
const dayKey = (iso) => String(iso || '').slice(0, 10);
const DAY = 86400e3;

function range(days = 30) {
  const to = new Date();
  const from = new Date(Date.now() - (days - 1) * DAY);
  return { from: from.toISOString(), to: to.toISOString(), days };
}

function summary({ days = 30 } = {}) {
  const { from } = range(days);
  const since = new Date(from).getTime();

  const entries = db.wallet_entries.all();
  const inRange = entries.filter((e) => new Date(e.created_at).getTime() >= since);

  const creditsAll = entries.filter((e) => e.amount_cents > 0);
  const realCredits = creditsAll.filter((e) => !e.demo);
  const demoCredits = creditsAll.filter((e) => e.demo);

  // حساب الضمان = مبالغ المزادات المحصّلة
  const escrow = db.wallet_accounts.findOne((a) => a.user_id === 'system:escrow') || { available_cents: 0, held_cents: 0 };

  const auctions = db.auctions.all();
  const settled = auctions.filter((a) => a.status === 'settled');
  const gmvCents = settled.reduce((s, a) => s + Number(a.final_amount || 0) * 100, 0);

  const ships = db.shipments.all();
  const realShips = ships.filter((s) => !s.demo);
  const demoShips = ships.filter((s) => s.demo);
  const paidSum = ships.reduce((s, x) => s + Number(x.paid || 0), 0);
  const remainingSum = ships.reduce((s, x) => s + Number(x.remaining || 0), 0);
  const invoiceSum = ships.reduce((s, x) => s + Number(x.invoiceValue || 0), 0);

  return {
    period: { days, from },
    wallet: {
      credits_total: toMoney(creditsAll.reduce((s, e) => s + e.amount_cents, 0)),
      credits_real: toMoney(realCredits.reduce((s, e) => s + e.amount_cents, 0)),
      credits_demo: toMoney(demoCredits.reduce((s, e) => s + e.amount_cents, 0)),
      credits_in_range: toMoney(inRange.filter((e) => e.amount_cents > 0).reduce((s, e) => s + e.amount_cents, 0)),
      entries_in_range: inRange.length,
      accounts: db.wallet_accounts.all().length,
      available_total: toMoney(db.wallet_accounts.all().reduce((s, a) => s + (a.available_cents || 0), 0)),
      held_total: toMoney(db.wallet_accounts.all().reduce((s, a) => s + (a.held_cents || 0), 0))
    },
    escrow: { available: toMoney(escrow.available_cents), held: toMoney(escrow.held_cents) },
    auctions: {
      total: auctions.length,
      active: auctions.filter((a) => a.status === 'active').length,
      settled: settled.length,
      ended_no_sale: auctions.filter((a) => a.status === 'ended').length,
      gmv: toMoney(gmvCents),
      bids: db.bids.all().length,
      demo: auctions.filter((a) => a.demo).length
    },
    shipments: {
      total: ships.length,
      real: realShips.length,
      demo: demoShips.length,
      invoice_value: toMoney(invoiceSum * 100),
      paid: toMoney(paidSum * 100),
      remaining: toMoney(remainingSum * 100),
      collection_rate_pct: invoiceSum > 0 ? Math.round((paidSum / invoiceSum) * 1000) / 10 : 0
    },
    notifications: {
      sent: db.notifications.all().length,
      campaigns: db.campaigns.all().length,
      visitors: db.visitors.all().length
    },
    note: 'قيم الشحنات التجريبية موسومة في حقل shipments.demo — الأرقام المالية الحقيقية هي wallet/auctions.'
  };
}

function series({ days = 30 } = {}) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
    const entries = db.wallet_entries.find((e) => dayKey(e.created_at) === d);
    const ships = db.shipments.find((s) => dayKey(s.created_at) === d);
    const closed = db.auctions.find((a) => dayKey(a.closed_at) === d && a.status === 'settled');
    out.push({
      date: d,
      credits: toMoney(entries.filter((e) => e.amount_cents > 0).reduce((s, e) => s + e.amount_cents, 0)),
      debits: toMoney(entries.filter((e) => e.amount_cents < 0).reduce((s, e) => s + Math.abs(e.amount_cents), 0)),
      entries: entries.length,
      shipments: ships.length,
      auction_sales: closed.length,
      auction_gmv: toMoney(closed.reduce((s, a) => s + Number(a.final_amount || 0) * 100, 0))
    });
  }
  return out;
}

function topClients({ limit = 10, by = 'shipments' } = {}) {
  const users = db.users.all();
  const rows = users.map((u) => {
    const ships = db.shipments.find((s) => s.user_id === u.id || s.created_by === u.id);
    const paid = ships.reduce((s, x) => s + Number(x.paid || 0), 0);
    const credits = db.wallet_entries.find((e) => e.user_id === u.id && e.amount_cents > 0 && !e.demo);
    const acc = db.wallet_accounts.findOne((a) => a.user_id === u.id && a.currency === 'USD');
    return {
      id: u.id, name: u.fullName || u.username, role: u.role, status: u.status,
      shipments: ships.length,
      paid: Math.round(paid * 100) / 100,
      credits: toMoney(credits.reduce((s, e) => s + e.amount_cents, 0)),
      balance: toMoney(acc ? acc.available_cents : 0)
    };
  });
  const key = by === 'credits' ? 'credits' : by === 'balance' ? 'balance' : 'paid';
  return rows.sort((a, b) => b[key] - a[key]).slice(0, limit);
}

/** تصدير CSV (UTF-8 مع BOM ليفتح صحيحًا في Excel العربي) */
function csv(type = 'entries') {
  const esc = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const lines = [];
  if (type === 'entries') {
    lines.push(['التاريخ', 'المستخدم', 'النوع', 'المبلغ', 'العملة', 'مرجع', 'ملاحظة', 'تجريبي'].map(esc).join(','));
    db.wallet_entries.all().slice().reverse().forEach((e) => {
      const u = db.users.byId(e.user_id);
      lines.push([e.created_at, u ? (u.fullName || u.username) : e.user_id, e.type, toMoney(e.amount_cents), 'USD', e.ref_type ? e.ref_type + ':' + (e.ref_id || '') : '', e.note || '', e.demo ? 'نعم' : 'لا'].map(esc).join(','));
    });
  } else if (type === 'shipments') {
    lines.push(['رقم الشحنة', 'الحالة', 'المصدر', 'الوجهة', 'قيمة الفاتورة', 'المدفوع', 'المتبقي', 'الوزن', 'تجريبي', 'التاريخ'].map(esc).join(','));
    db.shipments.all().forEach((s) => {
      lines.push([s.trackingNumber, s.status, s.source || '', s.destPort || '', s.invoiceValue || 0, s.paid || 0, s.remaining || 0, s.weight || 0, s.demo ? 'نعم' : 'لا', s.created_at || ''].map(esc).join(','));
    });
  } else if (type === 'auctions') {
    lines.push(['المزاد', 'الحالة', 'سعر البداية', 'السعر النهائي', 'الفائز', 'عدد المزايدات', 'أُغلق في', 'تجريبي'].map(esc).join(','));
    db.auctions.all().forEach((a) => {
      lines.push([a.title, a.status, (a.start_price || 0), (a.final_amount || 0), a.winner_name || '', a.bid_count || 0, a.closed_at || '', a.demo ? 'نعم' : 'لا'].map(esc).join(','));
    });
  } else if (type === 'audit') {
    lines.push(['التاريخ', 'المنفّذ', 'الإجراء', 'الكيان', 'المعرّف', 'IP'].map(esc).join(','));
    db.audit.all().slice().reverse().forEach((a) => {
      lines.push([a.created_at, a.actor_name || '', a.action, a.entity || '', a.entity_id || '', a.ip || ''].map(esc).join(','));
    });
  } else {
    throw Object.assign(new Error('نوع تصدير غير معروف'), { status: 400 });
  }
  return '\ufeff' + lines.join('\r\n');
}

/** سجل التدقيق مع فلاتر وترقيم صفحات */
function auditQuery({ action = null, actor = null, entity = null, from = null, to = null, q = null, page = 1, limit = 50 } = {}) {
  let rows = db.audit.all().slice().reverse();
  if (action) rows = rows.filter((a) => String(a.action || '').toLowerCase().includes(String(action).toLowerCase()));
  if (actor) rows = rows.filter((a) => String(a.actor_name || '').toLowerCase().includes(String(actor).toLowerCase()));
  if (entity) rows = rows.filter((a) => String(a.entity || '').toLowerCase() === String(entity).toLowerCase());
  if (from) rows = rows.filter((a) => new Date(a.created_at).getTime() >= new Date(from).getTime());
  if (to) rows = rows.filter((a) => new Date(a.created_at).getTime() <= new Date(to).getTime() + DAY);
  if (q) { const s = String(q).toLowerCase(); rows = rows.filter((a) => JSON.stringify(a).toLowerCase().includes(s)); }
  const total = rows.length;
  const start = (Math.max(1, page) - 1) * limit;
  const actions = [...new Set(db.audit.all().map((a) => a.action))].sort();
  const entities = [...new Set(db.audit.all().map((a) => a.entity).filter(Boolean))].sort();
  return { total, page, limit, items: rows.slice(start, start + limit), facets: { actions, entities } };
}

module.exports = { summary, series, topClients, csv, auditQuery, range };
