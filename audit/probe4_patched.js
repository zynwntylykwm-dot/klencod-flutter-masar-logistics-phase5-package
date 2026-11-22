const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync('/home/user/app/index.html', 'utf8');
const vc = new VirtualConsole();
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/a.html', virtualConsole: vc,
  beforeParse(w) {
    w.Chart = class { destroy() {} };
    w.L = { map: () => ({ setView: () => ({ addTo() {} }), addTo() {}, invalidateSize() {}, tileLayer() {}, marker: () => ({ addTo: () => ({ bindPopup() {} }) }) }), tileLayer: () => ({ addTo() {} }), marker: () => ({ addTo: () => ({ bindPopup() {} }) }) };
    w.HTMLCanvasElement.prototype.getContext = () => ({});
    w.alert = () => {}; w.confirm = () => true; w.print = () => {}; w.open = () => null;
    w.navigator.clipboard = { writeText: () => Promise.resolve() };
  }
});
const w = dom.window, d = w.document;
const DENY = /performLogout|deleteShipment|deleteCRM|deleteFleet|deleteContract|deleteUser|toggleUserStatus|restoreBackup|importSystemData|shareApp|window\.open|location\.|printShipmentReport|printReports|printShipmentForm|closeWelcomeModal|walletUndoLastTransaction|editUser|saveUserFormData|approvePendingUser|rejectPendingUser|moveTo/;

