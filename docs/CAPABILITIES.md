# Athena — Field Manual

**What she can do.** A portable agent with full control of the machine. Runs commands, edits
files, diagnoses and repairs hardware faults, browses the web, spawns parallel workers,
remembers across sessions, and keeps working when the internet is gone.

| | |
|---|---|
| Tools | 36 |
| Diagnostic routines | 12 |
| Repairs available | 22 |
| Watched conditions | 9 |
| Report types | 4 |
| Offline tiers | 3 |

---

## 1. Run things

Unrestricted shell in both `cmd` and PowerShell. Not a sandbox, not a fixed command list —
anything you could type yourself, with a working directory, a timeout, and structured output.

- **Single commands or whole scripts.** Multi-line PowerShell blocks run as one unit.
- **Exit codes, stdout and stderr separately** — so "it printed a warning" is
  distinguishable from "it failed".
- **Long output truncates from the middle**, keeping head and tail.
- **Timeouts kill the whole process tree**, not just the shell — nothing left orphaned.

> say: *check what's using port 8080 and kill it*

---

## 2. Work with files

| Tool | What it does |
|---|---|
| `read_file` | Reads any file, handling encoding and large files gracefully |
| `write_file` | Creates or overwrites. Parent directories created automatically |
| `edit_file` | Exact-match replacement inside a file — surgical, no full rewrite |
| `list_dir` | Directory listing with sizes and modified times |
| `search_files` | Finds files by name or content across a tree |
| `clipboard_read` / `clipboard_write` | Reads and sets the Windows clipboard |
| `open` | Opens a file, folder or URL in its default application |

> say: *find every config file under D:\ATHENA that mentions the API key and show me the lines*

---

## 3. Diagnose the machine

Describe a symptom in your own words — she picks the routine, runs real commands, and parses
output into numbers. "my wifi is gone" and "disk is full" both land correctly without you
naming anything.

| Routine | What she actually checks |
|---|---|
| `system_health` | CPU model and load, memory pressure, disk fill, uptime |
| `network_check` | Every adapter's status and link speed, IP addressing, packet loss, routing table |
| `device_check` | Devices not reporting OK, driver versions and dates, phantom device nodes |
| `boot_check` | Boot history, cold vs hybrid vs resume, reboots suspiciously close together |
| `disk_check` | Fill percentage per volume, largest directories when tight |
| `process_check` | Top processes by CPU and working set |
| `log_check` | Recent errors and crashes from the system log |
| `port_check` | What's listening, on which port, owned by which process |
| `service_check` | Services that should be running and aren't |
| `user_check` | Logged-in users and active sessions |
| `boot_info` | Uptime and last boot time |
| `env_check` | Environment variables and PATH |

**Routines chain themselves.** A memory warning pulls in a process check. An adapter fault
pulls in a device check, which pulls in boot history — so "my wifi died" ends up showing the
reboot pattern that explains it, without you asking three questions.

She can also tell an adapter that's *down* from one that's *up but useless* — connected at
144 Mbps with a self-assigned `169.254.x.x` address because no DHCP server answered. That's
the shape of a cold-boot failure, and it looks healthy to anything that only checks link status.

> say: *i cant see my wifi*

---

## 4. Repair the machine

Finding the fault is half of it. She carries a library of real repairs, runs them, and then
**checks they worked** — every repair has a command that proves success or failure.

| Area | Repairs |
|---|---|
| Network | `dns-cache-flush` `dhcp-renew` `adapter-bounce` `winsock-reset` `arp-flush` `nic-power-management` |
| Devices & boot | `phantom-net-devices` `fast-startup-off` |
| Disk space | `clear-temp` `clear-windows-update-cache` `empty-recycle-bin` |
| Stuck services | `restart-print-spooler` `restart-audio` `restart-explorer` `start-stopped-automatic-services` |
| Security | `firewall-enable` `defender-signatures` `defender-realtime-on` |
| System integrity | `sfc-scan` `dism-restore` `time-resync` |

