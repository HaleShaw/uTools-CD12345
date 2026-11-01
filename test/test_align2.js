/**
 * 列表页「上次查询 时间」列左对齐实测
 *
 * 背景：卡片副标题原本是「部门 · 上次查询 时间」拼在一个字符串里，
 * 部门名长度不同 ⇒ 「上次查询」起始位置随行漂移，时间无法成列。
 * 现在改为 grid：部门列固定宽 140px，「上次查询 时间」列左对齐。
 *
 * 断言：所有工单行的 .t-qtime 左边缘 x 坐标偏差 = 0
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9411;

(async () => {
  const p = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + path.join(os.tmpdir(), "cd12345-align2"),
    "--window-size=880,640", "about:blank"], { stdio: "ignore" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = l.find((x) => x.type === "page");
      if (t) break;
    } catch (e) {}
  }
  if (!t) { console.log("ERR 未连接"); p.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, pp = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pp })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 868, height: 608, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "file:///" + path.join(__dirname, "uitest.html").replace(/\\/g, "/") });
  await sleep(1500);

  const js = `(function(){
    var out = [];
    var cards = document.querySelectorAll('.card');
    for (var i=0;i<cards.length;i++){
      var q = cards[i].querySelector('.t-qtime');
      var d = cards[i].querySelector('.t-dept');
      var lbl = cards[i].querySelector('.col-time');
      if(!q) continue;
      out.push({
        serial: (cards[i].querySelector('.serial')||{}).textContent||'',
        qx: Math.round(q.getBoundingClientRect().left*100)/100,
        dx: Math.round(d.getBoundingClientRect().left*100)/100,
        timeLabel: lbl ? (lbl.childNodes[0].textContent||'').trim() : '',
        text: (q.textContent||'').trim()
      });
    }
    return JSON.stringify(out);
  })()`;

  const r = await send("Runtime.evaluate", { expression: js, returnByValue: true });
  const rows = JSON.parse(r.result.value);

  console.log("「上次查询 时间」列左对齐实测：\n");
  rows.forEach((x) => {
    console.log("  " + x.serial.padEnd(16) + " 部门列x=" + x.dx + "  查询列x=" + x.qx + "  时间列标签=" + JSON.stringify(x.timeLabel) + "  " + x.text.slice(0, 24));
  });

  const qxs = rows.map((x) => x.qx);
  const dxs = rows.map((x) => x.dx);
  const spread = (a) => Math.max.apply(null, a) - Math.min.apply(null, a);
  const qSpread = spread(qxs);
  const dSpread = spread(dxs);
  const labels = new Set(rows.map((x) => x.timeLabel));

  console.log("\n  查询列左边缘最大偏差 : " + qSpread + " px " + (qSpread < 0.5 ? "✅ 完全对齐" : "❌ 未对齐"));
  console.log("  部门列左边缘最大偏差 : " + dSpread + " px " + (dSpread < 0.5 ? "✅ 完全对齐" : "❌ 未对齐"));
  console.log("  时间列标签统一       : " + JSON.stringify(Array.from(labels)) + " " + (labels.size === 1 ? "✅" : "❌"));

  ws.close(); p.kill();
  const ok = qSpread < 0.5 && dSpread < 0.5 && labels.size === 1;
  console.log(ok ? "\n列表页副标题列对齐实测通过 ✅" : "\n存在未对齐项 ❌");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("ERR", (e && e.stack) || e); process.exit(1); });
