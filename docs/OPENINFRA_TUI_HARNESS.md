# OpenInfra TUI: the MVP, and which harness to build it on

_2026-10-22. Companion to [OPENINFRA_PLAN.md](OPENINFRA_PLAN.md) and [OPENINFRA_CLI_FIRST.md](OPENINFRA_CLI_FIRST.md).
This document answers two questions: **is the TUI the MVP?** and **what do we start from?**_

---

## 1. Is the TUI the MVP?

**The TUI is the MVP's face. It is not the MVP.**

| Layer | In v0.1? | Why |
|---|---|---|
| Engine + adapters (read-only) | **MVP** | without it there is no product |
| CLI verbs + exit codes (`doctor`, `drift check`) | **MVP** | the proof that works in CI and with no API key |
| TUI shell: chat + 3 screens | **MVP** | the proof that an engineer will use it daily |
| Desktop app | not in v0.1 | a skin; phase 5 |
| Writes / change execution | **MVP, gated** (phase 3) | the reason people trust it |

If the TUI alone were the MVP, we would ship a beautiful terminal that proves nothing in a pipeline and cannot be
adopted by a team. If the CLI alone were the MVP, nobody would sit in it for an hour. Both, in this order: engine →
CLI → TUI shell → desktop. **Definition of MVP done:** a lab of 200 devices where `oi doctor` runs in under 15 s
with no key, `oi drift check` returns a stable exit code in CI, and one real change can be triaged, approved and
watched entirely from the TUI.

---

## 2. What "robust harness" has to mean here (testable, not adjectives)

Every requirement below becomes an acceptance test in CI. This list is the specification the base must satisfy;
it is also how the candidates in §3 were scored.

| # | Layer | Requirement | Acceptance test |
|---|---|---|---|
| L1 | **Loop** | turns and steps with explicit budgets; parallel tool calls capped; cancellation ends the whole process group; retries with backoff; no silent infinite loops | a scripted 100-step task stops at budget with a summary; Ctrl-C mid-tool leaves no orphan `ssh`; a provider 429 retries then fails visibly |
| L2 | **Context assembly** | prompt sections composed per mode (explore/plan/execute/incident); tool schemas injected once; token meter; every injected fact has a source | a 200-device read stays under the token budget; `oi ask --show-context` prints exactly what was sent |
| L3 | **Compaction / pruning** | summarise under pressure; prune stale tool output; **never** drop the plan hash, approvals, evidence links or "unreadable" facts; replay the last user message after compaction | after forced compaction: `oi change show` still resolves its hash and artifacts; a test asserts protected facts survive; context never exceeds the window |
| L4 | **Memory** | four tiers: session log (durable), project facts (git), knowledge pack (tool versions), operational history (findings/runs) | new session cites the knowledge-pack pin and the last run of the same template; `oi kb show netmiko` matches the pack |
| L5 | **Tools** | typed schemas, tiers (read/plan/execute), timeouts, output caps with artifact offload, redaction, structured results | a write tool without an approval token is refused before execution; a 50 MB output becomes a blob + stub; secrets never appear in a result |
| L6 | **Skills** | `SKILL.md` (agentskills.io) portable format, progressive disclosure, project + global scopes | `oi skills list` shows 6 infra skills with < 100 tokens each in the catalog; a skill loads on demand; a skill from the standard works unchanged |
| L7 | **Subagents** | isolated context, curated tools, parallel fan-out with budget caps and merged evidence | 200 devices read through 8 readers, merged, every fact still has a source |
| L8 | **Approvals** | hash-bound, TTY-only, SSH-signed, non-TTY refuses with a distinct exit code | a forged approval fails verification; hash mismatch exits 7; piped stdin cannot approve |
| L9 | **Durability** | append-only log; resume after crash; idempotent re-run | `kill -9` mid-run then `oi run show` reports exact per-target state; re-running an applied change is a no-op |
| L10 | **Security of the surface** | control characters escaped in *all* engine text; no prompt injection reaching the screen as terminal commands; secret-deny paths; network allowlist | a fixture with `\e]52;c;…` in device output renders as visible escapes and never sets the clipboard |
| L11 | **Testability** | model record/replay ("cassettes"), fixture devices, PTY golden screens | the full TUI test suite runs in CI with no API key and no network |
| L12 | **Packaging** | one binary, no runtime surprises, Node-only (no experimental FFI), works over SSH/tmux at 80 columns | `brew install` on a clean box; `oi --version` in 120 ms; TUI usable in `tmux` over SSH |

