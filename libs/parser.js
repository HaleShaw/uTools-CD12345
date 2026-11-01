/**
 * HTML 解析：把成都 12345 的查询结果页 / 办理公开页转成结构化数据
 *
 * 两种页面的真实结构（均已用线上真实页面核对）：
 *
 * A) 查询结果页  POST /12345/searchTelDealByWs
 *    <table class="tb">
 *      <tr><td colspan=4>来电情况</td></tr>
 *      <tr><td>来电标题</td><td colspan=3>李某[投诉举报]违法建设</td></tr>
 *      <tr><td>来电时间</td><td colspan=3>2026-10-31 12:05</td></tr>
 *      <tr><td>来电内容</td><td colspan=3 id=FmContent>...</td></tr>
 *      <tr><td colspan=4>办理情况</td></tr>
 *      <tr><td rowspan=5>处理部门</td><td>市城市运行和政务服务办拟派工单（主办：武侯区）</td>
 *          <td>处理时间</td><td>2026-10-31 12:05</td></tr>
 *      <tr><td>武侯区签收工单。</td><td>处理时间</td><td>2026-10-31 12:09</td></tr>
 *      ...
 *      <tr><td colspan=4>办理结果</td></tr>
 *      <tr><td colspan=4>正在办理中</td></tr>
 *    </table>
 *
 * B) 办理公开页  GET /12345/searchMailDealReply?...
 *      同为 table.tb，标签为「来信（电）标题 / 来信（电）时间 / 来信（电）内容」，
 *      「办理部门」段只有部门名，「办理结果」段是「部门(时间)：正文」的回复正文。
 *
 * 解析策略：表格优先（精确），文本兜底（容错）。
 */
const util = require("./util");

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ldquo: "“", rdquo: "”", hellip: "…", mdash: "—", ndash: "–",
};

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

/** 单元格 / 片段 -> 纯文本（<br> 转换行） */
function toText(html) {
  let s = String(html == null ? "" : html);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((x) => x.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 页面「可见文本」—— 剥离 script/style 后再取文本。
 *
 * 关键：结果页里内联着站点自己的前端校验脚本，例如
 *   alert("流水号或提取码错误"); return false;
 * 若在全页正则里找「提取码错误」，就会把这段 JS 字面量误判成服务端错误。
 */
function visibleText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t\u00a0]+/g, " ");
}

/** HTML -> 文本行数组（兜底用） */
function htmlToLines(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|td|th|dd|dt|table|ul|ol)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((x) => x.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 表格解析                                                            */
/* ------------------------------------------------------------------ */

function attr(attrs, name) {
  const re = new RegExp(name + '\\s*=\\s*["\']?(\\d+)', "i");
  const m = String(attrs || "").match(re);
  return m ? parseInt(m[1], 10) : 1;
}

function parseTables(html) {
  const tables = [];
  const re = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(m[2]))) {
      const cells = [];
      const cellRe = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        cells.push({
          text: toText(cm[2]),
          colspan: attr(cm[1], "colspan"),
          rowspan: attr(cm[1], "rowspan"),
          cls: (String(cm[1]).match(/class\s*=\s*["']?([^\s"'>]+)/i) || [])[1] || "",
        });
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push({ attrs: m[1], rows });
  }
  return tables;
}

/* 分节标题 */
const SECTIONS = {
  "来电情况": "kv",
  "来信情况": "kv",
  "来信（电）情况": "kv",
  "来信(电)情况": "kv",
  "办理情况": "progress",
  "办理部门": "dept",
  "办理结果": "result",
};

/* 键值标签 */
const KV_LABELS = {
  // 热线工单（searchTelDealByWs）
  "来电标题": "title",
  "来电时间": "receiveTime",
  "来电内容": "appealContent",
  "来电人": "applicant",
  // 信箱工单（searchMailDealByWs）
  "来信标题": "title",
  "来信时间": "receiveTime",
  "来信内容": "appealContent",
  "来信人": "applicant",
  // 办理公开页（searchMailDealReply）
  "来信（电）标题": "title",
  "来信（电）时间": "receiveTime",
  "来信（电）内容": "appealContent",
  "来信(电)标题": "title",
  "来信(电)时间": "receiveTime",
  "来信(电)内容": "appealContent",
  // 通用
  "诉求人": "applicant",
  "反映人": "applicant",
  "所属区域": "region",
  "行政区域": "region",
  "受理编号": "serial",
  "工单编号": "serial",
};

function normLabel(s) {
  // 去掉所有空白与冒号：站点里存在「来 信人」这类带空格的标签
  return String(s || "")
    .replace(/[\s\u00a0]/g, "")
    .replace(/[:：]/g, "")
    .trim();
}

/** 从办理情况说明中拆出承办部门与动作 */
function splitAction(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/^(.{0,40}?)(拟派工单|转办工单|签收工单|重新分派|派单|签收|转办|退回|办结|回复|处理完毕|超时)([\s\S]*)$/);
  const host = raw.match(/[（(]\s*主办[:：]\s*([^)）]+)\s*[)）]/);
  if (!m) {
    return { dept: host ? host[1].trim() : "", action: "", rest: "", text: raw };
  }
  let dept = host ? host[1].trim() : m[1].trim();
  if (!dept) dept = m[1].trim();
  // 正文里去掉「（主办：XXX）」这类重复信息
  const rest = m[3].replace(/[（(]\s*主办[:：][^)）]*[)）]/g, "").trim();
  return { dept, action: m[2], rest, text: (m[2] + rest).trim() || raw };
}

