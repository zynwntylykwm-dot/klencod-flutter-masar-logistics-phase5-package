/**
 * auctions.js — محرك المزادات الحقيقي (المرحلة 2)
 * ------------------------------------------------
 * مبادئ التصميم:
 *  1) الوقت من ساعة الخادم فقط — لا تُقبل أي ساعة من العميل.
 *  2) المزايدة عملية ذرّية: التحقق + حجز المبلغ + تحرير المتجاوَز + تحديث المزاد
 *     تحدث في نفس المقطع المتزامن (لا await داخله) فلا يمكن أن تتداخل مزايدتان.
 *  3) لا تُقبل مزايدة أقل من (الأعلى + حد الزيادة)، ولا من البائع، ولا ممن هو الأعلى.
 *  4) الإغلاق مهمة مجدولة في الخادم: تُغلق المزادات المنتهية، تُحدد الفائز،
 *     تُرحّل المبلغ إلى الضمان، وتُطلق الإشعارات.
 *  5) كل حركة مالية تُسجَّل في دفتر القيود، وكل مزايدة تُحفظ بسجلّها.
 */
'use strict';
const crypto = require('crypto');
const { db, audit } = require('./store');
const wallet = require('./wallet');

const MIN_INCREMENT = 500;         // 5 دولارات
const DEFAULT_EXTEND_SECONDS = 60; // تمديد مانع للقنص
const MAX_EXTENSIONS = 20;

const toCents = (v) => Math.round(Number(v) * 100);
const toMoney = (c) => +(Number(c || 0) / 100).toFixed(2);
const iso = (ms) => new Date(ms).toISOString();

// ============================ الحالة الفعلية ============================
function effectiveStatus(a, now = Date.now()) {
  const s = new Date(a.starts_at).getTime();
  const e = new Date(a.ends_at).getTime();
  if (a.status === 'cancelled') return 'cancelled';
  if (a.status === 'settled') return 'settled';
  if (now < s) return 'upcoming';
  if (now > e) return a.winner_id ? 'settled' : 'ended';
  return 'active';
}

function maskedName(name) {
  const n = String(name || 'مستخدم');
  if (n.length <= 3) return n + '***';
  return n.slice(0, 3) + '***';
}

// ============================ التحويل للعرض ============================
function publicAuction(a, viewer, opts = {}) {
  const now = opts.now || Date.now();
  const eff = effectiveStatus(a, now);
  const ends = new Date(a.ends_at).getTime();
  const starts = new Date(a.starts_at).getTime();
  const minNext = a.current_bid ? a.current_bid + a.bid_increment : a.start_price;
  const out = {
    id: a.id,
    title: a.title,
    description: a.description,
    category: a.category,
    condition: a.condition || null,
    location: a.location || null,
    demo: !!a.demo,
    status: eff,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    seconds_left: eff === 'active' ? Math.max(0, Math.round((ends - now) / 1000)) : 0,
    seconds_to_start: eff === 'upcoming' ? Math.max(0, Math.round((starts - now) / 1000)) : 0,
    start_price: toMoney(a.start_price),
    reserve_price: a.reserve_price ? toMoney(a.reserve_price) : null,
    reserve_met: a.reserve_price ? (a.current_bid || 0) >= a.reserve_price : true,
    bid_increment: toMoney(a.bid_increment),
    min_next_bid: toMoney(minNext),
    current_bid: a.current_bid ? toMoney(a.current_bid) : null,
    bid_count: a.bid_count || 0,
    extension_count: a.extension_count || 0,
    winner: a.winner_id ? { id: a.winner_id, name: a.winner_name ? maskedName(a.winner_name) : null, amount: toMoney(a.final_amount) } : null,
    seller_name: maskedName(a.seller_name),
    created_at: a.created_at,
    my_bid: null,
    watching: false
  };
  if (viewer) {
    const mine = db.bids.find((b) => b.auction_id === a.id && b.user_id === viewer.id);
    if (mine.length) {
      const top = mine.reduce((x, y) => (y.amount > x.amount ? y : x));
      out.my_bid = { amount: toMoney(top.amount), status: top.status, at: top.created_at, count: mine.length };
    }
    out.watching = !!db.favorites.findOne((f) => f.user_id === viewer.id && f.item_type === 'auction' && f.item_id === a.id);
  }
  return out;
}

