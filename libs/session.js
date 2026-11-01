/**
 * 瑞数会话管理
 *
 * www.chengdu.gov.cn 由瑞数(Ruishu 5代) 保护，直接请求返回 412 挑战页。
 *
 * ── 通道设计 ────────────────────────────────────────────────
 * 【主通道】持久自定义窗口（utools.createBrowserWindow）
 *   窗口常驻 ⇒ ① 瑞数 Cookie 留在会话里，后续请求不再重复过盾
 *              ② JSESSIONID 也在会话里 ⇒ 图形验证码能正常校验
 *   这是唯一能同时满足「免过盾」和「验证码可用」的通道。
 *
 * 【备选通道】uTools 官方 uBrowser（utools.ubrowser）
 *   run() 结束会销毁隐藏窗口 ⇒ 会话 Cookie 随之丢失
 *   ⇒ 瑞数 Cookie（持久型）仍在，但 JSESSIONID 丢失，验证码不可用
 *   ⇒ 只在自定义窗口不可用时兜底
 *
 * 实测记录：
 *   · uTools 托管窗口运行时并未实现 loadURL（文档有、实际没有）→ 改用页面内 location 导航
 *   · 渲染进程里 require('electron').BrowserWindow 不是构造函数 → 无法自建窗口
 *   · uBrowser.setCookies 覆盖 httpOnly Cookie 会被 Chromium 拒绝
 *     （EXCLUDE_OVERWRITE_HTTP_ONLY）→ 不能靠搬运 Cookie 来续会话
 */
const util = require("./util");

const BASE = "https://www.chengdu.gov.cn/12345/index";
const READY_TITLE = "成都12345";
const READY_TIMEOUT = 30000;
/** 离屏 / 降级尝试用较短超时，避免用户在失败路径上干等太久 */
const PRELOAD_READY_TIMEOUT = 15000;
const POLL_INTERVAL = 500;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let win = null;          // 自定义窗口
let winKind = "";
let ready = false;
let pending = null;      // 会话初始化 Promise
let lastError = "";
let ubrowserBroken = false;
let windowUnavailable = false; // 自定义窗口创建失败后不再反复尝试

function log(...args) {
  try {
    console.log("[cd12345/session]", ...args);
  } catch (e) {}
}

/* ================================================================
 * 通道一：持久自定义窗口
 * ================================================================ */

const PROBE = `(function () {
  try {
    var b = document.body;
    return JSON.stringify({
      t: document.title || "",
      u: location.href || "",
      len: b ? b.innerHTML.length : 0,
      form: !!(document.querySelector('input[name="noMailorTel"]')),
      txt: b ? (b.innerText || "").slice(0, 300) : ""
    });
  } catch (e) {
    return JSON.stringify({ t: "", u: "", len: 0, form: false, txt: "", error: String(e && e.message || e) });
  }
})()`;

function isReady(p) {
  if (!p) return false;
  if (p.t && p.t.indexOf(READY_TITLE) >= 0) return true;
  if (p.form) return true;
  if (p.txt && (p.txt.indexOf("市政府信箱") >= 0 || p.txt.indexOf("流水号") >= 0)) return true;
  return false;
}

function stillLocal(p) {
  return !!(p && typeof p.u === "string" && /^(file|about|chrome|devtools)/i.test(p.u));
}

async function probe(target) {
  try {
    const raw = await target.webContents.executeJavaScript(PROBE, true);
    return JSON.parse(raw);
  } catch (e) {
    return { t: "", u: "", len: 0, form: false, txt: "", error: e && e.message };
  }
}

async function waitReady(target, timeout) {
  const t0 = Date.now();
  let last = null;
  let localStreak = 0;
  while (Date.now() - t0 < timeout) {
    last = await probe(target);
    if (isReady(last)) return true;
    if (stillLocal(last)) {
      localStreak++;
      if (localStreak >= 4) {
        log("导航未生效，仍停留在:", last.u);
        return false;
      }
    } else {
      localStreak = 0;
    }
    await util.sleep(POLL_INTERVAL);
  }
  log("等待页面就绪超时:", JSON.stringify(last));
  return false;
}

async function waitDocumentReady(target, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 8000)) {
    try {
      const st = await target.webContents.executeJavaScript("document.readyState", true);
      if (st === "complete" || st === "interactive") return true;
    } catch (e) {}
    await util.sleep(200);
  }
  return false;
}

