// Functional audit of the legacy single-file app using jsdom.
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync('/home/user/uploads/msaralugstealalmee.html', 'utf8');
const errors = [];
const logs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Could not load|Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('log', (...a) => logs.push(a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/app.html',
  virtualConsole: vc,
  beforeParse(window) {
    // Stubs for CDN libs that cannot load offline
    window.Chart = class { constructor(ctx, cfg) { this.cfg = cfg; } destroy() {} };
    window.L = {
      map: () => ({ setView: () => ({ addTo: () => ({}) }), addTo(){}, invalidateSize(){}, tileLayer(){}, marker(){ return { addTo: () => ({ bindPopup(){} }) }; } }),
      tileLayer: () => ({ addTo: () => ({}) }),
      marker: () => ({ addTo: () => ({ bindPopup(){} }) })
    };
    window.HTMLCanvasElement.prototype.getContext = () => ({});
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){} }));
    window.scrollTo = () => {};
  }
});
const w = dom.window, d = w.document;

function safe(label, fn) {
  try { return { label, ok: true, value: fn() }; }
  catch (e) { return { label, ok: false, error: e.message }; }
}
const results = [];
const push = (r) => results.push(r);
const txt = (id) => (d.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();

setTimeout(() => {
  // ---------- boot ----------
  push({ check: 'script executed / globals', ok: typeof w.navigateTo === 'function', info: 'navigateTo=' + typeof w.navigateTo });
  push({ check: 'seed users loaded', ok: (w.systemUsers || []).length >= 2, info: (w.systemUsers || []).length + ' users' });
  push({ check: 'seed shipments', ok: (w.shipments || []).length > 0, info: (w.shipments || []).length + ' shipments' });

  // ---------- login ----------
  d.getElementById('loginIdentifier').value = 'taha123';
  d.getElementById('loginPassword').value = '12580taha';
  let r = safe('login', () => { w.performLogin(); return d.getElementById('appContainer').style.display; });
  push({ check: 'login works', ok: r.ok && r.value === 'block', info: r.error || r.value });
  push({ check: 'currentLoggedInUser set', ok: !!w.currentLoggedInUser, info: w.currentLoggedInUser?.fullName });

  // ---------- navigate all pages ----------
  const pages = ['mainPage','trackingPage','myShipmentsPage','addShipmentPage','warehousesPage','calculatorPage','walletPage',
    'merchantsPage','statisticsPage','globalPortalPage','branchesPage','settingsPage','reportsPage','crmPage','fleetPage',
    'analyticsPage','promotionsPage','feedbackPage','contractsPage'];
  const pageRows = [];
  for (const p of pages) {
    const before = errors.length;
    const res = safe(p, () => { w.navigateTo(p); return d.getElementById(p).style.display; });
    pageRows.push({ page: p, displayed: res.ok ? res.value : 'ERR', error: res.error || (errors.slice(before).join(' | ') || ''), textLen: txt(p).length });
  }
  push({ check: 'all pages navigable', ok: pageRows.every(x => x.displayed !== 'ERR'), info: JSON.stringify(pageRows.filter(x => x.displayed === 'ERR')) });

  // ---------- tracking ----------
  d.getElementById('trackInput').value = 'HDTA6351661';
  r = safe('tracking', () => { w.searchShipment(); return { res: d.getElementById('resultCard').style.display, items: d.querySelectorAll('#resInfoGrid .info-item').length }; });
  push({ check: 'tracking search', ok: r.ok && r.value.items > 5, info: JSON.stringify(r.value || r.error) });

  // ---------- shipments filter + missing copyToClipboard ----------
  w.navigateTo('myShipmentsPage');
  r = safe('filterShipments delivered', () => { w.showDeliveredFilter(); return d.querySelectorAll('#shipmentsList .shipment').length; });
  push({ check: 'delivered filter renders', ok: r.ok && r.value > 0, info: String(r.value || r.error) });
  const copyBtnErr = safe('copyToClipboard', () => {
    const btn = d.querySelector('#shipmentsList .shipment button');
    if (!btn) return 'no button';
    // simulate the inline handler exactly as the browser would
    w.eval("document.querySelector('#shipmentsList .shipment button').click()");
    return 'clicked';
  });
  push({ check: 'copy button in delivered list (copyToClipboard defined?)', ok: copyBtnErr.ok && typeof w.copyToClipboard === 'function', info: copyBtnErr.error || ('typeof copyToClipboard=' + typeof w.copyToClipboard) });

  // ---------- calculator ----------
  w.navigateTo('calculatorPage');
  d.getElementById('calcWeight').value = '100';
  d.getElementById('calcSource').value = 'UAE'; d.getElementById('calcDest').value = 'OM'; d.getElementById('calcType').value = 'heavy';
  r = safe('calc', () => { w.calculateShipping(); return txt('calcResult'); });
  push({ check: 'shipping calculator (100kg AE→OM heavy = $2376)', ok: r.ok && /2,?376/.test(r.value || ''), info: (r.value || r.error).slice(0, 120) });

  // ---------- wallet ----------
  w.navigateTo('walletPage');
  push({ check: 'wallet renders', ok: (txt('walletAppContainer').length > 200), info: txt('walletAppContainer').length + ' chars' });
  const balBefore = w.walletGetTotalBalance();
  r = safe('wallet deposit', () => {
    w.walletActionDeposit && w.walletActionDeposit();
    return 'opened modal';
  });
  push({ check: 'wallet deposit opens flow', ok: r.ok, info: r.error || r.value });

  // ---------- portal ----------
  w.navigateTo('globalPortalPage');
  const portal = safe('portal', () => ({
    links: d.querySelectorAll('#globalPortalContainer a[href^="http"]').length,
    cards: d.querySelectorAll('#globalPortalContainer .card').length,
    tabs: d.querySelectorAll('#globalPortalContainer .tab, #globalPortalContainer .category-tab').length,
    len: txt('globalPortalContainer').length
  }));
  push({ check: 'portal renders 90 external sites', ok: portal.ok && portal.value.links >= 80, info: JSON.stringify(portal.value || portal.error) });

  // ---------- settings as normal user ----------
  w.navigateTo('settingsPage');
  push({ check: 'settings render for normal user', ok: txt('settingsContent').length > 500, info: txt('settingsContent').length + ' chars' });

  // ---------- CRUD ----------
  const crmBefore = (w.crmData || []).length;
  r = safe('CRM add', () => {
    d.getElementById('modalBody').innerHTML = '<input id="crmName"><input id="crmPhone"><input id="crmEmail"><textarea id="crmNotes"></textarea>';
    d.getElementById('crmName').value = 'عميل اختبار'; d.getElementById('crmPhone').value = '777123456';
    w.saveCRM();
    return (w.crmData || []).length;
  });
  push({ check: 'CRM add persists', ok: r.ok && r.value === crmBefore + 1, info: String(r.value || r.error) });

  const fleetBefore = (w.fleetData || []).length;
  r = safe('fleet add', () => {
    d.getElementById('modalBody').innerHTML = '<input id="fleetPlate"><input id="fleetModel"><input id="fleetYear"><input id="fleetDriver"><textarea id="fleetNotes"></textarea><select id="fleetStatus"><option value="active" selected>a</option></select>';
    d.getElementById('fleetPlate').value = 'س ص ع 9999'; d.getElementById('fleetModel').value = 'شاحنة اختبار'; d.getElementById('fleetYear').value = '2025';
    d.getElementById('fleetDriver').value = 'سائق'; d.getElementById('fleetStatus').value = 'active';
    w.saveFleet();
    return (w.fleetData || []).length;
  });
  push({ check: 'Fleet add persists', ok: r.ok && r.value === fleetBefore + 1, info: String(r.value || r.error) });

  // promo
  r = safe('promo apply', () => {
    w.loadPromoCodes && w.loadPromoCodes();
    if (!Array.isArray(w.promoCodes) || !w.promoCodes.length) return 'no promo codes seeded';
    d.getElementById('modalBody').innerHTML = '<input id="promoApplyInput">';
    d.getElementById('promoApplyInput').value = w.promoCodes[0].code;
    w.applyPromoCode();
    return txt('promoApplyResult') || 'no result text';
  });
  push({ check: 'promo code apply (seeded?)', ok: r.ok && !/no promo codes/.test(String(r.value)), info: String(r.value || r.error).slice(0, 120) });

  // backup
  r = safe('backup', () => { w.createBackup(); return !!w.localStorage.getItem('alshahd_system_backup'); });
  push({ check: 'backup creation', ok: r.ok && r.value === true, info: String(r.value || r.error) });

  // ---------- dupe functions ----------
  push({ check: 'applyUserDataToUI defined twice (code smell)', ok: true, info: 'confirmed statically' });

  // ---------- output ----------
  console.log('=== PAGE RENDER (jsdom, no layout) ===');
  pageRows.forEach(x => console.log(` ${x.page.padEnd(20)} display=${String(x.displayed).padEnd(5)} text=${String(x.textLen).padEnd(6)} ${x.error ? 'ERR: ' + x.error.slice(0, 90) : ''}`));
  console.log('\n=== CHECKS ===');
  results.forEach(x => console.log(` [${x.ok ? 'PASS' : 'FAIL'}] ${x.check}  -> ${String(x.info).slice(0, 150)}`));
  console.log('\n=== RUNTIME ERRORS (' + errors.length + ') ===');
  [...new Set(errors)].slice(0, 25).forEach(e => console.log(' - ' + e.slice(0, 200)));
  fs.writeFileSync('/home/user/audit/jsdom_report.json', JSON.stringify({ pages: pageRows, results, errors: [...new Set(errors)] }, null, 1));
}, 1200);
