/* 纯原生 JS 控制台：从 /api/snapshot 拉数据渲染，定时轮询，可手动触发同步 */
(() => {
  const STATE_LABEL = {
    planned: "已计划",
    working: "进行中",
    done: "已完成",
    "pr-open": "已出 PR",
    "needs-human": "待人工",
    blocked: "阻塞",
    escalated: "已升级",
    failed: "失败",
    reset: "已重置",
    unknown: "未知",
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let DATA = null;
  let filter = "all";

  /* ---------------- 主题：亮 / 暗 / 跟随系统 ---------------- */
  const THEME_KEY = "foreman-theme";
  const mqDark = window.matchMedia("(prefers-color-scheme: dark)");

  function paintTheme(mode) {
    const resolved = mode === "system" ? (mqDark.matches ? "dark" : "light") : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    for (const btn of document.querySelectorAll("#themeSwitch button")) {
      const on = btn.dataset.themeMode === mode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  function setTheme(mode) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {}
    paintTheme(mode);
  }

  function initTheme() {
    let saved = "system";
    try {
      saved = localStorage.getItem(THEME_KEY) || "system";
    } catch {}
    paintTheme(saved);

    document.getElementById("themeSwitch").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-theme-mode]");
      if (btn) setTheme(btn.dataset.themeMode);
    });

    // 系统主题变了：只有「跟随系统」跟着走，手动选的保持不动
    const onChange = () => {
      if (document.documentElement.dataset.themeMode === "system") paintTheme("system");
    };
    if (typeof mqDark.addEventListener === "function") mqDark.addEventListener("change", onChange);
    else if (typeof mqDark.addListener === "function") mqDark.addListener(onChange);
  }

  /* ---------------- 顶栏 ---------------- */
  function renderHead() {
    $("metaDay").textContent = DATA.today || "—";

    const svc = $("metaService");
    svc.textContent = DATA.service.alive ? `服务 · 运行中 pid ${DATA.service.pid}` : "服务 · 未运行";
    svc.className = "pill " + (DATA.service.alive ? "on" : "off");
    document.querySelector(".pulse")?.classList.toggle("is-off", !DATA.service.alive);

    const itv = $("metaInterval");
    const sec = DATA.prWatch.intervalSeconds;
    itv.textContent = sec ? `间隔 · ${sec}s` : "间隔 · 未开";
    itv.className = "pill " + (DATA.prWatch.enabled ? "on" : "off");

    const prsHint = $("prsHint");
    if (prsHint) {
      prsHint.textContent = DATA.prWatch.enabled
        ? `扫 ${DATA.repos.length} 个仓库 · 每 ${sec || "?"}s`
        : "监听未开启";
    }
  }

  /* ---------------- 指标卡 ---------------- */
  function renderStats() {
    const wrap = $("stats");
    wrap.textContent = "";
    const s = DATA.stats;
    const cards = [
      { label: "今日分配任务", value: s.tasks, sub: `历史累计 ${s.historyTasks ?? 0} 单`, accent: "accent-cyan" },
      { label: "进行中", value: s.working, sub: `已出 PR ${s.prOpen}`, accent: "accent-green" },
      { label: "今日 PR", value: s.prs, sub: `历史 ${s.historyPrs ?? 0} 条 · 新增 ${s.newPrs ?? 0}`, accent: "accent-cyan" },
      { label: "待通知", value: s.pending, sub: "非本人作者、未发出", accent: "accent-amber" },
      { label: "已跳过", value: s.skipped, sub: "作者是自己", accent: "accent-red" },
    ];

    for (const c of cards) {
      const box = el("div", "stat " + c.accent);
      box.appendChild(el("div", "stat-label", c.label));
      box.appendChild(el("div", "stat-value", String(c.value ?? 0)));
      box.appendChild(el("div", "stat-sub", c.sub));
      wrap.appendChild(box);
    }
  }

  /* ---------------- 任务表 ---------------- */
  function renderTasks() {
    const tbody = $("taskRows");
    const empty = $("taskEmpty");
    const hint = $("tasksHint");
    tbody.textContent = "";

    const rows = DATA.tasks || [];
    hint.textContent = rows.length ? `${rows.length} 条 · 当天有更新` : "暂无";
    empty.hidden = rows.length > 0;

    for (const t of rows) {
      const tr = el("tr");

      const id = el("td", "id-cell");
      id.appendChild(el("span", "repo", t.repo + "#"));
      id.appendChild(el("span", null, String(t.number)));
      tr.appendChild(id);

      const title = el("td", "title-cell", t.title || "（无标题）");
      title.title = t.title || "";
      tr.appendChild(title);

      const st = el("td");
      st.appendChild(el("span", "badge " + t.state, STATE_LABEL[t.state] || t.state));
      tr.appendChild(st);

      const br = el("td", "branch-cell", t.branch || "—");
      br.title = t.branch || "";
      tr.appendChild(br);

      tr.appendChild(el("td", "try-cell", t.attempts ? `#${t.attempts}` : "—"));
      tr.appendChild(el("td", "time-cell", t.updatedAtClock || "—"));

      tbody.appendChild(tr);
    }
  }

  /* ---------------- 扫描记录 ---------------- */
  function renderPollStrip() {
    const strip = $("pollStrip");
    strip.textContent = "";
    const polls = (DATA.recentPolls || []).slice(0, 6);
    if (!polls.length) return;

    const label = el("span", "poll-label", "最近扫描");
    strip.appendChild(label);

    for (const p of polls.slice(0, 5)) {
      const chip = el("span", "p-chip");
      chip.appendChild(el("span", "p-time", p.atClock || "—"));
      chip.appendChild(
        el("span", "p-nums", `${p.tasks}单/${p.prs}PR +${p.newTasks}/+${p.newPrs}`)
      );
      if (p.pending) chip.appendChild(el("span", "p-flag", `${p.pending} 待通知`));
      chip.title = `第 ${p.id} 次快照`;
      strip.appendChild(chip);
    }
  }

  /* ---------------- PR 列表 ---------------- */
  function renderPRs() {
    const list = $("prList");
    const empty = $("prEmpty");
    list.textContent = "";

    const all = DATA.prs || [];
    const counts = {
      all: all.length,
      pending: all.filter((p) => p.pending).length,
      notified: all.filter((p) => p.state === "notified").length,
      skipped: all.filter((p) => p.state === "skipped").length,
    };
    const baseLabel = { all: "全部", pending: "待通知", notified: "已通知", skipped: "已跳过" };

    for (const btn of document.querySelectorAll("#prTabs .tab")) {
      const k = btn.dataset.filter;
      btn.textContent = `${baseLabel[k]} ${counts[k] ?? 0}`;
      btn.classList.toggle("is-active", k === filter);
    }

    const rows =
      filter === "pending" ? all.filter((p) => p.pending)
      : filter === "notified" ? all.filter((p) => p.state === "notified")
      : filter === "skipped" ? all.filter((p) => p.state === "skipped")
      : all;

    empty.hidden = rows.length > 0;
    if (!rows.length) {
      empty.querySelector(".empty-title").textContent =
        filter === "all" ? "今天还没有扫到 PR" : "这个分类下暂时没有 PR";
    }

    for (const p of rows) {
      const li = el("li", "pr");

      const main = el("div", "pr-main");
      const numEl = el("span", "pr-num");
      numEl.appendChild(el("span", "repo", p.repo + "#"));
      numEl.appendChild(el("span", null, String(p.number)));
      main.appendChild(numEl);
      main.appendChild(el("span", "pr-title", p.title || "（无标题）"));

      if (p.url) {
        const a = el("a", "pr-link", "打开");
        a.href = p.url;
        a.target = "_blank";
        a.rel = "noreferrer";
        main.appendChild(a);
      }
      li.appendChild(main);

      const meta = el("div", "pr-meta");
      const author = el("span", "chip");
      author.appendChild(document.createTextNode("作者 "));
      author.appendChild(el("span", "mono", p.author || "未知"));
      meta.appendChild(author);

      if (p.state === "skipped") {
        meta.appendChild(el("span", "badge self", "跳过 · 自己的"));
      } else if (p.state === "notified") {
        meta.appendChild(el("span", "badge notified", `已通知 ${p.notifiedAtClock || ""}`.trim()));
      } else {
        meta.appendChild(el("span", "badge pending", "待通知"));
      }

      meta.appendChild(el("span", "pr-note", `发现 ${p.seenAtClock || "—"}`));
      if (p.notifiedTo) meta.appendChild(el("span", "pr-note", `→ ${p.notifiedTo}`));

      li.appendChild(meta);
      list.appendChild(li);
    }
  }

  /* ---------------- 页脚 ---------------- */
  function renderFoot() {
    $("footUpdated").textContent = `同步于 · ${DATA.generatedAtClock}`;
    const st = DATA.storage;
    if (st) {
      $("footDb").textContent = `SQLite · ${st.file.split("/").pop()} · 去重键 ${st.uniqueKey} · 快照 ${st.rows.polls} 次`;
    }
    $("footApi").textContent = `API · /api/snapshot · ${DATA.tasks.length} 单 / ${DATA.prs.length} PR`;
  }

  function render() {
    if (!DATA) return;
    renderHead();
    renderStats();
    renderTasks();
    renderPollStrip();
    renderPRs();
    renderFoot();
  }

  /* ---------------- 取数 ---------------- */
  async function load() {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      DATA = await res.json();
      render();
      $("metaService").dataset.err = "";
    } catch (e) {
      const svc = $("metaService");
      svc.textContent = `服务 · 拿不到数据（${e.message}）`;
      svc.className = "pill off";
    }
  }

  async function syncNow(btn) {
    const old = btn.textContent;
    btn.textContent = "扫描中…";
    btn.disabled = true;
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const body = await res.json();
      if (body.snapshot) {
        DATA = body.snapshot;
        render();
      } else {
        await load();
      }
      btn.textContent = body.ok ? "已同步" : "同步失败";
    } catch {
      btn.textContent = "同步失败";
    } finally {
      btn.disabled = false;
      setTimeout(() => (btn.textContent = old), 1600);
    }
  }

  $("prTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    filter = btn.dataset.filter;
    renderPRs();
  });

  $("manualRefresh").addEventListener("click", (e) => syncNow(e.currentTarget));

  function tickClock() {
    const n = new Date();
    const p = (x) => String(x).padStart(2, "0");
    $("metaClock").textContent = `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
  }

  initTheme();
  tickClock();
  setInterval(tickClock, 1000);
  load();
  setInterval(load, 15000);
  window.addEventListener("focus", load);
})();