/** 导航到远程地址：优先 loadURL，没有就用页面内 location */
async function loadUrl(target, url) {
  if (!target) throw new Error("窗口不存在");
  if (typeof target.loadURL === "function") {
    await target.loadURL(url);
    return "loadURL";
  }
  if (target.webContents && typeof target.webContents.loadURL === "function") {
    await target.webContents.loadURL(url);
    return "webContents.loadURL";
  }
  await waitDocumentReady(target, 8000);
  const r = await target.webContents.executeJavaScript(
    "(function(){try{window.location.href=" + JSON.stringify(url) + ";return 'ok';}catch(e){return 'ERR:'+String(e);}})()",
    true
  );
  if (typeof r === "string" && r.indexOf("ERR:") === 0) {
    throw new Error("页面内导航失败：" + r.slice(4));
  }
  return "location";
}

/**
 * 创建风控会话窗口。
 *
 * 该窗口随后会被导航到 www.chengdu.gov.cn（远程页面），因此挂上 bridge-preload.js
 * 主动剥离页面上下文中的 require / process 等 Node 能力，
 * 避免远程页面在插件进程里拿到本机文件访问权限。
 *
 * @param {boolean} offscreen  是否离屏（放到屏幕外，避免闪现）
 * @param {boolean} withPreload 是否挂载 bridge-preload
 */
function createUtoolsWindow(offscreen, withPreload) {
  const opts = {
    show: !offscreen ? false : true,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: true,
    alwaysOnTop: false,
    backgroundColor: "#ffffff",
  };
  if (offscreen) {
    opts.x = -3200;
    opts.y = -3200;
  }
  if (withPreload) {
    opts.webPreferences = { preload: "bridge-preload.js" };
  }
  return utools.createBrowserWindow("bridge.html", opts);
}

function destroyWindow() {
  try {
    if (win && typeof win.destroy === "function" && !win.isDestroyed()) win.destroy();
  } catch (e) {}
  win = null;
  ready = false;
}

/**
 * 尝试打开一个会话窗口。
 *
 * @param {boolean} offscreen   是否离屏
 * @param {boolean} withPreload 是否挂载 bridge-preload（隔离远程页面的 Node 能力）
 * @returns {Promise<"ok"|"create-failed"|"load-failed">}
 *   "create-failed" = 窗口都建不起来（可能与 webPreferences.preload 有关，可降级重试）
 *   "load-failed"  = 窗口建起来了但页面没就绪（站点风控，重试无意义）
 */
async function tryOpen(offscreen, withPreload, timeout) {
  let w;
  try {
    w = createUtoolsWindow(offscreen, withPreload);
  } catch (e) {
    log("窗口创建失败:", e && e.message);
    return "create-failed";
  }
  win = w;
  winKind = offscreen ? "utools-offscreen" : "utools-window";

  try {
    await loadUrl(win, BASE);
  } catch (e) {
    lastError = "加载页面失败：" + (e && e.message ? e.message : e);
    log(winKind, lastError);
    destroyWindow();
    return "load-failed";
  }

  if (await waitReady(win, timeout)) {
    ready = true;
    lastError = "";
    return "ok";
  }
  lastError = "页面未能加载完成（可能触发了站点风控）";
  destroyWindow();
  return "load-failed";
}

/**
 * 打开会话窗口。
 *
 * 尝试顺序（任一步成功即返回）：
 *   1. 屏幕内 + bridge-preload（首选：远程页面拿不到 Node 能力）
 *   2. 离屏   + bridge-preload
 *   3. 屏幕内，不带 preload（个别 uTools 版本可能不接受 webPreferences.preload）
 *   4. 离屏   ，不带 preload
 *
 * 带 preload 的尝试用较短超时——失败多半来自环境不支持，而不是站点风控，
 * 快速失败好过让用户干等。
 */
async function openSessionWindow() {
  const attempts = [
    { offscreen: false, preload: true, timeout: READY_TIMEOUT },
    { offscreen: true, preload: true, timeout: PRELOAD_READY_TIMEOUT },
    { offscreen: false, preload: false, timeout: READY_TIMEOUT },
    { offscreen: true, preload: false, timeout: PRELOAD_READY_TIMEOUT },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const r = await tryOpen(a.offscreen, a.preload, a.timeout);
    if (r === "ok") return true;
    if (r === "create-failed" && a.preload) {
      // 窗口本身都建不起来 ⇒ 很可能该 uTools 版本不支持 webPreferences.preload
      // 跳过剩余 preload 尝试，直接降级
      log("带 preload 的窗口无法创建，降级为普通窗口");
      i = 1;
    }
  }
  return false;
}

