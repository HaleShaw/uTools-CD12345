/**
 * 列表页状态徽章「列内居中」坐标实测
 *
 * 用无头 Edge 打开 test/uitest.html（内置桩服务），量每个卡片的状态徽章
 * 中心与状态列中心的偏差，应恒为 0。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9499;
const p = spawn(EDGE, ["--headless=new","--disable-gpu","--no-first-run",
  "--remote-debugging-port="+PORT,"--user-data-dir="+process.env.TEMP+"\\cd12345-eg","--window-size=880,640","about:blank"], {stdio:"ignore"});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
(async () => {
  let t=null;
  for(let i=0;i<40;i++){ await sleep(500); try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t=l.find(x=>x.type==="page"); if(t)break;}catch(e){} }
  const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const pend=new Map();
  const send=(m,pp={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pp}));});
  ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
  await new Promise(r=>ws.onopen=r);
  await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setDeviceMetricsOverride",{width:868,height:608,deviceScaleFactor:2,mobile:false});
  await send("Page.navigate",{url:"file:///"+path.join(__dirname,"uitest.html").replace(/\\/g,"/")});
  await sleep(1500);
  const r = await send("Runtime.evaluate",{expression:`(function(){
    var out=[];
    document.querySelectorAll('.card').forEach(function(card){
      var col=card.querySelector('.col-status');
      var b=col && col.querySelector('.badge');
      if(!b) return;
      var cb=col.getBoundingClientRect(), bb=b.getBoundingClientRect();
      out.push({ text: b.textContent,
                badgeLeft: +bb.left.toFixed(1), badgeRight: +bb.right.toFixed(1),
                colLeft: +cb.left.toFixed(1), colRight: +cb.right.toFixed(1),
                badgeCenter: +(bb.left+bb.width/2).toFixed(1),
                colCenter: +(cb.left+cb.width/2).toFixed(1),
                offset: +((bb.left+bb.width/2)-(cb.left+cb.width/2)).toFixed(2) });
    });
    return JSON.stringify(out);
  })()`,returnByValue:true});
  const rows = JSON.parse(r.result.value);
  if (!rows.length) {
    console.log("❌ 未取到任何状态徽章（自测页可能未加载）");
    ws.close(); p.kill(); process.exit(1);
  }
  console.log("状态列实测（badge 相对列中心的偏移应为 0）:");
  rows.forEach(x=>console.log(`  ${x.text.padEnd(8)} 列[${x.colLeft}~${x.colRight}] 徽章[${x.badgeLeft}~${x.badgeRight}] 中心偏移=${x.offset}px`));
  const centers = rows.map(x=>x.badgeCenter);
  const spread = Math.max(...centers) - Math.min(...centers);
  console.log("徽章中心最大偏差:", spread.toFixed(1), "px", spread < 0.5 ? "✅ 完全对齐" : "❌ 未对齐");
  const offsets = rows.map(x=>Math.abs(x.offset));
  console.log("相对列中心最大偏移:", Math.max(...offsets).toFixed(2), "px", Math.max(...offsets) < 0.5 ? "✅ 居中" : "❌ 未居中");
  ws.close(); p.kill(); process.exit(0);
})().catch(e=>{console.log("ERR",e.message); try{p.kill();}catch(_){} process.exit(1);});