function publicBid(b) {
  return { id: b.id, bidder: maskedName(b.user_name), amount: toMoney(b.amount), status: b.status, at: b.created_at };
}

// ============================ القراءة ============================
function list({ status = 'active', category, q, sort = 'ending', page = 1, limit = 30, viewer }) {
  const now = Date.now();
  let rows = db.auctions.all().slice();
  if (status && status !== 'all') rows = rows.filter((a) => effectiveStatus(a, now) === status);
  if (category) rows = rows.filter((a) => a.category === category);
  if (q) {
    const term = String(q).toLowerCase();
    rows = rows.filter((a) => (a.title + ' ' + (a.description || '') + ' ' + (a.category || '')).toLowerCase().includes(term));
  }
  const order = { active: 0, upcoming: 1, ended: 2, settled: 3, cancelled: 4 };
  rows.sort((a, b) => {
    if (sort === 'price') return (b.current_bid || b.start_price) - (a.current_bid || a.start_price);
    if (sort === 'newest') return b.created_at.localeCompare(a.created_at);
    if (sort === 'bids') return (b.bid_count || 0) - (a.bid_count || 0);
    // ending: النشطة أولًا ثم الأقرب انتهاءً
    const d = (order[effectiveStatus(a, now)] ?? 9) - (order[effectiveStatus(b, now)] ?? 9);
    if (d !== 0) return d;
    return new Date(a.ends_at) - new Date(b.ends_at);
  });
  const total = rows.length;
  const start = (page - 1) * limit;
  return { total, page, limit, items: rows.slice(start, start + limit).map((a) => publicAuction(a, viewer, { now })) };
}

function detail(id, viewer) {
  const a = db.auctions.byId(id);
  if (!a) throw Object.assign(new Error('المزاد غير موجود'), { status: 404 });
  const bids = db.bids.find((b) => b.auction_id === id)
    .sort((x, y) => y.created_at.localeCompare(x.created_at) || y.amount - x.amount)
    .slice(0, 50).map(publicBid);
  const base = publicAuction(a, viewer);
  base.bids = bids;
  base.timeline = {
    created: a.created_at,
    starts: a.starts_at,
    ends: a.ends_at,
    extensions: a.extension_count || 0,
    closed_at: a.closed_at || null
  };
  return base;
}

// ============================ الإنشاء والتعديل ============================
function create(payload, user, { demo = false } = {}) {
  const title = String(payload.title || '').trim();
  if (title.length < 4) throw Object.assign(new Error('عنوان المزاد قصير جدًا'), { status: 400 });
  const startPrice = toCents(payload.start_price);
  const increment = payload.bid_increment ? toCents(payload.bid_increment) : MIN_INCREMENT;
  if (!(startPrice > 0)) throw Object.assign(new Error('سعر البداية يجب أن يكون أكبر من صفر'), { status: 400 });
  if (!(increment >= MIN_INCREMENT)) throw Object.assign(new Error(`أقل زيادة مسموحة ${toMoney(MIN_INCREMENT)} $`), { status: 400 });

  let startsAt = payload.starts_at ? new Date(payload.starts_at).getTime() : Date.now();
  let endsAt = payload.ends_at ? new Date(payload.ends_at).getTime() : startsAt + 24 * 3600e3;
  if (!Number.isFinite(endsAt) || endsAt <= startsAt) throw Object.assign(new Error('وقت الانتهاء يجب أن يكون بعد وقت البداية'), { status: 400 });
  const durationMs = endsAt - startsAt;
  if (durationMs < 60e3) throw Object.assign(new Error('مدة المزاد 60 ثانية على الأقل'), { status: 400 });
  if (durationMs > 90 * 24 * 3600e3) throw Object.assign(new Error('المدة القصوى 90 يومًا'), { status: 400 });

  const reserve = payload.reserve_price ? toCents(payload.reserve_price) : null;
  if (reserve && reserve < startPrice) throw Object.assign(new Error('سعر الحجز لا يقل عن سعر البداية'), { status: 400 });

  const now = Date.now();
  const a = db.auctions.insert({
    id: crypto.randomUUID(),
    title, description: String(payload.description || '').slice(0, 4000),
    category: String(payload.category || 'other'),
    condition: payload.condition || null,
    location: payload.location || null,
    seller_id: user.id, seller_name: user.fullName,
    start_price: startPrice, reserve_price: reserve, bid_increment: increment,
    starts_at: iso(startsAt), ends_at: iso(endsAt),
    status: now >= startsAt ? 'active' : 'scheduled',
    current_bid: 0, current_bidder_id: null, current_bidder_name: null, bid_count: 0,
    extend_seconds: payload.extend_seconds === 0 ? 0 : (Number(payload.extend_seconds) || DEFAULT_EXTEND_SECONDS),
    max_extensions: Number(payload.max_extensions) || MAX_EXTENSIONS,
    extension_count: 0,
    winner_id: null, winner_name: null, final_amount: 0, closed_at: null,
    demo: !!demo, demo_reason: demo ? 'مزاد تجريبي للعرض' : null,
    created_by: user.id, created_at: iso(now)
  });
  audit(user, 'auction_create', 'auction', a.id, { details: { title, startPrice, demo } });
  return a;
}

