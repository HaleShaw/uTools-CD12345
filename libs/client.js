/**
 * 成都 12345 接口客户端
 *
 * 接口（均由真实请求验证）：
 *   POST /12345/searchTelDealByWs   流水号首位 1 —— 热线工单
 *   POST /12345/searchMailDealByWs  流水号首位 2 —— 信箱工单
 *   POST /12345/searchMsgDealByWs   流水号首位 3 —— 短信工单
 *        body: noMailorTel / noMailorTelPass / numcode=1 / error=firstpageError
 *              （出错 3 次后需带 randCode001 图形验证码）
 *   GET  /12345/searchMailDealReply?mailID=..&class=100&WorkFPkId=..  工单详情与办理回复
 *   GET  /12345/Site/generateCode?numcode=1   图形验证码图片
 *   POST /12345/verifyCode  { vCode, numcode } -> { status: "OK" }
 */
const session = require("./session");
const parser = require("./parser");
const util = require("./util");

const HOST = "https://www.chengdu.gov.cn/12345/";
const ENDPOINTS = {
  tel: "searchTelDealByWs",
  mail: "searchMailDealByWs",
  msg: "searchMsgDealByWs",
};

/** 同一时刻只发一个请求，避免触发风控 */
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => util.sleep(800),
    () => util.sleep(800)
  );
  return run;
}

/** 带风控重试的请求：412 视为会话失效，重建后重试一次 */
async function request(url, options, retry) {
  // 预热会话（失败不在此处抛错，统一由 fetchInPage 给出可读提示）
  await session.ensure();

  let res;
  try {
    res = await session.fetchInPage(url, options);
  } catch (e) {
    // 会话中途失效 / 风控挑战失败 -> 清 Cookie 重建后重试一次
    if (!retry) {
      await session.reset();
      return request(url, options, true);
    }
    const msg = (e && e.message) || "请求失败";
    if (/风控|未能返回结果|未返回结果|挑战/.test(msg)) {
      throw new Error("平台风控校验未通过，请稍后重试，或在列表页工具条点「打开12345」用浏览器手动查询");
    }
    throw e;
  }

  if (res.status === 412 || parser.isChallengePage(res.text)) {
    if (!retry) {
      await session.reset();
      return request(url, options, true);
    }
    throw new Error("平台风控校验未通过，请稍后重试");
  }

  return res;
}

/**
 * 批量请求（同一风控会话内完成，减少浏览器窗口开销）
 * @param {Array<string>} urls
 */
async function requestBatch(urls, retry) {
  if (!urls || !urls.length) return [];
  await session.ensure();

  let list;
  try {
    list = [];
    for (const u of urls) {
      list.push(
        await session.fetchInPage(u, { method: "GET", headers: {} })
      );
    }
  } catch (e) {
    if (!retry) {
      await session.reset();
      return requestBatch(urls, true);
    }
    throw e;
  }

  // 任一响应是挑战页 -> 视为会话失效
  for (const r of list) {
    if (r.status === 412 || parser.isChallengePage(r.text)) {
      if (!retry) {
        await session.reset();
        return requestBatch(urls, true);
      }
      throw new Error("平台风控校验未通过，请稍后重试");
    }
  }
  return list;
}

/**
 * 查询工单
 * @param {object} ticket
 * @param {object} opts { randCode }
 */
async function queryTicket(ticket, opts) {
  const randCode = (opts && opts.randCode) || "";
  const body = new URLSearchParams();
  body.set("noMailorTel", ticket.serial);
  body.set("noMailorTelPass", ticket.passcode);
  body.set("numcode", "1");
  body.set("error", "firstpageError");
  if (randCode) body.set("randCode001", randCode);

  const endpoint = ENDPOINTS[ticket.kind] || ENDPOINTS.tel;
  const url = HOST + endpoint;

  const res = await request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    false
  );

  const errorMsg = parser.detectError(res.text);
  if (errorMsg) {
    const err = new Error(errorMsg);
    err.needCaptcha = !randCode;
    err.code = "BAD_CREDENTIALS";
    throw err;
  }

  const detail = parser.parseDetailPage(res.text);

  // 查询结果页里可能带出多个详情页链接，逐个抓取完整办理反馈
  const links = detail.links.slice(0, 10);
  const timeline = detail.timeline.slice();
  const resultBlocks = detail.finalResult ? [detail.finalResult] : [];

  if (links.length) {
    try {
      const batch = await requestBatch(
        links.map((l) => HOST + l),
        false
      );
      for (const dres of batch) {
        if (!dres || dres.status !== 200) continue;
        const d = parser.parseDetailPage(dres.text);
        for (const t of d.timeline) timeline.push(t);
        if (d.finalResult) resultBlocks.push(d.finalResult);
        if (!detail.summary.title && d.summary.title) {
          detail.summary = Object.assign({}, d.summary, detail.summary);
        }
      }
    } catch (e) {
      // 详情抓取失败不影响主结果
    }
  }

  const summary = Object.assign({}, detail.summary);
  if (!summary.serial) summary.serial = ticket.serial;

  return {
    summary,
    timeline,
    finalResult: resultBlocks.join("\n\n"),
    statusText: detail.statusText || "",
    callTime: summary.receiveTime || "",
  };
}

/** 按文件头判断图片真实类型（该接口实际返回 JPEG） */
function sniffMime(buf) {
  if (!buf || buf.length < 4) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  return "image/png";
}

/** 获取图形验证码图片 */
async function getCaptcha() {
  const res = await request(HOST + "Site/generateCode?numcode=1", { method: "GET" }, false);
  return {
    imageBase64: "data:" + sniffMime(res.buffer) + ";base64," + res.base64,
    numcode: "1",
  };
}

/**
 * 校验图形验证码
 *
 * 服务端返回 { status: "OK" } 表示通过，{ status: "-1" } 表示不通过 ——
 * 且「验证码错误」与「当前会话里根本没有这张验证码」返回完全一样，无法区分。
 * 主通道是常驻自定义窗口（会话天然连续），正常情况下不会出现后者；
 * 若仍失败，则由调用方重新取图让用户再输一次。
 */
async function verifyCaptcha(code) {
  const body = new URLSearchParams();
  body.set("vCode", String(code || "").trim());
  body.set("numcode", "1");
  const res = await request(
    HOST + "verifyCode",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    false
  );
  let data = {};
  try {
    data = JSON.parse(res.text);
  } catch (e) {}
  const ok = !!(data && data.status === "OK");
  return ok;
}

/** 在系统默认浏览器中打开成都 12345 热线网站首页 */
function openInBrowser() {
  const url = HOST + "index";
  try {
    utools.shellOpenExternal(url);
  } catch (e) {}
}

module.exports = {
  queryTicket,
  getCaptcha,
  verifyCaptcha,
  openInBrowser,
};
