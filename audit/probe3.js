const fs=require('fs');const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync('/home/user/uploads/msaralugstealalmee.html','utf8');
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/a.html',virtualConsole:new VirtualConsole(),
 beforeParse(w){ w.Chart=class{destroy(){}}; w.L={map:()=>({setView:()=>({addTo(){}}),addTo(){},invalidateSize(){},tileLayer(){},marker:()=>({addTo:()=>({bindPopup(){}})})}),tileLayer:()=>({addTo(){}}),marker:()=>({addTo:()=>({bindPopup(){}})})}; w.HTMLCanvasElement.prototype.getContext=()=>({}); }});
const w=dom.window;
setTimeout(()=>{
  w.eval("loadSystemUsers();document.getElementById('loginIdentifier').value='taha123';document.getElementById('loginPassword').value='12580taha';performLogin();navigateTo('myShipmentsPage');");
  try{ w.eval("showDeliveredFilter()"); console.log('showDeliveredFilter OK'); }
  catch(e){ console.log('ERR', e.message); const st=(e.stack||'').split('\n'); console.log(st.slice(0,12).join('\n')); }
  console.log('--- source of showDeliveredFilter ---');
  console.log(w.eval("showDeliveredFilter.toString()").slice(0,600));
  process.exit(0);
},1500);