// ============================ المزايدة (القلب) ============================
function placeBid(auctionId, user, amountInput, ip) {
  // -------- 1) تحقق من الصلاحية والوقت (ساعة الخادم) --------
  const a = db.auctions.byId(auctionId);
  if (!a) throw Object.assign(new Error('المزاد غير موجود'), { status: 404 });
  const now = Date.now();
  const eff = effectiveStatus(a, now);
  if (eff === 'upcoming') throw Object.assign(new Error('المزاد لم يبدأ بعد'), { status: 409 });
  if (eff !== 'active') throw Object.assign(new Error('انتهى المزاد ولا تُقبل مزايدات جديدة'), { status: 409 });
  if (a.seller_id === user.id) throw Object.assign(new Error('لا يمكن للبائع المزايدة على مزاده'), { status: 403 });
  if (a.current_bidder_id === user.id) throw Object.assign(new Error('أنت الأعلى حاليًا، لا يمكنك تجاوز نفسك'), { status: 409 });

  // -------- 2) تحقق من المبلغ --------
  const amount = toCents(amountInput);
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('مبلغ المزايدة غير صالح'), { status: 400 });
  const minNext = a.current_bid ? a.current_bid + a.bid_increment : a.start_price;
  if (amount < minNext) {
    throw Object.assign(new Error(`الحد الأدنى للمزايدة ${toMoney(minNext)} $`), { status: 400, min_next: toMoney(minNext) });
  }
  if (amount > 100_000_000_00) throw Object.assign(new Error('المبلغ كبير جدًا'), { status: 400 });

  // -------- 3) الحجز المالي (يرفض إن لم يكفِ الرصيد) --------
  let held;
  try {
    held = wallet.hold(user.id, amount, { ref_type: 'auction', ref_id: a.id, note: 'حجز مبلغ مزايدة' });
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: e.status || 402 });
  }

  // -------- 4) تحرير مبلغ المتجاوَز وإشعاره --------
  let previous = null;
  if (a.current_bidder_id && a.current_bid) {
    try { wallet.releaseRef(a.current_bidder_id, { ref_type: 'auction', ref_id: a.id, note: 'تحرير بعد تجاوز المزايدة' }); } catch (_) {}
    const prevBid = db.bids.findOne((b) => b.auction_id === a.id && b.user_id === a.current_bidder_id && b.status === 'winning');
    if (prevBid) db.bids.update(prevBid.id, { status: 'outbid' });
    previous = { id: a.current_bidder_id, name: a.current_bidder_name, amount: a.current_bid };
  }

  // -------- 5) تسجيل المزايدة وتحديث المزاد --------
  const bid = db.bids.insert({
    id: crypto.randomUUID(),
    auction_id: a.id, user_id: user.id, user_name: user.fullName,
    amount, status: 'winning', ip: ip || null, created_at: iso(now)
  });
  a.current_bid = amount;
  a.current_bidder_id = user.id;
  a.current_bidder_name = user.fullName;
  a.bid_count = (a.bid_count || 0) + 1;

  // -------- 6) منع القنص: تمديد تلقائي إذا اقترب الانتهاء --------
  let extended = false;
  const endsMs = new Date(a.ends_at).getTime();
  const left = endsMs - now;
  if (a.extend_seconds > 0 && left <= a.extend_seconds * 1000 && (a.extension_count || 0) < (a.max_extensions || MAX_EXTENSIONS)) {
    a.ends_at = iso(endsMs + a.extend_seconds * 1000);
    a.extension_count = (a.extension_count || 0) + 1;
    extended = true;
  }
  db.auctions.update(a.id, a);
  audit(user, 'auction_bid', 'auction', a.id, { details: { amount: toMoney(amount), extended }, ip });

  return { auction: publicAuction(a, user), bid: publicBid(bid), previous, extended, held_cents: held.account.held_cents };
}