### How a repair runs

1. **She checks the symptom is actually present.** If it isn't, she skips — no DNS flush on a
   machine whose DNS is fine.
2. **The steps run**, and she reports which succeeded.
3. **She verifies.** A separate command proves the fix took. If it didn't, she says so rather
   than claiming success.
4. **Batches go safest-first and stop at the first failure**, so a broken repair doesn't
   cascade into four more.
5. **Dry run any of it** — she prints the exact commands without running them.

### Learning repairs specific to this machine

Solve something the generic library doesn't cover and she can store it permanently, tied to
this hardware. Repairs that verify successfully gain confidence; ones that fail lose it and
eventually retire themselves. She refuses to store a repair with no way to prove it worked.

One is seeded and waiting: bouncing the D-Link USB Wi-Fi adapter after a failed cold boot. It
has never fired. Next time that adapter doesn't come up, she should catch it, apply it, and
verify — proving itself without you doing anything.

> say: *find everything wrong and just fix it*

---

## 5. Know the machine

Fingerprints the machine by hardware ID and keeps history, so she can answer questions about
change over time — not just the current moment.

| Capability | What you get |
|---|---|
| Installed inventory | Every language runtime, compiler, package manager, container tool, browser, IDE, database, DevOps tool and GPU she can detect, plus configured MCP servers |
| Return detection | On reconnecting to a machine she's seen before, reports what changed since last visit |
| Health trend | Direction of travel across past visits, not a single snapshot |
| Runtime drift | Snapshot processes, listening ports, loaded drivers and connection count, then diff later. A driver present in the baseline and missing now answers "why did this stop working" |
| Installed programs | Full list of installed applications |
| System info | Hardware, OS build, memory, disks, network interfaces |

Facts she learns are **tagged with the machine they were true of**. She runs off the drive, so
the same store follows her between boxes — a fact about the Ryzen desktop does not surface as
truth on the Athlon laptop.

> say: *save a baseline now while everything works*

---

## 6. Security posture

- **Boot triage** — firewall state, antivirus state, disk headroom, exposed SSH, pending
  updates. Each returns pass, warn or critical.
- **Threat assessment** — 0–100 risk score from open ports, missing firewall or AV,
  world-writable directories, SUID binaries on Unix.
- **Network scan** — interfaces, DNS servers, listening ports, routing. Optional real nmap
  sweep against a target if nmap is present.
- **Guided remediation** — for a named issue like "firewall not enabled", returns the exact
  commands, and can apply them on request.

Security state comes from one source of truth. If she genuinely can't determine whether the
firewall is on, she says **unknown** rather than assuming healthy. The failure mode where a
report says "all clear" because a check silently failed is one she's specifically built to avoid.

> say: *run a security check and tell me what's actually exposed*

---

## 7. Reports

Four types, generated as formatted Markdown you can keep or send:

- **system** — hardware and software inventory
- **security** — posture and risk
- **network** — topology and exposure
- **full** — all three

She also keeps an audit log of every action taken, replayable by date — ask what she did on
Tuesday and get an accurate answer.

> say: *generate a full report and save it to my desktop*

---

## 8. The web

Searches through Brave and fetches individual pages directly, so she can look up an error
message, check current documentation, or pull a spec mid-task rather than guessing from memory.

> say: *look up what event ID 27 kernel-boot actually means and check it against my logs*

---

## 9. Parallel work

For anything that splits cleanly, she launches background agents running at the same time as
the main conversation — each with its own task, tool access, and task list.

- **Shared workspace** — agents post results to a common store the others read, so they build
  on each other instead of duplicating work.
- **Versioned broadcast log** — a skill saved mid-run is picked up at the next turn boundary
  rather than interrupting.
- **List and monitor** at any point; each reports status when it finishes.

> say: */spawn scanner check every drive for large files while we keep working*

