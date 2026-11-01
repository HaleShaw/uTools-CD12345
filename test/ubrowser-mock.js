/**
 * uBrowser 模拟器：按 uTools 文档实现同名链式 API，底层用 Edge CDP。
 * 目的：在不进入 uTools 的情况下，用真实站点验证插件的 uBrowser 调用链。
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function createUBrowser(port, profileDir) {
  const ops = [];
  const api = {
    userAgent(ua) { ops.push({ t: "ua", v: ua }); return api; },
    goto(url, headers, timeout) { ops.push({ t: "goto", v: url, headers, timeout }); return api; },
    wait(fn, opts, ...args) { ops.push({ t: "wait", fn, opts, args }); return api; },
    evaluate(fn, ...args) { ops.push({ t: "eval", fn, args }); return api; },
    cookies(filter) { ops.push({ t: "cookies", filter }); return api; },
    setCookies(list) { ops.push({ t: "setCookies", list }); return api; },
    clearCookies() { ops.push({ t: "clearCookies" }); return api; },
    async run(opts) {
      const values = [];
      let browser = null;
      for (const op of ops) {
        if (op.t === "ua") {
          await cdp("Emulation.setUserAgentOverride", { userAgent: op.v });
        } else if (op.t === "goto") {
          await cdp("Page.navigate", { url: op.v });
          await sleep(1200);
        } else if (op.t === "wait") {
          const o = typeof op.opts === "number" ? { timeout: op.opts } : (op.opts || {});
          const timeout = o.timeout || 30000;
          const interval = o.interval || 100;
          const t0 = Date.now();
          let ok = false;
          while (Date.now() - t0 < timeout) {
            const r = await evalInPage(op.fn, op.args || []);
            if (r === true) { ok = true; break; }
            await sleep(interval);
          }
          if (!ok) throw new Error("wait 超时: " + timeout + "ms");
        } else if (op.t === "eval") {
          values.push(await evalInPage(op.fn, op.args));
        } else if (op.t === "cookies") {
          const r = await send("Network.getCookies", { urls: ["https://www.chengdu.gov.cn/"] }, global.__sid);
          values.push((r && r.cookies) || []);
        } else if (op.t === "setCookies") {
          const list = op.list || [];
          const ck = list.map((c) => ({
            name: c.name, value: c.value, url: c.url || "https://www.chengdu.gov.cn/",
          }));
          await send("Network.setCookies", { cookies: ck }, global.__sid);
        } else if (op.t === "clearCookies") {
          await send("Network.clearBrowserCookies", {}, global.__sid);
        }
      }
      ops.length = 0;
      browser = { id: 1, url: "", title: "" };
      values.push(browser);
      return values;
    },
    clearCookies() { ops.push({ t: "clearCookies" }); return api; },
  };

  // —— CDP 辅助 ——
  let ws, id = 0;
  const pend = new Map();
  const send = (m, pp = {}, sid) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pp, sessionId: sid })); });
  async function connect() {
    await sleep(3000);
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) {
        if (m.error) { console.log("[cdp error]", m.method || "", JSON.stringify(m.error).slice(0, 200)); pend.get(m.id)(undefined); }
        else pend.get(m.id)(m.result);
        pend.delete(m.id);
      }
    };
    await new Promise((r) => (ws.onopen = r));
    const t = await send("Target.createTarget", { url: "about:blank" });
    const att = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    global.__sid = att.sessionId;
    await send("Page.enable", {}, global.__sid);
    await send("Runtime.enable", {}, global.__sid);
  }
  function cdp(method, params) {
    return send(method, params, global.__sid).then((r) => {
      if (!r) throw new Error("CDP 调用失败: " + method);
      return r;
    });
  }
  async function evalInPage(fn, args) {
    const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
    const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
    if (!r || !r.result) throw new Error("页面求值失败: " + method + " " + JSON.stringify(r).slice(0, 200));
    if (r.exceptionDetails) throw new Error("页面脚本异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 读取浏览器当前 Cookie（用于测试断言） */
  const getCookies = async () => {
    const r = await send("Network.getCookies", { urls: ["https://www.chengdu.gov.cn/"] }, global.__sid);
    return (r && r.cookies) || [];
  };
  /** 模拟「窗口销毁 → 会话 Cookie 丢失」 */
  const clearCookies = async () => {
    await send("Network.clearBrowserCookies", {}, global.__sid);
  };

  return { api, connect, getCookies, clearCookies };
}

module.exports = { createUBrowser };
