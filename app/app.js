/**
 * 成都12345 · 前端逻辑
 */
(function () {
  "use strict";

  var S = window.services;

  var state = {
    view: "list", // list | detail
    tickets: [],
    expanded: null,
    expandedTl: null,
    detailId: null,
    keyword: "",
    loading: false,
    loadingId: null,
    dialog: null, // add | captcha | clear
    captcha: null,
    pendingQueryId: null,
    toast: "",
    toastTimer: null,
  };

  /* ------------------ 工具 ------------------ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    function p(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  function showToast(msg) {
    state.toast = msg;
    render();
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      state.toast = "";
      render();
    }, 2600);
  }

  function findTicket(id) {
    for (var i = 0; i < state.tickets.length; i++) {
      if (state.tickets[i].id === id) return state.tickets[i];
    }
    return null;
  }

  /**
   * 状态徽章。
   * compact = 列表页用紧凑文案（「正在办理中」→「办理中」）；详情页保留平台原文。
   */
  function statusInfo(t, compact) {
    if (t.queryState === "ok" && t.result) {
      var st = t.result.statusText || "";
      var text = st;
      if (compact) {
        var short = { "正在办理中": "办理中", "正在处理": "处理中", "已经受理": "已受理" };
        if (short[st]) text = short[st];
      }
      if (/办结|结案/.test(st)) return { cls: "b-done", text: text || "已办结" };
      if (/办理中|处理中|在办/.test(st)) return { cls: "b-ing", text: text || "办理中" };
      if (st) return { cls: "b-ing", text: text };
      return { cls: "b-done", text: "已查询" };
    }
    if (t.queryState === "error") return { cls: "b-err", text: "查询失败" };
    return { cls: "b-new", text: "未查询" };
  }

  function kindText(kind) {
    return { tel: "热线", mail: "信箱", msg: "短信" }[kind] || "热线";
  }

  function filterTickets() {
    var kw = state.keyword.trim().toLowerCase();
    if (!kw) return state.tickets;
    return state.tickets.filter(function (t) {
      return (
        String(t.serial).toLowerCase().indexOf(kw) >= 0 ||
        String(t.passcode).toLowerCase().indexOf(kw) >= 0 ||
        String(t.remark || "").toLowerCase().indexOf(kw) >= 0 ||
        String((t.summary && t.summary.title) || "").toLowerCase().indexOf(kw) >= 0
      );
    });
  }

  /* ------------------ 列表页 ------------------ */

  function statBlock(t) {
    var s = statusInfo(t, true);
    return { cls: s.cls, text: s.text };
  }

  function renderList() {
    var list = filterTickets();

    var counts = { all: state.tickets.length, ing: 0, done: 0, wait: 0 };
    state.tickets.forEach(function (t) {
      var s = statBlock(t);
      if (s.cls === "b-ing") counts.ing++;
      else if (s.cls === "b-done") counts.done++;
      else counts.wait++;
    });

    var html = "";
    html +=
      '<div class="toolbar">' +
      '<div class="search">🔍<input id="kw" placeholder="搜索流水号 / 提取码 / 备注" value="' +
      esc(state.keyword) +
      '" autocomplete="off"></div>' +
      '<button class="tb-btn tb-icon" data-act="reload" title="重新载入列表">⟳</button>' +
      '<button class="tb-btn tb-danger" data-act="clear" title="清空本机保存的全部工单与查询结果">清空数据</button>' +
      '<button class="tb-btn" data-act="open-site" title="在默认浏览器打开成都 12345 热线网站">打开12345</button>' +
      '<button class="tb-btn tb-primary" data-act="add">＋ 添加工单</button>' +
      "</div>";

    html += '<div class="scroll"><div class="list">';

    html +=
      '<div class="stat-row">' +
      '<div class="stat"><i class="dot c-all"></i><b>' + counts.all + "</b><span>全部工单</span></div>" +
      '<div class="stat"><i class="dot c-ing"></i><b>' + counts.ing + "</b><span>办理中</span></div>" +
      '<div class="stat"><i class="dot c-done"></i><b>' + counts.done + "</b><span>已办结</span></div>" +
      '<div class="stat"><i class="dot c-wait"></i><b>' + counts.wait + "</b><span>待查询 / 失败</span></div>" +
      "</div>";

    if (!list.length) {
      html +=
        '<div class="empty-list"><span class="big">📋</span>' +
        (state.tickets.length
          ? "<p>没有匹配的工单</p>"
          : "<p>还没有添加工单<br>点击右上角「＋ 添加工单」<br>填入流水号与提取码即可查询办理进度</p>") +
        "</div>";
    }

    list.forEach(function (t) {
      html += renderCard(t);
    });

    html += "</div></div>";
    return html;
  }

  function renderCard(t) {
    var s = statBlock(t);
    var open = state.expanded === t.id;
    var timeLabel = "提交时间";
    var timeValue = t.callTime || t.fillTime || "—";
    var busy = state.loading && state.loadingId === t.id;

    var head =
      '<div class="card-head" data-act="open" data-id="' + esc(t.id) + '">' +
      '<div class="tgl' + (open ? " open" : "") + '" data-act="toggle" data-id="' + esc(t.id) + '">›</div>' +
      '<div class="col-serial">' +
      '<div class="serial"><b class="cpv mono" data-act="copy" data-text="' + esc(t.serial) +
      '" title="点击复制流水号">' + esc(t.serial) + '<i class="cp-ico">⧉</i></b></div>' +
      '<div class="meta" style="margin-top:3px">提取码 <span class="pass"><b class="cpv" data-act="copy" data-text="' +
      esc(t.passcode) + '" title="点击复制提取码">' + esc(t.passcode) + '<i class="cp-ico">⧉</i></b></span> ' +
      '<span class="kind">' + kindText(t.kind) + "</span></div>" +
      "</div>" +
      '<div class="col-title">' +
      '<div class="t-title" title="' + esc((t.summary && t.summary.title) || "") + '">' +
      esc((t.summary && t.summary.title) || "—") + "</div>" +
      '<div class="t-sub">' +
      '<span class="t-dept" title="' + esc((t.summary && t.summary.dept) || "") + '">' +
      esc((t.summary && t.summary.dept) || "—") + "</span>" +
      '<span class="t-qtime">' +
      (t.result
        ? "上次查询 " + esc(fmtTime(t.result.queriedAt))
        : t.queryState === "error"
        ? "查询失败：" + esc(t.lastError || "")
        : "尚无查询记录") +
      "</span></div></div>" +
      '<div class="col-time">' + timeLabel + "<b>" + esc(timeValue) + "</b></div>" +
      '<div class="col-status"><span class="badge ' + s.cls + '">' + esc(s.text) + "</span></div>" +
      "</div>";

    var body = "";
    if (open) {
      body = '<div class="expand">' + renderExpand(t) + "</div>";
    }

    return '<div class="card">' + head + body + "</div>";
  }

  /* ---------- 详情页 / 展开区共用的渲染片段 ---------- */

  /** 「来信（电）情况」的字段列表（详情页与列表展开区共用同一套） */
  function summaryFields(sm) {
    var fields = [];
    if (sm.title) fields.push(["标题", sm.title]);
    if (sm.applicant) fields.push(["诉求人", sm.applicant]);
    if (sm.region) fields.push(["所属区域", sm.region]);
    if (sm.dept) fields.push(["受理部门", sm.dept]);
    if (sm.receiveTime) fields.push(["受理时间", sm.receiveTime]);
    if (sm.category) fields.push(["来访分类", sm.category]);
    if (sm.appealContent) fields.push(["诉求内容", sm.appealContent]);
    if (!fields.length) fields.push(["提示", "平台未返回更多字段"]);
    return fields;
  }

  function renderFields(fields) {
    return fields
      .map(function (f) {
        return '<div class="field"><div class="k">' + esc(f[0]) + '</div><div class="v">' + esc(f[1]) + "</div></div>";
      })
      .join("");
  }

  /**
   * 「结果区」——来信（电）情况 + 办理进度 + 办理结果。
   * 详情页与列表页展开区共用这一段，保证两处样式与内容完全一致（单栏、逐项向下）。
   */
  function renderResultSections(t) {
    var r = t.result || {};
    var sm = r.summary || {};
    var html =
      '<div class="section"><h4>来信（电）情况</h4>' + renderFields(summaryFields(sm)) + "</div>";

    var timeline = r.timeline || [];
    if (timeline.length) {
      html +=
        '<div class="section"><h4>办理进度<span class="sec-count">' + timeline.length + " 条</span></h4>" +
        '<div class="tl-list">' + renderTimeline(t, timeline) + "</div></div>";
    }

    if (r.finalResult) {
      html +=
        '<div class="section"><h4>办理结果</h4>' +
        '<div class="field"><div class="v">' + esc(r.finalResult) + "</div></div></div>";
    }
    return html;
  }

  /** 办理进度时间线（每条一行，点击就地展开全文） */
  function renderTimeline(t, timeline) {
    var html = "";
    timeline.forEach(function (e, i) {
      var key = t.id + ":" + i;
      var open = state.expandedTl === key;
      var text = e.text || "";
      html +=
        '<div class="tl-row' + (open ? " open" : "") + '" data-act="tl" data-id="' + esc(t.id) + '" data-i="' + i + '">' +
        '<span class="tl-dot"></span>' +
        '<span class="tl-time">' + esc(e.time || "") + "</span>" +
        '<span class="tl-dept" title="' + esc(e.dept || "") + '">' + esc(e.dept || "—") + "</span>" +
        '<span class="tl-text" title="' + esc(text) + '">' + esc(text || "—") + "</span>" +
        "</div>";
      if (open && text) {
        html += '<div class="tl-full">' + esc(text) + "</div>";
      }
    });
    return html;
  }

  /**
   * 列表页展开区：完全复用详情页的展示样式，改为左右两栏，一次性把缓存结果全部铺开。
   * 纯只读 —— 需要刷新最新数据请点卡片进入详情页（会自动联网查询）。
   */
  function renderExpand(t) {
    var r = t.result || {};
    var sm = r.summary || {};

    var head = r.queriedAt
      ? '<div class="hist-head">🕘 最近一次查询结果（本地缓存于 ' + esc(fmtTime(r.queriedAt)) + "）</div>"
      : '<div class="hist-head">🕘 本地查询记录</div>';

    if (r.queriedAt) {
      // 与详情页完全一致：单栏、逐项向下
      return head + renderResultSections(t);
    }

    if (t.queryState === "error") {
      return (
        head +
        '<div class="section"><div class="empty" style="color:var(--accent)"><span class="big">⚠</span>' +
        "上次查询失败：<b>" + esc(t.lastError || "未知错误") + "</b><br>" +
        "请核对流水号与提取码，或点击卡片进入详情页重新查询。</div></div>"
      );
    }

    return (
      head +
      '<div class="section"><div class="empty"><span class="big">🔍</span>' +
      "该工单<b>从未查询过</b>，暂无本地缓存结果。<br>" +
      "点击卡片进入详情页即可联网向成都 12345 平台查询。</div></div>"
    );
  }

  /* ------------------ 详情页 ------------------ */

  function renderDetail(t) {
    var s = statusInfo(t);
    var r = t.result || {};
    var sm = r.summary || {};

    var html = "";
    var queriedAt = r.queriedAt ? fmtTime(r.queriedAt) : "";
    html +=
      '<div class="detail-head">' +
      '<div class="d-main">' +
      '<div class="d-title">' + esc(sm.title || t.remark || t.serial) + "</div>" +
      '<div class="d-meta">' +
      '<span class="badge ' + s.cls + '">' + esc(s.text) + "</span>" +
      '<span class="meta">流水号 <b class="cpv mono" data-act="copy" data-text="' + esc(t.serial) + '">' +
      esc(t.serial) + '<i class="cp-ico">⧉</i></b></span>' +
      '<span class="meta">提取码 <b class="cpv" data-act="copy" data-text="' + esc(t.passcode) + '">' +
      esc(t.passcode) + '<i class="cp-ico">⧉</i></b></span>' +
      (t.callTime ? '<span class="meta dim">提交时间 ' + esc(t.callTime) + "</span>" : "") +
      (queriedAt ? '<span class="meta dim">查询于 ' + esc(queriedAt) + "</span>" : "") +
      "</div></div>" +
      '<div class="d-actions">' +
      '<button class="d-btn" data-act="back">← 返回列表</button>' +
      '<button class="d-btn" data-act="query" data-id="' + esc(t.id) + '">⟳ 重新查询</button>' +
      "</div></div>";

    html += '<div class="scroll"><div class="d-body">';

    if (state.loading && state.loadingId === t.id) {
      html += '<div class="progress"><i></i></div>';
      html += '<div class="banner info">正在向成都 12345 平台查询最新结果…</div>';
    }

    if (t.queryState === "error" && t.lastError) {
      html +=
        '<div class="banner err">查询失败：' + esc(t.lastError) +
        '<div class="banner-actions">' +
        '<button class="btn sm" data-act="query" data-id="' + esc(t.id) + '">重新查询</button>' +
        "</div></div>";
    }

    if (!r.queriedAt) {
      html +=
        '<div class="section"><div class="empty"><span class="big">🔍</span>' +
        "该工单<b>还没有查询结果</b>。<br>点击下方「查询最新结果」向成都 12345 平台发起查询。</div></div>";
    } else {
      html += renderResultSections(t);
    }

    html += "</div></div>";

    return html;
  }

  /* ------------------ 弹窗 ------------------ */

  function renderDialog() {
    if (!state.dialog) return "";

    if (state.dialog === "add") {
      return (
        '<div class="mask" data-mask="1"><div class="dialog">' +
        "<h3>添加工单</h3>" +
        "<p>填写成都 12345 平台下发的<b>流水号</b>与<b>提取码</b>，即可随时查询办理进度。提取码仅保存在本机，不参与 uTools 账号同步。</p>" +
        '<div class="field-row"><label>流水号 <span class="req">*</span></label>' +
        '<input class="mono" id="in-serial" maxlength="12" placeholder="6~20 位数字，首位 1 热线 / 2 信箱 / 3 短信" value="' +
        esc(state.form && state.form.serial ? state.form.serial : "") + '">' +
        '<div class="hint">示例：112021000612345</div>' +
        (state.form && state.form.serialErr ? '<div class="err">' + esc(state.form.serialErr) + "</div>" : "") +
        "</div>" +
        '<div class="field-row"><label>提取码 <span class="req">*</span></label>' +
        '<input class="mono" id="in-pass" maxlength="6" placeholder="6 位数字" value="' +
        esc(state.form && state.form.passcode ? state.form.passcode : "") + '">' +
        '<div class="hint">示例：482913</div>' +
        (state.form && state.form.passErr ? '<div class="err">' + esc(state.form.passErr) + "</div>" : "") +
        "</div>" +
        '<div class="field-row"><label>备注（可选）</label>' +
        '<input id="in-remark" placeholder="例如：小区消防通道 / 2026-10-13 来电" value="' +
        esc(state.form && state.form.remark ? state.form.remark : "") + '"></div>' +
        '<div class="dlg-actions">' +
        '<button class="btn" data-act="close">取消</button>' +
        '<button class="btn primary" data-act="save">保存</button>' +
        "</div></div></div>"
      );
    }

    if (state.dialog === "captcha") {
      var img = state.captcha && state.captcha.imageBase64
        ? '<img src="' + esc(state.captcha.imageBase64) + '" alt="验证码">'
        : "";
      return (
        '<div class="mask" data-mask="1"><div class="dialog">' +
        "<h3>需要图形验证码</h3>" +
        "<p>该 12345 平台在同一会话内查询错误超过 3 次后会要求输入图形验证码。请输入下方图片中的字符后继续查询。</p>" +
        '<div class="cap-row"><input id="in-cap" maxlength="6" placeholder="请输入验证码" autocomplete="off">' +
        '<div class="cap-img">' + img + "</div></div>" +
        '<div class="dlg-actions">' +
        '<button class="btn" data-act="close">取消</button>' +
        '<button class="btn primary" data-act="verify">确认并查询</button>' +
        "</div></div></div>"
      );
    }

    if (state.dialog === "clear") {
      return (
        '<div class="mask" data-mask="1"><div class="dialog">' +
        "<h3>清空全部数据</h3>" +
        '<div class="danger-row">' +
        '<div class="danger-text">将删除本机保存的<b>全部工单与查询结果</b>，<b>操作后不可恢复</b>。' +
        "提取码等数据仅存于本机，清空后需要重新录入。</div>" +
        "</div>" +
        '<div class="dlg-actions">' +
        '<button class="btn" data-act="close">取消</button>' +
        '<button class="btn danger-solid" data-act="clear-confirm">确认清空</button>' +
        "</div></div></div>"
      );
    }

    return "";
  }

  /* ------------------ 渲染 ------------------ */

  function render() {
    var view = document.getElementById("view");

    // 保留滚动位置（展开办理进度行 / 展开卡片时不应跳回顶部）
    var scroller = view.querySelector(".scroll");
    var keepScroll = scroller ? scroller.scrollTop : 0;

    if (state.view === "detail") {
      var t = findTicket(state.detailId);
      if (!t) {
        state.view = "list";
        view.innerHTML = renderList();
      } else {
        view.innerHTML = renderDetail(t);
      }
    } else {
      view.innerHTML = renderList();
    }

    var ns = view.querySelector(".scroll");
    if (ns && keepScroll) ns.scrollTop = keepScroll;

    var mask = document.getElementById("overlay");
    if (!mask) {
      mask = document.createElement("div");
      mask.id = "overlay";
      document.body.appendChild(mask);
    }
    mask.innerHTML = renderDialog();

    var toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      document.body.appendChild(toast);
    }
    if (state.toast) {
      toast.className = "toast";
      toast.textContent = state.toast;
      toast.style.display = "block";
    } else {
      toast.style.display = "none";
    }
  }

  /* ------------------ 行为 ------------------ */

  function refresh() {
    state.tickets = S.listTickets() || [];
    render();
  }

  function openDetail(id) {
    state.detailId = id;
    state.view = "detail";
    render();
  }

  function doQuery(id, randCode) {
    if (state.loading) return;
    state.loading = true;
    state.loadingId = id;
    render();

    var payload = S.queryTicket(id, randCode ? { randCode: randCode } : {});

    Promise.resolve(payload).then(function (res) {
      state.loading = false;
      state.loadingId = null;
      if (res && res.ok) {
        state.tickets = res.tickets || state.tickets;
        state.dialog = null;
        render();
        showToast("查询成功");
        return;
      }
      state.tickets = (res && res.tickets) || state.tickets;
      if (res && res.needCaptcha) {
        state.pendingQueryId = id;
        state.dialog = "captcha";
        state.captcha = null;
        render();
        S.getCaptcha().then(function (cap) {
          state.captcha = cap && cap.ok ? cap : null;
          render();
        });
        return;
      }
      render();
      showToast((res && res.error) || "查询失败");
    });
  }

  function saveTicket() {
    var serial = (document.getElementById("in-serial") || {}).value || "";
    var passcode = (document.getElementById("in-pass") || {}).value || "";
    var remark = (document.getElementById("in-remark") || {}).value || "";
    var res = S.addTicket({ serial: serial.trim(), passcode: passcode.trim(), remark: remark.trim() });
    if (!res.ok) {
      state.form = { serial: serial, passcode: passcode, remark: remark, serialErr: "", passErr: res.error };
      render();
      return;
    }
    state.form = null;
    state.dialog = null;
    state.tickets = res.tickets || state.tickets;
    render();
    showToast("已添加");
  }

  function verifyCaptcha() {
    var code = ((document.getElementById("in-cap") || {}).value || "").trim();
    if (!code) {
      showToast("请输入验证码");
      return;
    }
    var id = state.pendingQueryId;
    state.dialog = null;
    render();
    S.verifyCaptcha(code).then(function (r) {
      if (r && r.ok) {
        doQuery(id, code);
      } else {
        // 服务端对「验证码错误」和「会话里没有这张验证码」返回完全相同的结果，
        // 因此统一按「需重新输入」处理，并重新取一张新图
        state.dialog = "captcha";
        state.captcha = null;
        render();
        showToast("校验未通过，请重新输入验证码");
        S.getCaptcha().then(function (cap) {
          state.captcha = cap && cap.ok ? cap : null;
          render();
        });
      }
    });
  }

  /* ------------------ 事件 ------------------ */

  document.addEventListener("click", function (e) {
    var actEl = e.target.closest("[data-act]");
    if (actEl) {
      var act = actEl.getAttribute("data-act");
      var id = actEl.getAttribute("data-id");
      if (act === "toggle") {
        state.expanded = state.expanded === id ? null : id;
        render();
      } else if (act === "open") {
        openDetail(id);
        doQuery(id);
      } else if (act === "tl") {
        var idx = actEl.getAttribute("data-i");
        var key = id + ":" + idx;
        state.expandedTl = state.expandedTl === key ? null : key;
        render();
      } else if (act === "query") {
        openDetail(id);
        doQuery(id);
      } else if (act === "open-site") {
        S.openInBrowser();
      } else if (act === "back") {
        state.view = "list";
        render();
      } else if (act === "add") {
        state.form = null;
        state.dialog = "add";
        render();
        setTimeout(function () {
          var el = document.getElementById("in-serial");
          if (el) el.focus();
        }, 30);
      } else if (act === "close") {
        state.dialog = null;
        state.form = null;
        render();
      } else if (act === "save") {
        saveTicket();
      } else if (act === "verify") {
        verifyCaptcha();
      } else if (act === "copy") {
        var text = actEl.getAttribute("data-text") || "";
        var copied = S.copyText ? S.copyText(text) : false;
        showToast(copied ? "已复制：" + text : "复制失败");
      } else if (act === "reload") {
        refresh();
        showToast("已刷新");
      } else if (act === "clear") {
        if (!state.tickets.length) {
          showToast("暂无数据可清空");
          return;
        }
        state.dialog = "clear";
        render();
      } else if (act === "clear-confirm") {
        S.clearAll();
        state.dialog = null;
        state.expanded = null;
        refresh();
        showToast("已清空全部数据");
      }
      return;
    }

    if (e.target.getAttribute && e.target.getAttribute("data-mask")) {
      state.dialog = null;
      state.form = null;
      render();
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "kw") {
      state.keyword = e.target.value;
      var pos = e.target.selectionStart;
      render();
      var el = document.getElementById("kw");
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(pos, pos);
        } catch (err) {}
      }
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      if (state.dialog === "add") saveTicket();
      else if (state.dialog === "captcha") verifyCaptcha();
    } else if (e.key === "Escape") {
      if (state.dialog) {
        state.dialog = null;
        state.form = null;
        render();
      }
    }
  });

  /* ------------------ 启动 ------------------ */

  if (S && typeof S.onPluginEnter === "function") {
    S.onPluginEnter(function () {
      refresh();
    });
  }

  refresh();
})();