// ============================ الإغلاق التلقائي ============================
function closeAuction(a, now = Date.now()) {
  if (!a || ['cancelled', 'settled', 'ended'].includes(a.status)) return null;
  const endsMs = new Date(a.ends_at).getTime();
  if (now < endsMs) return null;

  const hasBid = !!a.current_bidder_id;
  const reserveOk = a.reserve_price ? (a.current_bid || 0) >= a.reserve_price : hasBid;

  if (hasBid && reserveOk) {
    let captured = 0;
    try {
      const r = wallet.captureToEscrow(a.current_bidder_id, { ref_type: 'auction', ref_id: a.id, note: 'ترحيل مبلغ الفائز إلى الضمان' });
      captured = r.amount_cents;
    } catch (e) { captured = 0; }
    const winBid = db.bids.findOne((b) => b.auction_id === a.id && b.status === 'winning');
    if (winBid) db.bids.update(winBid.id, { status: 'won' });
    for (const b of db.bids.find((b) => b.auction_id === a.id && b.status === 'outbid')) { /* محفوظة كما هي */ }
    const updated = db.auctions.update(a.id, {
      status: 'settled', winner_id: a.current_bidder_id, winner_name: a.current_bidder_name,
      final_amount: a.current_bid, closed_at: iso(now), escrow_captured_cents: captured
    });
    audit({ id: null, fullName: 'scheduler' }, 'auction_close', 'auction', a.id, { details: { winner: a.current_bidder_id, amount: toMoney(a.current_bid) } });
    return { auction: updated, outcome: 'sold', winner_id: a.current_bidder_id, winner_name: a.current_bidder_name, amount: a.current_bid, seller_id: a.seller_id };
  }

  // لا مزايدات أو لم يُستوفَ سعر الحجز → تحرير أي مبلغ محجوز
  if (hasBid) {
    try { wallet.releaseRef(a.current_bidder_id, { ref_type: 'auction', ref_id: a.id, note: 'تحرير لعدم استيفاء سعر الحجز' }); } catch (_) {}
    const b = db.bids.findOne((x) => x.auction_id === a.id && x.status === 'winning');
    if (b) db.bids.update(b.id, { status: 'not_reserved' });
  }
  const updated = db.auctions.update(a.id, { status: 'ended', closed_at: iso(now), winner_id: null, final_amount: 0 });
  audit({ id: null, fullName: 'scheduler' }, 'auction_close', 'auction', a.id, { details: { outcome: hasBid ? 'reserve_not_met' : 'no_bids' } });
  return { auction: updated, outcome: hasBid ? 'reserve_not_met' : 'no_bids', seller_id: a.seller_id };
}

/** تُنفَّذ دوريًا من الخادم: تُغلق كل المزادات المنتهية */
function tick(handlers = {}) {
  const now = Date.now();
  const results = [];
  for (const a of db.auctions.all().slice()) {
    if (['cancelled', 'settled', 'ended'].includes(a.status)) continue;
    if (new Date(a.ends_at).getTime() > now) continue;
    const r = closeAuction(a, now);
    if (r) {
      results.push(r);
      if (handlers.onClosed) handlers.onClosed(r);
    }
  }
  return results;
}