**The one-line test for "robust":** *kill it anywhere, and the next command still tells the truth.*

---

## 3. Bases we could start from (checked 2026-10-22)

### 3.1 The shortlist

| Base | Language / licence | Loop | Context & compaction | Tools / memory / skills | TUI | Fit for us |
|---|---|---|---|---|---|---|
| **This repo's fork: DeepSeek Harness (`dsh`) + its Ink terminal chat** | TS / MIT | `agent-loop` plugin, parallel tool cap, retry, cancellation; **replaceable loop** | append-only session log as source of truth; compaction-basic with pruning + summarisation (surface `replace` op) | tool registry with guards, sandbox (Seatbelt/bwrap), hooks (Claude-Code format), MCP client, skills registry, subagents, watches | Ink 5.2.1 chat already shipping (streaming, tool lines, approval box, escaping, fallback) | **highest**: infra plugins already written against it; every safety feature we need exists |
| **Pi** (`@earendil-works/pi-ai`, `-agent-core`, `-tui`, `-coding-agent`) | TS / MIT | clean, small, event-driven; steering/follow-ups; SDK + RPC + JSON modes | session tree (JSONL/SQLite), compaction, prefix-cache aware | 4 core tools + typed extensions; skills; MCP since 1.0 (Codemode); **no sandbox/permissions by design** | `pi-tui`: differential rendering, main- and alternate-screen, CSI 2026 sync, bracketed paste; Bun-compiled binaries | **strong library base** if we outgrow Harness's TUI; we would rebuild sandbox/approvals (we are rebuilding those anyway) |
| **OpenCode** | TS (Solid on OpenTUI) / MIT | mature; primary + subagents (build/plan), LSP in loop | token meter, auto-compact at ~96–99%, **prune** beyond a 40k protected zone, replay last user message | plugins with hooks (tools, **compaction context**, chat params), MCP, skills, SDK/`run` headless | OpenTUI (Zig core over FFI) — beautiful, but needs Bun ≥1.3 or Node ≥26.4 with `--experimental-ffi` | **best "adopt a host" option**; worst fit for owning the shell and staying Node-only |
| **Crush** | Go / FSL-1.1 (→MIT after 2y) | solid | sessions in SQLite, summarisation | LSP, MCP, Agent Skills, permissions modes | Bubble Tea — the best-looking TUI in the field | language + licence friction; would be a rewrite of our engine |
| **Gemini CLI** | TS / Apache-2.0 | solid; subagents with isolated windows | GEMINI.md hierarchy, checkpointing (shadow git), `/compress` | extensions, skills, hooks | Ink | direction is uncertain (consumer tier retired June 2026 in favour of a closed-source successor) |
| **Codex CLI** | Rust / Apache-2.0 | very solid; strongest sandbox | compaction, resume | MCP, skills | Rust | Rust rewrite; OpenAI-centric |

### 3.2 Scorecard (weighted for *this* product)

Scores 1–5, weights in brackets. "Own it" = how much of the surface we control.

| Criterion (weight) | This fork | Pi | OpenCode | Crush | Gemini CLI | Codex |
|---|---|---|---|---|---|---|
| Existing infra fit — sandbox, hooks, plugin API, our plugins (25%) | **5** | 2 | 3 | 3 | 3 | 2 |
| Agent loop robustness & extensibility (20%) | **5** | 4 | 5 | 4 | 4 | 5 |
| Context management / compaction quality (15%) | 4 | 4 | **5** | 3 | 4 | 4 |
| TUI we can own and shape (15%) | 3 | **5** | 2 | 4 | 3 | 2 |
| Language & licence cleanliness (10%) | **5** | **5** | **5** | 2 | 3 | 4 |
| Packaging simplicity, Node-only (10%) | 3 | 4 | 2 | **5** | 4 | **5** |
| Skills / MCP / subagents today (5%) | 4 | 4 | **5** | 4 | 4 | 4 |
| **Weighted total** | **4.30** | **3.95** | **3.55** | **3.35** | **3.45** | **3.25** |

### 3.3 Verdict

**Build on this repo's fork. Keep Pi's TUI library as the funded alternative, and steal three things.**

