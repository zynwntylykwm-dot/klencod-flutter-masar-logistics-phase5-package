/**
 * auctions.js — واجهة المزادات (المرحلة 2)
 * ----------------------------------------
 * • تُضيف صفحة «المزادات» وزرًّا في شبكة الخدمات، بنفس كلاسات التصميم القائمة
 *   (لا تعديل على أي صفحة موجودة).
 * • الوقت المتبقي محسوب من ساعة الخادم + انحراف مُقاس، والمزايدة تُرسل للخادم دائمًا.
 * • التحديث اللحظي عبر SSE (أعلى سعر / عدد المزايدات / الإغلاق).
 * • لا تُعرض أي بيانات إن لم يكن الخادم متاحًا — رسالة صريحة بدلًا من بيانات وهمية.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const API = window.API;
  if (!API) return;

  const BASE = (window.MASAR_API_BASE || '').replace(/\/$/, '');
  const token = () => localStorage.getItem('masar.access') || '';
  /** طلب JSON موحّد: يمر عبر عنوان الخادم نفسه المستخدم في بقية الطبقة */
  async function rq(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && token()) headers.authorization = 'Bearer ' + token();
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
    return data;
  }


  const CATS = {
    vehicles: '🚛 مركبات', electronics: '💻 إلكترونيات', equipment: '🏗️ معدات ثقيلة',
    medical: '🏥 مستلزمات طبية', parts: '🔧 قطع غيار', other: '📦 أخرى'
  };
  const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  let serverOffset = 0;         // فرق ساعة العميل عن الخادم (مللي ثانية)
  let state = { tab: 'active', category: '', q: '', sort: 'ending', items: [], loading: false };
  let stream = null;
  let timerHandle = null;

  // ============================ بناء الصفحة (مرة واحدة) ============================
  function ensurePage() {
    if ($('auctionsPage')) return;
    const page = document.createElement('div');
    page.id = 'auctionsPage';
    page.className = 'app-page';
    page.innerHTML = `
      <button class="back-btn-custom" onclick="navigateTo('mainPage')"><i class="fa-solid fa-arrow-right"></i> العودة للرئيسية</button>
      <div class="page-title"><i class="fa-solid fa-gavel"></i> المزادات الإلكترونية</div>

      <div id="aucWalletBar" class="calculator-card" style="padding:12px 14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div style="font-size:12px;color:var(--text-muted);">
          <i class="fa-solid fa-wallet" style="color:#10b981"></i>
          الرصيد المتاح: <b id="aucAvail" style="color:#0a2540">—</b>
          · المحجوز: <b id="aucHeld" style="color:#f59e0b">—</b>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="copy-btn" id="aucTopUpBtn" style="width:auto;padding:6px 12px;background:#10b981;display:none;" onclick="AuctionUI.demoCredit()">شحن رصيد تجريبي (للعرض)</button>
          <button class="copy-btn" id="aucCreateBtn" style="width:auto;padding:6px 12px;background:#0a2540;display:none;" onclick="AuctionUI.openCreate()">+ إنشاء مزاد</button>
        </div>
      </div>

      <div class="filter-buttons" style="margin-bottom:10px;">
        <button class="filter-btn active" onclick="AuctionUI.setTab('active', event)">نشطة</button>
        <button class="filter-btn" onclick="AuctionUI.setTab('upcoming', event)">قادمة</button>
        <button class="filter-btn" onclick="AuctionUI.setTab('ended', event)">منتهية</button>
        <button class="filter-btn" onclick="AuctionUI.setTab('mine', event)">مزايداتي</button>
        <button class="filter-btn" onclick="AuctionUI.setTab('watching', event)">متابعاتي</button>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <input id="aucSearch" type="text" placeholder="ابحث في المزادات..." oninput="AuctionUI.onSearch(this.value)"
               style="flex:2;min-width:150px;padding:10px 12px;border-radius:12px;border:1px solid var(--border-color);background:var(--field-bg);font-family:Cairo,sans-serif;font-size:13px;">
        <select id="aucCategory" onchange="AuctionUI.setCategory(this.value)" style="flex:1;min-width:120px;padding:10px;border-radius:12px;border:1px solid var(--border-color);background:var(--field-bg);font-family:Cairo,sans-serif;font-size:13px;">
          <option value="">كل التصنيفات</option>
          ${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <select id="aucSort" onchange="AuctionUI.setSort(this.value)" style="flex:1;min-width:120px;padding:10px;border-radius:12px;border:1px solid var(--border-color);background:var(--field-bg);font-family:Cairo,sans-serif;font-size:13px;">
          <option value="ending">الأقرب انتهاءً</option>
          <option value="newest">الأحدث</option>
          <option value="price">الأعلى سعرًا</option>
          <option value="bids">الأكثر مزايدات</option>
        </select>
      </div>

      <div id="aucList"></div>
      <div id="aucServerNote" style="display:none;margin-top:10px;padding:10px 12px;border-radius:12px;background:#fef3c7;color:#92400e;font-size:12px;line-height:1.8;"></div>
    `;
    $('appContainer').insertBefore(page, document.querySelector('.bottom-nav'));

    // زر في شبكة الخدمات (clone لبطاقة قائمة للحفاظ على التصميم)
    const grid = $('servicesGrid');
    if (grid && !$('auctionsServiceCard')) {
      const card = document.createElement('div');
      card.className = 'service-card';
      card.id = 'auctionsServiceCard';
      card.setAttribute('onclick', "navigateTo('auctionsPage')");
      card.innerHTML = `<div class="icon-wrapper"><i class="fa-solid fa-gavel" style="color:#d40511;"></i></div><span class="service-title">المزادات</span>`;
      grid.appendChild(card);
    }
  }

  // ============================ أدوات العرض ============================
  function fmtLeft(sec) {
    if (sec <= 0) return 'انتهى';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d > 0) return `${d} يوم و${h} ساعة`;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function statusBadge(a) {
    const map = {
      active: ['● جارٍ', '#d1fae5', '#047857'],
      upcoming: ['⏳ لم يبدأ', '#dbeafe', '#1d4ed8'],
      ended: ['انتهى دون بيع', '#fee2e2', '#b91c1c'],
      settled: ['✅ تم البيع', '#e5e7eb', '#374151'],
      cancelled: ['⛔ ملغى', '#f3f4f6', '#6b7280']
    };
    const [t, bg, c] = map[a.status] || ['—', '#eee', '#333'];
    return `<span style="background:${bg};color:${c};padding:3px 9px;border-radius:20px;font-size:10.5px;font-weight:700;">${t}</span>`;
  }

  function cardHtml(a) {
    const demoBadge = a.demo
      ? `<span style="background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;">عرض تجريبي</span>`
      : '';
    const price = a.current_bid != null ? money(a.current_bid) : money(a.start_price);
    const label = a.current_bid != null ? 'أعلى مزايدة' : 'سعر البداية';
    return `
      <div class="calculator-card" style="margin-bottom:10px;padding:14px;" id="aucCard-${a.id}">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
          <div style="flex:1;">
            <div style="font-weight:800;font-size:14px;color:#0a2540;line-height:1.6;">${escapeHtml(a.title)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">${CATS[a.category] || a.category || '—'} ${a.location ? '· ' + escapeHtml(a.location) : ''}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
            ${statusBadge(a)} ${demoBadge}
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;background:var(--field-bg);border-radius:12px;padding:9px 11px;">
          <div>
            <div style="font-size:10px;color:var(--text-muted);">${label}</div>
            <div style="font-size:17px;font-weight:800;color:#10b981;" data-price="${a.id}">${price}</div>
          </div>
          <div style="text-align:left;">
            <div style="font-size:10px;color:var(--text-muted);">المزايدات</div>
            <div style="font-size:15px;font-weight:800;color:#0a2540;" data-bids="${a.id}">${a.bid_count}</div>
          </div>
          <div style="text-align:left;">
            <div style="font-size:10px;color:var(--text-muted);">${a.status === 'active' ? 'الوقت المتبقي' : a.status === 'upcoming' ? 'يبدأ بعد' : 'الحالة'}</div>
            <div style="font-size:13px;font-weight:800;color:#d40511;" data-timer="${a.id}" data-ends="${a.ends_at}" data-starts="${a.starts_at}" data-status="${a.status}">
              ${a.status === 'active' ? fmtLeft(a.seconds_left) : a.status === 'upcoming' ? fmtLeft(a.seconds_to_start) : statusBadge(a)}
            </div>
          </div>
        </div>

        ${a.my_bid ? `<div style="font-size:11px;margin-top:7px;color:${a.my_bid.status === 'winning' ? '#047857' : '#b45309'};">
            مزايدتك: ${money(a.my_bid.amount)} — ${a.my_bid.status === 'winning' ? 'أنت الأعلى حاليًا ✅' : a.my_bid.status === 'won' ? 'فزت 🎉' : 'تم تجاوزها'}
          </div>` : ''}

        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="copy-btn" style="flex:1;background:#0a2540;" onclick="AuctionUI.openDetail('${a.id}')">التفاصيل والمزايدة</button>
          <button class="copy-btn" style="width:44px;background:${a.watching ? '#f59e0b' : '#6b7280'};" title="${a.watching ? 'إلغاء المتابعة' : 'متابعة'}" onclick="AuctionUI.toggleWatch('${a.id}')">
            <i class="fa-${a.watching ? 'solid' : 'regular'} fa-star"></i>
          </button>
        </div>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ============================ الجلب والعرض ============================
  async function loadWallet() {
    try {
      const w = await rq('/api/wallet/me');
      if (w && w.ok) {
        $('aucAvail').textContent = money(w.balance.available);
        $('aucHeld').textContent = money(w.balance.held);
        $('aucTopUpBtn').style.display = w.balance.available <= 0 ? 'inline-block' : 'none';
      }
    } catch (_) {}
  }

  async function render() {
    ensurePage();
    if (!API.hasSession) {
      $('aucList').innerHTML = `<div class="calculator-card" style="text-align:center;padding:26px;font-size:13px;">
        🔐 سجّل الدخول لعرض المزادات والمشاركة فيها.
        <div style="margin-top:10px;"><button class="copy-btn" style="width:auto;padding:8px 16px;" onclick="navigateTo('mainPage')">العودة</button></div>
      </div>`;
      return;
    }
    if (state.tab === 'mine') return renderMine();
    if (state.tab === 'watching') return renderWatching();

    state.loading = true;
    $('aucList').innerHTML = `<div class="calculator-card" style="text-align:center;padding:20px;font-size:12px;color:#6b7280;">⏳ جلب المزادات من الخادم…</div>`;
    try {
      const params = { status: state.tab === 'ended' ? 'all' : state.tab, limit: 40, sort: state.sort };
      if (state.category) params.category = state.category;
      if (state.q) params.q = state.q;
      const qs = new URLSearchParams(params).toString();
      const res = await rq('/api/auctions?' + qs);
      if (!res.ok) throw new Error(res.error || 'فشل الجلب');
      let items = res.items;
      if (state.tab === 'ended') items = items.filter((a) => ['ended', 'settled', 'cancelled'].includes(a.status));
      state.items = items;
      $('aucList').innerHTML = items.length
        ? items.map(cardHtml).join('')
        : `<div class="calculator-card" style="text-align:center;padding:26px;font-size:13px;color:#6b7280;">لا توجد مزادات مطابقة.</div>`;
      startTicking();
      await loadWallet();
    } catch (e) {
      $('aucList').innerHTML = `<div class="calculator-card" style="text-align:center;padding:22px;font-size:12.5px;color:#b91c1c;">
        تعذّر جلب المزادات من الخادم: ${escapeHtml(e.message)}<br>
        <span style="color:#6b7280;line-height:1.9;">المزادات تعتمد على وقت الخادم للتحقق من المزايدات، لذلك لا تُعرض بيانات محلية بديلة.</span></div>`;
    } finally { state.loading = false; }
  }

  function showOffline() {
    $('aucList').innerHTML = `<div class="calculator-card" style="padding:18px;font-size:12.5px;line-height:1.9;color:#92400e;background:#fff7ed;">
      <b>الخادم غير متاح حاليًا.</b><br>المزادات تحتاج خادمًا للتحقق من الوقت والمزايدات ومنع التلاعب،
      لذلك لا تُعرض بيانات محلية بديلة. شغّل الخادم ثم أعد المحاولة.
    </div>`;
  }

  async function renderMine() {
    $('aucList').innerHTML = `<div class="calculator-card" style="text-align:center;padding:20px;font-size:12px;color:#6b7280;">⏳ جلب مزايداتك…</div>`;
    try {
      const res = await rq('/api/auctions/mine/bids');
      if (!res.ok) throw new Error(res.error || 'فشل');
      if (!res.items.length) { $('aucList').innerHTML = `<div class="calculator-card" style="text-align:center;padding:24px;font-size:13px;color:#6b7280;">لم تُقدّم أي مزايدة بعد.</div>`; return; }
      $('aucList').innerHTML = res.items.map((b) => `
        <div class="calculator-card" style="padding:12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;gap:8px;">
            <div style="font-weight:700;font-size:13px;">${escapeHtml(b.auction ? b.auction.title : 'مزاد محذوف')}</div>
            <div style="font-weight:800;color:${b.status === 'winning' ? '#047857' : b.status === 'won' ? '#10b981' : '#b45309'};font-size:13px;">${money(b.amount)}</div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            ${b.status === 'winning' ? 'أنت الأعلى حاليًا' : b.status === 'won' ? 'فزت بالمزاد 🎉' : b.status === 'outbid' ? 'تم تجاوزك' : b.status === 'not_reserved' ? 'لم يُستوفَ سعر الحجز' : b.status}
            · ${new Date(b.created_at).toLocaleString('ar-EG')}
          </div>
        </div>`).join('');
    } catch (e) {
      $('aucList').innerHTML = `<div class="calculator-card" style="padding:16px;color:#b91c1c;font-size:12.5px;">تعذّر الجلب: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function renderWatching() {
    $('aucList').innerHTML = `<div class="calculator-card" style="text-align:center;padding:20px;font-size:12px;color:#6b7280;">⏳ جلب متابعاتك…</div>`;
    try {
      const favs = await API.favorites();
      const ids = (favs.items || []).filter((f) => f.item_type === 'auction').map((f) => f.item_id);
      if (!ids.length) { $('aucList').innerHTML = `<div class="calculator-card" style="text-align:center;padding:24px;font-size:13px;color:#6b7280;">لا تتابع أي مزاد بعد — اضغط النجمة على أي مزاد.</div>`; return; }
      const all = await Promise.all(ids.map((id) => rq('/api/auctions/' + id).catch(() => null)));
      const items = all.filter((x) => x && x.ok).map((x) => x.auction);
      $('aucList').innerHTML = items.length ? items.map(cardHtml).join('') : `<div class="calculator-card" style="padding:18px;text-align:center;font-size:13px;color:#6b7280;">المزادات المتابَعة لم تعد متاحة.</div>`;
      startTicking();
    } catch (e) {
      $('aucList').innerHTML = `<div class="calculator-card" style="padding:16px;color:#b91c1c;font-size:12.5px;">تعذّر الجلب: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ============================ العدّاد (ساعة الخادم) ============================
  function startTicking() {
    if (timerHandle) clearInterval(timerHandle);
    const tick = () => {
      document.querySelectorAll('[data-timer]').forEach((el) => {
        const st = el.getAttribute('data-status');
        const ends = new Date(el.getAttribute('data-ends')).getTime();
        const starts = new Date(el.getAttribute('data-starts')).getTime();
        const now = Date.now() + serverOffset;
        if (st === 'active') {
          const left = Math.round((ends - now) / 1000);
          el.textContent = fmtLeft(left);
          if (left <= 0) el.textContent = 'جارٍ الإغلاق…';
          el.style.color = left <= 60 ? '#d40511' : '#123c63';
        } else if (st === 'upcoming') {
          el.textContent = fmtLeft(Math.round((starts - now) / 1000));
        }
      });
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  // ============================ التفاصيل والمزايدة ============================
  async function openDetail(id) {
    try {
      const res = await rq('/api/auctions/' + id);
      if (!res.ok) throw new Error(res.error);
      const a = res.auction;
      window.__aucOpen = a;
      const bidsHtml = (a.bids || []).length
        ? a.bids.map((b) => `<div style="display:flex;justify-content:space-between;font-size:11.5px;padding:4px 0;border-bottom:1px dashed #e5e7eb;">
            <span>${escapeHtml(b.bidder)} ${b.status === 'winning' ? '<b style="color:#047857">(الأعلى)</b>' : b.status === 'won' ? '<b style="color:#10b981">(فائز)</b>' : ''}</span>
            <span><b>${money(b.amount)}</b> · ${new Date(b.at).toLocaleTimeString('ar-EG')}</span>
          </div>`).join('')
        : `<div style="font-size:12px;color:#6b7280;padding:6px 0;">لا مزايدات بعد — كن أول المزايدين.</div>`;

      const canBid = a.status === 'active' && (!a.my_bid || a.my_bid.status !== 'winning');
      $('modalTitle').innerHTML = `🔨 ${escapeHtml(a.title)}`;
      $('modalBody').innerHTML = `
        <div class="info-grid">
          <div class="info-item"><span class="info-label">الحالة</span><span class="info-value">${statusBadge(a)}</span></div>
          <div class="info-item"><span class="info-label">${a.status === 'active' ? 'الوقت المتبقي' : 'الانتهاء'}</span>
            <span class="info-value" data-timer="${a.id}" data-ends="${a.ends_at}" data-starts="${a.starts_at}" data-status="${a.status}">${fmtLeft(a.seconds_left)}</span></div>
          <div class="info-item"><span class="info-label">أعلى مزايدة</span><span class="info-value" style="color:#10b981">${a.current_bid != null ? money(a.current_bid) : 'لا يوجد'}</span></div>
          <div class="info-item"><span class="info-label">الحد الأدنى التالي</span><span class="info-value">${money(a.min_next_bid)}</span></div>
          <div class="info-item"><span class="info-label">عدد المزايدات</span><span class="info-value">${a.bid_count}</span></div>
          <div class="info-item"><span class="info-label">سعر البداية</span><span class="info-value">${money(a.start_price)}</span></div>
          <div class="info-item"><span class="info-label">حد الزيادة</span><span class="info-value">${money(a.bid_increment)}</span></div>
          <div class="info-item"><span class="info-label">الموقع</span><span class="info-value">${escapeHtml(a.location || '—')}</span></div>
          <div class="info-item full-width"><span class="info-label">الوصف</span><span class="info-value">${escapeHtml(a.description || '—')}</span></div>
          ${a.demo ? `<div class="info-item full-width"><span class="info-label">تنبيه</span><span class="info-value" style="color:#6d28d9">عرض تجريبي — لا يمثل سلعة أو مالًا حقيقيًا.</span></div>` : ''}
        </div>

        ${a.status === 'active' ? `
        <div style="margin-top:12px;padding:12px;border-radius:12px;background:var(--field-bg);">
          <div style="font-size:12px;font-weight:700;margin-bottom:6px;">قدّم مزايدتك</div>
          <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
            ${[a.min_next_bid, a.min_next_bid + a.bid_increment, a.min_next_bid + 2 * a.bid_increment].map((v) => `
              <button class="copy-btn" style="width:auto;padding:6px 10px;background:#e5e7eb;color:#0a2540;" onclick="AuctionUI.setAmount(${v})">${money(v)}</button>`).join('')}
          </div>
          <div style="display:flex;gap:6px;">
            <input id="aucBidInput" type="number" min="${a.min_next_bid}" step="${a.bid_increment}" value="${a.min_next_bid}"
                   style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border-color);font-size:14px;font-family:Cairo,sans-serif;">
            <button class="copy-btn" style="width:auto;padding:10px 16px;background:#10b981;" ${canBid ? '' : 'disabled'} onclick="AuctionUI.submitBid('${a.id}')">
              ${canBid ? 'مزايدة' : 'أنت الأعلى'}
            </button>
          </div>
          <div id="aucBidMsg" style="font-size:11.5px;margin-top:6px;color:#b91c1c;"></div>
          <div style="font-size:10.5px;color:#9ca3af;margin-top:4px;">يُحجز المبلغ من رصيدك فورًا ويُحرَّر تلقائيًا إذا تجاوزك أحد. الوقت المُعتمد هو وقت الخادم.</div>
        </div>` : `<div style="margin-top:10px;font-size:12px;color:#6b7280;">${a.status === 'settled' && a.winner ? `الفائز: ${escapeHtml(a.winner.name || '')} بمبلغ ${money(a.winner.amount)}` : a.status === 'ended' ? 'انتهى المزاد دون بيع (لا مزايدات أو لم يُستوفَ سعر الحجز).' : 'المزاد غير مفتوح للمزايدة.'}</div>`}

        <div style="margin-top:14px;">
          <div style="font-weight:700;font-size:12.5px;margin-bottom:4px;">📋 سجل المزايدات</div>
          <div style="max-height:180px;overflow-y:auto;">${bidsHtml}</div>
        </div>

        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="copy-btn" style="flex:1;background:#6b7280;" onclick="AuctionUI.toggleWatch('${a.id}', true)">${a.watching ? '★ إلغاء المتابعة' : '☆ متابعة المزاد'}</button>
          ${a.status === 'active' ? `<button class="copy-btn" style="flex:1;background:#0a2540;" onclick="AuctionUI.refreshAfterBid('${a.id}')">🔄 تحديث</button>` : ''}
        </div>
      `;
      $('modal').classList.add('show');
      startTicking();
    } catch (e) {
      try { window.showToast('تعذّر فتح المزاد: ' + e.message); } catch (_) {}
    }
  }

  function setAmount(v) { const el = $('aucBidInput'); if (el) el.value = v; }

  async function submitBid(id) {
    const input = $('aucBidInput');
    const msg = $('aucBidMsg');
    const amount = Number(input && input.value);
    if (!(amount > 0)) { if (msg) msg.textContent = 'أدخل مبلغًا صحيحًا'; return; }
    if (msg) msg.textContent = '⏳ جارٍ إرسال المزايدة…';
    try {
      const res = await rq('/api/auctions/' + id + '/bids', { method: 'POST', body: { amount } });
      if (!res.ok) {
        if (msg) {
          msg.innerHTML = escapeHtml(res.error || 'فشلت المزايدة');
          if (/الرصيد/.test(res.error || '')) msg.innerHTML += `<div style="margin-top:6px;"><button class="copy-btn" style="width:auto;padding:5px 10px;background:#10b981;" onclick="AuctionUI.demoCredit()">شحن رصيد تجريبي للعرض</button></div>`;
        }
        return;
      }
      try { window.showToast(res.extended ? '✅ مزايدتك مسجّلة — مُدِّد المزاد لمنع القنص' : '✅ مزايدتك هي الأعلى الآن'); } catch (_) {}
      await loadWallet();
      await openDetail(id);
      await render();
    } catch (e) {
      if (msg) msg.textContent = 'تعذّر الاتصال بالخادم: ' + e.message;
    }
  }

  function refreshAfterBid(id) { openDetail(id); }

  async function toggleWatch(id, fromModal) {
    try {
      let currentlyWatching = false;
      if (fromModal && window.__aucOpen) currentlyWatching = !!window.__aucOpen.watching;
      else {
        const all = await API.favorites().catch(() => ({ items: [] }));
        currentlyWatching = (all.items || []).some((f) => f.item_type === 'auction' && f.item_id === id);
      }
      const res = await rq('/api/auctions/' + id + '/watch', { method: currentlyWatching ? 'DELETE' : 'POST' });
      if (res.ok) {
        try { window.showToast(res.watching ? '⭐ أُضيف إلى متابعاتك' : 'أُزيل من المتابعات'); } catch (_) {}
        if (fromModal) openDetail(id);
        if (state.tab === 'watching') renderWatching(); else render();
      }
    } catch (_) {}
  }

  async function demoCredit() {
    try {
      const res = await rq('/api/wallet/demo-credit', { method: 'POST', body: { amount: 5000 } });
      if (res.ok) {
        try { window.showToast('شُحن رصيد تجريبي للعرض — ليس مالًا حقيقيًا'); } catch (_) {}
        await loadWallet();
      } else {
        try { window.showToast(res.error || 'تعذّر الشحن'); } catch (_) {}
      }
    } catch (_) {}
  }


  // ============================ إنشاء مزاد (للموظفين فقط) ============================
  const ROLE_RANK = { user: 1, agent: 2, support_staff: 3, shipping_staff: 4, branch_manager: 5, warehouse_manager: 5, super_admin: 9 };
  function canCreate() {
    const role = (window.MASAR && window.MASAR.user && window.MASAR.user.role) || '';
    return (ROLE_RANK[role] || 0) >= 4;
  }
  function syncCreateButton() {
    const b = $('aucCreateBtn');
    if (b) b.style.display = canCreate() ? 'inline-block' : 'none';
  }

  function openCreate() {
    if (!canCreate()) { try { window.showToast('إنشاء المزادات متاح لموظفي الشركة فقط'); } catch (_) {} return; }
    $('modalTitle').innerHTML = '➕ إنشاء مزاد جديد';
    $('modalBody').innerHTML = `
      <div style="display:grid;gap:8px;">
        <input id="cfTitle" placeholder="عنوان المزاد *" style="padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;">
        <textarea id="cfDesc" rows="2" placeholder="الوصف" style="padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;"></textarea>
        <select id="cfCat" style="padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;">
          ${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <input id="cfLocation" placeholder="الموقع (مثل: ميناء عدن)" style="padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;">
        <div style="display:flex;gap:8px;">
          <input id="cfStart" type="number" min="1" placeholder="سعر البداية $ *" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;">
          <input id="cfInc" type="number" min="5" value="5" placeholder="الزيادة $" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;">
        </div>
        <div style="display:flex;gap:8px;">
          <input id="cfHours" type="number" min="1" value="24" placeholder="المدة (ساعة)" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;">
          <input id="cfReserve" type="number" min="0" placeholder="سعر الحجز $" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;">
        </div>
        <div style="font-size:11px;color:#6b7280;line-height:1.8;">سعر البداية والزيادة بالدولار · أقل زيادة 5$ · المدة من 1 ساعة إلى 90 يومًا · المزاد يبدأ فورًا ويُدار بوقت الخادم.</div>
        <div id="cfMsg" style="font-size:11.5px;color:#b91c1c;"></div>
        <button class="copy-btn" style="background:#10b981;" onclick="AuctionUI.submitCreate()">نشر المزاد</button>
      </div>`;
    $('modal').classList.add('show');
  }

  async function submitCreate() {
    const msg = $('cfMsg');
    const payload = {
      title: ($('cfTitle').value || '').trim(),
      description: ($('cfDesc').value || '').trim(),
      category: $('cfCat').value,
      location: ($('cfLocation').value || '').trim() || null,
      start_price: Number($('cfStart').value),
      bid_increment: Number($('cfInc').value) || undefined,
      ends_at: new Date(Date.now() + (Number($('cfHours').value) || 24) * 3600e3).toISOString(),
      reserve_price: Number($('cfReserve').value) || undefined
    };
    if (payload.title.length < 4) { msg.textContent = 'العنوان قصير جدًا'; return; }
    if (!(payload.start_price > 0)) { msg.textContent = 'أدخل سعر بداية صحيحًا'; return; }
    msg.textContent = '⏳ جارٍ النشر…';
    try {
      const res = await rq('/api/auctions', { method: 'POST', body: payload });
      if (!res.ok && !res.auction) { msg.textContent = res.error || 'تعذّر إنشاء المزاد'; return; }
      try { window.showToast('✅ نُشر المزاد وأصبح متاحًا للمزايدة'); } catch (_) {}
      const id = res.auction && res.auction.id;
      await render();
      if (id) openDetail(id);
    } catch (e) { msg.textContent = 'تعذّر الاتصال بالخادم: ' + e.message; }
  }

  // ============================ التحديث اللحظي ============================
  function startStream() {
    if (stream || !API.hasSession) return;
    stream = API.stream(['auctions'], {
      auction_bid: (m) => {
        const p = m.payload || {};
        const priceEl = document.querySelector(`[data-price="${p.auction_id}"]`);
        const bidsEl = document.querySelector(`[data-bids="${p.auction_id}"]`);
        if (priceEl) priceEl.textContent = money(p.current_bid);
        if (bidsEl) bidsEl.textContent = p.bid_count;
        const card = document.querySelector(`[data-timer="${p.auction_id}"]`);
        if (card && p.ends_at) card.setAttribute('data-ends', p.ends_at);
      },
      auction_closed: (m) => {
        const p = m.payload || {};
        if (p.outcome === 'sold') {
          try { window.showToast(`🔔 أُغلق مزاد بمبلغ ${money(p.amount)}`); } catch (_) {}
        }
        const t = document.querySelector(`[data-timer="${p.id}"]`);
        if (t) { t.setAttribute('data-status', 'settled'); t.textContent = 'أُغلق'; }
        if (['active', 'ended'].includes(state.tab)) render();
      },
      auction_created: () => { if (state.tab === 'active' || state.tab === 'upcoming') render(); }
    });
  }

  // ============================ ربط الأحداث ============================
  const origNavigate = window.navigateTo;
  window.navigateTo = function (pageId) {
    if (typeof origNavigate === 'function') origNavigate(pageId);
    if (pageId === 'auctionsPage') { ensurePage(); syncCreateButton(); render(); startStream(); loadWallet(); }
  };

  async function initOffset() {
    try {
      const h = await rq('/api/health', { auth: false });
      if (h.time) serverOffset = new Date(h.time).getTime() - Date.now();
    } catch (_) {}
  }

  const AuctionUI = {
    setTab(tab, ev) {
      state.tab = tab;
      document.querySelectorAll('#auctionsPage .filter-btn').forEach((b) => b.classList.remove('active'));
      if (ev && ev.target) ev.target.classList.add('active');
      render();
    },
    setCategory(v) { state.category = v; render(); },
    setSort(v) { state.sort = v; render(); },
    onSearch(v) { clearTimeout(window.__aucSearchT); window.__aucSearchT = setTimeout(() => { state.q = v; render(); }, 350); },
    openDetail, submitBid, setAmount, toggleWatch, demoCredit, refreshAfterBid,
    openCreate, submitCreate, canCreate,
    render, loadWallet
  };
  window.AuctionUI = AuctionUI;

  // إقلاع
  function boot() { ensurePage(); syncCreateButton(); initOffset(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
