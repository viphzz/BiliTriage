// BiliTriage 弹窗
// MV3 约束：扩展页 CSP 为 script-src 'self'，**内联 onclick 会被拒绝执行**，一律用 data-* + 事件委托。
const $ = (id) => document.getElementById(id);
const C = {
  精看: { bg: "#E6F1FB", fg: "#185FA5", line: "#185FA5" },
  倍速: { bg: "#FAEEDA", fg: "#BA7517", line: "#EF9F27" },
  跳过: { bg: "#F1EFE8", fg: "#8A8880", line: "#C9C6BE" },
};
const HIST_MAX = 40;
const LOG_MAX = 300;
const LOGKEY = "logs";

let TAB = null, CTX = null, LAST = null, RESULT = null, OWNER = null, CURRENT_KEY = null;
let pollTimer = null, logTimer = null, warned = false, tab = "overview";

const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; r(x); }));
const tabMsg = (id, m) => new Promise((r) => chrome.tabs.sendMessage(id, m, (x) => { void chrome.runtime.lastError; r(x); }));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mmss = (s) => { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
const mins = (s) => Math.round(s / 60);
const fmtDur = (sec) => (sec >= 3600 ? Math.floor(sec / 3600) + " 小时 " + Math.round((sec % 3600) / 60) + " 分" : Math.round(sec / 60) + " 分钟");
const hhmmss = (ts) => new Date(ts).toTimeString().slice(0, 8);

const IS_EXT = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

// ---------------------------------------------------------------- 日志系统
let logChain = Promise.resolve();
function logAdd(lv, msg) {
  if (!IS_EXT) { console.log(`[${lv}] ${msg}`); return Promise.resolve(); }
  logChain = logChain.then(async () => {
    try {
      const arr = (await chrome.storage.local.get(LOGKEY))[LOGKEY] || [];
      arr.push({ t: Date.now(), lv, m: String(msg == null ? "" : msg).slice(0, 1000) });
      while (arr.length > LOG_MAX) arr.shift();
      await chrome.storage.local.set({ [LOGKEY]: arr });
    } catch (e) { /* 日志失败不再抛错 */ }
  });
  return logChain;
}
const logInfo = (m) => logAdd("info", m);
const logWarn = (m) => logAdd("warn", m);
const logError = (m) => logAdd("error", m);
async function logGet() {
  if (!IS_EXT) return [];
  return (await chrome.storage.local.get(LOGKEY))[LOGKEY] || [];
}

// 顶部单行状态条
let statusTimer = null;
function status(text, kind, opts) {
  const el = $("status");
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  if (!text) { el.className = "status"; el.innerHTML = ""; return; }
  el.className = "status on " + (kind || "info");
  el.innerHTML = `<span>${esc(text)}</span>` +
    ((opts && opts.action) ? `<span class="lnk" id="statusAct">${esc(opts.action)}</span>` : "");
  if (opts && opts.action && opts.onAction) {
    const b = $("statusAct");
    if (b) b.onclick = opts.onAction;
  }
  if (kind !== "err") statusTimer = setTimeout(() => status(""), opts && opts.ms ? opts.ms : 6000);
}
const say = (m) => { status(m, "info"); logInfo(m); };
// fail(msg, {label, fn}) —— 可给一个一键修复入口，默认给「查看日志」
const fail = (m, act) => {
  status(m, "err", act ? { action: act.label, onAction: act.fn } : { action: "查看日志", onAction: () => showTab("log") });
  logError(m);
};

async function drawLogs() {
  const arr = await logGet();
  const box = $("logs");
  if (!arr.length) { box.innerHTML = `<div class="empty">还没有日志。</div>`; }
  else {
    box.innerHTML = arr.slice().reverse().map((x) =>
      `<div class="lgrow ${x.lv}">
        <span class="ts">${hhmmss(x.t)}</span>
        <span class="lv ${x.lv}">${x.lv === "error" ? "错误" : x.lv === "warn" ? "警告" : "信息"}</span>
        <span class="ms">${esc(x.m)}</span>
      </div>`).join("");
  }
  if (!IS_EXT) return;
  const seen = (await chrome.storage.local.get("logSeenTs")).logSeenTs || 0;
  const hasNew = arr.some((x) => x.lv === "error" && x.t > seen);
  $("logDot").classList.toggle("on", hasNew);
}

// ---------------------------------------------------------------- 标签页
function showTab(name) {
  tab = name;
  $("tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("on", p.id === "p-" + name));
  if (name === "log" && IS_EXT) {
    chrome.storage.local.set({ logSeenTs: Date.now() });
    $("logDot").classList.remove("on");
    drawLogs();
  }
}

// ---------------------------------------------------------------- 设置
async function loadCfg() {
  const c = await chrome.storage.local.get(["llm_base", "llm_key", "llm_model"]);
  $("llm_base").value = c.llm_base || "https://api.deepseek.com/v1";
  $("llm_model").value = c.llm_model || "deepseek-chat";
  $("llm_key").value = c.llm_key || "";
}
async function saveCfg() {
  const base = $("llm_base").value.trim();
  await chrome.storage.local.set({ llm_base: base, llm_model: $("llm_model").value.trim(), llm_key: $("llm_key").value.trim() });
  try {
    const host = new URL(base).origin + "/*";
    if (!(await chrome.permissions.contains({ origins: [host] }))) await chrome.permissions.request({ origins: [host] });
  } catch (e) {}
  $("cfgMsg").textContent = "已保存 ✓";
  logInfo("设置已保存（Base=" + base + "，Model=" + $("llm_model").value.trim() + "）");
  setTimeout(() => ($("cfgMsg").textContent = ""), 2200);
}
const cfg = async () => {
  const c = await chrome.storage.local.get(["llm_base", "llm_key", "llm_model"]);
  return { base: c.llm_base || "", key: c.llm_key || "", model: c.llm_model || "deepseek-chat" };
};

// ---------------------------------------------------------------- 历史（匹配码 = bvid + p）
const hKey = (bvid, p) => `h:${bvid}:${parseInt(p, 10) || 1}`;
const keyLabel = (bvid, p) => `${bvid} · P${parseInt(p, 10) || 1}`;
const getHistory = async () => (await chrome.storage.local.get("hist")).hist || [];

async function saveHistory(bvid, p, part, course, page, result) {
  const k = hKey(bvid, p);
  const store = { [k]: { bvid, p: page.p, part, course: course.title, up: course.up, page, result, ts: Date.now() } };
  const idx = await getHistory();
  store.hist = [{ bvid, p: page.p, part, course: course.title, ts: Date.now() }, ...idx.filter((x) => hKey(x.bvid, x.p) !== k)].slice(0, HIST_MAX);
  await chrome.storage.local.set(store);
}
async function loadRecord(bvid, p) {
  return (await chrome.storage.local.get(hKey(bvid, p)))[hKey(bvid, p)] || null;
}

async function drawHistory() {
  const items = await getHistory();
  const curBv = TAB ? parseBv(TAB.url) : { bvid: null, p: 1 };
  const curP = (CTX && CTX.p) || curBv.p;
  $("hist").innerHTML = items.length
    ? items.map((x) => {
        const on = CURRENT_KEY === hKey(x.bvid, x.p);
        const isCurTab = curBv.bvid === x.bvid && parseInt(x.p, 10) === parseInt(curP, 10);
        return `<div class="hist">
          <div class="bd">
            <div class="tp">${esc((x.part || "（无标题）").slice(0, 40))}${on ? '<span class="cur">已调出</span>' : ""}${isCurTab ? '<span class="cur g">当前页面</span>' : ""}</div>
            <div class="mt">${keyLabel(x.bvid, x.p)} · ${new Date(x.ts).toLocaleString()}</div>
          </div>
          <div class="ac">
            <button class="btn sm" data-view="${esc(x.bvid)}|${x.p}">查看</button>
            ${isCurTab ? "" : `<button class="btn sm" data-open="${esc(x.bvid)}|${x.p}">切到该页</button>`}
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">还没有记录。分析任意一节课后会自动存档。</div>`;
}

// ---------------------------------------------------------------- 页面信息
function parseBv(url) {
  const m = String(url || "").match(/(BV[0-9A-Za-z]{10})/);
  const pm = String(url || "").match(/[?&]p=(\d+)/);
  return { bvid: m ? m[1] : null, p: pm ? parseInt(pm[1], 10) : 1 };
}

function tabMatches(url, bvid, p) {
  if (!url) return false;
  if (!new RegExp("/" + bvid + "(/|\\?|$)").test(url)) return false;
  if (p == null) return true;
  const m = url.match(/[?&]p=(\d+)/);
  const cur = m ? parseInt(m[1], 10) : 1;
  return cur === parseInt(p, 10);
}

async function refreshPage(opts) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  TAB = tabs && tabs[0] ? tabs[0] : null;
  const isVideo = TAB && /bilibili\.com\/(video|list)\//.test(TAB.url || "");

  if (!isVideo) {
    $("vtitle").textContent = "当前不是 B 站视频页";
    $("vsub").textContent = "这是最近一次的分析结果";
    $("go").disabled = true;
    const items = await getHistory();
    if (items.length && !RESULT) {
      const rec = await loadRecord(items[0].bvid, items[0].p);
      if (rec && rec.result) {
        RESULT = rec.result;
        OWNER = { bvid: rec.bvid, p: rec.p };
        CURRENT_KEY = hKey(rec.bvid, rec.p);
        render(rec.result);
      }
    }
    return false;
  }

  $("go").disabled = false;
  CTX = await tabMsg(TAB.id, { type: "pageContext" });
  const { bvid, p } = parseBv(TAB.url);
  const pnum = (CTX && CTX.p) || p;
  $("vtitle").textContent = (CTX && CTX.title) || TAB.title || bvid || "未知标题";
  $("vsub").textContent = `${keyLabel(bvid, pnum)}${CTX && CTX.duration ? " · " + Math.round(CTX.duration / 60) + " 分钟" : ""}`;
  if (opts && opts.keep) return true;
  if (!bvid) return true;

  // 匹配码自动调取
  const k = hKey(bvid, pnum);
  if (k !== CURRENT_KEY) {
    const rec = await loadRecord(bvid, pnum);
    if (rec && rec.result) {
      RESULT = rec.result;
      OWNER = { bvid, p: rec.p };
      CURRENT_KEY = k;
      render(rec.result);
      $("manualCard").style.display = "none";
      status(`已调出这节课上次的报告`, "ok");
      logInfo(`自动调取记录：${keyLabel(bvid, pnum)}`);
    } else {
      RESULT = null; OWNER = null; CURRENT_KEY = null;
      renderEmpty();
      $("manualCard").style.display = "none";
    }
    await drawHistory();
  }
  return true;
}

// 等页面真正重新加载完：必须观察到 loading -> complete 的完整过程。
// 坑：chrome.tabs.reload() 是异步的，调用后标签页状态会短暂停留在旧的 complete，
// 若只看 status==='complete' 会撞上"假完成"，对正在卸载的页面发消息必然无接收方。
function reloadAndWait(tabId, timeout) {
  return new Promise((resolve) => {
    let sawLoading = false, done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
      clearInterval(tick);
      resolve(ok);
    };
    const onUpd = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (sawLoading && info.status === "complete") setTimeout(() => finish(true), 500);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    const t0 = Date.now();
    const tick = setInterval(() => {
      const el = Date.now() - t0;
      if (!sawLoading && el > 3000) finish(true);
      if (el > (timeout || 25000)) finish(false);
    }, 400);
    try { chrome.tabs.reload(tabId); } catch (e) { finish(false); }
  });
}

function ping() {
  return new Promise((resolve) => {
    if (!TAB) return resolve(false);
    chrome.tabs.sendMessage(TAB.id, { type: "pageContext" }, (x) => {
      void chrome.runtime.lastError;
      resolve(!!x);
    });
  });
}

// 内容脚本是否真的活着 —— 反复确认，而不是靠"加载完成"推测
async function ensureContentScript(maxTry, gap) {
  maxTry = maxTry || 10;
  gap = gap || 800;
  for (let i = 0; i < maxTry; i++) {
    if (await ping()) {
      CTX = await tabMsg(TAB.id, { type: "pageContext" });
      if (i > 0) logInfo(`页面脚本已就绪（重试 ${i} 次后）`);
      return true;
    }
    if (i === 0) logWarn("页面脚本尚未响应，重试中…");
    await new Promise((r) => setTimeout(r, gap));
  }
  return false;
}

async function reloadTab() {
  if (!TAB) { await refreshPage(); if (!TAB) return false; }
  const id = TAB.id;
  say("正在刷新页面…");
  logInfo("刷新 B 站页面：" + (TAB.url || ""));
  const ok = await reloadAndWait(id);
  warned = false;
  await refreshPage({ keep: true });
  const ready = await ensureContentScript();
  await drawHistory();
  if (!ready) {
    fail("刷新后还是没连上页面。确认下这是 B 站视频页，或手动按一次 F5。");
    return false;
  }
  status("刷新好了", "ok");
  logInfo("页面刷新完成，内容脚本可用");
  return true;
}

// ---------------------------------------------------------------- 取数据
async function biliFetch(urls) {
  const r = await send({ type: "biliFetch", tabId: TAB.id, urls });
  if (!r || !r.ok) throw new Error((r && r.error) || "页面内请求失败");
  const out = {};
  for (const x of r.data || []) {
    if (!x.ok) throw new Error(`接口请求失败（${x.error || x.status}）`);
    out[x.url] = JSON.parse(x.text);
  }
  return out;
}

function buildTranscript(rows, window = 30) {
  const out = [];
  let buf = [], start = null;
  for (const r of rows) {
    if (start === null) start = r.start;
    buf.push(r.text);
    if (r.start - start >= window || r.end - start >= window * 1.6) {
      out.push(`[${mmss(start)}] ${buf.join("").trim()}`);
      buf = []; start = null;
    }
  }
  if (buf.length) out.push(`[${mmss(start)}] ${buf.join("").trim()}`);
  return out.join("\n");
}

const SCHEMA_HINT = `{
  "verdict": { "one_line": "一句话结论（40字内）", "worth": "精看|选看|跳过",
               "net_value_min": 数字, "reason": "80字内，必须引用具体时间段作为证据" },
  "segments": [ { "start": 秒, "end": 秒, "topic": "14字内", "density": "高|中|低",
                  "type": "干货|推导|举例|铺垫|重复|试错|读稿|带货|闲聊",
                  "action": "精看|倍速|跳过", "star": 1-3, "note": "30字内" } ],
  "prereq": [ { "title": "", "detail": "", "ref": "" } ],
  "playlist": [ { "start": 秒, "end": 秒, "label": "20字内" } ]
}`;

function buildPrompt(course, page, rows) {
  return `下面是一门网课某一节的**带时间戳字幕稿**。

课程：${course.title}
合集：${course.up}
本篇：${page.part}
时长：${(page.duration / 60).toFixed(1)} 分钟

请输出一份「观看向导」，严格符合以下 JSON 结构：

${SCHEMA_HINT}

硬性要求：
1. segments 必须完整覆盖全片，从 0 秒到片尾，不重叠、不留空档。同一主题连续内容合并成一段，
   每段长度在 30 秒到 8 分钟之间。
2. 判定标准：
   - 精看：讲原理、讲结论、复现过程、方法论、思路转折、易错点。本节信息密度最高的部分。
   - 倍速：必要的操作过程，看懂"在做什么"就够。
   - 跳过：重复前面讲过的、纯鼠标操作、报错排查、找错文件、闲聊吐槽、念弹幕、无信息量过渡。
3. 必须警惕"藏在答疑/闲聊里的高价值段"——这类段落最容易漏判为"跳过"，判错是严重失误。
4. net_value_min 必须等于所有 action=精看 段落时长之和（四舍五入）。
5. 全部用中文。只输出 JSON，不要 markdown 代码块，不要解释文字。

字幕稿（[分:秒] 开头）：

${buildTranscript(rows)}`;
}

// ---------------------------------------------------------------- 校验
function parseJson(text) {
  let t = String(text).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (m) t = m[1].trim();
  return JSON.parse(t);
}

function normalize(a, duration) {
  const segs = [];
  for (const s of a.segments || []) {
    const st = Math.round(s.start), en = Math.round(s.end);
    if (!(en > st)) continue;
    segs.push({
      start: Math.max(0, st), end: Math.min(duration, en),
      topic: (s.topic || "").trim() || "（未标注）",
      density: ["高", "中", "低"].includes(s.density) ? s.density : "中",
      type: (s.type || "干货").trim(),
      action: ["精看", "倍速", "跳过"].includes(s.action) ? s.action : "倍速",
      star: Math.min(3, Math.max(1, parseInt(s.star) || 1)),
      note: (s.note || "").trim(),
    });
  }
  segs.sort((x, y) => x.start - y.start);
  const filled = [];
  let cur = 0;
  for (const s of segs) {
    if (s.start > cur) filled.push({ start: cur, end: s.start, topic: "未标注区间", density: "低", type: "闲聊", action: "跳过", star: 1, note: "模型未覆盖，按低价值处理" });
    filled.push(s);
    cur = Math.max(cur, s.end);
  }
  if (cur < duration) filled.push({ start: cur, end: duration, topic: "片尾", density: "低", type: "闲聊", action: "跳过", star: 1, note: "" });

  const stats = { total: duration, 精看: 0, 倍速: 0, 跳过: 0 };
  for (const x of filled) stats[x.action] += x.end - x.start;
  stats.core = filled.filter((x) => x.star === 3).reduce((n, x) => n + (x.end - x.start), 0);

  const v = a.verdict || {};
  if (!["精看", "选看", "跳过"].includes(v.worth)) v.worth = "选看";
  v.net_value_min = Math.round(stats.精看 / 60);
  return { verdict: v, segments: filled, stats, prereq: a.prereq || [], playlist: a.playlist || [] };
}

function renderEmpty() {
  $("overview").innerHTML = `<div class="empty">还没看过这节课。<br>点「分析」，我帮你拆一拆：哪段值得细看、哪段倍速就行、哪段可以直接跳。</div>`;
  $("cardRoute").style.display = "none";
  $("cardPrereq").style.display = "none";
  $("cardSeg").style.display = "none";
  $("segCount").textContent = "";
}

// ---------------------------------------------------------------- 渲染（概览 = 全部）
function render(d) {
  RESULT = d;
  const s = d.stats, v = d.verdict;
  const wc = { 精看: C.精看, 选看: C.倍速, 跳过: C.跳过 }[v.worth] || C.倍速;
  const foreign = OWNER && TAB ? !tabMatches(TAB.url, OWNER.bvid, OWNER.p) : false;

  $("overview").innerHTML = `<div class="card">
    <span class="badge" style="background:${wc.bg};color:${wc.fg}">${esc(v.worth)}</span>
    <div class="one">${esc(v.one_line)}</div>
    <div class="reason">${esc(v.reason)}</div>
    ${foreign ? `<div class="hint" style="margin-top:8px;color:#8A6D1F">这条记录不是当前这节。点时间会帮你切过去并跳到那一秒。</div>` : ""}
    <div class="nums">
      <div class="num"><b>${mins(s.total)}</b><span>总时长（分钟）</span></div>
      <div class="num"><b style="color:${C.精看.fg}">${mins(s.精看)}</b><span>值得精看</span></div>
      <div class="num"><b style="color:${C.倍速.fg}">${mins(s.倍速)}</b><span>可倍速</span></div>
      <div class="num"><b style="color:${C.跳过.fg}">${mins(s.跳过)}</b><span>可跳过</span></div>
    </div>
    <div class="tlwrap">
      <div class="tltip" id="tltip"></div>
      <div class="tl" id="tl">${d.segments
        .map((x, i) => `<i data-jump="${x.start}" data-i="${i}" style="flex-grow:${x.end - x.start};background:${C[x.action].line}"></i>`)
        .join("")}</div>
      <div class="scale"><span>00:00</span><span>${mmss(s.total / 2)}</span><span>${mmss(s.total)}</span></div>
    </div>
    <div class="legend">
      <span><s style="background:${C.精看.line}"></s>精看 <em>${mins(s.精看)}′</em></span>
      <span><s style="background:${C.倍速.line}"></s>倍速 <em>${mins(s.倍速)}′</em></span>
      <span><s style="background:${C.跳过.line}"></s>跳过 <em>${mins(s.跳过)}′</em></span>
      <span style="margin-left:auto">★★★ 核心 <em>${mins(s.core)}′</em> · 可省 <em>${mins(s.total - s.精看)}′</em></span>
    </div>
    <div class="hint" style="margin-top:9px">色块越宽说明那段越长。悬停看内容，点击直接跳过去看。</div>
    <div class="anchors">
      <button data-anchor="cardRoute">精华路线</button>
      <button data-anchor="cardPrereq">前置知识</button>
      <button data-anchor="cardSeg">逐段判定 ${d.segments.length} 段</button>
    </div>
  </div>`;

  let cum = 0;
  $("playlist").innerHTML = d.playlist.length
    ? d.playlist.map((p) => {
        cum += p.end - p.start;
        return `<div data-jump="${p.start}">
          <span class="tm">${mmss(p.start)}</span>
          <span class="lb">${esc(p.label)}</span>
          <span class="cu">${mins(p.end - p.start)}′ · 累计 ${mins(cum)}′</span></div>`;
      }).join("")
    : `<div class="empty">这次没有给精华路线。</div>`;
  $("cardRoute").style.display = "";

  $("prereq").innerHTML = d.prereq.length
    ? d.prereq.map((x) => `<div class="pq"><b>${esc(x.title)}</b>${x.ref ? `<span class="ref">${esc(x.ref)}</span>` : ""}<div class="d">${esc(x.detail)}</div></div>`).join("")
    : `<div class="empty">无</div>`;
  $("cardPrereq").style.display = "";

  $("segCount").textContent = `共 ${d.segments.length} 段`;
  drawPills();
  drawRows("全部");
  $("cardSeg").style.display = "";
}

function drawPills() {
  const w = $("pills");
  const opts = [["全部", "全部"], ["精看", "精看"], ["倍速", "倍速"], ["跳过", "跳过"], ["★★★", "core"]];
  w.innerHTML = opts.map((o, i) => `<button data-f="${o[1]}" class="${i === 0 ? "on" : ""}">${o[0]}</button>`).join("");
  w.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    w.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    drawRows(b.dataset.f);
  }));
}