1. **Brain = Harness (this fork).** Nothing else gives us, today: an OS sandbox with read-only holds and network
   allowlists, Claude-Code-compatible hooks and permission rules, an append-only session log that is the single
   source of truth for what the model saw, replaceable loop, MCP client, skills, subagents, watches, and a
   terminal chat that is already shipping and PTY-checked. That is ~80% of the harness we specified in §2, and
   our infra plugins are written against it.
2. **Screen = decide by spike, not by taste** (§4.2). Harness's terminal chat is Ink; Ink has no alternate-screen
   or differential rendering, and two of our three screens want a viewport. Pi's `pi-tui` is MIT, Node-friendly,
   and has exactly those two features. We do a 3-day spike and measure.
3. **Steal, don't fork:** OpenCode's prune rule (protect the last ~40k tokens of tool output, prune beyond it) and
   its practice of replaying the last user message after compaction; Gemini CLI's checkpoint-in-a-shadow-repo
   idea (we need it for intent edits before approval); Pi's four-mode shape (interactive / print-JSON / RPC / SDK),
   because that is exactly the CLI ↔ TUI ↔ desktop split we designed.

**Explicitly rejected as the base:** OpenCode (owning a Solid/OpenTUI shell plus a Bun-FFI distribution
requirement is the opposite of "one Node binary"; adopting it as a host means shipping OpenInfra as plugins we do
not control), Crush (Go + FSL), Gemini CLI (product direction), Codex (Rust).

---

## 4. The stack we build

