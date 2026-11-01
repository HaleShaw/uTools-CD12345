/**
 * 图形验证码链路测试（会话连续性 + 校验接口契约）
 *
 * 背景：
 *   生产环境的主通道是「常驻自定义窗口」。窗口常驻 ⇒ JSESSIONID 一直留在会话里，
 *   所以「取验证码图」和「提交验证码」必须是同一个 HTTP 会话，否则服务端认为
 *   当前会话根本没有这张验证码 —— 此时即使用户输入正确，也会返回 status:"-1"。
 *   uBrowser 每次 run() 都会销毁窗口 ⇒ JSESSIONID 丢失 ⇒ 验证码不可用（仅兜底通道）。
 *
 * 本测试用常驻 Edge + CDP 复刻「常驻窗口」语义，断言：
 *   [1] 验证码图片接口返回合法 JPEG
 *   [2] 会话 Cookie（JSESSIONID）在取图 → 校验之间保持不变 ← 关键
 *   [3] 校验接口对错误验证码返回 status:"-1"（而不是 HTML 错误页 / 抛异常）
 *   [4] 取图 → 校验 → 再取图 全链路不中断
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9520;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cd12345-cap-"));

global.utools = {
  getPluginLocalDataPath: () => tmp,
  dbStorage: { setItem() {}, getItem() {} },
  shellOpenExternal() {},
};

const client = require("../libs/client");
const session = require("../libs/session");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(ok, label, extra) {
  console.log((ok ? "  PASS " : "  FAIL ") + label + (extra ? "  " + extra : ""));
  if (!ok) failed++;
}

(async () => {
  const p = spawn(EDGE, [
    "--no-first-run", "--no-default-browser-check", "--window-size=1400,900",
    "--user-agent=" + UA,
    "--remote-debugging-port=" + PORT, "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + path.join(tmp, "edge"), "about:blank",
  ], { stdio: "ignore" });

  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = l.find((x) => x.type === "page");
      if (t) break;
    } catch (e) {}
  }
  if (!t) { console.log("未能获取调试目标"); p.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, pp = {}) =>
    new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pp })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.navigate", { url: "https://www.chengdu.gov.cn/12345/index" });
  await sleep(11000);

  const jsessionid = async () => {
    try {
      const r = await send("Network.getCookies", { urls: ["https://www.chengdu.gov.cn/"] });
      const c = (r.cookies || []).find((x) => x.name === "JSESSIONID");
      return c ? c.value : null;
    } catch (e) { return null; }
  };

  // 注入传输层：等价于 session.js 在常驻窗口里的页面内 fetch
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

  console.log("[1] 取图形验证码图片…");
  const cap = await client.getCaptcha();
  const isJpeg = cap.imageBase64.startsWith("data:image/jpeg;base64,");
  check(isJpeg, "验证码图片 MIME 为 image/jpeg", cap.imageBase64.slice(0, 24));
  check(cap.imageBase64.length > 500, "验证码图片数据长度合理", cap.imageBase64.length + " 字符");

  const sid1 = await jsessionid();
  console.log("[2] 会话 JSESSIONID:", sid1 ? sid1.slice(0, 12) + "…" : "(无)");

  console.log("[3] 提交错误验证码（应被拒绝）…");
  const ok = await client.verifyCaptcha("XXXX");
  check(ok === false, "错误验证码校验结果为 false（未通过）");

  const sid2 = await jsessionid();
  console.log("[4] 校验后 JSESSIONID:", sid2 ? sid2.slice(0, 12) + "…" : "(无)");
  check(!!sid1 && !!sid2 && sid1 === sid2, "取图 → 校验之间会话保持一致（同一 HTTP 会话）");

  console.log("[5] 会话仍可继续取图…");
  const cap2 = await client.getCaptcha();
  check(cap2.imageBase64.length > 500, "二次取图成功", cap2.imageBase64.length + " 字符");
  const sid3 = await jsessionid();
  check(sid3 === sid1, "二次取图后会话仍未变化");

  ws.close();
  p.kill();
  console.log(failed === 0 ? "\n验证码链路测试全部通过 ✅" : "\n失败 " + failed + " 项 ❌");
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log("ERR", (e && e.stack) || e); process.exit(1); });