function drawRows(f) {
  const rows = $("rows");
  if (!RESULT) return;
  let list = RESULT.segments;
  if (f === "core") list = list.filter((x) => x.star === 3);
  else if (f !== "全部") list = list.filter((x) => x.action === f);
  if (!list.length) { rows.innerHTML = `<div class="empty">这个筛选下没有段落</div>`; return; }
  rows.innerHTML = list.map((x) => {
    const c = C[x.action];
    return `<div class="seg" data-jump="${x.start}">
      <div class="tm">${mmss(x.start)} – ${mmss(x.end)}</div>
      <div class="bd">
        <div class="tp">${esc(x.topic)}<span class="tag" style="background:${c.bg};color:${c.fg}">${x.action}</span><span class="stars">${"★".repeat(x.star)}</span></div>
        <div class="nt">${esc(x.type)} · 密度${esc(x.density)}${x.note ? "<br>" + esc(x.note) : ""}</div>
      </div>
    </div>`;
  }).join("");
}

// ---------------------------------------------------------------- 时间轴悬停（document 级委托）
document.addEventListener("mousemove", (e) => {
  const tip = $("tltip");
  if (!tip) return;
  const i = e.target.closest ? e.target.closest("#tl i") : null;
  if (!i || !RESULT) { tip.classList.remove("on"); return; }
  const seg = RESULT.segments[parseInt(i.dataset.i, 10)];
  if (!seg) return;
  tip.textContent = `${mmss(seg.start)}–${mmss(seg.end)}  ${seg.topic} · ${seg.action} · ${fmtDur(seg.end - seg.start)}`;
  tip.classList.add("on");
  const wrap = i.parentElement.getBoundingClientRect();
  const x = Math.min(Math.max(0, e.clientX - wrap.left - tip.offsetWidth / 2), Math.max(0, wrap.width - tip.offsetWidth));
  tip.style.left = x + "px";
});

