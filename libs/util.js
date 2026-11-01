/**
 * 通用工具
 */
const crypto = require("node:crypto");

function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/** 时间戳 -> "2026-10-13 17:18" */
function fmtDateTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return (
    d.getFullYear() +
    "-" + pad2(d.getMonth() + 1) +
    "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) +
    ":" + pad2(d.getMinutes())
  );
}

function fmtDate(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 归一化：全角括号/冒号统一，便于文本匹配 */
function normalizeText(s) {
  return String(s || "")
    .replace(/\u3000/g, " ")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":")
    .replace(/[，]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/** 流水号 -> 类型 */
function kindOfSerial(serial) {
  const first = String(serial || "").trim()[0];
  if (first === "2") return "mail";
  if (first === "3") return "msg";
  return "tel";
}

const KIND_TEXT = { tel: "热线", mail: "信箱", msg: "短信" };

function kindText(kind) {
  return KIND_TEXT[kind] || "热线";
}

/**
 * 流水号合法性
 *
 * 站点 Check.js 的实际规则：
 *   CheckTel()        —— 电话工单：长度必须 12 位且首位为 1
 *   CheckMailorTel()  —— 流水号/提取码表单：首位 1/2/3；
 *                        仅当首位为 3(短信) 时才额外要求长度 12 位、提取码 6 位
 * 因此这里采取宽松校验（6~20 位纯数字 + 首位 1/2/3），真实长度以平台返回为准。
 */
function validateSerial(serial) {
  const s = String(serial || "").trim();
  if (!/^\d{6,20}$/.test(s)) return "流水号应为 6~20 位数字";
  if (!"123".includes(s[0])) return "流水号首位只能是 1(热线) / 2(信箱) / 3(短信)";
  return "";
}

/** 提取码合法性 */
function validatePasscode(code) {
  const s = String(code || "").trim();
  if (!/^\d{6}$/.test(s)) return "提取码应为 6 位数字";
  return "";
}

module.exports = {
  uuid,
  pad2,
  fmtDateTime,
  fmtDate,
  sleep,
  normalizeText,
  kindOfSerial,
  kindText,
  validateSerial,
  validatePasscode,
};
