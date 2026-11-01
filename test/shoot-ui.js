/**
 * 界面效果图生成器（产出 docs/screenshots/*.png）
 *
 * 用无头 Edge 打开 test/uitest.html（内置桩服务），逐个界面状态截图。
 * 截图输出到 docs/screenshots/，供 README / docs/DESIGN.md 引用。
 *
 * 用法：node test/shoot-ui.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9391;
const DEV = __dirname;                                   // test/
const OUT = path.join(DEV, "..", "docs", "screenshots"); // docs/screenshots/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const p = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + path.join(os.tmpdir(), "cd12345-uishot"),
    "--window-size=880,640", "about:blank",
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
  if (!t) { console.log("ERR 未能连接无头浏览器"); p.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, pp = {}) =>
    new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pp })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
    else if (m.method === "Runtime.exceptionThrown") {
      console.log("  !! 页面异常:", ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || "").slice(0, 200));
    }
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 868, height: 608, deviceScaleFactor: 2, mobile: false });

  const url = "file:///" + path.join(DEV, "uitest.html").replace(/\\/g, "/");
  await send("Page.navigate", { url });
  await sleep(1500);

  const shot = async (name, js, wait) => {
    if (js) {
      const r = await send("Runtime.evaluate", { expression: js });
      if (r.exceptionDetails) {
        console.log("  !! JS 异常:", ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text || "").slice(0, 200));
      }
      await sleep(wait == null ? 700 : wait);
    }
    const r2 = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r2.data, "base64"));
    console.log("saved docs/screenshots/" + name + ".png");
  };

  // 安全关闭弹窗
  const CLOSE = "(function(){var b=document.querySelector('[data-act=close]'); if(b) b.click(); return 1;})()";
  // 安全返回列表
  const BACK = "(function(){var b=document.querySelector('[data-act=back]'); if(b) b.click(); return 1;})()";

  // 01 列表页
  await shot("01-list", "", 400);

  // 02 展开：最近一次查询结果
  await shot("02-expanded", "document.querySelector('[data-act=toggle][data-id=t1]').click()");

  // 03 详情页
  await shot("03-detail", "document.querySelector('[data-act=open][data-id=t1]').click()", 1200);

  // 04 添加工单
  await shot("04-add-ticket", "document.querySelector('[data-act=back]').click();" + CLOSE + ";document.querySelector('[data-act=add]').click()", 800);

  // 05 查询失败态（展开 t4）
  await shot("05-error", CLOSE + ";document.querySelector('[data-act=toggle][data-id=t4]').click()");

  // 06 清空数据 · 二次确认弹窗
  await shot("06-clear-confirm", CLOSE + ";document.querySelector('[data-act=clear]').click()", 900);

  // 07 办理进度点击展开全文
  await shot("07-timeline-open",
    CLOSE + ";document.querySelector('[data-act=open][data-id=t5]').click()", 1200);
  await shot("07-timeline-open",
    "(function(){var r=document.querySelector('.tl-row'); if(r){r.click(); return 'clicked';} return 'no-row';})()", 900);

  // 08 点击复制：列表页卡片的流水号（悬停出现复制图标，点击复制）
  await shot("08-copy",
    BACK + ";" +
    "document.querySelectorAll('.serial .cp-ico').forEach(function(e){e.style.opacity='1'});" +
    "document.querySelectorAll('.serial .cpv').forEach(function(e){e.style.background='#eef2ff'});", 400);
  await shot("08-copy", "document.querySelector('.serial .cpv').click()", 700);

  // 09 图形验证码弹窗（查询从未查询过的工单 → 触发验证码）
  await shot("09-captcha",
    BACK + ";document.querySelector('[data-act=open][data-id=t3]').click()", 1800);

  ws.close();
  p.kill();
  console.log("\n界面效果图生成完毕 ✅");
  process.exit(0);
})().catch((e) => { console.log("ERR", (e && e.stack) || e); try { p.kill(); } catch (_) {} process.exit(1); });