/** 从办理结果正文中切分「部门(时间)：正文」 */
function parseTimeline(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const entries = [];
  const re = /^(.{1,40}?)\s*[(（]\s*(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?)\s*[)）]\s*[:：]\s*$/;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    cur.text = cur.text.join("\n").trim();
    if (cur.text || cur.dept) entries.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      flush();
      cur = { dept: m[1].trim(), time: m[2].trim(), text: [] };
    } else if (cur) {
      cur.text.push(line);
    }
  }
  flush();
  return entries;
}

const STATUS_LIKE = /^(正在办理中|办理中|在办|已办结|办结|已结案|已受理|受理中|待办理|待处理|已转办|已退回|已办|已回复|已处理)$/;

function detectStatus(text) {
  const t = util.normalizeText(visibleText(String(text || "")));
  if (/已办结|办结|已结案|办理完成|已回复|已处理完毕/.test(t)) return "已办结";
  if (/正在办理中|办理中|处理中|审核中|在办/.test(t)) return "办理中";
  if (/已转办|转办中/.test(t)) return "已转办";
  if (/待办理|待处理|已受理|已登记|受理中/.test(t)) return "已受理";
  return "";
}

/** 表格优先的主解析 */
function parseByTable(html) {
  const tables = parseTables(html);
  if (!tables.length) return null;

  // 选取包含业务表格的表（出现任一业务标签）
  const score = (t) =>
    t.rows.reduce((acc, row) => {
      const first = normLabel(row[0] && row[0].text);
      if (SECTIONS[first]) acc.section = true;
      if (KV_LABELS[first]) acc.kv = true;
      return acc;
    }, { section: false, kv: false });

  let table = null;
  for (const t of tables) {
    const sc = score(t);
    if (sc.section || sc.kv) {
      table = t;
      break;
    }
  }
  if (!table) return null;

  const summary = {};
  const timeline = [];
  let section = "";
  let dept = "";
  let finalResult = "";
  let statusText = "";

  for (const row of table.rows) {
    const first = normLabel(row[0] && row[0].text);

    // 分节标题：整行只有一个单元格
    if (row.length === 1 && SECTIONS[first]) {
      section = SECTIONS[first];
      if (section === "dept") dept = "";
      if (section === "result") finalResult = "";
      continue;
    }

    if (section === "kv") {
      // 一行可能只有一组 KV（2 列），也可能并排放两组（4 列，如「来 信人 | 李某 | 来信时间 | …」）
      let i = 0;
      while (i < row.length - 1) {
        const key = KV_LABELS[normLabel(row[i].text)];
        if (key) {
          const value = row[i + 1] ? row[i + 1].text : "";
          if (key === "title") summary.title = value;
          else if (key === "receiveTime") summary.receiveTime = value;
          else if (key === "appealContent") summary.appealContent = value;
          else if (key === "applicant") summary.applicant = value;
          else if (key === "region") summary.region = value;
          else if (key === "serial") summary.serial = value;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (section === "progress") {
      // 行内找到「处理时间」单元格，其左侧是说明，右侧是时间
      const idx = row.findIndex((c) => normLabel(c.text) === "处理时间");
      if (idx > 0) {
        const note = row[idx - 1].text;
        const time = row[idx + 1] ? row[idx + 1].text : "";
        const info = splitAction(note);
        if (info.dept) dept = info.dept;
        timeline.push({
          dept: info.dept || dept,
          time,
          text: info.text || note,
        });
      }
      continue;
    }

    if (section === "dept") {
      if (row.length === 1) dept = row[0].text;
      continue;
    }

    if (section === "result") {
      if (row.length === 1) {
        finalResult = row[0].text;
        if (STATUS_LIKE.test(finalResult)) {
          statusText = finalResult;
          finalResult = "";
        }
      }
      continue;
    }
  }

  // 办理结果正文（公开页）里的多条回复 -> 时间线
  if (finalResult) {
    for (const e of parseTimeline(finalResult)) timeline.push(e);
  }

  if (!summary.title) {
    const m = (summary.appealContent || "").match(/[［\[【]([^】\]］]{2,12})[】\]］]/);
    if (m) summary.category = m[1].trim();
  }
  const cat = (summary.title || "").match(/[［\[【]([^】\]］]{2,12})[】\]］]/);
  if (cat) summary.category = cat[1].trim();

  if (dept) summary.dept = dept;
  if (!statusText) {
    statusText =
      detectStatus(finalResult || "") ||
      detectStatus(table.rows.map((r) => r.map((c) => c.text).join(" ")).join("\n")) ||
      "";
  }
  // 有办理结果正文但正文里没写状态 -> 视为已办结
  if (!statusText && finalResult) statusText = "已办结";

  return { summary, timeline, finalResult, statusText, dept };
}

/** 文本兜底解析 */
function parseByText(html) {
  const lines = htmlToLines(html);
  const buckets = {};
  let curKey = null;
  let curBuf = [];

  const flush = () => {
    if (!curKey) return;
    const value = curBuf.join("\n").trim();
    if (!buckets[curKey]) buckets[curKey] = [];
    buckets[curKey].push(value);
    curBuf = [];
    curKey = null;
  };

  const LABELS = [
    { key: "title", names: ["来电标题", "来信（电）标题", "标题"] },
    { key: "receiveTime", names: ["来电时间", "来信（电）时间", "受理时间"] },
    { key: "appealContent", names: ["来电内容", "来信（电）内容", "诉求内容"] },
    { key: "dept", names: ["办理部门", "处理部门", "承办部门"] },
    { key: "result", names: ["办理结果", "处理结果"] },
    { key: "serial", names: ["受理编号", "工单编号"] },
    { key: "applicant", names: ["诉求人", "来电人"] },
    { key: "region", names: ["所属区域", "行政区域"] },
  ];

  for (const line of lines) {
    const norm = util.normalizeText(line).replace(/[:：]\s*$/, "");
    let hit = null;
    for (const item of LABELS) {
      if (norm === item.names[0] || item.names.indexOf(norm) >= 0) {
        hit = item.key;
        break;
      }
    }
    if (hit) {
      flush();
      curKey = hit;
      continue;
    }
    if (curKey) curBuf.push(line);
  }
  flush();

  const first = (k) => (buckets[k] && buckets[k][0]) || "";
  const summary = {};
  const title = first("title");
  if (title) summary.title = title;
  if (first("receiveTime")) summary.receiveTime = first("receiveTime");
  if (first("appealContent")) summary.appealContent = first("appealContent");
  if (first("dept")) summary.dept = first("dept");
  if (first("serial")) summary.serial = first("serial");
  if (first("applicant")) summary.applicant = first("applicant");
  if (first("region")) summary.region = first("region");

  const resultText = buckets.result ? buckets.result.join("\n") : "";
  const cat = title.match(/[［\[【]([^】\]］]{2,12})[】\]］]/);
  if (cat) summary.category = cat[1].trim();

  let statusText = "";
  let finalResult = resultText.trim();
  if (STATUS_LIKE.test(finalResult)) {
    statusText = finalResult;
    finalResult = "";
  }

  return {
    summary,
    timeline: parseTimeline(finalResult),
    finalResult,
    statusText: statusText || detectStatus(resultText),
    dept: summary.dept || "",
  };
}

