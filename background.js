// BiliTriage service worker
// 1) 在页面主世界代发请求（借用 B 站登录态，绕过 CORS）
// 2) 跑 LLM 长任务 —— 放在这里而不是弹窗里，弹窗关掉任务也不会丢

// ---------------------------------------------------------------- 消息路由
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;

  if (msg.type === "openPopup") {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup()
        .then(() => reply({ ok: true }))
        .catch((e) => reply({ ok: false, error: String(e) }));
    } else {
      reply({ ok: false, error: "当前 Chrome 版本不支持自动弹窗，请点工具栏图标" });
    }
    return true;
  }

  if (msg.type === "biliFetch") {
    fetchInMainWorld(msg.tabId, msg.urls)
      .then((r) => reply({ ok: true, data: r }))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "llm") {
    // 先回执，再干活：fetch 处于 pending 时 SW 不会被回收
    reply({ ok: true, jobId: msg.job.id });
    runLLMJob(msg.job);
    return true;
  }
});

// ---------------------------------------------------------------- 主世界 fetch
function fetchInMainWorld(tabId, urls) {
  return chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (list) => {
        const out = [];
        for (const u of list) {
          try {
            const r = await fetch(u, {
              credentials: "include",
              headers: { Accept: "application/json, text/plain, */*" },
            });
            out.push({ url: u, ok: r.ok, status: r.status, text: await r.text() });
          } catch (e) {
            out.push({ url: u, ok: false, error: String(e) });
          }
        }
        return out;
      },
      args: [urls],
    })
    .then((res) => (res && res[0] && res[0].result) || []);
}

// ---------------------------------------------------------------- 日志（与弹窗共用 chrome.storage.local.logs）
let logChain = Promise.resolve();
function logAdd(lv, msg) {
  logChain = logChain.then(async () => {
    try {
      const arr = (await chrome.storage.local.get("logs")).logs || [];
      arr.push({ t: Date.now(), lv, m: String(msg == null ? "" : msg).slice(0, 1000) });
      while (arr.length > 300) arr.shift();
      await chrome.storage.local.set({ logs: arr });
    } catch (e) {}
  });
  return logChain;
}

// ---------------------------------------------------------------- LLM 任务
// 进度与结果都写进 chrome.storage.local 的 job 字段，弹窗轮询它即可；
// 这样弹窗中途被关掉，回来还能看到结果。
async function runLLMJob(job) {
  const put = (patch) => chrome.storage.local.set({ job: Object.assign({}, job, patch) });
  await put({ status: "running", startedAt: Date.now(), error: "" });
  logAdd("info", `大模型任务开始：${job.model} @ ${job.base}`);
  try {
    const url = String(job.base || "").replace(/\/+$/, "") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + job.key },
      body: JSON.stringify({
        model: job.model,
        messages: [
          {
            role: "system",
            content:
              "你是严谨的课程质检员，任务是帮学习者省时间。你只做两件事：(1) 判断每段时间的信息密度与必要性；(2) 指出内容中的可疑或含糊之处。你不复述内容、不写观后感、不替学习者判断'对职业有没有用'。只输出 JSON。",
          },
          { role: "user", content: job.prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status} ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const raw = (data.choices && data.choices[0] && data.choices[0].message.content) || "";
    if (!raw) throw new Error("模型返回空内容");
    const usage = data.usage || {};
    await put({ status: "done", raw, finishedAt: Date.now() });
    logAdd("info", `大模型返回成功：${raw.length} 字` +
      (usage.total_tokens ? `，token 用量 ${usage.prompt_tokens || "?"}+${usage.completion_tokens || "?"}=${usage.total_tokens}` : ""));
  } catch (e) {
    const msg = String((e && e.message) || e);
    await put({ status: "error", error: msg, finishedAt: Date.now() });
    logAdd("error", `大模型调用失败：${msg}`);
  }
}