/** 确保自定义窗口可用（并发调用共享同一次初始化） */
function ensureWindow() {
  if (ready && win && !win.isDestroyed()) return Promise.resolve(true);
  if (windowUnavailable) return Promise.resolve(false);
  if (pending) return pending;
  pending = (async () => {
    if (await openSessionWindow()) return true;
    windowUnavailable = true; // 彻底失败，后续不再反复尝试建窗口
    return false;
  })()
    .then((ok) => {
      pending = null;
      return ok;
    })
    .catch((e) => {
      pending = null;
      lastError = "会话异常：" + (e && e.message ? e.message : e);
      log(lastError);
      return false;
    });
  return pending;
}

const WINDOW_FETCH = `(async () => {
  try {
    const res = await fetch(URL, OPT);
    const buf = await res.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return JSON.stringify({ status: res.status, url: res.url, b64: btoa(bin) });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;

async function fetchViaWindow(url, options) {
  const opts = Object.assign({ credentials: "include" }, options || {});
  const code = WINDOW_FETCH.replace("URL", JSON.stringify(url)).replace("OPT", JSON.stringify(opts));
  const raw = await win.webContents.executeJavaScript(code, true);
  let obj;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error("会话返回数据异常");
  }
  if (!obj || obj.error) throw new Error((obj && obj.error) || "请求失败");
  const buf = Buffer.from(obj.b64 || "", "base64");
  return {
    status: obj.status,
    url: obj.url,
    buffer: buf,
    text: buf.toString("utf-8"),
    base64: buf.toString("base64"),
  };
}

/* ================================================================
 * 通道二：uBrowser（备选）
 * ================================================================ */

function ubrowserCaps() {
  const caps = {
    goto: false, evaluate: false, wait: false, run: false,
    userAgent: false, clearCookies: false, cookies: false, setCookies: false,
  };
  try {
    const ub = utools && utools.ubrowser;
    if (!ub) return caps;
    caps.goto = typeof ub.goto === "function";
    caps.evaluate = typeof ub.evaluate === "function";
    caps.wait = typeof ub.wait === "function";
    caps.run = typeof ub.run === "function";
    caps.userAgent = typeof ub.userAgent === "function";
    caps.clearCookies = typeof ub.clearCookies === "function";
    caps.cookies = typeof ub.cookies === "function";
    caps.setCookies = typeof ub.setCookies === "function";
  } catch (e) {}
  return caps;
}

function hasUBrowser() {
  if (ubrowserBroken) return false;
  const c = ubrowserCaps();
  return c.goto && c.evaluate && c.run;
}

/**
 * 页面内发起请求。
 * 注意：必须用 blob + FileReader 取 base64，不能用 r.text() ——
 * text() 会按 UTF-8 解码，二进制内容（验证码图片）会被破坏。
 */
const PAGE_FETCH = (req) => {
  const slot = (window.__cdResps = window.__cdResps || []);
  slot[req.index] = { done: false, status: 0, b64: "", error: "" };
  const fail = (e) => {
    slot[req.index] = { done: true, status: 0, b64: "", error: String((e && e.message) || e) };
  };
  try {
    const opt = { method: req.method, credentials: "include", headers: req.headers || {} };
    if (req.body) opt.body = req.body;
    fetch(req.url, opt)
      .then((r) =>
        r.blob()
          .then(
            (b) =>
              new Promise((resolve) => {
                try {
                  const fr = new FileReader();
                  fr.onload = () => {
                    const s = String(fr.result || "");
                    const i = s.indexOf(",");
                    resolve(i >= 0 ? s.slice(i + 1) : "");
                  };
                  fr.onerror = () => resolve("");
                  fr.readAsDataURL(b);
                } catch (e) {
                  resolve("");
                }
              })
          )
          .then((b64) => {
            slot[req.index] = { done: true, status: r.status, b64: b64 || "", error: "" };
          })
      )
      .catch(fail);
  } catch (e) {
    fail(e);
  }
  return true;
};

const WAIT_READY = () => {
  try {
    if (document.title && document.title.indexOf("成都12345") >= 0) return true;
    if (document.querySelector('input[name="noMailorTel"]')) return true;
    const t = document.body ? document.body.innerText || "" : "";
    return t.indexOf("市政府信箱") >= 0 || t.indexOf("流水号") >= 0;
  } catch (e) {
    return false;
  }
};

const WAIT_RESP = () => {
  const slot = window.__cdResps || [];
  const n = window.__cdExpect || 0;
  for (let i = 0; i < n; i++) {
    if (!slot[i] || !slot[i].done) return false;
  }
  return true;
};

const TAKE_RESP = () => {
  const slot = window.__cdResps || [];
  const n = window.__cdExpect || 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(slot[i] || { done: true, status: 0, b64: "", error: "no-response" });
  }
  return "__CD__" + JSON.stringify(out);
};

async function fetchViaUBrowser(requests) {
  const list = requests && requests.length ? requests : [];
  const caps = ubrowserCaps();

  let chain = utools.ubrowser;
  if (caps.userAgent) chain = chain.userAgent(UA);
  if (caps.goto) chain = chain.goto(BASE);
  if (caps.wait) chain = chain.wait(WAIT_READY, { timeout: READY_TIMEOUT, interval: 300 });

  chain = chain.evaluate((n) => {
    window.__cdResps = [];
    window.__cdExpect = n;
    return true;
  }, list.length);

  for (let i = 0; i < list.length; i++) {
    const req = list[i];
    chain = chain.evaluate(PAGE_FETCH, {
      index: i,
      url: req.url,
      method: req.method || "GET",
      headers: req.headers || {},
      body: req.body || null,
    });
    if (caps.wait) chain = chain.wait(WAIT_RESP, { timeout: 30000, interval: 150 });
  }

  chain = chain.evaluate(TAKE_RESP);

  const result = await chain.run({ show: false, width: 1280, height: 900, title: "成都12345" });

  let raw = null;
  if (Array.isArray(result)) {
    for (const item of result) {
      if (typeof item === "string" && item.indexOf("__CD__") === 0) {
        raw = item.slice(6);
        break;
      }
    }
    if (raw === null && typeof result[0] === "string" && result[0].charAt(0) === "[") raw = result[0];
  } else if (typeof result === "string" && result.indexOf("__CD__") === 0) {
    raw = result.slice(6);
  }

  let arr = [];
  try {
    arr = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) {
    arr = [];
  }
  if (!Array.isArray(arr) || !arr.length) throw new Error("页面内请求未返回结果");

  return arr.map((o) => {
    const b64 = o.b64 || "";
    const buf = Buffer.from(b64, "base64");
    return {
      status: o.status || 0,
      text: buf.toString("utf-8"),
      buffer: buf,
      base64: b64,
      error: o.error || "",
      url: BASE,
    };
  });
}

/* ================================================================
 * 统一入口
 * ================================================================ */

/**
 * 是否存在可用通道。
 * 注意：uBrowser 通道本身不需要预热（每次 run 自带浏览器），
 * 所以只有 uBrowser 可用时也应视为「就绪」，否则调用方会直接判失败。
 */
async function ensure() {
  if (ready && win && !win.isDestroyed()) return true;
  if (hasUBrowser()) return true;
  return ensureWindow();
}

/** 会话失效时重建 */
async function reset() {
  destroyWindow();
  ubrowserBroken = false;
  windowUnavailable = false;
  return ensure();
}

/**
 * 在风控会话内发起请求
 * 优先「持久自定义窗口」，失败再退到 uBrowser。
 */
async function fetchInPage(url, options) {
  const opts = Object.assign({ method: "GET", headers: {} }, options || {});

  const windowReady = await ensureWindow();
  if (windowReady) {
    try {
      return await fetchViaWindow(url, opts);
    } catch (e) {
      log("窗口通道请求失败:", e && e.message);
    }
  }

  if (hasUBrowser()) {
    try {
      const list = await fetchViaUBrowser([
        { url, method: opts.method, headers: opts.headers, body: opts.body || null },
      ]);
      return list[0];
    } catch (e) {
      ubrowserBroken = true;
      lastError = "uBrowser 通道失败：" + (e && e.message ? e.message : e);
      log(lastError);
      throw e;
    }
  }

  const reason = lastError ? lastError : "";
  throw new Error(
    "无法建立与成都 12345 平台的连接" + (reason ? "（" + reason + "）" : "") +
      "。可稍后重试，或在列表页工具条点「打开12345」用浏览器手动查询。"
  );
}

module.exports = {
  ensure,
  reset,
  fetchInPage,
  hasUBrowser,
  isReady: () => ready && !!win && !win.isDestroyed(),
  destroy: destroyWindow,
  kind: () => (winKind || (hasUBrowser() ? "ubrowser" : "")),
  lastError: () => lastError,
  status: () => ({
    kind: winKind || (hasUBrowser() ? "ubrowser" : ""),
    ready: !!(ready && win && !win.isDestroyed()) || hasUBrowser(),
    lastError,
  }),
};
