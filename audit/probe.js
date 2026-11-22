const fs=require('fs');const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync('/home/user/uploads/msaralugstealalmee.html','utf8');
const vc=new VirtualConsole(); vc.on('jsdomError',e=>{ if(!/Could not load/.test(e.message)) console.log('JSDOMERR:',e.message.slice(0,300)); });
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/a.html',virtualConsole:vc,
 beforeParse(w){ w.Chart=class{destroy(){}}; w.L={map:()=>({setView:()=>({addTo(){}}),addTo(){},invalidateSize(){},tileLayer(){},marker:()=>({addTo:()=>({bindPopup(){}})})}),tileLayer:()=>({addTo(){}}),marker:()=>({addTo:()=>({bindPopup(){}})})}; w.HTMLCanvasElement.prototype.getContext=()=>({}); }});
const w=dom.window,d=w.document;
setTimeout(()=>{
  w.eval("loadSystemUsers();");
  console.log('users via eval:', w.eval('systemUsers.length'));
  console.log('shipments via eval:', w.eval('shipments.length'));
  w.eval("document.getElementById('loginIdentifier').value='taha123';document.getElementById('loginPassword').value='12580taha';performLogin();");
  console.log('logged in:', w.eval('currentLoggedInUser && currentLoggedInUser.fullName'));
  try{ w.eval("navigateTo('myShipmentsPage'); displayShipments('delivered');"); console.log('delivered direct OK, cards=', w.eval("document.querySelectorAll('#shipmentsList .shipment').length")); }
  catch(e){ console.log('delivered direct ERR:', e.message, (e.stack||'').split('\n').slice(0,4).join(' | ')); }
  try{ w.eval("showDeliveredFilter();"); console.log('showDeliveredFilter OK'); }
  catch(e){ console.log('showDeliveredFilter ERR:', e.message); }
  try{ console.log('crm len', w.eval('crmData.length'), 'fleet', w.eval('fleetData.length'), 'promo', w.eval('promoCodes.length')); }catch(e){console.log('data err',e.message);}
  try{ console.log('portal html sample:', w.eval("(document.getElementById('globalPortalContainer').innerHTML||'').slice(0,400)")); }catch(e){}
  process.exit(0);
},1500);
