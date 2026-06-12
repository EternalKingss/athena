<script lang="ts">
  import type { ServerEvent } from "../shared/events";

  const views = ["Chat", "Approvals", "Memory", "Skills", "Agents", "Watchers", "Sessions", "System"] as const;
  type View = (typeof views)[number];

  let token = "";
  let active: View = "Chat";
  let status: "idle" | "connected" | "error" = "idle";
  let events: ServerEvent[] = [];
  let draft = "";
  let error = "";
  let socket: WebSocket | undefined;

  function connect() {
    error = "";
    const since = events.at(-1)?.seq ?? 0;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket?.close();
    socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(token)}&since=${since}`);
    socket.onopen = () => {
      status = "connected";
    };
    socket.onerror = () => {
      status = "error";
      error = "connection failed";
    };
    socket.onmessage = (message) => {
      events = [...events, JSON.parse(message.data) as ServerEvent].slice(-240);
    };
    socket.onclose = () => {
      if (status === "connected") status = "idle";
    };
  }

  let autoApprove = false;
  let forSession = false;
  let showErrors = false;

  function send(payload: Record<string, unknown>) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function submitTurn() {
    if (!socket || socket.readyState !== WebSocket.OPEN || draft.trim().length === 0) return;
    send({ type: "chat_submit", text: draft });
    draft = "";
  }

  function respondApproval(id: string, approved: boolean) {
    send({ type: "approval_response", id, approved, forSession });
  }

  function toggleAutoApprove() {
    autoApprove = !autoApprove;
    send({ type: "set_auto_approve", enabled: autoApprove });
  }

  $: resolvedIds = new Set(
    events.filter((event) => event.type === "approval_resolved").map((event) => (event as Extract<ServerEvent, { type: "approval_resolved" }>).id),
  );
  $: pendingApprovals = events.filter(
    (event) => event.type === "approval_required" && !resolvedIds.has((event as Extract<ServerEvent, { type: "approval_required" }>).id),
  ) as Array<Extract<ServerEvent, { type: "approval_required" }>>;
  $: errorEvents = events.filter((event) => event.type === "error_detail") as Array<Extract<ServerEvent, { type: "error_detail" }>>;
  $: memories = events.filter((event) => event.type === "memory_updated" || event.type === "instinct_event");
  $: alerts = events.filter((event) => event.type === "alert_event");
  $: system = events.filter((event) => event.type === "capability_changed" || event.type === "storage_mode" || event.type === "error_detail" || event.type === "failover");
  $: displayRows =
    active === "Approvals"
      ? pendingApprovals
      : active === "Memory"
        ? memories
        : active === "Skills"
          ? events.filter((event) => event.type === "skill_crystallized" || event.type === "coral_update")
          : active === "Agents"
            ? events.filter((event) => event.type === "turn_started" || event.type === "turn_finished")
            : active === "Watchers"
              ? alerts
              : active === "Sessions"
                ? events.filter((event) => event.type === "chat_received" || event.type === "turn_finished")
                : system;
</script>

<svelte:head>
  <title>Athena v4</title>
</svelte:head>

<main class="workspace">
  <aside class="rail" aria-label="Primary views">
    <div class="mark">A</div>
    {#each views as view}
      <button class:active={active === view} title={view} on:click={() => (active = view)}>{view}</button>
    {/each}
  </aside>

  <section class="surface" aria-label={active}>
    <header>
      <h1>{active}</h1>
      <div class="status">
        <span class:ok={status === "connected"} class:error={status === "error"}>{status}</span>
        <span>{events.at(-1)?.seq ?? 0}</span>
      </div>
    </header>

    <div class="connection">
      <input bind:value={token} placeholder="Session token" autocomplete="off" />
      <button type="button" on:click={connect}>Connect</button>
      <button type="button" class:warn={autoApprove} on:click={toggleAutoApprove}>AUTO_APPROVE {autoApprove ? "ON" : "OFF"}</button>
    </div>

    {#if autoApprove}
      <div class="banner" role="alert">⚠ AUTO_APPROVE is ON — interactive Tier 2 actions are granted without a prompt. Background agents remain blocked.</div>
    {/if}

    {#if error}
      <p class="errorText">{error}</p>
    {/if}

    {#if active === "Chat"}
      <div class="chat">
        <ol class="stream">
          {#each events.filter((event) => event.type === "text_delta" || event.type === "tool_started" || event.type === "tool_finished" || event.type === "failover") as event}
            <li><strong>{event.type}</strong><code>{JSON.stringify(event)}</code></li>
          {/each}
        </ol>
        <form on:submit|preventDefault={submitTurn}>
          <input bind:value={draft} placeholder="Message" />
          <button type="submit">Send</button>
        </form>
      </div>
    {:else if active === "Approvals"}
      <div class="approvals">
        <label class="forSession"><input type="checkbox" bind:checked={forSession} /> grant for the rest of the session</label>
        {#if pendingApprovals.length === 0}
          <p class="muted">No pending approvals.</p>
        {/if}
        {#each pendingApprovals as event (event.id)}
          <div class="approval">
            <div class="meta">
              <strong>{event.tool}</strong>
              <span class="reason">{event.reason}</span>
              <code>{event.preview}</code>
            </div>
            <div class="actions">
              <button class="approve" on:click={() => respondApproval(event.id, true)}>Approve</button>
              <button class="deny" on:click={() => respondApproval(event.id, false)}>Deny</button>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <ol class="events">
        {#each displayRows as event}
          <li>
            <time>{event.seq}</time>
            <strong>{event.type}</strong>
            <code>{JSON.stringify(event)}</code>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</main>

<button class="drawer-toggle" class:has={errorEvents.length > 0} on:click={() => (showErrors = !showErrors)}>
  Errors ({errorEvents.length})
</button>

{#if showErrors}
  <aside class="drawer" aria-label="Error drawer">
    <header>
      <strong>Errors</strong>
      <button on:click={() => (showErrors = false)}>close</button>
    </header>
    {#if errorEvents.length === 0}
      <p class="muted">No errors.</p>
    {/if}
    {#each errorEvents as event}
      <div class="err">
        <code>{event.error.code}</code>
        <span class="sev {event.error.severity}">{event.error.severity}</span>
        <span>{event.error.message}</span>
      </div>
    {/each}
  </aside>
{/if}

<style>
  :global(body) {
    margin: 0;
    background: #101113;
    color: #eef0f3;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .workspace {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 116px minmax(0, 1fr);
  }

  .rail {
    background: #171a1f;
    border-right: 1px solid #30343c;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 10px;
  }

  .mark {
    width: 42px;
    height: 42px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: #d6b35f;
    color: #151515;
    font-weight: 800;
    margin-bottom: 8px;
  }

  button {
    border: 1px solid #3b414c;
    background: #232832;
    color: inherit;
    border-radius: 6px;
    min-height: 36px;
    padding: 0 12px;
    cursor: pointer;
  }

  .rail button {
    text-align: left;
    font-size: 12px;
  }

  button.active,
  button:hover {
    border-color: #d6b35f;
  }

  button.warn {
    border-color: #d9a441;
    background: #3a2c12;
    color: #ffd58a;
  }

  .banner {
    border: 1px solid #d9a441;
    background: #3a2c12;
    color: #ffd58a;
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 14px;
    font-size: 13px;
  }

  .approvals {
    display: grid;
    gap: 10px;
  }

  .forSession {
    font-size: 12px;
    color: #c8d1de;
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .approval {
    border: 1px solid #30343c;
    border-radius: 8px;
    padding: 12px;
    background: #171a20;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
  }

  .approval .meta {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .approval .reason {
    color: #d6b35f;
    font-size: 12px;
  }

  .approval .actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  button.approve {
    border-color: #5fbf8f;
    color: #9be0bd;
  }

  button.deny {
    border-color: #d9796f;
    color: #ffaaa3;
  }

  .muted {
    color: #8a93a0;
    font-size: 13px;
  }

  .drawer-toggle {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 10;
  }

  .drawer-toggle.has {
    border-color: #d9796f;
    color: #ffaaa3;
  }

  .drawer {
    position: fixed;
    right: 16px;
    bottom: 60px;
    width: min(420px, 90vw);
    max-height: 50vh;
    overflow: auto;
    background: #14171c;
    border: 1px solid #3b414c;
    border-radius: 10px;
    padding: 12px;
    z-index: 10;
    display: grid;
    gap: 8px;
  }

  .drawer header {
    margin: 0;
  }

  .err {
    border-top: 1px solid #262a31;
    padding-top: 8px;
    font-size: 12px;
    display: grid;
    gap: 2px;
  }

  .sev.error,
  .sev.critical {
    color: #ffaaa3;
  }

  .sev.warning {
    color: #ffd58a;
  }

  .surface {
    padding: 20px;
    max-width: 1280px;
  }

  header,
  .connection,
  form {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  header {
    justify-content: space-between;
    margin-bottom: 14px;
  }

  h1 {
    margin: 0;
    font-size: 22px;
    line-height: 1.2;
  }

  .status {
    display: flex;
    gap: 8px;
  }

  span {
    border: 1px solid #3b414c;
    border-radius: 999px;
    padding: 6px 10px;
    font-size: 12px;
  }

  span.ok {
    border-color: #5fbf8f;
    color: #9be0bd;
  }

  span.error,
  .errorText {
    border-color: #d9796f;
    color: #ffaaa3;
  }

  .connection {
    margin-bottom: 14px;
  }

  input {
    min-width: 240px;
    flex: 1;
    border: 1px solid #3b414c;
    border-radius: 6px;
    background: #171a20;
    color: inherit;
    padding: 10px 12px;
  }

  .chat {
    display: grid;
    gap: 14px;
  }

  .events,
  .stream {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
  }

  .events li,
  .stream li {
    border: 1px solid #30343c;
    border-radius: 8px;
    padding: 12px;
    background: #171a20;
    display: grid;
    grid-template-columns: 64px 160px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }

  time {
    color: #d6b35f;
    font-variant-numeric: tabular-nums;
  }

  code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: #c8d1de;
  }

  @media (max-width: 760px) {
    .workspace {
      grid-template-columns: 1fr;
    }

    .rail {
      flex-direction: row;
      overflow-x: auto;
    }

    .rail button {
      min-width: 92px;
      text-align: center;
    }

    header,
    .connection,
    form,
    .events li,
    .stream li {
      grid-template-columns: 1fr;
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