// ---------------------------------------------------------------- 打开视频（去重）
async function openVideo(bvid, p, t) {
  p = parseInt(p, 10) || 1;
  const base = `https://www.bilibili.com/video/${bvid}?p=${p}`;
  const withT = t != null ? `&t=${Math.max(0, Math.floor(t))}` : "";

  if (TAB && tabMatches(TAB.url, bvid, p)) {
    if (t != null) {
      await chrome.tabs.update(TAB.id, { url: base + withT });
      say(`已跳到 ${mmss(t)}`);
    } else {
      status("就是这个页面", "ok");
      showTab("overview");
    }
    return;
  }

  let hit = null;
  try {
    const list = await chrome.tabs.query({ url: "*://www.bilibili.com/video/*" });
    hit = list.find((x) => tabMatches(x.url, bvid, p));
  } catch (e) {}
  if (hit) {
    if (t != null) await chrome.tabs.update(hit.id, { url: base + withT });
    await chrome.tabs.update(hit.id, { active: true });
    try { await chrome.windows.update(hit.windowId, { focused: true }); } catch (e) {}
    say("已经开着这个视频了，帮你切过去");
    return;
  }

  await chrome.tabs.create({ url: base + withT });
  say(`打开 ${keyLabel(bvid, p)}${t != null ? "，跳到 " + mmss(t) : ""}`);
}