```
┌────────────────────────────── openinfra (single Node binary) ──────────────────────────────┐
│  CLI verbs        TUI shell (chat + 3 screens)        RPC/JSON (later: desktop, CI, MCP)   │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│  Harness runtime (fork, pinned): agent loop · tools · session log · compaction · sandbox    │
│                                  hooks · skills · subagents · MCP · watches                │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│  OpenInfra plugins (this repo): inventory · adapters · drift · change · knowledge · guard   │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│  EEs (containers): network · iaac · k8s · cloud        Artifacts (content-addressed blobs)  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rules: **one runtime** (Node ≥ 22, no Bun, no experimental FFI), **one state home** (`~/.openinfra`), **one
protocol** (ndjson events; every TUI action has a CLI form), **one binary**.

### 4.1 Things to verify in the first day (they change the plan)

| Check | Why | If it fails |
|---|---|---|
| Does the fork's `@deepseek-ai/dsh-terminal-chat` export its components (stream view, approval box, input, keys)? | we want to *import* the chat, not fork it | add exports on the fork (small commit) |
| Does Ink 5.2.1 redraw a full-viewport list smoothly at 80×24 with streaming in the bottom area? | decides L6/TUI | alternate screen via `pi-tui` only for dashboards |
| Can the engine run headless with no Electron (plain `node`)? | standalone binary | extraction work moves into phase 0 |
| Are `node:sqlite` and the sandbox helpers usable from a bundled binary? | packaging | ship Node + `node_modules` tarball instead of SEA |

### 4.2 Spike S1 — the renderer (3 days, time-boxed)

Build the same screen twice (drift list with a detail pane, live run matrix):

- **A: Ink only, inline.** Rows printed to scrollback, live area at the bottom, detail via `$PAGER`, `r` re-renders
  with a status line.
- **B: `pi-tui` viewport.** Alternate screen, differential rendering, CSI 2026 sync, own scrolling.

Measure: frames per second while a model streams, keystroke latency, redraw artifacts under `tmux` + SSH, resize,
80×24 usability, bundle size, and how hard the PTY golden test is. **Decision rule:** if A is comfortable, stay
Ink-only (one renderer, fewer dependencies); if A flickers or the list is unusable at 80×24, adopt `pi-tui` for the
two dashboard screens and keep Ink for chat. Record the numbers in this document either way.

### 4.3 What we borrow, concretely

| From | Idea | Where it lands |
|---|---|---|
| OpenCode | prune tool output beyond a protected window; replay the last user message after compaction; compaction hook receives domain context | `openinfra-core` compaction policy + a `session.compacting` hook that protects evidence refs and the plan hash |
| Pi | print/JSON/RPC/SDK mode ladder; differential rendering; deferred tool loading | `oi --json`, `oi rpc` (later), TUI renderer if S1 says so |
| Gemini CLI | checkpoint in a shadow git repo, `/restore` | intent edits before approval; `oi change restore` |
| Codex CLI | approval modes as a first-class axis | our four modes (explore/plan/execute/incident) |
| DeepSeek Harness (already ours) | session log as the only truth; "model-visible means logged" | evidence for every claim; replay-based tests |

---

## 5. Gap list: what we must build on top of the fork

| # | Gap | Work | Lands in |
|---|---|---|---|
| G1 | Loop budgets per mode, incident time-box | plugin subscribing to `agent/pre-step`; refuses past budget with a summary | `openinfra-core` |
| G2 | Evidence pinning + redaction of tool results | post-execute transform: redact, truncate, offload to artifact, keep `source·query·ts` | `openinfra-core` |
| G3 | Compaction policy for infra facts | protect hash/approvals/evidence/"unreadable"; prune stale device output | `openinfra-drift` + core |
| G4 | Knowledge pack + staleness watch | pack registry, `oi kb`, watches on release feeds | `openinfra-knowledge` |
| G5 | Tool tiers enforced host-side | registry wrapper: `read` always allowed in explore; `execute` only with a valid approval token | `openinfra-guard` |
| G6 | Skills in the standard format | 6 skills: `inventory-triage`, `config-drift`, `change-author`, `netconf-read`, `k8s-readonly-audit`, `incident-timeline` | `openinfra-core/skills` |
| G7 | Subagent fan-out for device reads | cap concurrency, merge results, per-reader budget, evidence preserved | `openinfra-network` |
| G8 | Hash-bound, SSH-signed approvals | approval record + `ssh-keygen -Y sign/verify`; non-TTY = exit 4 | `openinfra-change` |
| G9 | Crash-safe run records | write-ahead run file; reconcile on start | `openinfra-change` |
| G10 | TUI screens | drift triage, change review, run live (+ chat) | fork TUI package / `openinfra-tui` |
| G11 | Cassettes + fixture devices | record model streams; simulated SSH/NETCONF device server with golden configs | `test/` |
| G12 | Packaging | bundled binary, brew tap, Docker image, `oi completion` | `scripts/` |

---

## 6. MVP cut (what ships in v0.1)

**In:** `oi init`, `oi doctor`, `oi inv list/show`, `oi drift check/list/show`, `oi ask` (read tier), `oi change
new/check/approve/run/verify` for network devices via Ansible + our read adapters, `oi kb`, `oi tui` with the three
screens and chat, knowledge pack for the 12 tools in the plan, cassettes + 5 PTY tests, one binary.

**Out (v0.2+):** cloud writes, NetBox writes, k8s writes (ever?), gNMI, multi-user team mode, desktop app, MCP
server mode, topology diagrams, Windows.

**Non-negotiables even in v0.1:** exit-code contract, evidence on every claim, protected facts through compaction,
no `--yes`, escaping everywhere, and a test that proves each of those.

---

## 7. Build order (4 weeks to a usable TUI)

| Week | Focus | Done when |
|---|---|---|
| 0 (3 days) | §4.1 checks + spike S1 | renderer decision recorded with numbers |
| 1 | G1 G2 G5 + `oi doctor` wired to the engine; cassettes | `oi doctor` in CI with a recorded model, no key |
| 2 | G3 G6 G7 + `oi ask` and `oi drift check`; device simulator | 200-device fixture lab, drift exit codes |
| 3 | G10 (drift + finding detail + chat) | triage 20 findings in the TUI; `x` explain shows evidence |
| 4 | G4 G8 G9 G10 (change review + approve + run live) | approve and watch a change end-to-end in the TUI; PTY tests green |

---

## 8. Decisions

1. **Renderer:** spike first (recommended), or go straight to `pi-tui` for the dashboard screens?
2. **Where do the TUI screens live:** on the fork (beside the chat package) or in this repo consuming the chat
   package's exports? (Recommendation: this repo, with one small fork commit adding exports — keeps domain screens
   with the domain.)
3. **Skills:** adopt the `SKILL.md` standard as our only skill format (recommended, for portability and because
   every other agent reads it), or keep the runtime registry and emit `SKILL.md` for export?
4. **Subagents for device fan-out:** Harness sessions-as-subagents (existing) or a lighter in-process pool inside
   `openinfra-network`? (Recommendation: in-process pool for reads; sessions only for genuinely separate work.)
5. **Cassette policy:** record model streams in CI with a fake provider, or ship a `--fake-model` adapter? (I
   recommend both: fake adapter for unit tests, cassettes for TUI golden tests.)