function cancel(auctionId, user) {
  const a = db.auctions.byId(auctionId);
  if (!a) throw Object.assign(new Error('المزاد غير موجود'), { status: 404 });
  if (user.role !== 'super_admin' && a.seller_id !== user.id) throw Object.assign(new Error('لا تملك صلاحية إلغاء هذا المزاد'), { status: 403 });
  if (a.bid_count > 0) throw Object.assign(new Error('لا يمكن الإلغاء بعد وجود مزايدات — أغلقه أو اتركه ينتهي'), { status: 409 });
  const updated = db.auctions.update(a.id, { status: 'cancelled', closed_at: iso(Date.now()) });
  audit(user, 'auction_cancel', 'auction', a.id);
  return updated;
}

// ============================ بيانات أولية (موسومة تجريبيًا) ============================
function seedDemo(adminUser) {
  if (db.auctions.all().length > 0 || !adminUser) return 0;
  const now = Date.now();
  const H = 3600e3;
  const rows = [
    { title: 'شاحنة مرسيدس أكتروس 2021 — وارد أوروبا', category: 'vehicles', start: 42000, inc: 250, hours: 26, desc: 'شاحنة جرّ ثقيل، عداد 320,000 كم، فحص كامل متوفر. الشحن من ميناء جبل علي.' },
    { title: 'دفعة أجهزة لابتوب Dell XPS 15 (20 جهازًا)', category: 'electronics', start: 12500, inc: 100, hours: 8, desc: 'أجهزة جديدة بالكرتونة، ضمان دولي، تُشحن من الصين أو الإمارات.' },
    { title: 'رافعة شوكية كهربائية 3 طن', category: 'equipment', start: 6800, inc: 50, hours: 1.5, desc: 'بطارية جديدة، ساعات تشغيل منخفضة، مناسبة للمستودعات.' },
    { title: 'مستلزمات طبية — 500 جهاز قياس ضغط', category: 'medical', start: 3200, inc: 25, hours: 50, desc: 'أجهزة Omron أصلية، صلاحية طويلة، مستندات منشأ متوفرة.' },
    { title: 'قطع غيار سيارات يابانية — حاوية 20 قدم', category: 'parts', start: 24000, inc: 200, hours: 72, desc: 'خلطة قطع أصلية من مزاد ياباني، قائمة تفصيلية عند الطلب.' },
    { title: 'مجموعة هواتف Samsung Galaxy S24 (10 أجهزة)', category: 'electronics', start: 5400, inc: 50, hours: 0.5, desc: 'أجهزة جديدة، ذاكرة 256GB، ألوان متنوعة.' }
  ];
  let n = 0;
  for (const r of rows) {
    const starts = iso(now - H);
    const ends = iso(now + r.hours * H);
    db.auctions.insert({
      id: crypto.randomUUID(), title: r.title, description: r.desc, category: r.category,
      condition: 'مستعمل/جديد حسب الوصف', location: 'ميناء جبل علي — الإمارات',
      seller_id: adminUser.id, seller_name: adminUser.fullName,
      start_price: r.start * 100, reserve_price: null, bid_increment: r.inc * 100,
      starts_at: starts, ends_at: ends, status: 'active',
      current_bid: 0, current_bidder_id: null, current_bidder_name: null, bid_count: 0,
      extend_seconds: DEFAULT_EXTEND_SECONDS, max_extensions: MAX_EXTENSIONS, extension_count: 0,
      winner_id: null, winner_name: null, final_amount: 0, closed_at: null,
      demo: true, demo_reason: 'مزاد تجريبي للعرض — لا يمثل سلعة حقيقية',
      created_by: adminUser.id, created_at: iso(now)
    });
    n++;
  }
  return n;
}

module.exports = {
  list, detail, create, placeBid, closeAuction, tick, cancel, publicAuction, seedDemo,
  effectiveStatus, MIN_INCREMENT, DEFAULT_EXTEND_SECONDS, toCents, toMoney
};