setTimeout(() => {
  w.eval("loadSystemUsers();document.getElementById('loginIdentifier').value='taha123';document.getElementById('loginPassword').value='12580taha';performLogin();");
  if (d.getElementById('welcomeModal')) d.getElementById('welcomeModal').classList.remove('show');

  const pages = ['mainPage','trackingPage','myShipmentsPage','addShipmentPage','warehousesPage','calculatorPage','walletPage',
    'merchantsPage','statisticsPage','globalPortalPage','branchesPage','settingsPage','reportsPage','crmPage','fleetPage',
    'analyticsPage','promotionsPage','feedbackPage','contractsPage'];

  const seen = new Map(); // handler -> {ok, err, where}
  const perPage = {};

  for (const p of pages) {
    try { w.eval(`navigateTo('${p}')`); } catch (e) { perPage[p] = 'NAV ERR: ' + e.message; continue; }
    const handlers = [...d.querySelectorAll(`#${p} [onclick]`)].map(el => el.getAttribute('onclick'));
    perPage[p] = { handlers: handlers.length };
    for (const h of new Set(handlers)) {
      const key = p + ' :: ' + h.slice(0, 70);
      if (seen.has(h)) continue;
      if (DENY.test(h)) { seen.set(h, { ok: true, skipped: true }); continue; }
      let res;
      try {
        w.eval(`(function(){ try { ${h} } catch(e) { window.__err = e; } })()`);
        res = { ok: true };
        if (w.__err) { res = { ok: false, err: w.__err.message }; w.__err = null; }
      } catch (e) { res = { ok: false, err: e.message }; }
      seen.set(h, res);
    }
  }

  // also test onchange/oninput handlers
  const chg = new Map();
  for (const p of pages) {
    try { w.eval(`navigateTo('${p}')`); } catch (e) { continue; }
    for (const el of d.querySelectorAll(`#${p} [onchange],[oninput]`)) {
      const h = el.getAttribute('onchange') || el.getAttribute('oninput');
      if (!h || chg.has(h)) continue;
      try { w.eval(h); chg.set(h, { ok: true }); }
      catch (e) { chg.set(h, { ok: false, err: e.message }); }
    }
  }

  const broken = [...seen.entries()].filter(([h, r]) => !r.ok);
  const brokenChg = [...chg.entries()].filter(([h, r]) => !r.ok);
  console.log('=== PAGES: handler counts ===');
  console.log(JSON.stringify(perPage, null, 1));
  console.log('\n=== BROKEN onclick HANDLERS (' + broken.length + ' of ' + seen.size + ') ===');
  broken.forEach(([h, r]) => console.log(' ✗ ' + h.slice(0, 90) + '  =>  ' + String(r.err).slice(0, 100)));
  console.log('\n=== BROKEN onchange/oninput (' + brokenChg.length + ') ===');
  brokenChg.forEach(([h, r]) => console.log(' ✗ ' + h.slice(0, 90) + '  =>  ' + String(r.err).slice(0, 100)));

  // deep functional checks with eval scope
  const checks = [];
  const C = (name, code, predicate) => {
    try { const v = w.eval(code); checks.push({ name, ok: predicate ? predicate(v) : true, v }); }
    catch (e) { checks.push({ name, ok: false, v: 'ERR: ' + e.message }); }
  };
  C('filter shipments (all)', "navigateTo('myShipmentsPage'); filterShipments('all'); document.querySelectorAll('#shipmentsList .shipment').length", v => v === 37);
  C('filter shipments (shipped)', "filterShipments('shipped'); document.querySelectorAll('#shipmentsList .shipment').length", v => v === 8);
  C('filter delivered', "showDeliveredFilter(); document.querySelectorAll('#shipmentsList .shipment').length", v => v === 25);
  C('filter by date', "document.getElementById('dateFrom').value='2019-01-01';document.getElementById('dateTo').value='2019-12-31';filterByDate(); document.querySelectorAll('#shipmentsList .shipment').length", v => v > 0);
  C('branches filter', "navigateTo('branchesPage'); filterBranches('active'); document.querySelectorAll('#branchesList .branch-card').length", v => v > 0);
  C('branches search', "document.getElementById('branchSearch').value='عدن';searchBranches(); document.querySelectorAll('#branchesList .branch-card').length", v => v === 1);
  C('warehouse filter YE', "navigateTo('warehousesPage'); filterWarehouses('YE', null); document.querySelectorAll('#warehousesList .warehouse-card').length", v => v === 4);
  C('warehouse search', "document.getElementById('warehouseSearch').value='عدن'; searchWarehouses(); document.querySelectorAll('#warehousesList .warehouse-card').length", v => v === 1);
  C('add shipment (long press path)', "navigateTo('addShipmentPage'); showFullAddShipmentForm(); document.getElementById('fullShipmentForm').innerHTML.length", v => v > 3000);
  C('generate tracking number', "typeof generateTrackingNumber==='function' ? generateTrackingNumber() : (document.getElementById('newTrackingNumber')||{}).value", v => !!v);
  C('save new shipment', "document.getElementById('newSender').value='X';document.getElementById('newWeight').value='10'; saveNewShipment(); shipments.length", v => v === 38);
  C('statistics charts', "navigateTo('statisticsPage'); loadStatisticsPage(); document.querySelectorAll('#statsGrid .stat-card').length", v => v === 8);
  C('reports render', "navigateTo('reportsPage'); loadReportsPage(); document.getElementById('reportsContent').innerHTML.length", v => v > 1000);
  C('crm render', "navigateTo('crmPage'); renderCRMPage(); document.querySelectorAll('#crmList .crm-card').length", v => v === 2);
  C('crm add', "document.getElementById('modalBody').innerHTML='<input id=\"crmName\"><input id=\"crmPhone\"><input id=\"crmEmail\"><textarea id=\"crmNotes\"></textarea>';document.getElementById('crmName').value='عميل';document.getElementById('crmPhone').value='777';saveCRM(); crmData.length", v => v === 3);
  C('fleet render', "navigateTo('fleetPage'); renderFleetPage(); document.querySelectorAll('#fleetList .fleet-card').length", v => v === 2);
  C('feedback render', "navigateTo('feedbackPage'); renderFeedbackPage(); document.querySelectorAll('#feedbackList *').length", v => v > 0);
  C('contracts render', "navigateTo('contractsPage'); renderContractsPage(); document.querySelectorAll('#contractsList *').length", v => v > 0);
  C('promotions render', "navigateTo('promotionsPage'); renderPromotionsPage(); document.querySelectorAll('#promoList *').length", v => v > 0);
  C('promo generate', "generatePromoCode(); promoCodes.length", v => v === 3);
  C('analytics render', "navigateTo('analyticsPage'); renderAnalyticsPage(); document.getElementById('analyticsContent').innerHTML.length", v => v > 100);
  C('merchants render', "navigateTo('merchantsPage'); renderMerchantsPage(); document.querySelectorAll('#merchantsListContainer .merchant-card-custom').length", v => v === 2);
  C('wallet deposit math', "loadWalletData(); (function(){const b=walletCards[0].balance; walletCards[0].balance=b+100; saveWalletData(); return walletCards[0].balance-b;})()", v => v === 100);
  C('wallet total balance', "walletGetTotalBalance()", v => v === 36655 + 100);
  C('notifications render', "addNotification('🧪','اختبار'); loadNotifications(); document.getElementById('notificationPopup').innerHTML.length", v => v > 0);
  C('AI: tracking query', "handleAIMessage('تتبع HDTA6351661')", v => /HDTA6351661/.test(v) && /الموقع/.test(v));
  C('AI: unknown query fallback', "handleAIMessage('سؤال غريب تماما')", v => /المساعد الذكي/.test(v));
  C('backup roundtrip', "createBackup(); localStorage.getItem('alshahd_system_backup').length", v => v > 1000);
  C('export data (blob)', "typeof exportData", v => v === 'function');
  C('portal invoice calc', "navigateTo('globalPortalPage'); document.getElementById('portalProductPrice').value='100';document.getElementById('portalProductQuantity').value='2';document.getElementById('portalShippingWeight').value='3'; portalCalculateInvoice()", v => v === 275);
  C('portal favorites toggle', "portalToggleFavorite('Amazon'); portalState ? 'x':'y'", v => true);
  C('portal search filter', "document.getElementById('portalSearchInput').value='amazon'; window.portalSearch && portalSearch()", v => true);
  C('settings sections', "navigateTo('settingsPage'); document.querySelectorAll('#settingsContent .settings-section').length", v => v === 9);
  C('change password wrong current', "navigateTo('settingsPage'); document.getElementById('currentPassword').value='x';document.getElementById('newPassword').value='y';document.getElementById('confirmPassword').value='y'; changePassword(); currentLoggedInUser.password", v => v === '12580taha');
  C('theme change', "document.getElementById('themeSelect') && (document.getElementById('themeSelect').value='dark', changeTheme()); document.body.classList.contains('dark-mode')", v => v === true);
  C('font size change', "document.getElementById('fontSizeSelect').value='large'; changeFontSize(); document.body.style.fontSize", v => v === '18px');

  console.log('\n=== FUNCTIONAL CHECKS ===');
  checks.forEach(c => console.log(` [${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(34)} => ${String(c.v).slice(0, 90)}`));

  fs.writeFileSync('/home/user/audit/deep_report.json', JSON.stringify({ perPage, broken: broken.map(([h, r]) => ({ h, e: r.err })), brokenChg: brokenChg.map(([h, r]) => ({ h, e: r.err })), checks }, null, 1));
  process.exit(0);
}, 1500);