---

## 10. Autonomous tasks

Task mode makes her define the job before starting: restate the objective, write explicit
done-criteria, name inputs and outputs. Then she builds a step list, works through it, and
checks each step against those criteria.

- **Produces a handoff** — what was done, current state, what's left.
- **A step failing twice stops her and triggers a re-plan** instead of hammering the same call.
- **Loop detection** — three identical calls in a row forces self-diagnosis: what failed,
  which pattern applies, what's the smallest different thing to try.
- **Interruptible** — stop her mid-task and she summarises what got done and what remained.

> say: */task clean up every duplicate file on D:\ and give me a report*

---

## 11. Memory

| Store | Holds |
|---|---|
| About you | Durable facts, preferences, how you work |
| Her own notes | Working context she wants to keep |
| Instincts | Small learned behaviours applied automatically without being told again |
| Dead ends | Approaches that failed repeatedly, so she doesn't re-walk them |
| Sessions | Summarised past conversations, searchable |

**Semantic recall** searches all of it by meaning, not just keywords — ask about something you
discussed weeks ago in different words and she'll find it.

**Memory maintains itself.** Duplicates merge, genuinely contradictory instincts are resolved,
and anything low-confidence that keeps not being used decays out. Where two stored facts
conflict and neither is clearly right, she **flags the conflict rather than silently picking
one** — a wrong answer delivered confidently is worse than an admitted gap.

**Long conversations compress themselves.** When context fills, she summarises the middle and
keeps going rather than losing the thread or erroring out.

> say: *remember that i work four on four off, so scheduling matters*

---

## 12. Skills

Anything she works out how to do can be saved as a reusable skill and loaded later. She can
also write them herself: after a task involving four or more real tool calls, she looks at the
trace and, if there's a repeatable pattern, drafts a skill from it automatically.

- Auto-drafted skills stay marked unverified until you approve one.
- Skills are versioned — roll back to any prior version if an edit made it worse.
- She tracks which skills actually succeed and which keep failing.

---

## 13. Background monitoring

A watcher runs continuously across nine conditions — disk headroom, memory pressure, service
state, network reachability and others. When something trips, the alert is queued and delivered
at the next natural break in conversation rather than cutting into a reply mid-sentence.

---

## 14. How you talk to her

Two front ends over the same brain. The browser UI runs on a random loopback port that opens
itself, streams responses live, and shows tools running as they run. The CLI is the same thing
in a terminal.

| Command | Does |
|---|---|
| `/task <goal>` | Autonomous task mode with done-criteria and handoff |
| `/spawn <name> <goal>` | Launch a background agent |
| `/agents` | List running agents and their status |
| `/model [name]` | Show or switch model, including local ones |
| `/mem` | Inspect memory usage and contents |
| `/forget` | Clear conversation, keep long-term memory |
| `/clear` | Reset context |
| `/help` | Command list |

The browser UI additionally shows live memory contents, saved skills, past sessions, the agent
broadcast log, and the machine fingerprint — each on its own view. Responses stream token by
token, tools appear as they execute, and the task list updates in place.

---

## 15. She keeps working without the internet

The part most assistants don't have. Three levels of intelligence that degrade instead of dying.

```
   L4 Cloud            L3 Local model         L2 Control engine
   ---------           --------------         -----------------
   Claude.             Runs on your GPU.      Measures and repairs
   50 tools, agents,   Talks, reasons,        with no model at all.
   skills.             calls 8 tools.
        |                     |                       |
        +--credits gone------>+--no net / no GPU----->+- this floor never
                                                          disappears
```

| Tier | When | What she can still do |
|---|---|---|
| **L4** Cloud | Default | Everything — full tool surface, agents, skills, crystallisation. Fails over between models automatically when one is rate-limited |
| **L3** Local model | Credits gone, or no network | Qwen 2.5 3B loads on demand. Starts in ~3s, answers in under 2s. Holds a conversation, runs shell commands, reads and writes files, applies repairs |
| **L2** Control engine | Always | All twelve diagnostics and the repair library, on raw code. No API key, no internet, no model weights |

