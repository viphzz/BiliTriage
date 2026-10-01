// BiliTriage content script：页面入口按钮 + 播放器内跳转
(function () {
  if (window.__biliTriageLoaded) return;
  window.__biliTriageLoaded = true;

  const BTN_ID = "bilitriage-btn";
  const TIP_ID = "bilitriage-tip";

  const video = () => document.querySelector("video");

  function toast(text, ms) {
    let el = document.getElementById(TIP_ID);
    if (!el) { el = document.createElement("div"); el.id = TIP_ID; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(el.__t);
    el.__t = setTimeout(() => el.classList.remove("show"), ms || 3000);
  }

  function mountButton() {
    if (!document.body) return; // document_start 阶段 body 可能还不存在
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.innerHTML = '<span class="d"></span>判断这节课';
    btn.title = "BiliTriage：分析当前这节是否值得认真看";
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openPopup" }, (r) => {
        if (!r || !r.ok) toast("请点浏览器工具栏上的 BiliTriage 图标");
      });
    });
    document.body.appendChild(btn);
  }

  function pageContext() {
    const url = location.href;
    const m = url.match(/[?&]p=(\d+)/);
    const p = m ? parseInt(m[1], 10) : 1;
    let title = document.title.replace(/[_-]哔哩哔哩.*$/, "").trim();
    const h1 = document.querySelector("h1.video-title, .video-title, h1");
    if (h1 && h1.textContent.trim()) title = h1.textContent.trim();
    const v = video();
    return {
      url, p, title,
      duration: v && isFinite(v.duration) ? Math.round(v.duration) : 0,
      currentTime: v ? Math.round(v.currentTime) : 0,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg) return;
    if (msg.type === "pageContext") {
      reply(pageContext());
      return true;
    }
    if (msg.type === "jump") {
      const v = video();
      if (!v) {
        reply({ ok: false, error: "页面上没找到播放器，请确认视频已开始播放" });
        return true;
      }
      try {
        v.currentTime = msg.t;
        if (msg.play) v.play().catch(() => {});
        v.scrollIntoView({ block: "center", behavior: "smooth" });
        reply({ ok: true, t: Math.round(v.currentTime) });
      } catch (e) {
        reply({ ok: false, error: String(e) });
      }
      return true;
    }
  });

  mountButton();
  setInterval(mountButton, 2000);
})();
