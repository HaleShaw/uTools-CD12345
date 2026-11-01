/**
 * 用 uBrowser 模拟器跑通插件真实代码（client.js / parser.js / store.js）
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const { createUBrowser } = require("./ubrowser-mock");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9470;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cd12345-ub-"));
const { serial: SERIAL, passcode: PASSCODE } = pickCreds();

const ub = createUBrowser(PORT, path.join(tmp, "edge"));

global.utools = {
  ubrowser: ub.api,
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


(async () => {
  const p = spawn(EDGE, ["--no-first-run","--no-default-browser-check","--window-size=1280,900",
    "--remote-debugging-port="+PORT,"--remote-debugging-address=127.0.0.1",
    "--user-data-dir="+path.join(tmp,"edge"),"about:blank"], {stdio:"ignore"});
  await ub.connect();
  console.log("[1] uBrowser 模拟器已连接");

  console.log("[2] hasUBrowser() =", session.hasUBrowser());

  const add = store.addTicket({ serial: SERIAL, passcode: PASSCODE, remark: "ubrowser-e2e" });
  console.log("[3] 新增工单:", add.ok ? "OK" : add.error);

  const t0 = Date.now();
  let data, err;
  try { data = await client.queryTicket(add.ticket, {}); }
  catch (e) { err = e; }
  console.log("[4] 查询耗时", Date.now() - t0, "ms");
  if (err) { console.log("    失败:", err.message); p.kill(); process.exit(1); }

  console.log("[5] 解析结果:");
  console.log("    标题     :", data.summary.title);
  console.log("    来电时间 :", data.callTime);
  console.log("    承办部门 :", data.summary.dept);
  console.log("    状态     :", data.statusText);
  console.log("    办理进度 :", data.timeline.length, "条");
  data.timeline.forEach((e,i)=>console.log(`      [${i}] ${e.dept} | ${e.time} | ${String(e.text).slice(0,40)}`));

  store.saveResult(add.ticket.id, { queriedAt: Date.now(), statusText: data.statusText, summary: data.summary, timeline: data.timeline, finalResult: data.finalResult }, { callTime: data.callTime, summary: data.summary });
  const list = store.listTickets();
  console.log("[6] 回写后列表首位:", list[0].serial, "| callTime:", list[0].callTime, "| state:", list[0].queryState);

  // 第二次查询，验证 Cookie 复用（不再触发挑战）
  const t1 = Date.now();
  try {
    const d2 = await client.queryTicket(add.ticket, {});
    console.log("[7] 第二次查询耗时", Date.now() - t1, "ms | 标题:", d2.summary.title);
  } catch (e) {
    console.log("[7] 第二次查询失败:", e.message);
  }

  // 验证码图片：二进制必须无损
  try {
    const cap = await client.getCaptcha();
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(cap.imageBase64 || "");
    console.log("[8] 验证码 MIME:", m ? m[1] : "(无)", "| dataURL 长度:", (cap.imageBase64 || "").length);
    if (m) {
      const buf = Buffer.from(m[2], "base64");
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isJpegEoi = buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
      console.log("    字节数:", buf.length, "| JPEG 头:", isJpeg, "| JPEG 尾:", isJpegEoi, "| PNG 头:", isPng);
      console.log("    完整性:", isJpeg && isJpegEoi ? "正常（首尾标记齐全）" : "异常（二进制被破坏）");
    }
  } catch (e) {
    console.log("[8] 验证码获取失败:", e.message);
  }

  p.kill();
  console.log("\nuBrowser 链路端到端测试完成 ✅");
  process.exit(0);
})().catch((e) => { console.log("ERR", e && e.stack || e); process.exit(1); });
