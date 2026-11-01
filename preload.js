/**
 * 成都12345 · preload 桥接层
 */
const store = require("./libs/store");
const client = require("./libs/client");

/* 插件进入事件可能早于前端就绪，这里做一次排队 */
const enterQueue = [];
let enterHandler = null;

function handleEnter(info) {
  const payload = {
    code: info && info.code,
    type: info && info.type,
    payload: info && info.payload,
  };
  if (enterHandler) {
    try {
      enterHandler(payload);
    } catch (e) {}
  } else {
    enterQueue.push(payload);
  }
}

if (typeof utools !== "undefined" && typeof utools.onPluginEnter === "function") {
  utools.onPluginEnter(handleEnter);
}

window.services = {
  /** 注册进入插件的回调 */
  onPluginEnter(cb) {
    enterHandler = cb;
    while (enterQueue.length) {
      try {
        cb(enterQueue.shift());
      } catch (e) {}
    }
  },

  /** 复制文本到系统剪贴板 */
  copyText(text) {
    const value = String(text == null ? "" : text);
    try {
      if (typeof utools.copyText === "function") return !!utools.copyText(value);
    } catch (e) {}
    try {
      const { clipboard } = require("electron");
      clipboard.writeText(value);
      return true;
    } catch (e) {
      return false;
    }
  },

  /* ---------- 工单库 ---------- */
  listTickets() {
    return store.listTickets();
  },

  addTicket(input) {
    return store.addTicket(input);
  },

  updateTicket(id, patch) {
    return store.updateTicket(id, patch);
  },

  removeTicket(id) {
    return store.removeTicket(id);
  },

  clearAll() {
    return store.clearAll();
  },

  /* ---------- 查询 ---------- */
  async queryTicket(id, opts) {
    const ticket = store.findById(id);
    if (!ticket) return { ok: false, error: "工单不存在", tickets: store.listTickets() };

    try {
      const data = await client.queryTicket(ticket, opts || {});
      const saved = store.saveResult(
        id,
        {
          queriedAt: Date.now(),
          statusText: data.statusText || "",
          summary: data.summary || {},
          timeline: data.timeline || [],
          finalResult: data.finalResult || "",
        },
        { callTime: data.callTime || "", summary: data.summary || {} }
      );
      return {
        ok: true,
        ticket: saved.ticket,
        tickets: saved.tickets,
        data,
      };
    } catch (e) {
      const message = (e && e.message) || "查询失败";
      const needCaptcha = !!(e && e.needCaptcha);
      const saved = store.saveError(id, message);
      return {
        ok: false,
        error: message,
        needCaptcha,
        tickets: saved.tickets || store.listTickets(),
      };
    }
  },

  async getCaptcha() {
    try {
      const cap = await client.getCaptcha();
      return { ok: true, ...cap };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "验证码获取失败" };
    }
  },

  async verifyCaptcha(code) {
    try {
      const ok = await client.verifyCaptcha(code);
      return { ok };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "验证码校验失败" };
    }
  },

  openInBrowser() {
    client.openInBrowser();
  },
};