// ---------------------------------------------------------------- 跳转
async function jump(t) {
  t = Math.max(0, Math.floor(Number(t) || 0));
  if (!OWNER) return;
  if (TAB && tabMatches(TAB.url, OWNER.bvid, OWNER.p)) {
    const r = await tabMsg(TAB.id, { type: "jump", t });
    if (r && r.ok) return;
    logWarn(`页内跳转失败（${(r && r.error) || "未知"}），改用标签页跳转`);
  }
  await openVideo(OWNER.bvid, OWNER.p, t);
}

document.addEventListener("click", (e) => {
  const tb = e.target.closest("#tabs button");
  if (tb) { showTab(tb.dataset.tab); return; }
  const an = e.target.closest("[data-anchor]");
  if (an) {
    const el = $(an.dataset.anchor);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const j = e.target.closest("[data-jump]");
  if (j) { e.preventDefault(); jump(j.dataset.jump); return; }
  const v = e.target.closest("[data-view]");
  if (v) {
    e.preventDefault();
    const [bvid, p] = v.dataset.view.split("|");
    viewSaved(bvid, p);
    return;
  }
  const o = e.target.closest("[data-open]");
  if (o) {
    e.preventDefault();
    const [bvid, p] = o.dataset.open.split("|");
    openVideo(bvid, p);
  }
});

async function viewSaved(bvid, p) {
  const rec = await loadRecord(bvid, p);
  if (!rec || !rec.result) { fail("没有找到 " + keyLabel(bvid, p) + " 的记录"); return; }
  RESULT = rec.result;
  OWNER = { bvid: rec.bvid, p: rec.p };
  CURRENT_KEY = hKey(rec.bvid, rec.p);
  render(rec.result);
  showTab("overview");
  status(`已调出 ${keyLabel(rec.bvid, rec.p)} 的报告`, "ok");
  logInfo(`手动调取记录：${keyLabel(rec.bvid, rec.p)}`);
  await drawHistory();
}

// ---------------------------------------------------------------- LLM 任务
async function pollJob(jobId, page) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const job = (await chrome.storage.local.get("job")).job;
    if (!job || job.id !== jobId) return;
    if (job.status === "running") return;
    clearInterval(pollTimer); pollTimer = null;
    if (job.status === "error") { fail("大模型调用失败：" + job.error); return; }
    try {
      const norm = normalize(parseJson(job.raw), page.duration);
      RESULT = norm;
      OWNER = { bvid: job.bvid, p: job.p };
      render(norm);
      CURRENT_KEY = hKey(job.bvid, job.p);
      await saveHistory(job.bvid, job.p, page.part, job.course, page, norm);
      await drawHistory();
      status(`搞定了：${mins(norm.stats.total)} 分钟的课，真正值得看的只有 ${mins(norm.stats.精看)} 分钟`, "ok");
      logInfo(`分析完成并已存档：${keyLabel(job.bvid, job.p)}`);
    } catch (e) {
      fail("结果解析失败：" + (e && e.message ? e.message : e));
    }
    await chrome.storage.local.remove("job");
  }, 1500);
}