/**
 * 主入口：解析查询结果页 / 办理公开页
 */
function parseDetailPage(html) {
  const t = parseByTable(html);
  if (t) {
    t.links = extractDetailLinks(html);
    return t;
  }
  const r = parseByText(html);
  r.links = extractDetailLinks(html);
  return r;
}

/** 抽取详情页链接 */
function extractDetailLinks(html) {
  const set = new Set();
  const re = /searchMailDealReply\?[^"'<>\\\s]+/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    set.add(m[0].replace(/&amp;/g, "&"));
  }
  return Array.from(set);
}

/** 抽取 meta */
function extractMeta(html) {
  const meta = {};
  const re = /<meta\s+[^>]*name=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) meta[m[1].toLowerCase()] = decodeEntities(m[2]);
  return meta;
}

/**
 * 识别错误提示。
 * 只在「可见文本」里找 —— 页面内联的 JS 字面量会造成误判（见 visibleText 注释）。
 */
function detectError(html) {
  const text = util.normalizeText(visibleText(html));
  if (/流水号或验证码错误/.test(text)) return "流水号或提取码不正确，请核对后重试";
  if (/流水号错误|提取码错误|验证码错误/.test(text)) return "流水号或提取码不正确，请核对后重试";
  if (/系统繁忙|服务异常|请稍后/.test(text)) return "平台返回异常，请稍后重试";
  return "";
}

/** 是否是瑞数挑战页 */
function isChallengePage(html) {
  const s = String(html || "");
  return s.includes("$_ts") || s.includes("azSsQE5NvspcO") || s.includes("nsd=");
}

module.exports = {
  htmlToLines,
  visibleText,
  toText,
  decodeEntities,
  parseTables,
  parseDetailPage,
  parseByTable,
  parseByText,
  parseTimeline,
  splitAction,
  detectError,
  detectStatus,
  extractDetailLinks,
  extractMeta,
  isChallengePage,
};
