const fs=require('fs');const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync('/home/user/uploads/msaralugstealalmee.html','utf8');
const vc=new VirtualConsole();
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/a.html',virtualConsole:vc,
 beforeParse(w){ w.Chart=class{destroy(){}}; w.L={map:()=>({setView:()=>({addTo(){}}),addTo(){},invalidateSize(){},tileLayer(){},marker:()=>({addTo:()=>({bindPopup(){}})})}),tileLayer:()=>({addTo(){}}),marker:()=>({addTo:()=>({bindPopup(){}})})}; w.HTMLCanvasElement.prototype.getContext=()=>({}); }});
const w=dom.window,d=w.document;
setTimeout(()=>{
  w.eval("loadSystemUsers();document.getElementById('loginIdentifier').value='taha123';document.getElementById('loginPassword').value='12580taha';performLogin();navigateTo('myShipmentsPage');displayShipments('delivered');");
  const tests = [
    "document.querySelectorAll('#myShipmentsPage .filter-btn').length",
    "document.querySelectorAll('#myShipmentsPage .filter-btn').forEach(b=>b.classList.remove('active'))",
    "document.getElementById('deliveredDateFilter').style.display='flex'",
    "displayShipments('delivered')",
    "document.querySelectorAll('#shipmentsList .shipment').forEach(el=>el.innerText)"
  ];
  tests.forEach(t=>{ try{ const v=w.eval(t); console.log('OK  :',t,'=>',String(v).slice(0,60)); }catch(e){ console.log('ERR :',t,'=>',e.message); } });
  // check overflow threshold: count nodes
  console.log('nodes:', w.eval('document.querySelectorAll("*").length'));
  try{ w.eval("navigateTo('globalPortalPage')"); }catch(e){ console.log('portal nav err', e.message); }
  console.log('portal cards:', w.eval("document.querySelectorAll('#globalPortalContainer .card').length"), 'len', w.eval("document.getElementById('globalPortalContainer').innerHTML.length"));
  console.log('portal first card:', w.eval("(document.querySelector('#globalPortalContainer .card')||{}).outerHTML").slice(0,500));
  process.exit(0);
},1500);