async function resumeRunningJob() {
  const job = (await chrome.storage.local.get("job")).job;
  if (!job || job.status !== "running") return false;
  if (Date.now() - (job.startedAt || 0) > 15 * 60 * 1000) { await chrome.storage.local.remove("job"); return false; }
  say("上次的分析还在跑，继续等它…");
  pollJob(job.id, job.page);
  return true;
}

// ---------------------------------------------------------------- 主流程
async function analyze() {
  $("go").disabled = true;
  try {
    await refreshPage({ keep: true });
    if (!TAB) throw new Error("当前不是 B 站视频页");
    if (!(await ensureContentScript(3, 600))) {
      say("页面脚本没连上，正在刷新页面…");
      if (!(await reloadTab())) throw new Error("页面脚本一直没响应，请手动刷新页面后重试");
    }
    const { bvid, p } = parseBv(TAB.url);
    if (!bvid) throw new Error("从 URL 里没解析出 BV 号");
    const pnum = (CTX && CTX.p) || p;
    say("开始分析这节课…");

    const vurl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const view = (await biliFetch([vurl]))[vurl];
    if (!view || view.code !== 0) throw new Error("view 接口异常：" + JSON.stringify(view).slice(0, 120));
    const course = { title: view.data.title, up: view.data.owner.name, count: view.data.videos };
    const pg = (view.data.pages || []).find((x) => x.page === pnum) || (view.data.pages || [])[0];
    if (!pg) throw new Error("没找到第 " + pnum + " 分P");
    const page = { p: pg.page, cid: pg.cid, part: pg.part, duration: pg.duration };
    say(`第 ${page.p} 节 · ${Math.round(page.duration / 60)} 分钟，我来拆一拆`);

    const purl = `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${page.cid}`;
    const pl = (await biliFetch([purl]))[purl];
    const subs = ((pl.data || {}).subtitle || {}).subtitles || [];
    if (!subs.length) {
      throw new Error(
        (pl.data && pl.data.need_login_subtitle ? "该视频有 AI 字幕但需要登录态，请先登录 B 站。" : "该视频没有可用字幕。") +
          " 无字幕的视频请用桌面版 CourseTriage（支持音频转写）。"
      );
    }
    const track = subs.find((s) => (s.lan || "").startsWith("zh")) || subs[0];
    say("正在取字幕…");
    let subUrl = track.subtitle_url;
    if (subUrl.startsWith("//")) subUrl = "https:" + subUrl;
    const resp = await fetch(subUrl);
    if (!resp.ok) throw new Error("字幕文件下载失败 " + resp.status);
    const rows = ((await resp.json()).body || []).map((x) => ({ start: x.from, end: x.to, text: x.content }));
    if (!rows.length) throw new Error("字幕文件是空的");
    say(`拿到 ${rows.length} 段字幕`);

    const prompt = buildPrompt(course, page, rows);
    LAST = { course, page, rows, prompt, bvid };
    say("整理好了，交给大模型…");

    const c = await cfg();
    if (!c.key) {
      $("prompt").value = prompt;
      $("manualCard").style.display = "";
      showTab("set");
      status("还没配 Key：复制提示词交给任意 AI，把返回的 JSON 粘回来", "info");
      logWarn("未配置 LLM Key，走手动模式");
      return;
    }
    const jobId = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const job = { id: jobId, prompt, base: c.base, key: c.key, model: c.model, bvid, p: page.p, page, course, status: "running" };
    await chrome.storage.local.set({ job });
    await send({ type: "llm", job });
    say("正在分析，可能要 30–60 秒，可以先去干别的");
    pollJob(jobId, page);
  } catch (e) {
    const msg = "失败：" + (e && e.message ? e.message : e);
    fail(msg, /脚本/.test(msg) || /刷新/.test(msg) ? { label: "刷新页面", fn: reloadTab } : null);
  } finally {
    $("go").disabled = false;
  }
}

