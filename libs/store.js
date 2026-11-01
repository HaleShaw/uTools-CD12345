/**
 * 工单库存储
 *
 * - 主存储：本地 JSON（utools.getPluginLocalDataPath()/tickets.json），含提取码，绝不同步
 * - 同步副本：utools.dbStorage 仅保存脱敏元数据（不含提取码与详情正文）
 * - 每条工单只保存最新一次查询结果（result 覆盖写）
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const util = require("./util");

const FILE_NAME = "tickets.json";
const SYNC_KEY = "cd12345.tickets.meta";

/**
 * 候选数据目录（按优先级）。
 *
 * 注意：utools.getPluginLocalDataPath() 是 uTools **8.0.0 才新增**的 API，
 * 7.x 版本上没有，必须提供兜底，否则工单数据无处安放。
 *  - 8.0.0+  utools.getPluginLocalDataPath()  插件专属目录（官方推荐）
 *  - 7.x      utools.getPath('home')/.uTools-CD12345
 *  - 兜底     系统临时目录
 */
function candidateDirs() {
  const list = [];
  try {
    if (typeof utools.getPluginLocalDataPath === "function") {
      const d = utools.getPluginLocalDataPath();
      if (d) list.push(d);
    }
  } catch (e) {}
  try {
    if (typeof utools.getPath === "function") {
      const home = utools.getPath("home");
      if (home) list.push(path.join(home, ".uTools-CD12345"));
    }
  } catch (e) {}
  try {
    list.push(path.join(os.tmpdir(), "uTools-CD12345"));
  } catch (e) {}
  return list;
}

function dataDir() {
  return candidateDirs()[0];
}

function filePath() {
  return path.join(dataDir(), FILE_NAME);
}

/**
 * 读取工单库。
 * 若当前目录没有数据文件（例如从 7.x 升级到 8.x 后目录变了），
 * 自动从其它候选目录迁移过来，避免数据丢失。
 */
function readAll() {
  const dirs = candidateDirs();
  for (let i = 0; i < dirs.length; i++) {
    const f = path.join(dirs[i], FILE_NAME);
    try {
      if (!fs.existsSync(f)) continue;
      const json = JSON.parse(fs.readFileSync(f, "utf-8"));
      const list = Array.isArray(json.tickets) ? json.tickets : [];
      if (i > 0 && list.length) {
        // 从旧目录迁移到当前目录
        try {
          fs.mkdirSync(dirs[0], { recursive: true });
          fs.copyFileSync(f, path.join(dirs[0], FILE_NAME));
          console.log("[cd12345/store] 已从", dirs[i], "迁移工单数据到", dirs[0]);
        } catch (e) {}
      }
      return list;
    } catch (e) {
      // 解析失败则继续尝试下一个目录
    }
  }
  return [];
}

/** 排序键：有来电时间用来电时间，否则用填写时间 */
function sortKey(t) {
  return t.callTime || t.fillTime || "";
}

function sortList(list) {
  return list.slice().sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka === kb) return (b.createdAt || 0) - (a.createdAt || 0);
    return ka < kb ? 1 : -1;
  });
}

/** 同步脱敏副本：不含提取码、不含详情正文 */
function syncMeta(list) {
  try {
    const meta = list.map((t) => ({
      id: t.id,
      serial: t.serial,
      kind: t.kind,
      remark: t.remark || "",
      createdAt: t.createdAt,
      fillTime: t.fillTime,
      callTime: t.callTime || "",
      queryState: t.queryState,
      lastQueryAt: t.lastQueryAt || 0,
      summary: t.summary || null,
    }));
    utools.dbStorage.setItem(SYNC_KEY, meta);
  } catch (e) {
    // 同步失败不影响本地功能
  }
}

function writeAll(list) {
  const dir = dataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ version: 1, updatedAt: Date.now(), tickets: list }, null, 2),
      "utf-8"
    );
  } catch (e) {
    // ignore
  }
  syncMeta(list);
}

function listTickets() {
  return sortList(readAll());
}

function findById(id) {
  return readAll().find((t) => t.id === id);
}

function findBySerial(serial) {
  return readAll().find((t) => t.serial === serial);
}

/**
 * 新增工单
 */
function addTicket(input) {
  const serial = String(input.serial || "").trim();
  const passcode = String(input.passcode || "").trim();
  const remark = String(input.remark || "").trim();

  const err = util.validateSerial(serial) || util.validatePasscode(passcode);
  if (err) return { ok: false, error: err };

  const list = readAll();
  if (findBySerial(serial)) {
    return { ok: false, error: "该流水号已存在" };
  }

  const now = Date.now();
  const ticket = {
    id: util.uuid(),
    serial,
    passcode,
    kind: util.kindOfSerial(serial),
    remark,
    createdAt: now,
    fillTime: util.fmtDateTime(now),
    callTime: "",
    lastQueryAt: 0,
    queryState: "never",
    lastError: "",
    result: null,
  };

  list.push(ticket);
  writeAll(list);
  return { ok: true, tickets: listTickets(), ticket };
}

function updateTicket(id, patch) {
  const list = readAll();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return { ok: false, error: "工单不存在" };
  const merged = Object.assign({}, list[idx], patch || {});
  list[idx] = merged;
  writeAll(list);
  return { ok: true, tickets: listTickets(), ticket: merged };
}

function removeTicket(id) {
  const list = readAll().filter((t) => t.id !== id);
  writeAll(list);
  return { ok: true, tickets: listTickets() };
}

/**
 * 查询成功后回写结果（覆盖写，只保留最新一次）
 */
function saveResult(id, result, extra) {
  const list = readAll();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return { ok: false, error: "工单不存在" };

  const t = list[idx];
  t.result = result;
  t.lastQueryAt = Date.now();
  t.queryState = "ok";
  t.lastError = "";
  if (extra && extra.callTime) t.callTime = extra.callTime;
  if (extra && extra.summary) {
    t.summary = Object.assign({}, t.summary || {}, extra.summary);
  }
  t.updatedAt = Date.now();
  list[idx] = t;
  writeAll(list);
  return { ok: true, tickets: listTickets(), ticket: t };
}

/** 查询失败：记录错误，但不覆盖已有结果 */
function saveError(id, message) {
  const list = readAll();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return { ok: false, error: "工单不存在" };
  list[idx].queryState = "error";
  list[idx].lastError = message || "";
  list[idx].lastQueryAt = Date.now();
  writeAll(list);
  return { ok: true, tickets: listTickets(), ticket: list[idx] };
}

/** 清空全部数据 */
function clearAll() {
  writeAll([]);
  return { ok: true, tickets: [] };
}

module.exports = {
  dataDir,
  candidateDirs,
  listTickets,
  addTicket,
  updateTicket,
  removeTicket,
  saveResult,
  saveError,
  findById,
  findBySerial,
  clearAll,
  sortKey,
};
