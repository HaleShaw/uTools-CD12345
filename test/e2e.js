/**
 * 端到端测试：用真实凭据跑通 client.js -> parser.js -> store.js 全链路
 * 传输层用 Edge CDP 模拟（生产环境由 session.js 的隐藏窗口承担）
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9437;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Electron/30.0.0";
const { serial: SERIAL, passcode: PASSCODE } = pickCreds();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cd12345-e2e-"));
global.utools = {
  getPluginLocalDataPath: () => tmp,
  dbStorage: { _v: {}, setItem(k, v) { this._v[k] = v; }, getItem(k) { return this._v[k]; } },
  shellOpenExternal() {},
};

const store = require("../libs/store");
const client = require("../libs/client");
const session = require("../libs/session");

/**
 * 取一组测试凭据。
 *
 * 凭据**不写进代码**——仓库可能会公开，一组可用的「流水号 + 提取码」不该躺在里面。
 * 用法：node e2e.js <流水号> <提取码>
 * 也可用环境变量 CD12345_SERIAL / CD12345_PASSCODE。
 */
function pickCreds() {
  const serial = process.argv[2] || process.env.CD12345_SERIAL || "";
  const passcode = process.argv[3] || process.env.CD12345_PASSCODE || "";
  if (!/^\d{12}$/.test(serial) || !/^\d{6}$/.test(passcode)) {
    console.log("用法：node e2e.js <流水号> <提取码>");
    console.log("   或设置环境变量 CD12345_SERIAL / CD12345_PASSCODE");
    console.log("（凭据来自成都 12345 平台受理后的短信/回执，仅用于本地联调）");
    process.exit(2);
  }
  return { serial, passcode };
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const p = spawn(EDGE, ["--no-first-run","--no-default-browser-check","--window-size=1400,900","--user-agent="+UA,
    "--remote-debugging-port=" + PORT, "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + path.join(tmp, "edge"), "about:blank"], { stdio: ["ignore","pipe","pipe"] });
  p.stderr.on("data", (d) => process.stdout.write("[edge] " + d));

  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = l.find((x) => x.type === "page" && /^about:blank|^https?:/.test(x.url)) || l.find((x) => x.type === "page");
      if (t) break;
    } catch (e) { if (i % 8 === 0) console.log("[boot] 等待 DevTools:", e.message); }
  }
  if (!t) { console.log("[boot] 未能获取调试目标"); p.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, pp = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pp })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "https://www.chengdu.gov.cn/12345/index" });
  await sleep(11000);
  const titleRes = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  console.log("[1] 瑞数挑战通过，页面标题:", JSON.stringify(titleRes.result.value));

  // 注入传输层：等价于 session.js 在真实插件里的页面内 fetch
  session.fetchInPage = async (url, options) => {
    const opts = options || {};
    const init = {
      method: opts.method || "GET",
      headers: opts.headers || {},
      credentials: "include",
    };
    if (opts.body) init.body = opts.body;
    const expr = `(async()=>{const r=await fetch(${JSON.stringify(url)},${JSON.stringify(init)});const b=await r.arrayBuffer();const u=new Uint8Array(b);let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return JSON.stringify({status:r.status,url:r.url,b64:btoa(s)});})()`;
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    const o = JSON.parse(r.result.value);
    const buf = Buffer.from(o.b64, "base64");
    return { status: o.status, url: o.url, buffer: buf, text: buf.toString("utf-8"), base64: buf.toString("base64") };
  };

  // 1. 新增工单
  const add = store.addTicket({ serial: SERIAL, passcode: PASSCODE, remark: "e2e" });
  console.log("[2] 新增工单:", add.ok ? "OK" : add.error);
  if (!add.ok) { p.kill(); process.exit(1); }
  const ticketId = add.ticket.id;

  // 2. 真实查询
  const t0 = Date.now();
  let data, err;
  try {
    data = await client.queryTicket(add.ticket, {});
  } catch (e) {
    err = e;
  }
  console.log("[3] 查询耗时", Date.now() - t0, "ms");
  if (err) {
    console.log("    查询失败:", err.message, "| needCaptcha =", !!err.needCaptcha);
    p.kill(); process.exit(1);
  }

  console.log("[4] 解析结果:");
  console.log("    标题     :", data.summary.title);
  console.log("    来电时间 :", data.callTime);
  console.log("    承办部门 :", data.summary.dept);
  console.log("    分类     :", data.summary.category);
  console.log("    状态     :", data.statusText);
  console.log("    办理进度 :", data.timeline.length, "条");
  data.timeline.forEach((e, i) => console.log(`      [${i}] ${e.dept} | ${e.time} | ${String(e.text).slice(0, 50)}`));
  console.log("    诉求内容 :", String(data.summary.appealContent || "").split("\n")[0]);

  // 3. 回写存储
  store.saveResult(ticketId, { queriedAt: Date.now(), statusText: data.statusText, summary: data.summary, timeline: data.timeline, finalResult: data.finalResult }, { callTime: data.callTime, summary: data.summary });
  const list = store.listTickets();
  const t1 = list.find((x) => x.id === ticketId);
  console.log("[5] 回写存储:");
  console.log("    queryState:", t1.queryState, "| callTime:", t1.callTime);
  console.log("    summary.title:", t1.summary.title, "| summary.dept:", t1.summary.dept);
  console.log("    result.timeline 条数:", t1.result.timeline.length);
  console.log("    列表排序首位 =", list[0].serial, "（来电时间", list[0].callTime + "）");

  // 4. 同步副本检查
  const meta = global.utools.dbStorage.getItem("cd12345.tickets.meta");
  console.log("[6] 同步副本含提取码 ?", JSON.stringify(meta).includes(PASSCODE), "（应为 false）");

  // 5. 验证码图片
  const cap = await client.getCaptcha();
  console.log("[7] 图形验证码图片:", cap.imageBase64.slice(0, 30) + "...", "长度", cap.imageBase64.length);

  ws.close(); p.kill();
  console.log("\n端到端测试完成 ✅");
  process.exit(0);
})().catch((e) => { console.log("ERR", e && e.stack || e); process.exit(1); });