async function submitJson() {
  try {
    if (!LAST) { fail("请先点「分析」"); showTab("overview"); return; }
    const raw = $("paste").value.trim();
    if (!raw) throw new Error("请粘贴 JSON");
    const norm = normalize(parseJson(raw), LAST.page.duration);
    RESULT = norm;
    OWNER = { bvid: LAST.bvid, p: LAST.page.p };
    render(norm);
    CURRENT_KEY = hKey(LAST.bvid, LAST.page.p);
    await saveHistory(LAST.bvid, LAST.page.p, LAST.page.part, LAST.course, LAST.page, norm);
    await drawHistory();
    status(`搞定了：${mins(norm.stats.total)} 分钟的课，真正值得看的只有 ${mins(norm.stats.精看)} 分钟`, "ok");
    logInfo(`手动模式完成并已存档：${keyLabel(LAST.bvid, LAST.page.p)}`);
    $("manualCard").style.display = "none";
    showTab("overview");
  } catch (e) {
    fail("解析失败：" + (e && e.message ? e.message : e));
  }
}

// ---------------------------------------------------------------- 绑定
$("go").onclick = analyze;
$("reload").onclick = reloadTab;
$("saveCfg").onclick = saveCfg;
$("submitJson").onclick = submitJson;
$("copyPrompt").onclick = () => {
  const t = $("prompt");
  t.select();
  document.execCommand("copy");
  $("copyPrompt").textContent = "已复制 ✓";
  setTimeout(() => ($("copyPrompt").textContent = "复制"), 1500);
};
$("copyLog").onclick = async () => {
  const arr = await logGet();
  const text = arr.map((x) => `[${new Date(x.t).toLocaleString()}] [${x.lv}] ${x.m}`).join("\n");
  const ta = document.createElement("textarea");
  ta.value = text || "（空）";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  status("日志已复制到剪贴板", "ok");
};
let armedLog = false;
$("clearLog").onclick = async () => {
  if (!armedLog) { armedLog = true; $("clearLog").textContent = "再点一次"; setTimeout(() => { armedLog = false; $("clearLog").textContent = "清空"; }, 3000); return; }
  armedLog = false; $("clearLog").textContent = "清空";
  await chrome.storage.local.set({ [LOGKEY]: [] });
  await drawLogs();
  status("日志已清空", "ok");
};
let armed = false;
$("clearHist").onclick = async () => {
  if (!armed) { armed = true; $("clearHist").textContent = "再点一次"; setTimeout(() => { armed = false; $("clearHist").textContent = "清空"; }, 3000); return; }
  armed = false; $("clearHist").textContent = "清空";
  const items = await getHistory();
  await chrome.storage.local.remove(items.map((x) => hKey(x.bvid, x.p)).concat(["hist"]));
  CURRENT_KEY = null; RESULT = null; OWNER = null;
  renderEmpty();
  await drawHistory();
  logWarn("历史记录已清空");
  status("历史记录已清空", "ok");
};

