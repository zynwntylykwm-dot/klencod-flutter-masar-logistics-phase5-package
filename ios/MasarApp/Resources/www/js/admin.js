/**
 * admin.js — لوحة الإدارة المتكاملة (المرحلة 3)
 * ---------------------------------------------
 * تظهر كقسم داخل «الإعدادات» وتفتح صفحة إدارة كاملة بنفس تصميم النظام:
 *   نظرة عامة على الخادم · المستخدمون · العملاء · الزوار · الإشعارات · سجل التدقيق
 * كل العمليات تُنفَّذ على الخادم عبر /api/admin/* (الصلاحيات تُفحص هناك لا هنا).
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const BASE = (window.MASAR_API_BASE || '').replace(/\/$/, '');
  const token = () => { try { return localStorage.getItem('masar.access') || ''; } catch (e) { return ''; } };
  const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dt = (iso) => iso ? new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const toast = (m) => { try { window.showToast(m); } catch (e) { console.log(m); } };

  const ROLE_RANK = { user: 1, agent: 2, support_staff: 3, shipping_staff: 4, branch_manager: 5, warehouse_manager: 5, super_admin: 9 };
  const ROLE_LABEL = { user: 'مستخدم', agent: 'وكيل', support_staff: 'دعم فني', shipping_staff: 'موظف شحن', branch_manager: 'مدير فرع', warehouse_manager: 'مدير مستودع', super_admin: 'مدير عام' };
  const STATUS_LABEL = { active: 'نشط', pending: 'بانتظار الموافقة', suspended: 'موقوف', deleted: 'محذوف' };
  const STATUS_STYLE = { active: 'background:#d1fae5;color:#047857', pending: 'background:#fef3c7;color:#b45309', suspended: 'background:#fee2e2;color:#b91c1c', deleted: 'background:#e5e7eb;color:#374151' };

  function role() { return (window.MASAR && window.MASAR.user && window.MASAR.user.role) || ''; }
  function canManage() { return (ROLE_RANK[role()] || 0) >= 5; }
  function isSuper() { return role() === 'super_admin'; }

  async function rq(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token()) headers.authorization = 'Bearer ' + token();
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
    if (!res.ok || data.ok === false) throw new Error(data.error || 'فشل الطلب (' + res.status + ')');
    return data;
  }

  const state = { tab: 'overview', users: { q: '', kind: '', status: '' }, visitors: { q: '' }, server: null };

  // ============================ صفحة الإدارة ============================
  function ensurePage() {
    if ($('adminPage')) return;
    const page = document.createElement('div');
    page.id = 'adminPage';
    page.className = 'app-page';
    page.innerHTML = `
      <button class="back-btn-custom" onclick="navigateTo('settingsPage')"><i class="fa-solid fa-arrow-right"></i> العودة للإعدادات</button>
      <div class="page-title"><i class="fa-solid fa-user-shield"></i> لوحة الإدارة</div>
      <div class="filter-buttons" style="margin-bottom:12px;flex-wrap:wrap;">
        <button class="filter-btn active" data-atab="overview" onclick="AdminUI.tab('overview',event)">الخادم</button>
        <button class="filter-btn" data-atab="users" onclick="AdminUI.tab('users',event)">المستخدمون</button>
        <button class="filter-btn" data-atab="clients" onclick="AdminUI.tab('clients',event)">العملاء</button>
        <button class="filter-btn" data-atab="visitors" onclick="AdminUI.tab('visitors',event)">الزوار</button>
        <button class="filter-btn" data-atab="notify" onclick="AdminUI.tab('notify',event)">الإشعارات</button>
        <button class="filter-btn" data-atab="pricing" onclick="AdminUI.tab('pricing',event)">التسعير</button>
        <button class="filter-btn" data-atab="reports" onclick="AdminUI.tab('reports',event)">التقارير</button>
        <button class="filter-btn" data-atab="carriers" onclick="AdminUI.tab('carriers',event)">الشحن والتتبّع</button>
        <button class="filter-btn" data-atab="assistant" onclick="AdminUI.tab('assistant',event)">المساعد الذكي</button>
        <button class="filter-btn" data-atab="audit" onclick="AdminUI.tab('audit',event)">السجل</button>
      </div>
      <div id="adminBody"></div>
    `;
    const container = $('appContainer') || document.body;
    const nav = document.querySelector('.bottom-nav');
    container.insertBefore(page, nav || null);
  }

  async function render() {
    ensurePage();
    if (!window.API || !API.hasSession) return body(`<div class="calculator-card" style="padding:18px;font-size:13px;">🔐 سجّل الدخول للوصول إلى لوحة الإدارة.</div>`);
    if (!canManage()) return body(`<div class="calculator-card" style="padding:18px;font-size:13px;color:#b91c1c;">هذه اللوحة متاحة لمدير الفرع والمدير العام فقط (رتبتك: ${ROLE_LABEL[role()] || role() || 'غير معروف'}).</div>`);
    body(`<div class="calculator-card" style="text-align:center;padding:18px;font-size:12px;color:#6b7280;">⏳ تحميل…</div>`);
    try {
      if (state.tab === 'overview') await renderOverview();
      else if (state.tab === 'users') await renderUsers();
      else if (state.tab === 'clients') await renderClients();
      else if (state.tab === 'visitors') await renderVisitors();
      else if (state.tab === 'notify') await renderNotify();
      else if (state.tab === 'pricing') await renderPricing();
      else if (state.tab === 'reports') await renderReports();
      else if (state.tab === 'carriers') await renderCarriers();
      else if (state.tab === 'assistant') await renderAssistant();
      else if (state.tab === 'audit') await renderAudit();
    } catch (e) {
      body(`<div class="calculator-card" style="padding:16px;color:#b91c1c;font-size:12.5px;">تعذّر التحميل من الخادم: ${esc(e.message)}</div>`);
    }
  }

  const body = (html) => { const el = $('adminBody'); if (el) el.innerHTML = html; };

  // ============================ نظرة عامة ============================
  async function renderOverview() {
    const s = await rq('/api/admin/server');
    state.server = s;
    const c = s.counts;
    const stat = (v, l, color) => `<div class="stat" style="text-align:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:9px;"><b style="display:block;font-size:17px;color:${color || '#0a2540'};">${v}</b><span style="font-size:10.5px;color:#64748b;">${l}</span></div>`;
    const ch = (k, v) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed #e5e7eb;">
        <span style="font-size:12px;font-weight:700;">${k}</span>
        <span style="font-size:11px;padding:2px 8px;border-radius:20px;${v.ready ? 'background:#d1fae5;color:#047857' : 'background:#fef3c7;color:#b45309'};">${v.ready ? 'جاهز' : 'غير مهيّأ'}</span>
      </div><div style="font-size:10.5px;color:#6b7280;padding-bottom:6px;">${esc(v.note)}</div>`;
    body(`
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <b style="font-size:13px;">حالة الخادم</b>
          <span style="font-size:11px;color:#047857;">● يعمل ${Math.floor(s.uptime_s / 60)} دقيقة</span>
        </div>
        <div style="font-size:11px;color:#6b7280;line-height:1.9;">
          الإصدار: ${esc(s.version)} · Node ${esc(s.node)} · الذاكرة ${s.memory_mb}MB<br>
          التخزين: ${esc(s.storage)} · المجلد: <span style="direction:ltr;display:inline-block;">${esc(s.data_dir)}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px;">
          ${stat(c.users, 'مستخدم')}${stat(c.staff, 'موظف')}${stat(c.clients, 'عميل')}${stat(c.visitors, 'زائر')}
          ${stat(c.active_users, 'نشط', '#047857')}${stat(c.pending_users, 'بانتظار الموافقة', '#b45309')}${stat(c.sessions, 'جلسة')}${stat(c.shipments, 'شحنة')}
          ${stat(c.auctions, 'مزاد')}${stat(c.bids, 'مزايدة')}${stat(c.campaigns, 'حملة')}${stat(c.audit, 'حدث تدقيق')}
        </div>
      </div>
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">قنوات الإشعارات</b>
        ${ch('داخل التطبيق + SSE', s.push_channels.inapp)}
        ${ch('Web Push (أندرويد/iOS)', s.push_channels.webpush)}
        ${ch('FCM — أندرويد أصلي', s.push_channels.fcm)}
        ${ch('APNs — آيفون أصلي', s.push_channels.apns)}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          <button class="copy-btn" style="width:auto;padding:7px 12px;background:#10b981;" onclick="AdminUI.enablePush()">🔔 تفعيل الإشعارات على هذا الجهاز</button>
          <button class="copy-btn" style="width:auto;padding:7px 12px;background:#0a2540;" onclick="AdminUI.testPush()">إرسال إشعار تجريبي</button>
          ${isSuper() ? `<button class="copy-btn" style="width:auto;padding:7px 12px;background:#6b7280;" onclick="AdminUI.downloadBackup()">⬇️ نسخة احتياطية</button>` : ''}
        </div>
        <div id="pushMsg" style="font-size:11px;color:#6b7280;margin-top:6px;"></div>
      </div>
      <div class="calculator-card" style="padding:14px;">
        <b style="font-size:13px;">العملاء والموظفون</b>
        <div style="font-size:11.5px;color:#6b7280;margin-top:6px;line-height:1.9;">
          الاشتراكات المفعّلة للدفع: <b>${c.push_subscriptions}</b> · أجهزة مسجّلة: <b>${c.device_tokens}</b><br>
          الزوار المسجّلون: <b>${c.visitors}</b> · الإشعارات المرسلة: <b>${c.notifications}</b>
        </div>
      </div>
    `);
  }

  // ============================ المستخدمون ============================
  function userCard(u) {
    const canEdit = (ROLE_RANK[u.role] || 0) < (ROLE_RANK[role()] || 0);
    return `
      <div class="calculator-card" style="padding:12px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
          <div style="flex:1;">
            <div style="font-weight:800;font-size:13px;color:#0a2540;">${esc(u.fullName || u.username)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(u.role_label)} · ${esc(u.username)}${u.phone ? ' · ' + esc(u.phone) : ''}</div>
            <div style="font-size:10.5px;color:#9ca3af;margin-top:2px;">أُنشئ: ${dt(u.created_at)}</div>
          </div>
          <span style="font-size:10.5px;padding:2px 8px;border-radius:20px;${STATUS_STYLE[u.status] || ''}">${STATUS_LABEL[u.status] || u.status}</span>
        </div>
        ${canEdit ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;">
          ${u.status !== 'active' ? `<button class="copy-btn" style="width:auto;padding:5px 10px;background:#10b981;font-size:11px;" onclick="AdminUI.actUser('${u.id}','active')">تفعيل</button>` : `<button class="copy-btn" style="width:auto;padding:5px 10px;background:#f59e0b;font-size:11px;" onclick="AdminUI.actUser('${u.id}','suspended')">إيقاف</button>`}
          <select style="font-size:11px;padding:4px 6px;border-radius:8px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;" onchange="AdminUI.changeRole('${u.id}',this.value)">
            ${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <button class="copy-btn" style="width:auto;padding:5px 10px;background:#0a2540;font-size:11px;" onclick="AdminUI.resetPassword('${u.id}')">🔑 كلمة مرور جديدة</button>
          <button class="copy-btn" style="width:auto;padding:5px 10px;background:#d40511;font-size:11px;" onclick="AdminUI.removeUser('${u.id}')">حذف</button>
        </div>` : `<div style="font-size:10.5px;color:#9ca3af;margin-top:6px;">رتبة مساوية أو أعلى — لا يمكن تعديلها من حسابك.</div>`}
      </div>`;
  }

  async function renderUsers(page = 1) {
    const qs = new URLSearchParams({ limit: 50, page: String(page) });
    if (state.users.q) qs.set('q', state.users.q);
    if (state.users.kind) qs.set('kind', state.users.kind);
    if (state.users.status) qs.set('status', state.users.status);
    const d = await rq('/api/admin/users?' + qs);
    body(`
      <div class="calculator-card" style="padding:12px;margin-bottom:10px;">
        <input type="text" placeholder="🔍 بحث بالاسم/المستخدم/الهاتف" value="${esc(state.users.q)}" oninput="AdminUI.setUserFilter('q', this.value)"
               style="width:100%;padding:9px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
        <div style="display:flex;gap:6px;margin-top:8px;">
          <select onchange="AdminUI.setUserFilter('kind', this.value)" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
            <option value="">الكل</option>
            <option value="client" ${state.users.kind === 'client' ? 'selected' : ''}>العملاء</option>
            <option value="staff" ${state.users.kind === 'staff' ? 'selected' : ''}>الموظفون</option>
          </select>
          <select onchange="AdminUI.setUserFilter('status', this.value)" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
            <option value="">كل الحالات</option>
            ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${state.users.status === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <button class="copy-btn" style="width:auto;padding:8px 12px;background:#10b981;font-size:12px;" onclick="AdminUI.newUser()">➕ جديد</button>
        </div>
        <div style="font-size:11px;color:#6b7280;margin-top:6px;">${d.total} مستخدم</div>
      </div>
      ${d.items.map(userCard).join('') || '<div class="calculator-card" style="padding:16px;text-align:center;font-size:12px;color:#6b7280;">لا نتائج</div>'}
    `);
  }

  // ============================ العملاء ============================
  async function renderClients() {
    const qs = new URLSearchParams({ limit: 100 });
    if (state.users.q) qs.set('q', state.users.q);
    const d = await rq('/api/admin/clients?' + qs);
    body(`
      <div class="calculator-card" style="padding:12px;margin-bottom:10px;">
        <input type="text" placeholder="🔍 بحث عن عميل" value="${esc(state.users.q)}" oninput="AdminUI.setClientFilter(this.value)"
               style="width:100%;padding:9px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
        <div style="font-size:11px;color:#6b7280;margin-top:6px;">${d.total} عميل مسجّل</div>
      </div>
      ${d.items.map((c) => `
        <div class="calculator-card" style="padding:12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;">
            <div>
              <div style="font-weight:800;font-size:13px;">${esc(c.fullName || c.username)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${esc(c.username)}${c.phone ? ' · ' + esc(c.phone) : ''}${c.email ? ' · ' + esc(c.email) : ''}</div>
            </div>
            <span style="font-size:10.5px;padding:2px 8px;border-radius:20px;${STATUS_STYLE[c.status] || ''}">${STATUS_LABEL[c.status] || c.status}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px;font-size:11px;text-align:center;">
            <div style="background:var(--field-bg);border-radius:9px;padding:6px;"><b>${c.shipments}</b><br><span style="color:#6b7280;">شحنة</span></div>
            <div style="background:var(--field-bg);border-radius:9px;padding:6px;"><b>${money(c.wallet_available)}</b><br><span style="color:#6b7280;">رصيد</span></div>
            <div style="background:var(--field-bg);border-radius:9px;padding:6px;"><b>${esc(ROLE_LABEL[c.role] || c.role)}</b><br><span style="color:#6b7280;">الرتبة</span></div>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
            <button class="copy-btn" style="width:auto;padding:5px 10px;background:#0a2540;font-size:11px;" onclick="AdminUI.messageUser('${c.id}','${esc(c.fullName || c.username)}')">✉️ رسالة</button>
            <button class="copy-btn" style="width:auto;padding:5px 10px;background:${c.status === 'active' ? '#f59e0b' : '#10b981'};font-size:11px;" onclick="AdminUI.actUser('${c.id}','${c.status === 'active' ? 'suspended' : 'active'}')">${c.status === 'active' ? 'إيقاف' : 'تفعيل'}</button>
            <button class="copy-btn" style="width:auto;padding:5px 10px;background:#6b7280;font-size:11px;" onclick="AdminUI.resetPassword('${c.id}')">🔑 إعادة تعيين</button>
          </div>
        </div>`).join('') || '<div class="calculator-card" style="padding:16px;text-align:center;font-size:12px;color:#6b7280;">لا يوجد عملاء بعد</div>'}
    `);
  }

  // ============================ الزوار ============================
  async function renderVisitors() {
    const [stats, list] = await Promise.all([
      rq('/api/admin/visitors/stats?days=7'),
      rq('/api/admin/visitors?limit=60' + (state.visitors.q ? '&q=' + encodeURIComponent(state.visitors.q) : ''))
    ]);
    const max = Math.max(1, ...stats.series.map((s) => s.unique));
    const bars = stats.series.map((s) => `
      <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:70px;">
        <div style="width:70%;background:linear-gradient(180deg,#10b981,#047857);border-radius:4px 4px 0 0;height:${Math.round((s.unique / max) * 60)}px;" title="${s.date}: ${s.unique}"></div>
        <div style="font-size:8.5px;color:#9ca3af;margin-top:3px;">${s.date.slice(5)}</div>
      </div>`).join('');
    body(`
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center;">
          <div><b style="font-size:16px;color:#0a2540;">${stats.total_unique}</b><div style="font-size:10px;color:#6b7280;">زائر</div></div>
          <div><b style="font-size:16px;color:#0a2540;">${stats.total_visits}</b><div style="font-size:10px;color:#6b7280;">زيارة</div></div>
          <div><b style="font-size:16px;color:#047857;">${stats.active_now}</b><div style="font-size:10px;color:#6b7280;">الآن</div></div>
          <div><b style="font-size:16px;color:#b45309;">${stats.blocked}</b><div style="font-size:10px;color:#6b7280;">محجوب</div></div>
        </div>
        <div style="display:flex;gap:2px;margin-top:12px;align-items:flex-end;">${bars}</div>
        <div style="font-size:10.5px;color:#6b7280;margin-top:8px;">مسجّلون: ${stats.logged_in} · مجهولون: ${stats.anonymous}</div>
      </div>
      <div class="calculator-card" style="padding:12px;margin-bottom:10px;">
        <b style="font-size:12.5px;">أكثر الصفحات زيارة</b>
        <div style="margin-top:6px;">${stats.top_pages.map((p) => `<div style="display:flex;justify-content:space-between;font-size:11.5px;padding:3px 0;border-bottom:1px dashed #eef1f6;"><span style="direction:ltr;">${esc(p.path)}</span><b>${p.hits}</b></div>`).join('') || '<div style="font-size:11px;color:#6b7280;">لا بيانات</div>'}</div>
      </div>
      <div class="calculator-card" style="padding:12px;margin-bottom:10px;">
        <input type="text" placeholder="🔍 بحث في الزوار" value="${esc(state.visitors.q)}" oninput="AdminUI.setVisitorFilter(this.value)"
               style="width:100%;padding:9px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
        <div style="font-size:11px;color:#6b7280;margin-top:6px;">${list.total} زائر مسجّل</div>
      </div>
      ${list.items.map((v) => `
        <div class="calculator-card" style="padding:11px;margin-bottom:7px;">
          <div style="display:flex;justify-content:space-between;gap:8px;">
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:700;">${v.user_id ? '👤 مسجّل' : '🕵️ زائر مجهول'} · ${esc(v.platform)} · ${esc(v.device)}</div>
              <div style="font-size:10.5px;color:#6b7280;margin-top:2px;">آخر ظهور: ${dt(v.last_seen)} · الزيارات: ${v.hits}</div>
              <div style="font-size:10px;color:#9ca3af;direction:ltr;text-align:left;margin-top:2px;">${esc((v.pages || []).slice(-3).join(' → '))}</div>
            </div>
            <button class="copy-btn" style="width:auto;padding:4px 9px;font-size:10.5px;background:${v.blocked ? '#10b981' : '#d40511'};" onclick="AdminUI.blockVisitor('${v.id}', ${v.blocked ? 'false' : 'true'})">${v.blocked ? 'إلغاء الحجب' : 'حجب'}</button>
          </div>
        </div>`).join('') || '<div class="calculator-card" style="padding:16px;text-align:center;font-size:12px;color:#6b7280;">لا زوار بعد</div>'}
    `);
  }

  // ============================ الإشعارات ============================
  async function renderNotify() {
    const [campaigns, log] = await Promise.all([rq('/api/admin/notifications?limit=10'), rq('/api/admin/notifications/log')]);
    const s = state.server || {};
    body(`
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">إرسال إشعار</b>
        <div style="display:grid;gap:8px;margin-top:8px;">
          <input id="ntTitle" placeholder="العنوان *" style="padding:9px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12.5px;">
          <textarea id="ntBody" rows="3" placeholder="نص الإشعار *" style="padding:9px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12.5px;"></textarea>
          <select id="ntAudience" style="padding:9px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12.5px;">
            <option value="all">الجميع (عملاء + موظفون)</option>
            <option value="clients">العملاء فقط</option>
            <option value="staff">الموظفون فقط</option>
          </select>
          <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:12px;">
            <label style="display:flex;align-items:center;gap:5px;"><input type="checkbox" id="chInapp" checked> داخل التطبيق</label>
            <label style="display:flex;align-items:center;gap:5px;"><input type="checkbox" id="chWeb" checked> Web Push</label>
            <label style="display:flex;align-items:center;gap:5px;" title="${(s.push_channels && s.push_channels.fcm && s.push_channels.fcm.ready) ? '' : 'غير مهيّأ على الخادم'}"><input type="checkbox" id="chFcm" ${(s.push_channels && s.push_channels.fcm && s.push_channels.fcm.ready) ? '' : 'disabled'}> FCM</label>
            <label style="display:flex;align-items:center;gap:5px;" title="${(s.push_channels && s.push_channels.apns && s.push_channels.apns.ready) ? '' : 'غير مهيّأ على الخادم'}"><input type="checkbox" id="chApns" ${(s.push_channels && s.push_channels.apns && s.push_channels.apns.ready) ? '' : 'disabled'}> APNs</label>
          </div>
          <div id="ntMsg" style="font-size:11.5px;color:#b91c1c;"></div>
          <button class="copy-btn" style="background:#10b981;" onclick="AdminUI.sendNotification()">📤 إرسال الآن</button>
        </div>
      </div>
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">آخر الحملات</b>
        ${campaigns.items.map((c) => `
          <div style="padding:7px 0;border-bottom:1px dashed #e5e7eb;">
            <div style="display:flex;justify-content:space-between;font-size:12px;"><b>${esc(c.title)}</b><span style="font-size:10.5px;color:#6b7280;">${dt(c.created_at)}</span></div>
            <div style="font-size:10.5px;color:#6b7280;">${esc(c.audience)} · المستهدفون ${c.target_count} · أُرسل ${c.sent_count} · القنوات: ${(c.channels || []).join(', ')}</div>
            ${c.push_results && c.push_results.webpush ? `<div style="font-size:10px;color:${c.push_results.webpush.failed ? '#b45309' : '#047857'};">Web Push: ناجح ${c.push_results.webpush.sent} · فاشل ${c.push_results.webpush.failed}</div>` : ''}
          </div>`).join('') || '<div style="font-size:11px;color:#6b7280;margin-top:6px;">لا حملات بعد</div>'}
      </div>
      <div class="calculator-card" style="padding:14px;">
        <b style="font-size:13px;">سجل قنوات الإرسال</b>
        ${log.items.slice(0, 12).map((l) => `<div style="display:flex;justify-content:space-between;font-size:11px;padding:4px 0;border-bottom:1px dashed #eef1f6;">
            <span>${esc(l.channel)} · ${l.status}</span><span style="color:#6b7280;">ناجح ${l.sent} · فاشل ${l.failed}</span></div>`).join('') || '<div style="font-size:11px;color:#6b7280;margin-top:6px;">لا سجلات</div>'}
      </div>
    `);
  }

  // ============================ التسعير (المرحلة 4) ============================
  const SERVICE_LABEL = { air: 'جوي', sea: 'بحري', land: 'بري' };
  function ruleCard(r) {
    const m = r.match || {};
    const cond = [m.service ? SERVICE_LABEL[m.service] : null, m.origin, m.dest_port,
      m.weight_min_kg != null ? 'من ' + m.weight_min_kg + 'كجم' : null,
      m.weight_max_kg != null ? 'حتى ' + m.weight_max_kg + 'كجم' : null,
      m.client_roles && m.client_roles.length ? 'رتب: ' + m.client_roles.join('/') : null].filter(Boolean);
    return `
      <div class="calculator-card" style="padding:12px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <div style="flex:1;">
            <div style="font-weight:800;font-size:13px;">${esc(r.name)}</div>
            <div style="font-size:10.5px;color:#6b7280;margin-top:2px;">${cond.length ? cond.map(esc).join(' · ') : 'تُطبَّق على كل الشحنات'}</div>
            <div style="font-size:11px;margin-top:5px;color:#0a2540;">
              رسم ${money(r.rate.base_fee)} + ${money(r.rate.per_kg)}/كجم${r.rate.per_cbm ? ' + ' + money(r.rate.per_cbm) + '/م³' : ''}
              ${r.rate.min_charge ? ' · حد أدنى ' + money(r.rate.min_charge) : ''}
              ${r.rate.surcharge_pct ? ' · +' + r.rate.surcharge_pct + '%' : ''}${r.rate.discount_pct ? ' · -' + r.rate.discount_pct + '%' : ''}
            </div>
          </div>
          <div style="text-align:left;">
            <span style="font-size:10.5px;padding:2px 8px;border-radius:20px;${r.active ? 'background:#d1fae5;color:#047857' : 'background:#e5e7eb;color:#374151'}">${r.active ? 'مفعّلة' : 'معطّلة'}</span>
            <div style="font-size:10px;color:#9ca3af;margin-top:3px;">أولوية ${r.priority}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <button class="copy-btn" style="width:auto;padding:5px 10px;background:${r.active ? '#f59e0b' : '#10b981'};font-size:11px;" onclick="AdminUI.toggleRule('${r.id}', ${r.active ? 'false' : 'true'})">${r.active ? 'تعطيل' : 'تفعيل'}</button>
          ${isSuper() ? `<button class="copy-btn" style="width:auto;padding:5px 10px;background:#d40511;font-size:11px;" onclick="AdminUI.deleteRule('${r.id}')">حذف</button>` : ''}
        </div>
      </div>`;
  }

  async function renderPricing() {
    const [rules, servicesRes] = await Promise.all([rq('/api/pricing/rules'), rq('/api/pricing/services').catch(() => ({ services: ['air', 'sea', 'land'] }))]);
    const services = servicesRes.services || ['air', 'sea', 'land'];
    body(`
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">محاكي التسعير (يُحسب على الخادم)</b>
        <div style="display:grid;gap:6px;margin-top:8px;">
          <div style="display:flex;gap:6px;">
            <select id="pqService" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
              ${services.map((k) => `<option value="${k}">${SERVICE_LABEL[k] || k}</option>`).join('')}
            </select>
            <input id="pqWeight" type="number" min="0" step="0.5" value="10" placeholder="الوزن كجم" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
          </div>
          <div style="display:flex;gap:6px;">
            <input id="pqDest" placeholder="الوجهة (مثل: ميناء عدن)" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
            <input id="pqCbm" type="number" min="0" step="0.1" value="0" placeholder="م³" style="width:80px;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
          </div>
          <button class="copy-btn" style="background:#0a2540;" onclick="AdminUI.quote()">احسب السعر</button>
          <div id="pqOut" style="font-size:11.5px;color:#0a2540;line-height:1.9;"></div>
        </div>
      </div>
      <div class="calculator-card" style="padding:12px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:12px;color:#6b7280;">${rules.items.length} قاعدة تسعير</div>
        ${canManage() ? `<button class="copy-btn" style="width:auto;padding:7px 12px;background:#10b981;font-size:12px;" onclick="AdminUI.newRule()">➕ قاعدة جديدة</button>` : ''}
      </div>
      ${rules.items.map(ruleCard).join('') || '<div class="calculator-card" style="padding:16px;text-align:center;font-size:12px;color:#6b7280;">لا قواعد بعد</div>'}
    `);
  }

  // ============================ التقارير (المرحلة 4) ============================
  async function renderReports() {
    const [s, series, top] = await Promise.all([
      rq('/api/admin/reports/summary?days=30'),
      rq('/api/admin/reports/series?days=14'),
      rq('/api/admin/reports/top-clients?limit=6')
    ]);
    const maxCredits = Math.max(1, ...series.series.map((x) => x.credits));
    const bars = series.series.map((x) => `
      <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:64px;">
        <div title="${x.date}: ${x.credits}$" style="width:70%;background:linear-gradient(180deg,#10b981,#047857);border-radius:4px 4px 0 0;height:${Math.round((x.credits / maxCredits) * 52)}px;"></div>
        <div style="font-size:8px;color:#9ca3af;margin-top:2px;">${x.date.slice(8)}</div>
      </div>`).join('');
    const num = (v, l, c) => `<div style="text-align:center;"><b style="font-size:15px;color:${c || '#0a2540'};">${v}</b><div style="font-size:10px;color:#6b7280;">${l}</div></div>`;
    body(`
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="font-size:13px;">الملخّص المالي (آخر 30 يومًا)</b>
          <button class="copy-btn" style="width:auto;padding:5px 10px;background:#0a2540;font-size:11px;" onclick="AdminUI.exportCsv('entries')">⬇️ CSV</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px;">
          ${num(money(s.wallet.credits_total), 'إجمالي الإيداعات')}
          ${num(money(s.escrow.available), 'رصيد الضمان', '#047857')}
          ${num(money(s.auctions.gmv), 'مبيعات المزادات', '#0a2540')}
          ${num(money(s.shipments.paid), 'مدفوعات الشحن', '#123c63')}
          ${num(s.wallet.held_total ? money(s.wallet.held_total) : '$0', 'محجوز في المزادات', '#b45309')}
          ${num(s.shipments.collection_rate_pct + '%', 'نسبة التحصيل')}
          ${num(s.shipments.total, 'شحنة')}
          ${num(s.auctions.settled, 'مزاد مُباع')}
        </div>
        <div style="font-size:10.5px;color:#6b7280;margin-top:8px;line-height:1.8;">
          إيداعات حقيقية: ${money(s.wallet.credits_real)} · تجريبية موسومة: ${money(s.wallet.credits_demo)}<br>
          شحنات تجريبية: ${s.shipments.demo} من ${s.shipments.total} · المتبقي على العملاء: ${money(s.shipments.remaining)}
        </div>
      </div>
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:12.5px;">الإيداعات — 14 يومًا</b>
        <div style="display:flex;gap:2px;align-items:flex-end;margin-top:8px;">${bars}</div>
      </div>
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;"><b style="font-size:12.5px;">أفضل العملاء</b>
          <button class="copy-btn" style="width:auto;padding:4px 9px;background:#6b7280;font-size:10.5px;" onclick="AdminUI.exportCsv('shipments')">CSV الشحنات</button></div>
        ${top.items.map((c) => `<div style="display:flex;justify-content:space-between;font-size:11.5px;padding:4px 0;border-bottom:1px dashed #eef1f6;">
            <span>${esc(c.name)} <span style="color:#9ca3af;">(${c.shipments} شحنة)</span></span>
            <b>${money(c.paid)}</b></div>`).join('') || '<div style="font-size:11px;color:#6b7280;">لا بيانات</div>'}
      </div>
      <div class="calculator-card" style="padding:14px;">
        <b style="font-size:12.5px;">تصدير</b>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
          ${['entries|القيود المالية', 'shipments|الشحنات', 'auctions|المزادات', 'audit|سجل التدقيق'].map((x) => {
            const [k, l] = x.split('|');
            return `<button class="copy-btn" style="width:auto;padding:6px 11px;background:#123c63;font-size:11px;" onclick="AdminUI.exportCsv('${k}')">${l}</button>`;
          }).join('')}
        </div>
        <div style="font-size:10.5px;color:#6b7280;margin-top:6px;">ملفات CSV بترميز UTF-8 + BOM تفتح مباشرة في Excel بالعربية.</div>
      </div>
    `);
  }

  // ============================ شركات الشحن والتتبّع (المرحلة 4) ============================
  async function renderCarriers() {
    const d = await rq('/api/admin/carriers');
    body(`
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">تتبّع شحنة</b>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <input id="ctNumber" placeholder="رقم الشحنة" style="flex:1;padding:9px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12.5px;">
          <button class="copy-btn" style="width:auto;padding:8px 14px;background:#0a2540;font-size:12px;" onclick="AdminUI.trackShipment()">تتبّع</button>
        </div>
        <div id="ctOut" style="font-size:11.5px;line-height:1.9;margin-top:8px;color:#0a2540;"></div>
      </div>
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">إضافة حدث تتبّع (موظف الشحن)</b>
        <div style="display:grid;gap:6px;margin-top:8px;">
          <input id="ceNumber" placeholder="رقم الشحنة" style="padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
          <input id="ceStatus" placeholder="الحالة (مثل: وصلت مركز الفرز)" style="padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
          <input id="ceLocation" placeholder="الموقع (اختياري)" style="padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
          <button class="copy-btn" style="background:#10b981;" onclick="AdminUI.addCarrierEvent()">حفظ الحدث</button>
          <div id="ceMsg" style="font-size:11.5px;color:#b91c1c;"></div>
        </div>
      </div>
      <div class="calculator-card" style="padding:14px;">
        <b style="font-size:13px;">مزوّدو التتبّع</b>
        ${d.providers.map((p) => `
          <div style="padding:7px 0;border-bottom:1px dashed #e5e7eb;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:12px;font-weight:700;">${esc(p.name)}${d.active === p.id ? ' <span style="font-size:9.5px;color:#047857;">(النشط)</span>' : ''}</span>
              <span style="font-size:10.5px;padding:2px 8px;border-radius:20px;${p.ready ? 'background:#d1fae5;color:#047857' : 'background:#fef3c7;color:#b45309'}">${p.ready ? 'جاهز' : 'غير مهيّأ'}</span>
            </div>
            <div style="font-size:10px;color:#6b7280;margin-top:2px;">${esc(p.note)}</div>
          </div>`).join('')}
        <div style="font-size:10.5px;color:#9ca3af;margin-top:8px;">المزوّد غير المهيّأ لا يُعيد أي بيانات — النظام لا يخترع أحداث تتبّع.</div>
      </div>
    `);
  }

  // ============================ المساعد الذكي (المرحلة 5) ============================
  async function renderAssistant() {
    const [s, st, faq] = await Promise.all([
      rq('/api/admin/assistant/status'),
      rq('/api/admin/assistant/stats?days=30'),
      rq('/api/admin/assistant/faq')
    ]);
    const S = s.status, K = st.stats;
    const badge = (ok, label) => `<span style="font-size:10.5px;padding:2px 8px;border-radius:20px;${ok ? 'background:#d1fae5;color:#047857' : 'background:#fef3c7;color:#b45309'};">${ok ? '✅ جاهز' : '⚠️ ' + label}</span>`;
    const providers = S.providers.map((p) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed #e5e7eb;">
        <span style="font-size:12px;font-weight:700;">${esc(p.name)}</span>${badge(p.ready, 'غير مهيّأ')}
      </div>
      <div style="font-size:10.5px;color:#6b7280;padding-bottom:6px;">${esc(p.note)} · النموذج: <span style="direction:ltr;display:inline-block;">${esc(p.model)}</span></div>`).join('');
    const tops = (K.top_questions || []).map((q) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:3px 0;border-bottom:1px dashed #f1f5f9;"><span>${esc(q.q)}</span><b style="color:#0a2540;">${q.n}</b></div>`).join('') || '<div style="font-size:11px;color:#94a3b8;">لا أسئلة بعد</div>';
    const faqRows = faq.items.map((f) => `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;margin-bottom:6px;background:${f.active === false ? '#f8fafc' : '#fff'};">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
          <b style="font-size:12px;">${esc(f.question)}</b>
          <span style="display:flex;gap:6px;flex-shrink:0;">
            <button class="copy-btn" style="width:auto;padding:3px 8px;font-size:10px;background:#0a2540;" onclick="AdminUI.editFaq('${f.id}')">تعديل</button>
            <button class="copy-btn" style="width:auto;padding:3px 8px;font-size:10px;background:${f.active === false ? '#10b981' : '#6b7280'};" onclick="AdminUI.toggleFaq('${f.id}', ${f.active === false})">${f.active === false ? 'تشغيل' : 'تعطيل'}</button>
            ${isSuper() ? `<button class="copy-btn" style="width:auto;padding:3px 8px;font-size:10px;background:#dc2626;" onclick="AdminUI.deleteFaq('${f.id}')">حذف</button>` : ''}
          </span>
        </div>
        <div style="font-size:11px;color:#475569;margin-top:4px;">${esc(f.answer).slice(0, 180)}${String(f.answer).length > 180 ? '…' : ''}</div>
      </div>`).join('');

    body(`
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <b style="font-size:13px;">حالة المساعد الذكي</b>
          ${S.ai_ready ? `<span style="font-size:11px;padding:3px 9px;border-radius:20px;background:#d1fae5;color:#047857;">🤖 يعمل بنموذج ${esc(S.active_name)}</span>`
                       : `<span style="font-size:11px;padding:3px 9px;border-radius:20px;background:#fef3c7;color:#b45309;">📚 محرّك قواعد مُسنَد إلى البيانات</span>`}
        </div>
        <div style="font-size:11px;color:#6b7280;line-height:1.9;margin-top:7px;">
          ${esc(S.reason || 'مزوّد الذكاء الاصطناعي مُهيّأ — الإجابات من النموذج مع حقن بيانات المستخدم.')}<br>
          ${esc(S.honest_note || '')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px;">
          ${[['أسئلة 30 يومًا', K.questions], ['محادثات', K.conversations], ['مستخدمون', K.users], ['اليوم', K.today]]
            .map(([l, v]) => `<div class="stat" style="text-align:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:9px;"><b style="display:block;font-size:17px;color:#0a2540;">${v ?? 0}</b><span style="font-size:10.5px;color:#64748b;">${l}</span></div>`).join('')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px;">
          ${[['إسناد%', (K.grounded_rate ?? 0) + '%'], ['زمن الرد', (K.avg_latency_ms ?? 0) + 'ms'], ['رموز', (K.tokens.input + K.tokens.output)], ['تقييم', `${K.feedback.up}/${K.feedback.down}`]]
            .map(([l, v]) => `<div class="stat" style="text-align:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:9px;"><b style="display:block;font-size:15px;color:#0a2540;">${v}</b><span style="font-size:10.5px;color:#64748b;">${l}</span></div>`).join('')}
        </div>
      </div>

      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">مزوّدو الذكاء الاصطناعي</b>
        ${providers}
        <div style="font-size:10.5px;color:#6b7280;margin-top:8px;">يُفعَّل المزوّد بإضافة مفتاحه في بيئة الخادم (أو docker-compose) ثم إعادة التشغيل. لا يُدَّعى أي مزوّد جاهزًا بلا مفتاح.</div>
      </div>

      ${isSuper() ? `
      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">إعدادات المساعد</b>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:11.5px;">
          <label>المزوّد المفضّل
            <select id="asProvider" style="width:100%;padding:7px;border:1px solid #dce2ea;border-radius:8px;margin-top:3px;">
              ${[['auto', 'تلقائي (أول مزوّد متاح)'], ['rules', 'محرّك القواعد فقط (تعطيل النموذج)']]
                .concat(S.providers.map((p) => [p.id, p.name]))
                .map(([v, l]) => `<option value="${v}" ${S.settings.provider === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
          <label>الحد اليومي للمستخدم
            <input id="asLimit" type="number" min="1" max="1000" value="${S.settings.daily_limit}" style="width:100%;padding:7px;border:1px solid #dce2ea;border-radius:8px;margin-top:3px;">
          </label>
          <label>الحرارة (0–1)
            <input id="asTemp" type="number" min="0" max="1" step="0.1" value="${S.settings.temperature}" style="width:100%;padding:7px;border:1px solid #dce2ea;border-radius:8px;margin-top:3px;">
          </label>
          <label>أقصى رموز الرد
            <input id="asTokens" type="number" min="64" max="4096" step="16" value="${S.settings.max_tokens}" style="width:100%;padding:7px;border:1px solid #dce2ea;border-radius:8px;margin-top:3px;">
          </label>
        </div>
        <label style="display:block;font-size:11.5px;margin-top:8px;">تعليمات إضافية تُضاف لنموذج الذكاء الاصطناعي
          <textarea id="asPrompt" rows="2" style="width:100%;padding:7px;border:1px solid #dce2ea;border-radius:8px;margin-top:3px;font-family:inherit;">${esc(S.settings.system_prompt || '')}</textarea>
        </label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;align-items:center;">
          <label style="font-size:11px;display:flex;gap:5px;align-items:center;"><input id="asEnabled" type="checkbox" ${S.enabled ? 'checked' : ''}> المساعد مفعّل</label>
          <button class="copy-btn" style="width:auto;padding:7px 12px;background:#10b981;" onclick="AdminUI.saveAssistant()">💾 حفظ الإعدادات</button>
        </div>
        <div id="asMsg" style="font-size:11px;color:#6b7280;margin-top:6px;"></div>
      </div>` : ''}

      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <b style="font-size:13px;">جرّب المساعد الآن</b>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <input id="asTest" placeholder="مثال: كم تكلفة 20 كجم جوي؟" style="flex:1;padding:8px;border:1px solid #dce2ea;border-radius:9px;font-family:inherit;">
          <button class="copy-btn" style="width:auto;padding:8px 14px;background:#0a2540;" onclick="AdminUI.testAssistant()">إرسال</button>
        </div>
        <div id="asReply" style="font-size:11.5px;color:#0f172a;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:9px;margin-top:8px;white-space:pre-wrap;display:none;"></div>
      </div>

      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="font-size:13px;">أكثر الأسئلة</b>
          <span style="font-size:10.5px;color:#6b7280;">توزيع المحرّك: ${Object.entries(K.by_engine).map(([k, v]) => `${k}=${v}`).join(' · ') || '—'}</span>
        </div>
        <div style="margin-top:6px;">${tops}</div>
      </div>

      <div class="calculator-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <b style="font-size:13px;">قاعدة الأسئلة الشائعة (${faq.items.length})</b>
          <button class="copy-btn" style="width:auto;padding:6px 10px;background:#0a2540;" onclick="AdminUI.newFaq()">+ سؤال جديد</button>
        </div>
        ${faqRows || '<div style="font-size:11px;color:#94a3b8;">لا أسئلة — أضف أول سؤال.</div>'}
      </div>

      <div class="calculator-card" style="padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="font-size:13px;">آخر المحادثات</b>
          <button class="copy-btn" style="width:auto;padding:6px 10px;background:#6b7280;" onclick="AdminUI.assistantConvs()">عرض السجل</button>
        </div>
        <div id="asConvs" style="font-size:11px;color:#6b7280;margin-top:6px;"></div>
      </div>
    `);
  }

  // ============================ سجل التدقيق المتقدّم ============================
  const auditState = { action: '', actor: '', page: 1 };
  async function renderAudit() {
    const qs = new URLSearchParams({ limit: '40', page: String(auditState.page) });
    if (auditState.action) qs.set('action', auditState.action);
    if (auditState.actor) qs.set('actor', auditState.actor);
    const d = await rq('/api/admin/audit/query?' + qs);
    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    body(`
      <div class="calculator-card" style="padding:12px;margin-bottom:10px;">
        <div style="display:flex;gap:6px;">
          <input placeholder="منفّذ…" value="${esc(auditState.actor)}" oninput="AdminUI.setAuditFilter('actor', this.value)" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
          <select onchange="AdminUI.setAuditFilter('action', this.value)" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border-color);font-family:Cairo,sans-serif;font-size:12px;">
            <option value="">كل الإجراءات</option>
            ${d.facets.actions.map((a) => `<option value="${esc(a)}" ${auditState.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <button class="copy-btn" style="width:auto;padding:8px 11px;background:#6b7280;font-size:11px;" onclick="AdminUI.exportCsv('audit')">CSV</button>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#6b7280;margin-top:6px;">
          <span>${d.total} حدث · صفحة ${d.page}/${pages}</span>
          <span>
            <button class="copy-btn" style="width:auto;padding:3px 8px;background:#e5e7eb;color:#0a2540;font-size:10.5px;" onclick="AdminUI.auditPage(-1)">السابق</button>
            <button class="copy-btn" style="width:auto;padding:3px 8px;background:#e5e7eb;color:#0a2540;font-size:10.5px;" onclick="AdminUI.auditPage(1)">التالي</button>
          </span>
        </div>
      </div>
      <div class="calculator-card" style="padding:14px;">
        <div style="max-height:62vh;overflow-y:auto;">
          ${d.items.map((a) => `<div style="padding:5px 0;border-bottom:1px dashed #eef1f6;">
            <div style="font-size:11.5px;font-weight:700;">${esc(a.action)} <span style="font-weight:400;color:#6b7280;">· ${esc(a.entity || '')}</span></div>
            <div style="font-size:10px;color:#9ca3af;">${esc(a.actor_name || '—')} · ${dt(a.created_at)}${a.ip ? ' · ' + esc(a.ip) : ''}</div>
          </div>`).join('') || '<div style="font-size:12px;color:#6b7280;text-align:center;padding:14px;">لا نتائج</div>'}
        </div>
      </div>
    `);
  }

  // ============================ قسم داخل الإعدادات ============================
  function injectSettingsSection() {
    const container = $('settingsContent');
    if (!container || $('adminSettingsSection')) return;
    const wrap = document.createElement('div');
    wrap.id = 'adminSettingsSection';
    wrap.className = 'settings-section';
    wrap.innerHTML = `
      <div class="settings-section-header" onclick="toggleSettingsSection(this)">
        <span>🛡️ الإدارة والإشعارات</span><i class="fa-solid fa-chevron-down"></i>
      </div>
      <div class="settings-section-body" style="display:none;">
        <div style="font-size:12px;color:var(--text-muted);line-height:1.9;margin-bottom:10px;">
          تحكّم في المستخدمين والعملاء والزوار، وأرسل إشعارات لتطبيقات العملاء والموظفين.
        </div>
        <button class="copy-btn" style="width:100%;background:#0a2540;margin-bottom:8px;" onclick="AdminUI.open()">🛡️ فتح لوحة الإدارة</button>
        <button class="copy-btn" style="width:100%;background:#10b981;" onclick="AdminUI.enablePush()">🔔 تفعيل إشعارات هذا الجهاز</button>
        <div id="settingsPushMsg" style="font-size:11px;color:#6b7280;margin-top:6px;"></div>
      </div>`;
    container.insertBefore(wrap, container.firstChild);
  }

  // ============================ الإجراءات ============================
  const AdminUI = {
    open() { ensurePage(); window.navigateTo('adminPage'); },
    tab(name, ev) {
      state.tab = name;
      document.querySelectorAll('#adminPage .filter-btn').forEach((b) => b.classList.remove('active'));
      if (ev && ev.target && ev.target.classList.contains('filter-btn')) ev.target.classList.add('active');
      else { const b = document.querySelector(`#adminPage [data-atab="${name}"]`); if (b) b.classList.add('active'); }
      render();
    },
    setUserFilter(k, v) { state.users[k] = v; clearTimeout(window.__uT); window.__uT = setTimeout(() => render(), 350); },
    setClientFilter(v) { state.users.q = v; clearTimeout(window.__cT); window.__cT = setTimeout(() => render(), 350); },
    setVisitorFilter(v) { state.visitors.q = v; clearTimeout(window.__vT); window.__vT = setTimeout(() => render(), 350); },

    async actUser(id, status) {
      if (!confirm(status === 'suspended' ? 'إيقاف هذا الحساب؟ سيُسحب دخوله فورًا.' : 'تفعيل هذا الحساب؟')) return;
      try { await rq('/api/admin/users/' + id, { method: 'PATCH', body: { status } }); toast('تم التحديث'); render(); }
      catch (e) { toast(e.message); }
    },
    async changeRole(id, roleValue) {
      if (!confirm('تغيير الرتبة إلى: ' + (ROLE_LABEL[roleValue] || roleValue) + '؟')) { render(); return; }
      try { await rq('/api/admin/users/' + id, { method: 'PATCH', body: { role: roleValue } }); toast('تغيّرت الرتبة'); render(); }
      catch (e) { toast(e.message); }
    },
    async resetPassword(id) {
      if (!confirm('إنشاء كلمة مرور مؤقتة جديدة؟ ستُسحب جلسات المستخدم الحالية.')) return;
      try {
        const r = await rq('/api/admin/users/' + id + '/reset-password', { method: 'POST' });
        alert(`كلمة المرور المؤقتة للمستخدم ${r.username}:\n\n${r.temporary_password}\n\nتُعرض مرة واحدة — سلّمها له واطلب تغييرها فورًا.`);
      } catch (e) { toast(e.message); }
    },
    async removeUser(id) {
      if (!confirm('حذف الحساب؟ (حذف ناعم: يُعطَّل ويبقى أثره في السجل)')) return;
      try { await rq('/api/admin/users/' + id, { method: 'DELETE' }); toast('تم الحذف'); render(); }
      catch (e) { toast(e.message); }
    },
    async newUser() {
      const username = prompt('اسم المستخدم الجديد:'); if (!username) return;
      const fullName = prompt('الاسم الكامل:'); if (!fullName) return;
      const password = prompt('كلمة المرور (8 أحرف على الأقل):'); if (!password) return;
      const roleValue = prompt('الرتبة (user/agent/support_staff/shipping_staff/branch_manager/warehouse_manager):', 'user') || 'user';
      try { await rq('/api/admin/users', { method: 'POST', body: { username, fullName, password, role: roleValue } }); toast('أُنشئ المستخدم'); render(); }
      catch (e) { toast(e.message); }
    },
    async blockVisitor(id, blocked) {
      try { await rq('/api/admin/visitors/' + id + '/block', { method: 'POST', body: { blocked } }); toast(blocked ? 'حُجب الزائر' : 'أُلغي الحجب'); render(); }
      catch (e) { toast(e.message); }
    },
    messageUser(id, name) {
      state.tab = 'notify'; render().then(() => {
        const t = $('ntTitle'); if (t) t.value = 'رسالة إلى ' + name;
        const aud = $('ntAudience'); if (aud) { aud.innerHTML = `<option value="users" selected>المستخدم المحدد</option>`; aud.dataset.userId = id; }
        const b = $('ntBody'); if (b) b.focus();
      });
    },
    async sendNotification() {
      const msg = $('ntMsg');
      const title = ($('ntTitle') || {}).value || '';
      const bodyText = ($('ntBody') || {}).value || '';
      const audEl = $('ntAudience');
      const audience = audEl ? audEl.value : 'all';
      const channels = [];
      if ($('chInapp') && $('chInapp').checked) channels.push('inapp');
      if ($('chWeb') && $('chWeb').checked) channels.push('webpush');
      if ($('chFcm') && $('chFcm').checked) channels.push('fcm');
      if ($('chApns') && $('chApns').checked) channels.push('apns');
      const values = audEl && audEl.dataset.userId && audience === 'users' ? [audEl.dataset.userId] : [];
      if (msg) msg.textContent = '⏳ جارٍ الإرسال…';
      try {
        const r = await rq('/api/admin/notifications', { method: 'POST', body: { title, body: bodyText, audience, values, channels } });
        const wp = r.results.webpush;
        toast(`✅ أُرسل إلى ${r.campaign.sent_count} مستخدم${wp ? ` · Web Push: ${wp.sent} ناجح / ${wp.failed} فاشل` : ''}`);
        renderNotify();
      } catch (e) { if (msg) msg.textContent = e.message; }
    },
    async enablePush() {
      const out = $('pushMsg') || $('settingsPushMsg');
      if (out) out.textContent = '⏳ طلب الإذن…';
      try {
        if (!window.MasariPush) throw new Error('مديول الإشعارات غير محمّل');
        await MasariPush.enable();
        if (out) out.textContent = '✅ الإشعارات مفعّلة على هذا الجهاز.';
        toast('✅ فُعّلت الإشعارات على هذا الجهاز');
      } catch (e) { if (out) out.textContent = '❌ ' + e.message; toast(e.message); }
    },
    async testPush() {
      const out = $('pushMsg');
      if (out) out.textContent = '⏳ إرسال…';
      try {
        const r = await rq('/api/push/test', { method: 'POST' });
        if (out) out.textContent = `اشتراكات: ${r.subscriptions} · ناجح: ${r.sent} · فاشل: ${r.failed}${r.errors && r.errors.length ? ' — ' + r.errors[0] : ''}`;
      } catch (e) { if (out) out.textContent = '❌ ' + e.message; }
    },
    setAuditFilter(k, v) { auditState[k] = v; auditState.page = 1; clearTimeout(window.__aT); window.__aT = setTimeout(render, 350); },
    auditPage(delta) { auditState.page = Math.max(1, auditState.page + delta); render(); },

    async quote() {
      const out = $('pqOut');
      out.textContent = '⏳ حساب على الخادم…';
      try {
        const r = await rq('/api/pricing/quote', {
          method: 'POST',
          body: {
            service: ($('pqService') || {}).value || null,
            weight_kg: Number(($('pqWeight') || {}).value || 0),
            volume_cbm: Number(($('pqCbm') || {}).value || 0),
            dest_port: (($('pqDest') || {}).value || '').trim() || null
          }
        });
        const q = r.quote;
        if (!q.matched) { out.innerHTML = `⚠️ ${esc(q.reason)}`; return; }
        const b = q.breakdown;
        out.innerHTML = `<b style="font-size:15px;color:#10b981;">${money(q.total)}</b> — القاعدة: ${esc(q.rule.name)}<br>
          رسم ثابت ${money(b.base_fee)} + وزن ${b.weight_kg}كجم × ${money(b.per_kg)} = ${money(b.weight_cost)}
          ${b.volume_cost ? ' + حجم ' + money(b.volume_cost) : ''}<br>
          ${b.surcharge ? 'زيادة ' + b.surcharge_pct + '% = ' + money(b.surcharge) + '<br>' : ''}
          ${b.discount ? 'خصم ' + b.discount_pct + '% = -' + money(b.discount) + '<br>' : ''}
          ${b.min_applied ? '⚠️ طُبِّق الحد الأدنى ' + money(b.min_charge) + '<br>' : ''}
          <span style="color:#6b7280;">المجموع قبل التعديلات: ${money(b.subtotal)}</span>`;
      } catch (e) { out.textContent = '❌ ' + e.message; }
    },
    async newRule() {
      const name = prompt('اسم القاعدة:'); if (!name) return;
      const service = prompt('نوع الخدمة (air/sea/land) أو اتركه فارغًا للكل:', 'air') || null;
      const base = Number(prompt('الرسم الثابت ($):', '15') || 0);
      const perKg = Number(prompt('سعر الكيلو ($):', '5') || 0);
      const minCharge = Number(prompt('الحد الأدنى ($):', '0') || 0);
      try {
        await rq('/api/pricing/rules', { method: 'POST', body: { name, match: { service: service || null }, rate: { base_fee: base, per_kg: perKg, min_charge: minCharge } } });
        toast('✅ أُضيفت القاعدة'); render();
      } catch (e) { toast(e.message); }
    },
    async toggleRule(id, active) {
      try { await rq('/api/pricing/rules/' + id, { method: 'PATCH', body: { active } }); toast(active ? 'فُعّلت القاعدة' : 'عُطّلت القاعدة'); render(); }
      catch (e) { toast(e.message); }
    },
    async deleteRule(id) {
      if (!confirm('حذف قاعدة التسعير؟')) return;
      try { await rq('/api/pricing/rules/' + id, { method: 'DELETE' }); toast('حُذفت'); render(); }
      catch (e) { toast(e.message); }
    },
    async exportCsv(type) {
      try {
        const res = await fetch(BASE + '/api/admin/reports/export?type=' + encodeURIComponent(type), { headers: { authorization: 'Bearer ' + token() } });
        if (!res.ok) throw new Error('فشل التصدير');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'masar-' + type + '-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        toast('⬇️ بدأ تنزيل CSV');
      } catch (e) { toast(e.message); }
    },
    async trackShipment() {
      const out = $('ctOut');
      const tn = ($('ctNumber') || {}).value || '';
      out.textContent = '⏳ استعلام…';
      try {
        const r = await rq('/api/admin/carriers/track', { method: 'POST', body: { tracking_number: tn } });
        const res = r.result;
        out.innerHTML = `<b>المزوّد: ${esc(res.provider)}</b> ${res.ready ? '' : '— غير مهيّأ'}<br>
          ${res.local ? 'الحالة في النظام: ' + esc(res.local.status || '—') + ' · الموقع: ' + esc(res.local.currentLocation || '—') + '<br>' : ''}
          ${res.events && res.events.length ? res.events.map((e) => '• ' + esc(e.status) + (e.location ? ' — ' + esc(e.location) : '') + ' <span style="color:#9ca3af;">' + dt(e.at) + '</span>').join('<br>') : ''}
          ${res.note ? '<span style="color:#b45309;">' + esc(res.note) + '</span>' : ''}`;
      } catch (e) { out.textContent = '❌ ' + e.message; }
    },
    async addCarrierEvent() {
      const msg = $('ceMsg');
      try {
        await rq('/api/admin/carriers/events', {
          method: 'POST',
          body: { tracking_number: ($('ceNumber') || {}).value || '', status: ($('ceStatus') || {}).value || '', location: ($('ceLocation') || {}).value || null }
        });
        msg.style.color = '#047857'; msg.textContent = '✅ حُفظ الحدث';
        toast('✅ سُجّل حدث التتبّع');
      } catch (e) { msg.style.color = '#b91c1c'; msg.textContent = e.message; }
    },
    async downloadBackup() {
      try {
        const res = await fetch(BASE + '/api/admin/backup', { headers: { authorization: 'Bearer ' + token() } });
        if (!res.ok) throw new Error('فشل التنزيل');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'masar-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        toast('⬇️ بدأ تنزيل النسخة الاحتياطية');
      } catch (e) { toast(e.message); }
    },

    // ---------- المساعد الذكي ----------
    async saveAssistant() {
      const msg = $('asMsg');
      const bodyData = {
        provider: ($('asProvider') || {}).value,
        daily_limit: Number(($('asLimit') || {}).value),
        temperature: Number(($('asTemp') || {}).value),
        max_tokens: Number(($('asTokens') || {}).value),
        system_prompt: ($('asPrompt') || {}).value || '',
        enabled: !!(($('asEnabled') || {}).checked)
      };
      if (msg) msg.textContent = '⏳ جارٍ الحفظ…';
      try { await rq('/api/admin/assistant/settings', { method: 'PATCH', body: bodyData }); toast('✅ حُفظت إعدادات المساعد'); render(); }
      catch (e) { if (msg) msg.textContent = '❌ ' + e.message; }
    },
    async testAssistant() {
      const q = ($('asTest') || {}).value || '';
      const out = $('asReply');
      if (!q.trim()) return;
      if (out) { out.style.display = 'block'; out.textContent = '⏳ يفكّر…'; }
      try {
        const r = await rq('/api/admin/assistant/test', { method: 'POST', body: { message: q } });
        const src = r.engine === 'model' ? `نموذج ${r.provider} · ${r.model}` : 'محرّك القواعد';
        if (out) out.textContent = `${r.reply}\n\n— المصدر: ${src} · ${r.latency_ms}ms${r.degraded ? ' · ⚠️ ' + (r.reason || '') : ''}`;
      } catch (e) { if (out) out.textContent = '❌ ' + e.message; }
    },
    async newFaq() {
      const question = prompt('السؤال المتوقّع من العميل:'); if (!question) return;
      const answer = prompt('الإجابة المعتمدة (يجب أن تكون دقيقة):'); if (!answer) return;
      const kw = prompt('كلمات مفتاحية مفصولة بفاصلة (اختياري):', '') || '';
      try {
        await rq('/api/admin/assistant/faq', { method: 'POST', body: { question, answer, keywords: kw.split(',').map((x) => x.trim()).filter(Boolean) } });
        toast('✅ أُضيف السؤال'); render();
      } catch (e) { toast(e.message); }
    },
    async editFaq(id) {
      const answer = prompt('الإجابة الجديدة:'); if (!answer) return;
      try { await rq('/api/admin/assistant/faq/' + id, { method: 'PATCH', body: { answer } }); toast('حُدِّثت الإجابة'); render(); }
      catch (e) { toast(e.message); }
    },
    async toggleFaq(id, activate) {
      try { await rq('/api/admin/assistant/faq/' + id, { method: 'PATCH', body: { active: !!activate } }); toast(activate ? 'مفعّل' : 'معطّل'); render(); }
      catch (e) { toast(e.message); }
    },
    async deleteFaq(id) {
      if (!confirm('حذف هذا السؤال نهائيًا؟')) return;
      try { await rq('/api/admin/assistant/faq/' + id, { method: 'DELETE' }); toast('حُذف'); render(); }
      catch (e) { toast(e.message); }
    },
    async assistantConvs() {
      const el = $('asConvs');
      if (el) el.textContent = '⏳ تحميل…';
      try {
        const r = await rq('/api/admin/assistant/conversations?limit=10');
        if (!el) return;
        el.innerHTML = r.items.length ? r.items.map((c) => `
          <div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px dashed #e5e7eb;">
            <span>${esc(c.title).slice(0, 60)} <span style="color:#94a3b8;">· ${esc(c.user)} · ${c.messages} رسالة</span></span>
            <span style="color:#0a2540;cursor:pointer;text-decoration:underline;" onclick="AdminUI.openAssistantConv('${c.id}')">فتح</span>
          </div>`).join('') : '<div>لا محادثات بعد.</div>';
      } catch (e) { if (el) el.textContent = '❌ ' + e.message; }
    },
    async openAssistantConv(id) {
      try {
        const r = await rq('/api/admin/assistant/conversations/' + id);
        const lines = r.conversation.messages.map((m) => `${m.role === 'user' ? '👤' : '🤖'} ${m.text}`).join('\n\n');
        alert('محادثة ' + r.conversation.id.slice(0, 8) + '\n\n' + lines.slice(0, 3000));
      } catch (e) { toast(e.message); }
    },
    render
  };
  window.AdminUI = AdminUI;

  // ربط: عند فتح صفحة الإعدادات يُضاف القسم، وعند فتح صفحة الإدارة تُرسم
  const origNav = window.navigateTo;
  window.navigateTo = function (pageId) {
    const r = origNav && origNav.apply(this, arguments);
    if (pageId === 'settingsPage') { injectSettingsSection(); setTimeout(injectSettingsSection, 80); }
    else if (pageId === 'adminPage') render();
    return r;
  };

  // لو فُتحت الإعدادات بطريقة أخرى
  document.addEventListener('click', (e) => {
    const path = e.target && e.target.closest && e.target.closest('[onclick*="settingsPage"]');
    if (path) setTimeout(injectSettingsSection, 120);
  }, true);

  function boot() {
    ensurePage();
    if ($('settingsContent') && $('settingsContent').children.length) injectSettingsSection();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
