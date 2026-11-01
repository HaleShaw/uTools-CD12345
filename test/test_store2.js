/* 存储目录兜底与迁移测试：模拟 uTools 7.x（无 getPluginLocalDataPath） */
const fs = require("node:fs");
const path = require("path");
const os = require("os");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cd12345-home-"));
const legacy = path.join(home, ".uTools-CD12345");
fs.mkdirSync(legacy, { recursive: true });
// 预置一份「旧版本」数据
fs.writeFileSync(
  path.join(legacy, "tickets.json"),
  JSON.stringify({ version: 1, tickets: [{ id: "old1", serial: "112021000612345", passcode: "482913", kind: "tel", createdAt: 1, fillTime: "2026-10-13 18:02", callTime: "", queryState: "never", lastError: "", result: null }] }, null, 2),
  "utf-8"
);

// 模拟 uTools 7.x：没有 getPluginLocalDataPath，只有 getPath('home')
global.utools = {
  getPath: (n) => (n === "home" ? home : os.tmpdir()),
  dbStorage: { _v: {}, setItem(k, v) { this._v[k] = v; }, getItem(k) { return this._v[k]; } },
};

const store = require("../libs/store");
const list = store.listTickets();
console.log("7.x 读取到工单数:", list.length, "|", list[0] && list[0].serial);
console.log("数据目录候选:", store.candidateDirs());
console.log("当前数据目录:", store.dataDir());

// 模拟升级到 8.x：目录变了
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd12345-plug-"));
global.utools.getPluginLocalDataPath = () => pluginDir;
const list2 = store.listTickets();
console.log("升级后读取到工单数:", list2.length, "|", list2[0] && list2[0].serial);
console.log("已迁移到新目录:", fs.existsSync(path.join(pluginDir, "tickets.json")));
store.addTicket({ serial: "112021000612346", passcode: "482914" });
console.log("新增后工单数:", store.listTickets().length);