// ---------------------------------------------------------------- 启动
const MOCK = {
  verdict: { one_line: "讲透「模板=代码执行入口」和「第三方组件版本就是攻击面」两条结论。", worth: "精看", reason: "真正值得投入的是 41:31–45:27 与 53:46–70:22 两段共约 21 分钟；前 41 分钟是建表、找文件的试错过程，可跳过。" },
  segments: [
    { start: 0, end: 125, topic: "开场：本节三条主线", density: "高", type: "干货", action: "精看", star: 2, note: "听完就知道全节结构" },
    { start: 125, end: 365, topic: "建表并插入测试数据", density: "低", type: "试错", action: "跳过", star: 1, note: "纯鼠标操作，无信息量" },
    { start: 365, end: 595, topic: "写查询：连库、拼接、输出", density: "中", type: "干货", action: "倍速", star: 2, note: "$_GET 直拼 SQL，是注入源头" },
    { start: 595, end: 731, topic: "从「页面太丑」引出模板必要性", density: "高", type: "推导", action: "精看", star: 2, note: "模板为什么被发明出来的逻辑链" },
    { start: 731, end: 972, topic: "自写模板最小原理", density: "高", type: "干货", action: "精看", star: 2, note: "读模板 + 替换占位符 + eval" },
    { start: 972, end: 1560, topic: "替换 5 个占位符并调试", density: "低", type: "试错", action: "倍速", star: 1, note: "只需理解替换模式" },
    { start: 1560, end: 1806, topic: "为什么需要模板 → MVC 分层", density: "高", type: "干货", action: "精看", star: 2, note: "把模板塞进分层架构" },
    { start: 1806, end: 2387, topic: "拆源码目录、反复找错文件", density: "低", type: "试错", action: "跳过", star: 1, note: "6 分半找文件，可整段跳过" },
    { start: 2387, end: 2491, topic: "模板负责视图、代码负责调用", density: "中", type: "干货", action: "倍速", star: 2, note: "结论值得听" },
    { start: 2491, end: 2727, topic: "自写模板 RCE：标题写代码被执行", density: "高", type: "干货", action: "精看", star: 3, note: "核心结论一：写模板 = 写代码" },
    { start: 2727, end: 2840, topic: "引入第三方模板的背景", density: "高", type: "干货", action: "精看", star: 2, note: "为什么会有第三方模板" },
    { start: 2840, end: 3226, topic: "第三方模板安装与语法试错", density: "低", type: "试错", action: "倍速", star: 1, note: "只记改目录 + 写 tpl" },
    { start: 3226, end: 3308, topic: "模板里写代码不执行 →「安全了吗」", density: "高", type: "推导", action: "精看", star: 3, note: "全节转折点，接着就被推翻" },
    { start: 3308, end: 3427, topic: "引出组件历史漏洞与版本区间", density: "高", type: "干货", action: "精看", star: 3, note: "建立「版本 → 漏洞」直觉" },
    { start: 3427, end: 3724, topic: "换成漏洞版本，代码执行复现成功", density: "高", type: "干货", action: "精看", star: 3, note: "本节最高价值：复现全过程" },
    { start: 3724, end: 3908, topic: "方法论：漏洞三层来源", density: "高", type: "干货", action: "精看", star: 3, note: "本节最该背下来的一段" },
    { start: 3908, end: 4222, topic: "新旧版本对照实验", density: "高", type: "干货", action: "精看", star: 3, note: "把「版本」这个变量讲透了" },
    { start: 4222, end: 4331, topic: "收尾与下节预告", density: "中", type: "铺垫", action: "倍速", star: 1, note: "下节衔接性强" },
    { start: 4331, end: 4378, topic: "吐槽弹幕", density: "低", type: "闲聊", action: "跳过", star: 1, note: "" },
    { start: 4378, end: 4560, topic: "答疑：这类漏洞怎么判断", density: "高", type: "干货", action: "精看", star: 2, note: "藏在答疑里的干货" },
    { start: 4560, end: 4870, topic: "框架 / 模板 / 组件三者的区别", density: "高", type: "干货", action: "精看", star: 3, note: "全节最清楚的一段，在答疑区易漏" },
    { start: 4870, end: 4940, topic: "黑盒识别手段", density: "中", type: "干货", action: "倍速", star: 2, note: "知道有哪些手段即可" },
    { start: 4940, end: 5104, topic: "组件漏洞判断方法 + 功能点理念", density: "高", type: "干货", action: "精看", star: 2, note: "「功能越敏感越容易出洞」很实用" },
  ],
  prereq: [
    { title: "PHP 应用开发（含数据库连接文件）", detail: "本节代码直接 include 前面写好的连接文件，没看过接不上", ref: "第22-25天" },
    { title: "留言板 / 文件管理项目", detail: "老师开场明说本节做法与留言板项目完全一致", ref: "第22-25天" },
    { title: "富文本编辑器组件", detail: "讲第三方组件漏洞时点名它，没印象接不上这条线", ref: "第24-25天" },
  ],
  playlist: [
    { start: 731, end: 972, label: "自写模板最小原理：读模板 + 替换 + eval" },
    { start: 1560, end: 1806, label: "为什么需要模板 → MVC 分层" },
    { start: 2491, end: 2727, label: "模板要被解析 → 写模板 = 写代码" },
    { start: 3226, end: 3724, label: "第三方模板也不安全：漏洞版本复现" },
    { start: 3724, end: 4222, label: "漏洞三层来源 + 版本对照实验" },
    { start: 4560, end: 4870, label: "框架 / 模板 / 组件三者的区别" },
  ],
};

(async function init() {
  if (!IS_EXT) {
    $("vtitle").textContent = "《高等数学》同济版 2024年更新｜宋浩老师";
    $("vsub").textContent = "BV1Eb411u7Fw · P26 · 85 分钟（界面预览，非真实数据）";
    OWNER = { bvid: "BV1Eb411u7Fw", p: 26 };
    render(normalize(MOCK, 5104));
    showTab("overview");
    return;
  }
  try {
    await loadCfg();
    await refreshPage();      // 内部负责「按匹配码自动调取记录」或置空
    await drawHistory();
    await drawLogs();
    await resumeRunningJob();
    logInfo("弹窗已打开");
    logTimer = setInterval(drawLogs, 2500);
  } catch (e) {
    fail("初始化异常：" + (e && e.message ? e.message : e));
  }
})();
