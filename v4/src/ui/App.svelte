<script lang="ts">
  import type { ServerEvent } from "../shared/events";

  let token = "";
  let events: ServerEvent[] = [];
  let status: "idle" | "connected" | "error" = "idle";
  let error = "";

  async function connect() {
    status = "idle";
    error = "";
    try {
      const response = await fetch(`/events?token=${encodeURIComponent(token)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      events = await response.json() as ServerEvent[];
      status = "connected";
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : "Unknown connection error";
    }
  }
</script>

<svelte:head>
  <title>Athena v4</title>
</svelte:head>

<main class="workspace">
  <aside class="rail" aria-label="Primary views">
    <div class="mark">A</div>
    <button class="active" title="Chat">Chat</button>
    <button title="Approvals">Approvals</button>
    <button title="Memory">Memory</button>
    <button title="System">System</button>
  </aside>

  <section class="panel" aria-label="Event stream">
    <header>
      <div>
        <h1>Athena v4</h1>
        <p>Portable debugging companion overhaul</p>
      </div>
      <span class:ok={status === "connected"} class:error={status === "error"}>{status}</span>
    </header>

    <form on:submit|preventDefault={connect}>
      <input bind:value={token} placeholder="Session token" autocomplete="off" />
      <button type="submit">Connect</button>
    </form>

    {#if error}
      <p class="errorText">{error}</p>
    {/if}

    <ol class="events">
      {#each events as event}
        <li>
          <time>{event.seq}</time>
          <strong>{event.type}</strong>
          <code>{JSON.stringify(event)}</code>
        </li>
      {/each}
    </ol>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #111317;
    color: #eef0f3;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .workspace {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr);
  }

  .rail {
    background: #181b20;
    border-right: 1px solid #30343c;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 16px 10px;
  }

  .mark {
    width: 42px;
    height: 42px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: #d7b36a;
    color: #171717;
    font-weight: 800;
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
    width: 100%;
    font-size: 11px;
    padding: 0 4px;
  }

  button.active,
  button:hover {
    border-color: #d7b36a;
  }

  .panel {
    padding: 24px;
    max-width: 1120px;
  }

  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-size: 28px;
    line-height: 1.15;
  }

  p {
    color: #aeb5c0;
    margin-top: 6px;
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

  span.error {
    border-color: #d9796f;
    color: #ffaaa3;
  }

  form {
    display: flex;
    gap: 10px;
    margin-bottom: 18px;
  }

  input {
    min-width: 260px;
    flex: 1;
    border: 1px solid #3b414c;
    border-radius: 6px;
    background: #171a20;
    color: inherit;
    padding: 10px 12px;
  }

  .errorText {
    color: #ffaaa3;
    margin-bottom: 12px;
  }

  .events {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
  }

  .events li {
    border: 1px solid #30343c;
    border-radius: 8px;
    padding: 12px;
    background: #171a20;
    display: grid;
    gap: 6px;
  }

  time {
    color: #d7b36a;
    font-variant-numeric: tabular-nums;
  }

  code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: #c8d1de;
  }

  @media (max-width: 720px) {
    .workspace {
      grid-template-columns: 1fr;
    }

    .rail {
      flex-direction: row;
      justify-content: start;
      overflow-x: auto;
    }

    .rail button {
      width: auto;
      min-width: 72px;
    }

    form,
    header {
      flex-direction: column;
    }

    input,
    button {
      width: 100%;
    }
  }
</style>
