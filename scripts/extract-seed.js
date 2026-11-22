const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync('backups/' + fs.readdirSync('backups').find(f => f.includes('ORIGINAL')), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/a.html', virtualConsole: new VirtualConsole(),
  beforeParse(w){ w.Chart=class{destroy(){}}; w.L={map:()=>({setView:()=>({addTo(){}}),addTo(){},invalidateSize(){},tileLayer(){},marker:()=>({addTo:()=>({bindPopup(){}})})}),tileLayer:()=>({addTo(){}}),marker:()=>({addTo:()=>({bindPopup(){}})})}; w.HTMLCanvasElement.prototype.getContext=()=>({}); }});
setTimeout(() => {
  const raw = dom.window.eval('JSON.stringify(shipments)');
  const rows = JSON.parse(raw).map(s => ({ ...s, demo: true, data_source: 'بيانات تجريبية مستوردة من النظام السابق' }));
  fs.writeFileSync('data/seed-shipments.json', JSON.stringify(rows, null, 1), 'utf8');
  console.log('exported', rows.length, 'shipments');
  process.exit(0);
}, 1500);
