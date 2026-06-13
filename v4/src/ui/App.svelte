<script lang="ts">
  import { onMount } from "svelte";
  import type { ServerEvent } from "../shared/events";

  type View = "chat" | "dash" | "presence" | "memory" | "skills" | "agents" | "sessions" | "settings";

  // ── connection state ──
  let token = "";
  let status: "idle" | "connecting" | "connected" | "error" = "idle";
  let connError = "";
  let socket: WebSocket | undefined;
  let events: ServerEvent[] = [];
  let snapshot: any = null;

  // ── ui state ──
  let active: View = "chat";
  let draft = "";
  let evening = false;
  let reduceMotion = false;
  let listening = false;
  let autoApprove = false;
  let forSession = false;
  let memoryTab: "all" | "memory" | "instincts" = "all";
  let threadEl: HTMLElement | undefined;

  // ── boot ──
  onMount(() => {
    const urlToken = new URLSearchParams(location.search).get("token");
    try {
      evening = localStorage.getItem("athena-theme") === "evening";
      reduceMotion = localStorage.getItem("athena-reduce-motion") === "1";
    } catch {}
    if (urlToken) {
      token = urlToken;
      connect();
    }
  });

  $: if (typeof document !== "undefined") {
    document.body.classList.toggle("evening", evening);
    document.body.classList.toggle("reduce-motion", reduceMotion);
  }

  function connect() {
    if (!token.trim()) {
      connError = "Paste the session token printed at startup.";
      return;
    }
    connError = "";
    status = "connecting";
    const since = events.at(-1)?.seq ?? 0;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket?.close();
    socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(token)}&since=${since}`);
    socket.onopen = () => {
      status = "connected";
      void fetchSnapshot();
    };
    socket.onerror = () => {
      status = "error";
      connError = "Connection failed — check the token.";
    };
    socket.onmessage = (message) => {
      const ev = JSON.parse(message.data) as ServerEvent;
      events = [...events, ev].slice(-5000);
      if (["memory_updated", "instinct_event", "skill_crystallized", "coral_update", "alert_event"].includes(ev.type)) scheduleSnapshot();
      queueMicrotask(scrollThread);
    };
    socket.onclose = () => {
      if (status === "connected") status = "idle";
    };
  }

  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSnapshot() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => void fetchSnapshot(), 400);
  }
  async function fetchSnapshot() {
    try {
      const res = await fetch(`/api/snapshot?token=${encodeURIComponent(token)}`);
      if (res.ok) {
        snapshot = await res.json();
        if (typeof snapshot.autoApprove === "boolean") autoApprove = snapshot.autoApprove;
      }
    } catch {}
  }

  function send(payload: Record<string, unknown>) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }
  function submitTurn() {
    if (status !== "connected" || draft.trim().length === 0) return;
    send({ type: "chat_submit", text: draft });
    draft = "";
  }
  function onComposerKey(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitTurn();
    }
  }
  function respondApproval(id: string, approved: boolean) {
    send({ type: "approval_response", id, approved, forSession });
  }
  function toggleAutoApprove() {
    autoApprove = !autoApprove;
    send({ type: "set_auto_approve", enabled: autoApprove });
  }
  function setTheme(next: boolean) {
    evening = next;
    try {
      localStorage.setItem("athena-theme", next ? "evening" : "day");
    } catch {}
  }
  function toggleReduceMotion() {
    reduceMotion = !reduceMotion;
    try {
      localStorage.setItem("athena-reduce-motion", reduceMotion ? "1" : "0");
    } catch {}
  }
  function scrollThread() {
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
  }

  // ── derived: conversation timeline ──
  type ThreadItem =
    | { kind: "msg"; role: "you" | "athena"; text: string; seq: number; ts: string }
    | { kind: "tool"; id: string; name: string; tier: number; statusText: "running" | "done" | "failed"; bytes: number; capped: boolean; seq: number; ts: string }
    | { kind: "gate"; id: string; tool: string; reason: string; preview: string; resolved: boolean; approved: boolean; seq: number; ts: string }
    | { kind: "skill"; skill: string; version: number; verified: boolean; seq: number; ts: string };

  function buildTimeline(evs: ServerEvent[]): ThreadItem[] {
    const items: ThreadItem[] = [];
    const asstByTurn = new Map<string, number>();
    const toolById = new Map<string, ThreadItem & { kind: "tool" }>();
    const gateById = new Map<string, ThreadItem & { kind: "gate" }>();
    for (const e of evs) {
      const any = e as any;
      switch (e.type) {
        case "chat_received":
          items.push({ kind: "msg", role: "you", text: any.text, seq: e.seq, ts: e.ts });
          break;
        case "text_delta": {
          let idx = asstByTurn.get(any.id);
          if (idx === undefined) {
            idx = items.length;
            items.push({ kind: "msg", role: "athena", text: "", seq: e.seq, ts: e.ts });
            asstByTurn.set(any.id, idx);
          }
          (items[idx] as ThreadItem & { kind: "msg" }).text += any.text;
          break;
        }
        case "tool_started": {
          const item = { kind: "tool", id: any.id, name: any.name, tier: any.tier, statusText: "running", bytes: 0, capped: false, seq: e.seq, ts: e.ts } as ThreadItem & { kind: "tool" };
          toolById.set(any.id, item);
          items.push(item);
          break;
        }
        case "tool_output": {
          const t = toolById.get(any.id);
          if (t) {
            t.bytes = any.bytes;
            t.capped = any.capped;
          }
          break;
        }
        case "tool_finished": {
          const t = toolById.get(any.id);
          if (t) {
            t.statusText = any.ok ? "done" : "failed";
            t.bytes = any.bytes;
          }
          break;
        }
        case "approval_required": {
          const item = { kind: "gate", id: any.id, tool: any.tool, reason: any.reason, preview: any.preview, resolved: false, approved: false, seq: e.seq, ts: e.ts } as ThreadItem & { kind: "gate" };
          gateById.set(any.id, item);
          items.push(item);
          break;
        }
        case "approval_resolved": {
          const g = gateById.get(any.id);
          if (g) {
            g.resolved = true;
            g.approved = any.approved;
          }
          break;
        }
        case "skill_crystallized":
          items.push({ kind: "skill", skill: any.skill, version: any.version, verified: any.verified, seq: e.seq, ts: e.ts });
          break;
      }
    }
    return items;
  }

  $: timeline = buildTimeline(events);
  $: pendingApprovals = timeline.filter((i) => i.kind === "gate" && !i.resolved) as Array<ThreadItem & { kind: "gate" }>;
  $: toolsUsed = timeline.filter((i) => i.kind === "tool").length;
  $: turnsCount = events.filter((e) => e.type === "chat_received").length;
  $: errorEvents = events.filter((e) => e.type === "error_detail") as Array<Extract<ServerEvent, { type: "error_detail" }>>;
  $: securityFeed = (events.filter((e) => e.type === "security_audit") as any[]).slice(-12).reverse();

  $: turnInProgress = (() => {
    const open = new Set<string>();
    for (const e of events) {
      if (e.type === "turn_started") open.add((e as any).id);
      else if (e.type === "turn_finished") open.delete((e as any).id);
    }
    return open.size > 0;
  })();
  $: toolRunning = timeline.some((i) => i.kind === "tool" && i.statusText === "running");
  $: presenceState = status !== "connected" ? "" : toolRunning ? "acting" : turnInProgress ? "thinking" : listening ? "listening" : "";
  $: presenceDoing =
    status !== "connected" ? "Waiting to connect" : toolRunning ? "Running tools on your behalf" : turnInProgress ? "Thinking it through" : listening ? "Listening…" : "Present & attentive";

  // ── derived: capabilities, mode, provider, watchers ──
  $: capabilities = (() => {
    const m = new Map<string, { available: boolean; reason?: string }>();
    for (const e of events) if (e.type === "capability_changed") m.set((e as any).capability, { available: (e as any).available, reason: (e as any).reason });
    return m;
  })();
  $: mode = (() => {
    let value = "";
    for (const e of events) if (e.type === "mode_changed") value = (e as any).mode;
    return value;
  })();
  $: modeLabel = mode === "cloud" ? "Cloud" : mode === "local" ? "Local model" : mode === "offline" ? "Offline" : "—";
  $: provider = (() => {
    let p: any = null;
    for (const e of events) if (e.type === "failover") p = (e as any).to;
    if (!p && snapshot?.providers?.length) p = snapshot.providers[0];
    return p;
  })();

  const MONITOR_META: Record<string, { label: string; icon: string; cls: string }> = {
    temp_high: { label: "CPU temperature", icon: "🌡️", cls: "bg-terra" },
    disk_low: { label: "Disk space", icon: "💾", cls: "bg-olive" },
    net_change: { label: "Network", icon: "🌐", cls: "bg-lapis" },
    kp41: { label: "Power events", icon: "⚡", cls: "bg-bronze" },
    ram_pressure: { label: "Memory pressure", icon: "🧠", cls: "bg-olive" },
    cpu_spike: { label: "CPU load", icon: "📈", cls: "bg-terra" },
    battery_drain: { label: "Battery", icon: "🔋", cls: "bg-bronze" },
    login_failures: { label: "Sign-in attempts", icon: "🔐", cls: "bg-lapis" },
    pending_reboot: { label: "Pending reboot", icon: "🔄", cls: "bg-olive" },
  };
  const WATCH_DISPLAY = ["temp_high", "disk_low", "net_change", "kp41"];
  const ACTIVE_ALERT = new Set(["created", "shown", "escalated"]);

  $: watchers = (() => {
    const m = new Map<string, { state: string; severity: string }>();
    if (snapshot?.alerts) for (const a of snapshot.alerts) m.set(a.monitor, { state: a.state, severity: a.severity });
    for (const e of events) if (e.type === "alert_event") m.set((e as any).monitor, { state: (e as any).state, severity: (e as any).severity });
    return m;
  })();
  $: activeAlertCount = [...watchers.values()].filter((w) => ACTIVE_ALERT.has(w.state)).length;

  function watchStateText(monitor: string): string {
    const w = watchers.get(monitor);
    if (!w || !ACTIVE_ALERT.has(w.state)) return "calm";
    return `${w.severity} · ${w.state}`;
  }
  function watchDot(monitor: string): "ok" | "warn" | "crit" {
    const w = watchers.get(monitor);
    if (!w || !ACTIVE_ALERT.has(w.state)) return "ok";
    return w.severity === "critical" ? "crit" : "warn";
  }

  // ── snapshot-backed collections ──
  $: memoryEntries = (snapshot?.memory ?? []) as any[];
  $: instinctEntries = (snapshot?.instincts ?? []) as any[];
  $: skillEntries = (snapshot?.skills ?? []) as any[];
  $: coralEntries = ((snapshot?.coral ?? []) as any[]).slice().reverse();
  $: providerEntries = (snapshot?.providers ?? []) as any[];
  $: counts = snapshot?.counts ?? { memory: 0, instincts: 0, skills: 0, coral: 0, alerts: 0, audit: 0, errors: 0, instinctEvents: 0 };
  $: memoryView = memoryTab === "instincts" ? [] : memoryEntries;

  $: recentSessions = timeline
    .filter((i) => i.kind === "msg" && i.role === "you")
    .slice(-12)
    .reverse() as Array<ThreadItem & { kind: "msg" }>;

  // ── helpers ──
  const CAP_LABEL: Record<string, { label: string; icon: string }> = {
    sqlite: { label: "Database", icon: "🗄️" },
    sqlite_fts5: { label: "Search index", icon: "🔎" },
    local_llm: { label: "Local model", icon: "🧠" },
    embeddings: { label: "Embeddings", icon: "🧬" },
    pty: { label: "Terminal", icon: "⌨️" },
  };

  function rel(ts: string): string {
    if (!ts) return "";
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return "";
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 45) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return `${Math.floor(d / 7)}w ago`;
  }
  function clock(ts: string): string {
    const t = ts ? Date.parse(ts) : Date.now();
    return new Date(Number.isNaN(t) ? Date.now() : t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  $: greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
  })();
  $: firstTurnTs = events.find((e) => e.type === "turn_started")?.ts ?? "";

  const NAV_MAIN: Array<{ view: View; icon: string; label: string }> = [
    { view: "chat", icon: "i-chat", label: "Conversation" },
    { view: "dash", icon: "i-grid", label: "Dashboard" },
    { view: "presence", icon: "i-spark", label: "Presence" },
  ];

  const PRESENCE_STUDY = [
    { cls: "", label: "Present", doing: "Idle and listening. The mark breathes — a soft bronze halo, eyes forward." },
    { cls: "listening", label: "Listening", doing: "You're speaking. A warm terracotta pulse, leaning in." },
    { cls: "thinking", label: "Thinking", doing: "Reasoning through a problem. A laurel-gold ring turns around her." },
    { cls: "acting", label: "Acting", doing: "Running tools on your behalf. A steady olive ring marks the work." },
  ];

  function tierLabel(tier: number): string {
    return tier >= 2 ? "Tier 2 · needs you" : tier === 1 ? "Tier 1 · logged" : "Tier 0 · silent";
  }
</script>

{#if status !== "connected"}
  <div class="gateway">
    <div class="gateway-card">
      <div class="presence-orb"><span class="halo"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg></div>
      <h1>ATHENA</h1>
      <p class="gateway-sub">Goddess of Wisdom</p>
      <p class="gateway-help">Paste the session token printed when Athena started, then connect.</p>
      <input
        bind:value={token}
        placeholder="Session token"
        autocomplete="off"
        spellcheck="false"
        on:keydown={(e) => e.key === "Enter" && connect()}
      />
      <button class="gateway-btn" on:click={connect}>{status === "connecting" ? "Connecting…" : "Connect"}</button>
      {#if connError}<p class="gateway-error">{connError}</p>{/if}
    </div>
  </div>
{:else}
  <div class="app" class:dashboard-mode={active !== "chat"}>
    <!-- ───────── LEFT RAIL ───────── -->
    <aside class="rail">
      <div class="brand">
        <svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg>
        <div>
          <div class="brand-name">ATHENA</div>
          <div class="brand-sub">Goddess of Wisdom</div>
        </div>
      </div>

      <div class="nav-eyebrow">Workspace</div>
      <nav class="nav">
        {#each NAV_MAIN as item}
          <div class="nav-item" class:active={active === item.view} on:click={() => (active = item.view)} role="button" tabindex="0">
            <svg><use href={"#" + item.icon} /></svg>{item.label}
          </div>
        {/each}
      </nav>

      <div class="nav-eyebrow">Her Mind</div>
      <nav class="nav">
        <div class="nav-item" class:active={active === "memory"} on:click={() => (active = "memory")} role="button" tabindex="0">
          <svg><use href="#i-book" /></svg>Memory <span class="nav-badge">{counts.memory}</span>
        </div>
        <div class="nav-item" class:active={active === "skills"} on:click={() => (active = "skills")} role="button" tabindex="0">
          <svg><use href="#i-spark" /></svg>Skills <span class="nav-badge">{counts.skills}</span>
        </div>
        <div class="nav-item" class:active={active === "agents"} on:click={() => (active = "agents")} role="button" tabindex="0">
          <svg><use href="#i-agents" /></svg>Agents <span class="nav-badge" class:live={coralEntries.length > 0}>{counts.coral}</span>
        </div>
        <div class="nav-item" class:active={active === "sessions"} on:click={() => (active = "sessions")} role="button" tabindex="0">
          <svg><use href="#i-clock" /></svg>Sessions
        </div>
        <div class="nav-item" class:active={active === "settings"} on:click={() => (active = "settings")} role="button" tabindex="0">
          <svg><use href="#i-gear" /></svg>Settings
        </div>
      </nav>

      <div class="rail-foot">
        <button class="theme-btn" on:click={() => setTheme(!evening)}>
          <svg><use href={evening ? "#i-sun" : "#i-moon"} /></svg><span>{evening ? "Day" : "Evening"}</span>
        </button>
        <div class="watch-pill"><span class="dot"></span>Watcher active · {activeAlertCount === 0 ? "all calm" : activeAlertCount + " active"}</div>
        <div class="provider">
          <div class="provider-row">
            <div class="provider-logo anthropic">{(provider?.provider ?? modeLabel ?? "A").slice(0, 1).toUpperCase()}</div>
            <div class="provider-meta">
              <b>{provider?.provider ?? modeLabel}</b><span>{provider?.model ?? mode ?? "no provider"}</span>
            </div>
            <button class="provider-switch" on:click={() => (active = "settings")}>switch</button>
          </div>
        </div>
      </div>
    </aside>

    <!-- ───────── CHAT ───────── -->
    {#if active === "chat"}
      <main class="main">
        <div class="topbar">
          <div>
            <h1>Conversation</h1>
            <div class="sub">{firstTurnTs ? "Begun " + clock(firstTurnTs) : "Ready"} · {toolsUsed} tools consulted</div>
          </div>
          <span class="chip"><svg><use href="#i-grid" /></svg>This machine · {modeLabel}</span>
          <div class="topbar-actions">
            <button class="icon-btn" on:click={() => (active = "memory")}><svg><use href="#i-search" /></svg></button>
            <button class="icon-btn" on:click={() => (active = "dash")}><svg><use href="#i-bell" /></svg></button>
          </div>
        </div>

        <div class="thread" bind:this={threadEl}>
          <div class="thread-inner">
            {#if timeline.length === 0}
              <div class="welcome">
                <div class="presence-orb"><span class="halo"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg></div>
                <h2>{greeting}</h2>
                <p>I'm here and keeping an eye on this machine. Ask me anything, give me a task, or just think out loud — I'll handle the rest.</p>
              </div>
            {:else}
              <div class="day-sep">Today</div>
              {#each timeline as item (item.kind + "-" + ("id" in item ? item.id : item.seq))}
                {#if item.kind === "msg"}
                  <div class="msg {item.role}">
                    {#if item.role === "you"}
                      <div class="avatar you">You</div>
                    {:else}
                      <div class="avatar athena"><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg></div>
                    {/if}
                    <div class="bubble-wrap">
                      <div class="sender">{item.role === "you" ? "You" : "Athena"}</div>
                      <div class="bubble">{item.text}</div>
                    </div>
                  </div>
                {:else if item.kind === "tool"}
                  <div class="tool-scroll open" style="margin-left:52px">
                    <div class="tool-head">
                      <div class="tool-glyph">$</div>
                      <div class="tool-title">{item.name}<small>{item.statusText === "running" ? "running…" : item.statusText}</small></div>
                      <span class="tier {item.tier >= 2 ? 't2' : item.tier === 1 ? 't1' : 't0'}">{tierLabel(item.tier)}</span>
                    </div>
                    <div class="tool-body">
                      <div class="code-line"><span class="prompt">$ </span>{item.name}</div>
                      <div class="tool-out">{item.statusText === "running" ? "working…" : `${item.bytes} bytes${item.capped ? " · output capped" : ""}`}</div>
                    </div>
                  </div>
                {:else if item.kind === "gate"}
                  <div class="msg athena">
                    <div class="avatar athena"><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg></div>
                    <div class="bubble-wrap" style="max-width:78%">
                      <div class="sender">Athena</div>
                      <div class="gate" style:opacity={item.resolved ? "0.6" : "1"}>
                        <div class="gate-top">
                          <span class="tier t2">Tier 2 · needs you</span>
                          <b>Approve a system action</b>
                        </div>
                        <p>{item.tool} — {item.reason}</p>
                        <div class="cmd">{item.preview}</div>
                        <div class="gate-actions">
                          {#if item.resolved}
                            <span style="font-size:12.5px;font-weight:600;color:{item.approved ? 'var(--olive-deep)' : 'var(--terra-deep)'}">
                              {item.approved ? "✓ Approved" : "✕ Declined"}
                            </span>
                          {:else}
                            <button class="btn btn-approve" on:click={() => respondApproval(item.id, true)}>Approve once</button>
                            <button class="btn btn-decline" on:click={() => respondApproval(item.id, false)}>Not now</button>
                          {/if}
                        </div>
                      </div>
                    </div>
                  </div>
                {:else if item.kind === "skill"}
                  <div class="tool-scroll" style="margin-left:52px">
                    <div class="tool-head">
                      <div class="tool-glyph">✦</div>
                      <div class="tool-title">Crystallized a skill<small>{item.skill} · v{item.version}</small></div>
                      <span class="tier {item.verified ? 't1' : 't2'}">{item.verified ? "verified" : "review"}</span>
                    </div>
                  </div>
                {/if}
              {/each}
            {/if}
          </div>
        </div>

        <div class="composer-wrap">
          <div class="composer">
            <div class="composer-tools">
              <button class="c-btn"><svg><use href="#i-attach" /></svg></button>
              <button class="c-btn mic" class:listening on:click={() => (listening = !listening)}><svg><use href="#i-mic" /></svg></button>
            </div>
            <textarea rows="1" bind:value={draft} on:keydown={onComposerKey} placeholder="Ask Athena, give her a task, or type / for commands…"></textarea>
            <button class="send-btn" on:click={submitTurn}><svg><use href="#i-send" /></svg></button>
          </div>
          <div class="composer-hint">
            <span><kbd>/recall</kbd> search memory</span>
            <span><kbd>/tool</kbd> run a tool directly</span>
            <span><kbd>Enter</kbd> to send</span>
          </div>
        </div>
      </main>

      <!-- ───────── RIGHT RAIL · PRESENCE ───────── -->
      <aside class="context">
        <div class="ctx-card">
          <div class="presence-hero">
            <div class="presence-orb {presenceState}"><span class="halo"></span><span class="ring"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg></div>
            <div class="presence-state">{presenceDoing}</div>
            <div class="presence-doing">{provider?.model ?? modeLabel}</div>
            <div class="presence-meta">
              <span class="mini-pill">{mode || "—"}</span>
              <span class="mini-pill">{toolsUsed} tools used</span>
              <span class="mini-pill">{autoApprove ? "auto-approve" : "tier gated"}</span>
            </div>
          </div>
        </div>

        <div class="ctx-card">
          <div class="head"><h3>She's Watching</h3><span class="count">{WATCH_DISPLAY.length} sentinels</span></div>
          <div class="watch-list">
            {#each WATCH_DISPLAY as monitor}
              <div class="watch-row">
                <div class="watch-ico {MONITOR_META[monitor].cls}">{MONITOR_META[monitor].icon}</div>
                <div class="watch-info"><b>{MONITOR_META[monitor].label}</b><span>{watchStateText(monitor)}</span></div>
                <span class="status-dot {watchDot(monitor) === 'ok' ? 'ok' : 'warn'}"></span>
              </div>
            {/each}
          </div>
        </div>

        <div class="ctx-card">
          <div class="head"><h3>Helpers</h3><span class="count">CORAL</span></div>
          <div class="agent-list">
            {#if coralEntries.length === 0}
              <div class="agent-row"><div style="min-width:0"><b>No helpers yet</b><span class="goal">Background agents and shared learning appear here.</span></div></div>
            {:else}
              {#each coralEntries.slice(0, 4) as entry}
                <div class="agent-row">
                  <span class="agent-check"><svg><use href="#i-check" /></svg></span>
                  <div style="min-width:0"><b>v{entry.version} · {entry.platform}</b><span class="goal">{entry.body}</span></div>
                </div>
              {/each}
            {/if}
            <button class="add-agent" on:click={() => (active = "agents")}><svg width="14" height="14"><use href="#i-plus" /></svg>Open the CORAL network</button>
          </div>
        </div>
      </aside>
    {/if}

    <!-- ───────── DASHBOARD ───────── -->
    {#if active === "dash"}
      <main class="main">
        <div class="topbar">
          <div><h1>Dashboard</h1><div class="sub">Everything Athena knows about this machine</div></div>
          <span class="chip"><span class="dot"></span>{activeAlertCount === 0 ? "All systems calm" : activeAlertCount + " need attention"}</span>
        </div>
        <div class="dash">
          <div class="dash-inner">
            <div class="dash-hero">
              <div class="presence-orb"><span class="halo"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg></div>
              <div class="dash-hero-text">
                <h2>{greeting}</h2>
                <p>I'm watching over <strong>this machine</strong> in <strong>{modeLabel}</strong> mode. {activeAlertCount === 0 ? "Everything is calm right now." : activeAlertCount + " thing(s) want attention."}</p>
              </div>
              <div class="dash-hero-stats">
                <div class="dash-stat"><div class="v">{turnsCount}</div><div class="l">Turns</div></div>
                <div class="dash-stat"><div class="v">{counts.skills}</div><div class="l">Skills</div></div>
                <div class="dash-stat"><div class="v">{counts.memory}</div><div class="l">Memories</div></div>
              </div>
            </div>

            <div class="dash-grid">
              <div class="card col-7">
                <div class="card-head"><div class="ci bg-olive"><svg width="17" height="17" style="color:var(--olive-deep)"><use href="#i-grid" /></svg></div><h3>Machine health</h3></div>
                <div class="health-grid">
                  {#each [...capabilities] as [cap, info]}
                    <div class="health-tile"><div class="ht-ico {info.available ? 'bg-olive' : 'bg-bronze'}">{CAP_LABEL[cap]?.icon ?? "•"}</div><div><b>{CAP_LABEL[cap]?.label ?? cap}</b><span>{info.available ? "available" : info.reason ?? "unavailable"}</span></div></div>
                  {/each}
                  <div class="health-tile"><div class="ht-ico bg-lapis">🌐</div><div><b>Mode</b><span>{modeLabel}</span></div></div>
                </div>
              </div>

              <div class="card col-5">
                <div class="card-head"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-book" /></svg></div><h3>Memory</h3><span class="more" on:click={() => (active = "memory")} role="button" tabindex="0">Open →</span></div>
                <div class="flex between" style="font-size:12px;color:var(--ink-3)"><span>Long-term store</span><span>{counts.memory} entries</span></div>
                <div class="meter"><span style="width:{Math.min(100, counts.memory * 4)}%"></span></div>
                <div class="mem-line"><span>Memories</span><b>{counts.memory}</b></div>
                <div class="mem-line"><span>Learned instincts</span><b>{counts.instincts}</b></div>
                <div class="mem-line"><span>Instinct updates</span><b>{counts.instinctEvents}</b></div>
                <div class="mem-line"><span>Audit records</span><b>{counts.audit}</b></div>
              </div>

              <div class="card col-4">
                <div class="card-head"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-spark" /></svg></div><h3>Skills</h3></div>
                {#if skillEntries.length === 0}
                  <p class="muted">No skills crystallized yet.</p>
                {:else}
                  {#each skillEntries.slice(0, 4) as skill}
                    <div class="skill-row"><div class="sg bg-olive">✦</div><div style="flex:1"><b>{skill.name}</b><span class="meta">v{skill.versions?.length ?? 1}</span></div><span class="badge {skill.verified ? 'verified' : 'unverified'}">{skill.verified ? "verified" : "review"}</span></div>
                  {/each}
                {/if}
              </div>

              <div class="card col-5">
                <div class="card-head"><div class="ci bg-olive"><svg width="17" height="17" style="color:var(--olive-deep)"><use href="#i-agents" /></svg></div><h3>Providers</h3></div>
                {#if providerEntries.length === 0}
                  <div class="flex center" style="gap:11px;padding:9px 0"><div class="provider-logo anthropic" style="width:30px;height:30px;border-radius:8px">{modeLabel.slice(0, 1)}</div><div style="flex:1"><b style="font-size:13px">{modeLabel}</b><div class="meta" style="font-family:var(--font-mono);font-size:11px;color:var(--ink-3)">no calls yet</div></div><span class="status-dot ok"></span></div>
                {:else}
                  {#each providerEntries as p}
                    <div class="flex center" style="gap:11px;padding:9px 0;border-bottom:1px solid var(--line-soft)"><div class="provider-logo anthropic" style="width:30px;height:30px;border-radius:8px">{p.provider.slice(0, 1).toUpperCase()}</div><div style="flex:1"><b style="font-size:13px">{p.provider}</b><div class="meta" style="font-family:var(--font-mono);font-size:11px;color:var(--ink-3)">{p.model} · {p.failureCount} fails</div></div><span class="status-dot {p.blockedUntil ? 'warn' : 'ok'}"></span></div>
                  {/each}
                {/if}
              </div>

              <div class="card col-7">
                <div class="card-head"><div class="ci bg-lapis"><svg width="17" height="17" style="color:var(--lapis-deep)"><use href="#i-clock" /></svg></div><h3>Recent activity</h3><span class="more" on:click={() => (active = "sessions")} role="button" tabindex="0">All →</span></div>
                {#if recentSessions.length === 0}
                  <p class="muted">No conversations yet.</p>
                {:else}
                  {#each recentSessions.slice(0, 5) as s}
                    <div class="session-row"><span class="when">{clock(s.ts)}</span><span class="what">{s.text}</span></div>
                  {/each}
                {/if}
              </div>
            </div>
          </div>
        </div>
      </main>
    {/if}

    <!-- ───────── PRESENCE ───────── -->
    {#if active === "presence"}
      <main class="main">
        <div class="topbar"><div><h1>Athena's presence</h1><div class="sub">How she shows up on screen as her state changes</div></div></div>
        <div class="dash">
          <div class="dash-inner" style="max-width:900px">
            <div class="card" style="grid-column:auto;margin-bottom:20px">
              <p style="color:var(--ink-2);font-size:14px;max-width:640px">The owl of wisdom, framed in laurel, is Athena's living mark. It breathes when she's idle, and her presence shifts — colour, motion, the focus of her eyes — so you always feel <em style="color:var(--olive-deep);font-style:normal;font-weight:600">who's there and what she's doing</em> without reading a word.</p>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:20px">
              {#each PRESENCE_STUDY as s}
                <div class="card" style="text-align:center;padding:26px 18px">
                  <div class="presence-orb {s.cls}" style="width:96px;height:96px;margin:0 auto 18px"><span class="halo"></span><span class="ring"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark" /></svg></div>
                  <div style="font-family:var(--font-display);font-size:21px;font-weight:600">{s.label}</div>
                  <p style="font-size:12.5px;color:var(--ink-2);margin-top:7px;line-height:1.55">{s.doing}</p>
                </div>
              {/each}
            </div>
          </div>
        </div>
      </main>
    {/if}

    <!-- ───────── MEMORY ───────── -->
    {#if active === "memory"}
      <main class="main">
        <div class="topbar"><div><h1>Memory</h1><div class="sub">What Athena carries across every session</div></div><span class="chip"><svg><use href="#i-book" /></svg>{counts.memory} memories · {counts.instincts} instincts</span></div>
        <div class="dash">
          <div class="dash-inner" style="max-width:1000px">
            <div class="subnav">
              <span class="tab" class:active={memoryTab === "all"} on:click={() => (memoryTab = "all")} role="button" tabindex="0">All<span class="n">{counts.memory + counts.instincts}</span></span>
              <span class="tab" class:active={memoryTab === "memory"} on:click={() => (memoryTab = "memory")} role="button" tabindex="0">Memories<span class="n">{counts.memory}</span></span>
              <span class="tab" class:active={memoryTab === "instincts"} on:click={() => (memoryTab = "instincts")} role="button" tabindex="0">Instincts<span class="n">{counts.instincts}</span></span>
            </div>

            {#if memoryTab !== "instincts"}
              <div class="section-title">Memories<span class="eyebrow">memory_entries</span></div>
              {#if memoryView.length === 0}
                <p class="muted">No memories stored yet.</p>
              {:else}
                <div class="mem-grid">
                  {#each memoryView as m}
                    <div class="mem-card"><div class="mc-top"><span class="mem-tag {m.validated ? 'self' : 'you'}">{m.validated ? "Validated" : "Note"}</span><span class="when">{rel(m.updatedAt ?? m.createdAt)}</span></div><div class="body">{m.body}</div></div>
                  {/each}
                </div>
              {/if}
            {/if}

            {#if memoryTab !== "memory"}
              <div class="section-title" style="margin-top:26px">Learned instincts<span class="eyebrow">instincts · auto-promoted</span></div>
              {#if instinctEntries.length === 0}
                <p class="muted">No instincts learned yet.</p>
              {:else}
                <div class="mem-grid">
                  {#each instinctEntries as ins}
                    <div class="mem-card"><div class="mc-top"><span class="mem-tag instinct">Instinct</span><span class="when">{ins.seenSessions} sessions</span></div><div class="body">{ins.body}</div><div class="conf">confidence<span class="bar"><span style="width:{Math.round(ins.confidence * 100)}%"></span></span>{Math.round(ins.confidence * 100)}</div></div>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      </main>
    {/if}

    <!-- ───────── SKILLS ───────── -->
    {#if active === "skills"}
      <main class="main">
        <div class="topbar"><div><h1>Skills</h1><div class="sub">The library Athena builds for herself</div></div><span class="chip"><span class="dot"></span>{skillEntries.filter((s) => s.verified).length} verified · {skillEntries.filter((s) => !s.verified).length} in review</span></div>
        <div class="dash">
          <div class="dash-inner">
            {#if skillEntries.length === 0}
              <p class="muted">No skills yet. Athena crystallizes skills from successful multi-step tasks.</p>
            {:else}
              <div class="skills-grid">
                {#each skillEntries as skill}
                  <div class="skill-card" class:review={!skill.verified}>
                    <div class="sc-top"><div class="sc-glyph bg-olive">✦</div><div><div class="sc-name">{skill.name}</div><div class="sc-plat">v{skill.versions?.length ?? 1}</div></div><span class="badge {skill.verified ? 'verified' : 'unverified'}" style="margin-left:auto">{skill.verified ? "verified" : "review"}</span></div>
                    <div class="sc-desc">{skill.versions?.at(-1)?.body ?? "No description."}</div>
                    <div class="sc-foot"><span class="sc-uses">used {skill.versions?.reduce((a, v) => a + (v.uses ?? 0), 0) ?? 0}×</span></div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </main>
    {/if}

    <!-- ───────── AGENTS / CORAL ───────── -->
    {#if active === "agents"}
      <main class="main">
        <div class="topbar"><div><h1>Helpers</h1><div class="sub">Background agents and shared learning — the CORAL network</div></div></div>
        <div class="dash">
          <div class="dash-inner">
            <div class="coral">
              <div class="ch"><svg width="17" height="17" style="color:var(--olive)"><use href="#i-agents" /></svg><h3>CORAL log</h3><span class="v">turn-boundary learning</span></div>
              <div class="coral-feed">
                {#if coralEntries.length === 0}
                  <div class="coral-row"><span class="ctext">No CORAL entries yet. Agents broadcast skills and notes here at safe turn boundaries.</span></div>
                {:else}
                  {#each coralEntries as entry}
                    <div class="coral-row"><span class="cv">v{entry.version}</span><span class="cdot" style="background:var(--olive)"></span><span class="ctext"><b>{entry.platform}</b> {entry.body}</span></div>
                  {/each}
                {/if}
              </div>
            </div>
          </div>
        </div>
      </main>
    {/if}

    <!-- ───────── SESSIONS ───────── -->
    {#if active === "sessions"}
      <main class="main">
        <div class="topbar"><div><h1>Sessions</h1><div class="sub">Every conversation in this run</div></div></div>
        <div class="dash">
          <div class="dash-inner" style="max-width:920px">
            <div class="section-title">Today</div>
            {#if recentSessions.length === 0}
              <p class="muted">No conversations yet.</p>
            {:else}
              <div class="card" style="padding:6px 20px">
                {#each recentSessions as s}
                  <div class="session-row"><span class="when">{clock(s.ts)}</span><span class="what">{s.text}</span></div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </main>
    {/if}

    <!-- ───────── SETTINGS ───────── -->
    {#if active === "settings"}
      <main class="main">
        <div class="topbar"><div><h1>Settings</h1><div class="sub">How Athena behaves on this machine</div></div></div>
        <div class="dash">
          <div class="dash-inner">
            <div class="set-wrap">
              <div class="set-section">
                <div class="sh"><div class="ci bg-olive"><svg width="17" height="17" style="color:var(--olive-deep)"><use href="#i-agents" /></svg></div><div><h3>Providers</h3><p>Mode: {modeLabel}</p></div></div>
                {#if providerEntries.length === 0}
                  <div class="set-row"><div class="sr-text"><b>No providers used yet</b><span>Provider health appears after the first model call.</span></div><div class="sr-control"><span class="field">{modeLabel}</span></div></div>
                {:else}
                  {#each providerEntries as p}
                    <div class="set-row"><div class="sr-text"><b>{p.provider}</b><span>{p.model}</span></div><div class="sr-control"><span class="field">{p.failureCount} failures{p.blockedUntil ? " · blocked" : ""}</span></div></div>
                  {/each}
                {/if}
                {#each [...capabilities] as [cap, info]}
                  <div class="set-row"><div class="sr-text"><b>{CAP_LABEL[cap]?.label ?? cap}</b><span>{info.available ? "available" : info.reason ?? "unavailable"}</span></div><div class="sr-control"><span class="tier-tag" style="background:{info.available ? 'var(--wash-olive)' : 'var(--wash-terra)'};color:{info.available ? 'var(--olive-deep)' : 'var(--terra-deep)'}">{info.available ? "on" : "off"}</span></div></div>
                {/each}
              </div>

              <div class="set-section">
                <div class="sh"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-spark" /></svg></div><div><h3>Autonomy</h3><p>How much Athena does without asking</p></div></div>
                <div class="set-row"><div class="sr-text"><b>Tier 0 — read-only</b><span>Runs silently</span></div><div class="sr-control"><span class="tier-tag" style="background:var(--wash-olive);color:var(--olive-deep)">always on</span></div></div>
                <div class="set-row"><div class="sr-text"><b>Tier 1 — low-impact writes</b><span>Runs automatically, written to the audit trail</span></div><div class="sr-control"><span class="tier-tag" style="background:var(--wash-olive);color:var(--olive-deep)">on</span></div></div>
                <div class="set-row"><div class="sr-text"><b>Tier 2 — destructive actions</b><span>Always pause for explicit approval</span></div><div class="sr-control"><span class="tier-tag" style="background:var(--wash-terra);color:var(--terra-deep)">locked on</span></div></div>
                <div class="set-row"><div class="sr-text"><b>Auto-approve everything</b><span>Skip Tier 2 gates — interactive session only, never background agents</span></div><div class="sr-control"><span class="toggle" class:on={autoApprove} on:click={toggleAutoApprove} role="switch" tabindex="0" aria-checked={autoApprove}></span></div></div>
              </div>

              <div class="set-section">
                <div class="sh"><div class="ci bg-terra"><svg width="17" height="17" style="color:var(--terra-deep)"><use href="#i-bell" /></svg></div><div><h3>The watcher</h3><p>What she keeps an eye on in the background</p></div></div>
                {#each Object.keys(MONITOR_META) as monitor}
                  <div class="set-row"><div class="sr-text"><b>{MONITOR_META[monitor].label}</b><span>{watchStateText(monitor)}</span></div><div class="sr-control"><span class="status-dot {watchDot(monitor) === 'ok' ? 'ok' : 'warn'}"></span></div></div>
                {/each}
              </div>

              <div class="set-section">
                <div class="sh"><div class="ci bg-lapis"><svg width="17" height="17" style="color:var(--lapis-deep)"><use href="#i-mic" /></svg></div><div><h3>Appearance</h3><p>How she looks</p></div></div>
                <div class="set-row"><div class="sr-text"><b>Theme</b><span>Day marble, or warm evening</span></div><div class="sr-control"><div class="seg"><button class:on={!evening} on:click={() => setTheme(false)}>Day</button><button class:on={evening} on:click={() => setTheme(true)}>Evening</button></div></div></div>
                <div class="set-row"><div class="sr-text"><b>Reduce motion</b><span>Calm the breathing and animations</span></div><div class="sr-control"><span class="toggle" class:on={reduceMotion} on:click={toggleReduceMotion} role="switch" tabindex="0" aria-checked={reduceMotion}></span></div></div>
              </div>

              <div class="set-section">
                <div class="sh"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-book" /></svg></div><div><h3>Session</h3><p>Connection &amp; diagnostics</p></div></div>
                <div class="set-row"><div class="sr-text"><b>Status</b><span>Connected to this machine</span></div><div class="sr-control"><span class="field">{status}</span></div></div>
                <div class="set-row"><div class="sr-text"><b>Errors logged</b><span>This run</span></div><div class="sr-control"><span class="field">{errorEvents.length}</span></div></div>
                <div class="set-row"><div class="sr-text"><b>Events received</b><span>Replayed + live</span></div><div class="sr-control"><span class="field">{events.length}</span></div></div>
              </div>
            </div>
          </div>
        </div>
      </main>
    {/if}
  </div>
{/if}

<style>
  .gateway {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: var(--paper);
  }
  .gateway-card {
    width: min(420px, 92vw);
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 38px 34px 30px;
    box-shadow: var(--sh-2, 0 24px 60px rgba(44, 38, 32, 0.14));
  }
  .gateway-card .presence-orb {
    width: 84px;
    height: 84px;
    margin: 0 auto 18px;
  }
  .gateway-card h1 {
    font-family: var(--font-display);
    letter-spacing: 0.16em;
    font-size: 26px;
    margin: 0;
    color: var(--ink);
  }
  .gateway-sub {
    color: var(--bronze-deep);
    font-weight: 600;
    margin: 4px 0 18px;
    font-size: 13px;
  }
  .gateway-help {
    color: var(--ink-2);
    font-size: 13px;
    margin: 0 0 18px;
    line-height: 1.5;
  }
  .gateway-card input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    color: var(--ink);
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    margin-bottom: 12px;
  }
  .gateway-btn {
    width: 100%;
    border: none;
    border-radius: 10px;
    padding: 12px;
    font-weight: 700;
    font-size: 14px;
    color: #fff;
    cursor: pointer;
    background: linear-gradient(135deg, var(--olive), var(--bronze));
  }
  .gateway-error {
    color: var(--terra-deep);
    font-size: 12.5px;
    margin: 12px 0 0;
  }
  :global(body.reduce-motion *) {
    animation: none !important;
    transition: none !important;
  }
</style>
