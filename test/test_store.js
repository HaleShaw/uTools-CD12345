/* store 层离线测试：用假的 utools 全局对象跑通增删改查 + 排序 + 结果回写 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cd12345-"));
global.utools = {
  getPluginLocalDataPath: () => tmp,
  dbStorage: {
    _v: {},
    setItem(k, v) { this._v[k] = v; },
    getItem(k) { return this._v[k]; },
  },
};

const store = require("../libs/store");

function check(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : ""));
  if (!cond) process.exitCode = 1;
}

// 1. 新增
let r = store.addTicket({ serial: "112021000612345", passcode: "482913", remark: "小区消防通道" });
check("新增工单成功", r.ok, r.error);
check("类型推导 = tel", r.ticket.kind === "tel");
check("流水号重复被拒", !store.addTicket({ serial: "112021000612345", passcode: "482913" }).ok);
check("非法流水号被拒", !store.addTicket({ serial: "123", passcode: "482913" }).ok);
check("非法提取码被拒", !store.addTicket({ serial: "112021000612399", passcode: "12" }).ok);
check("首位 2 => mail", store.addTicket({ serial: "212021000612348", passcode: "482916" }).ticket.kind === "mail");
check("首位 3 => msg", store.addTicket({ serial: "312021000612347", passcode: "482915" }).ticket.kind === "msg");

// 2. 排序：有来电时间优先、倒序
store.saveResult(store.findBySerial("212021000612348").id, { queriedAt: Date.now(), summary: { title: "信箱件" } }, { callTime: "2026-10-30 21:44" });
let list = store.listTickets();
check("列表长度 = 3", list.length === 3);
check("按时间倒序（首条为最新）", list[0].serial === "312021000612347" || list[0].serial === "212021000612348", list.map(t=>t.serial).join(","));

// 3. 结果回写（覆盖写）
const id = store.findBySerial("112021000612345").id;
store.saveResult(id, { queriedAt: 111, summary: { title: "第一次" } }, { callTime: "2026-10-13 17:18" });
store.saveResult(id, { queriedAt: 222, summary: { title: "第二次" } }, {});
let t = store.findById(id);
check("结果只保留最新一次", t.result.queriedAt === 222 && t.result.summary.title === "第二次");
check("来电时间被保留", t.callTime === "2026-10-13 17:18");
check("queryState = ok", t.queryState === "ok");

// 4. 失败不覆盖已有结果
store.saveError(id, "流水号或提取码不正确");
t = store.findById(id);
check("失败后旧结果仍在", t.result && t.result.queriedAt === 222);
check("失败状态被记录", t.queryState === "error" && t.lastError.indexOf("流水号") >= 0);

// 5. 本地文件含提取码，同步副本不含
const raw = JSON.parse(fs.readFileSync(path.join(tmp, "tickets.json"), "utf-8"));
check("本地文件包含提取码", raw.tickets.some(x => x.passcode === "482913"));
const meta = global.utools.dbStorage.getItem("cd12345.tickets.meta");
check("同步副本不含提取码", !JSON.stringify(meta).includes("482913"));
check("同步副本含流水号", JSON.stringify(meta).includes("112021000612345"));

// 6. 删除
store.removeTicket(id);
check("删除生效", store.listTickets().length === 2);
store.clearAll();
check("清空生效", store.listTickets().length === 0);

console.log("\n本地数据目录:", tmp);