**The rule that binds them:** whatever L2 measures is fact. A model above it can explain the
findings, prioritise them and recommend a repair — but cannot overrule a measurement. That's
why she doesn't tell you the Wi-Fi is broken when the data says 144 Mbps at zero packet loss.

This is what makes a network fault something she can *fix* rather than something that
*disables* her.

**She repairs her own connection first.** When the cloud model can't be reached, before
falling back to anything she measures where the link is broken and fixes the layer that
failed, then retries the same request:

| Measured | Fix applied automatically |
|---|---|
| No adapter has an address | Restart the adapter (Windows) / NetworkManager (Linux) |
| Only a 169.254.x.x address | DHCP release and renew |
| Internet reachable, API name won't resolve | Flush the DNS cache |
| Address fine, nothing reachable | **Nothing** -- recommends the winsock reset, which needs a reboot and your approval |
| Internet fine, provider not answering | Nothing to fix locally; she says so |

Each fix runs through the fix library's detect -> apply -> verify contract, so it builds a
track record on this machine. Set `NET_TRIAGE=off` in `config/.env` to only report.

**A silent provider can't freeze her.** If a model accepts a request and then goes quiet,
she abandons it after `API_STALL_MS` (default 2 minutes, 5x for local models), tries one
more model, and then tells you the provider stalled -- instead of hanging the turn.

---

## 16. Machine control

Through the Windows bridge she also drives the machine directly:

- Launch and close applications, switch windows, list what's running
- Read text off the screen, take screenshots
- Control media playback and volume
- Open URLs, lock the machine, shut down or restart with a cancel window
- Start long-running work — installs, builds, downloads — as a background job with no timeout,
  and poll it for live output while doing something else

> say: *start the build in the background and tell me when it finishes*

---

## 17. Your real Chrome

A small extension (`extension/`, load unpacked in Chrome) lets her act inside your actual,
signed-in Chrome -- not a separate automation browser. She works in her own tab and never
touches the tab you're looking at unless you hand her one.

| Tool | Does |
|---|---|
| `browser_navigate` | Opens a URL in her working tab (or a tab you name) |
| `browser_click` / `browser_type` | Clicks an element by selector or visible text; types into a field |
| `browser_read_text` | Reads the visible text of a page |
| `browser_screenshot` | Captures a tab |
| `browser_list_tabs` / `browser_status` | Lists open tabs; reports whether the extension is connected |

Clicks that move money -- place order, buy now, book now, checkout -- always stop for your
approval, even with auto-approve on.

> say: *open the weather for Edmonton and tell me if it'll rain tomorrow*

---

## 18. Gmail and Calendar

Connected through your own Google account (one-time setup with `google_oauth_setup.mjs`).

| Tool | Does |
|---|---|
| `email_list` / `email_read` | Lists and reads mail, with Gmail search syntax (`is:unread`, `from:...`) |
| `email_draft` | Writes a draft or a threaded reply -- **never sends**; Google never granted her send permission |
| `calendar_list` | Upcoming events, any of your calendars |
| `calendar_create_event` / `calendar_update_event` | Adds or changes events |

Reading and calendar changes run on their own; nothing leaves your outbox without you
pressing send. The Google sign-in expires every 7 days -- re-run the setup script to renew it.

> say: *anything unread from today that needs a reply? draft the replies*

---

## Self-check

`node selfcheck.mjs` from the Athena root runs 14 checks across module parsing, intent
routing, the approval gates, tool registration, machine identity, memory scoping, the repair
contract, and a clean boot. All 14 should pass.

---

*Athena · runs from the drive · L2 control engine, L3 local weights, L4 cloud ·
36 tools, 12 diagnostics, 22 repairs*
