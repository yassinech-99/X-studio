# OpenInfra workspaces and toolchain

_2026-10-22. Companion to [TUI.md](TUI.md) (the build plan), [OPENINFRA_CLI_FIRST.md](OPENINFRA_CLI_FIRST.md)
(CLI contract) and [OPENINFRA_PLAN.md](OPENINFRA_PLAN.md) (product). Two features, grilled: **the TUI installs and
sets up the automation tools** (Ansible, OpenTofu/Terraform, kubectl, Helm, uv, cosign, linters…), and **workspaces**
— named, git-tracked folders that hold one infrastructure project each._

---

## 0. The two promises, stated precisely

**Toolchain promise.** `oi` detects what a workspace needs, shows exactly what is missing and what it would
download, installs **only after a human says so**, verifies every byte against a publisher signature or a pinned
digest, keeps tools **out of your PATH and out of your system**, wires the tool's *configuration* into the
workspace (not your dotfiles), and records the exact versions in a committed lockfile so a plan approved yesterday
cannot silently run under a different Ansible today.

**Workspace promise.** One command gives you a named folder that is a git repository, with an OpenInfra
identity (`id`), a config, an inventory, a lockfile, a change history and a skills override — findable from any
subfolder, movable, renamable, shareable with a teammate as a small export, and safe to run two of at once.

**What we refuse, up front:** `sudo`, system package managers, `curl | sh`, silent installs, a model that can
install anything, tools on `PATH` globally, and any state in `~/.ansible`, `~/.terraform.d`, or your shell rc files.

---

## 1. Grilling: is installing tools even the right move?

| Option | Argument for | Argument against | Verdict |
|---|---|---|---|
| **Do nothing; require the user to install everything** | zero supply chain, zero support burden | the ten-minute promise dies at step one; version skew is then invisible and unbounded; "which ansible is this?" becomes our bug report | rejected as the only path |
| **Ship everything in our binary** | reproducible | licence minefield (Terraform BSL, Ansible GPL, providers), platform matrix, 500 MB+ binary, security patching on our release cadence | rejected |
| **Containers only (execution environments)** | best reproducibility, clean isolation, one mechanism | requires a container runtime; many engineers have none on a laptop; device SSH with the user's agent/keys is painful from inside a container; ~2 s startup per run | **keep as the preferred provider**, not the only one |
| **Delegate entirely to mise / asdf / aqua** | mature, lockfiles, verification (aqua verifies checksums, cosign, SLSA, attestations) | another tool with its own format and breaking releases; its lockfile is not our lockfile; it cannot express "this container image digest" or "this Ansible collection set"; still needs a story for projects that don't use it | **support importing** `mise.toml`/`.tool-versions`, do not depend on it |
| **Managed toolchain directory, pinned + verified, per version** (this plan) | no root, no system pollution, works on a bare laptop, exact versions per workspace, digests go into the plan hash | we own the recipes and their rot; we must get verification right | **the core mechanism** |

**Conclusion.** Three providers behind one interface — `container`, `managed`, `system` — with `managed` as the
default on a laptop and `container` as the default on CI or where the runtime exists. A workspace records which
provider satisfied each tool, and the choice is visible in the UI. Delegation to mise/asdf is an import path, not a
dependency.

---

## 2. Tool providers

| Provider | Where the tool lives | Chosen when | Guarantees |
|---|---|---|---|
| `container` | OCI image by **digest** (`ee-network`, `ee-iaac`, `ee-k8s`, `ee-cloud`) | runtime available (podman/docker), or `tools.provider = "container"` | byte-exact environment; image digest enters the plan hash |
| `managed` | `~/.openinfra/toolchains/<tool>/<version>/` | default on a workstation | version + digest + signature recorded in the workspace lock |
| `system` | whatever is on `PATH` | tool already present inside the supported range, and the user says "use mine" | version recorded; **never modified**; warned when unsupported |
| `imported` | a `mise.toml` / `.tool-versions` the project already has | file present and user accepts | we shell out to that manager and record what it resolved |

Rules that apply to all four:

- **Detection is free and always on** (`oi doctor`, `oi tools doctor`, the TUI Setup screen).
- **Installation is a human action.** The agent may produce a *recommendation* ("this workspace needs
  ansible-core 2.21 and tofu 1.13; run `oi tools install`"), never an install. `oi tools install` is denied to the
  agent's shell by the guard rules, exactly like `ansible-playbook`.
- **No `sudo`, no `apt`, no `brew install`.** If a tool cannot be satisfied without root, we say so and stop.
- **Nothing global.** No writes to `~/.bashrc`, `~/.zshrc`, `~/.ansible.cfg`, `/usr/local/bin`, or the user's
  `~/.terraform.d`. The engine passes absolute paths and a scoped environment to child processes.
- **User's own install wins in their shell.** Our bin directory is appended (not prepended) for user-facing shells,
  and prepended only inside engine-spawned children — the same bargain `plugins/compact/ffmpeg.js` already makes.

---

## 3. What "set up" means (install is the easy half)

For each tool the workspace records an **invocation** (how we run it) and a **configuration** (files we manage),
both inside the workspace:

| Tool | Invocation | Configuration we write | We deliberately do not touch |
|---|---|---|---|
| **uv** (bootstrap for Python tools) | `<toolchains>/uv/<v>/uv` | `UV_CACHE_DIR` under the workspace, `UV_PYTHON_INSTALL_DIR` in the toolchain | user's uv config, global cache |
| **ansible-core** (+ collections) | `uv tool run --from ansible-core==X ansible-playbook` (isolated env per version) or a materialised venv under `<toolchains>/ansible/<v>/` | `.openinfra/ansible/ansible.cfg` (inventory = engine export, `collections_paths` = workspace, `host_key_checking=True`, `stdout_callback`, `forks`), `ansible/requirements.yml`, `.openinfra/ansible/inventory.json` | `~/.ansible.cfg`, `~/.ansible/collections`, user inventory files |
| **ansible-lint / yamllint** | pinned with ansible | `.ansible-lint` (profile: production) and `.yamllint` if absent | — |
| **OpenTofu** (default) | `<toolchains>/tofu/<v>/tofu` | `.openinfra/tofu/rc` via `TF_CLI_CONFIG_FILE` (plugin cache in the workspace, no telemetry), `TF_DATA_DIR` per workspace | `~/.terraformrc`, `~/.terraform.d` |
| **Terraform** (opt-in, BSL) | `<toolchains>/terraform/<v>/terraform` | same shape | same |
| **kubectl / helm** | `<toolchains>/kubectl/<v>`, `<toolchains>/helm/<v>` | `KUBECONFIG` = a **read-only** kubeconfig reference (never copied into the repo) | `~/.kube/config` |
| **cosign / gh** | toolchain | — | user's auth |
| **delta / difftastic** (diff delegation) | toolchain, optional | `ui.diff_tool` | user's git config |
| **jq, yq** | toolchain, optional | — | — |

"Set up" also means **smoke-testing**: after install, `ansible --version`, `tofu version`,
`ansible localhost -m ping -c local`, `kubectl version --client`, and a linter on an empty playbook. A tool that
installs but does not run is not installed; the lockfile records the smoke result and its timestamp.

---

## 4. Recipes, verification, and the trust anchor

### 4.1 A recipe (`toolchain/recipes/tofu.yaml` in the app)

```yaml
tool: tofu
version: "1.13.0"
licence: MPL-2.0
homepage: https://opentofu.org
platforms:
  darwin-arm64: { asset: "tofu_{v}_darwin_arm64.zip", sha256: "2f1c…" }
  darwin-x64:   { asset: "tofu_{v}_darwin_amd64.zip", sha256: "9ab3…" }
  linux-x64:    { asset: "tofu_{v}_linux_amd64.zip",  sha256: "c7d1…" }
  linux-arm64:  { asset: "tofu_{v}_linux_arm64.zip",  sha256: "4e02…" }
source:
  kind: github-release
  repo: opentofu/opentofu
  tag: "v{v}"
  checksums: "tofu_{v}_SHA256SUMS"
verify:
  - kind: sha256-pinned           # the digests above, shipped in the app
  - kind: gpg-checksums
    key: https://get.opentofu.org/opentofu.gpg
    fingerprint: E3E6E43D84CB852EADB0051D0C0AF313E5FD9F80
  - kind: cosign-keyless          # when cosign is available
    identity: "https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v{major_minor}"
    issuer: https://token.actions.githubusercontent.com
smoke: ["tofu version"]
install: extract-to-toolchain     # zip/tar → <toolchains>/tofu/<version>/
```

Terraform's recipe is the same shape with `source: hashicorp-release`, `verify: gpg-checksums` against the
HashiCorp release key fingerprint `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`, and
`requires_acknowledgement: "BSL-1.1 licence — read before downloading"`.

Python tools use a different recipe kind (`kind: python-tool`) that resolves through uv:

```yaml
tool: ansible-core
version: "2.21.5"
licence: GPL-3.0-or-later
kind: python-tool
python: "3.12"
package: "ansible-core==2.21.5"
entrypoints: [ansible, ansible-playbook, ansible-galaxy, ansible-doc, ansible-inventory]
verify: [{ kind: pypi-hash, package: ansible-core, version: "2.21.5" }]
smoke: ["ansible --version", "ansible localhost -m ping -c local -o"]
notes: >
  The `ansible` community package only exposes `ansible-community`; its executables come from ansible-core.
  With uv use --with-executables-from ansible-core (or pipx --include-deps). We install ansible-core plus the
  collections the workspace lists, not the 9,000-module bundle.
```

### 4.2 Verification ladder

Highest available wins, all applicable ones run, any failure aborts and leaves nothing installed:

| Level | Mechanism | Applies to |
|---|---|---|
| 1 | **Pinned sha256 in the recipe** (shipped with the app, reviewed at release) | every tool |
| 2 | **Publisher checksum file + its signature** — GPG (Terraform, OpenTofu, Helm `.prov`) or cosign keyless (OpenTofu, kubectl, cosign itself) with **identity and issuer pinned**, not "any valid signature" | tofu, terraform, helm, kubectl, cosign |
| 3 | **GitHub artifact attestation** (`gh attestation verify`, when `gh` is present) | binaries published with attestations |
| 4 | **PyPI hash** from the package metadata (uv enforces `--require-hashes` style locking) | python tools |

The trust anchor is level 1: the digests live in the app, refreshed by a signed recipe update, so a compromised
release host cannot silently substitute a binary. Level 2 proves *who published it*; level 1 proves *it is the
build we reviewed*. Both are reported in the install preview, and both are written into the lockfile.

**Never:** `curl | sh`, `--insecure`, `--skip-verify`, or ignoring a signature failure. There is no flag to skip
verification; a mirror that does not match the pinned digest fails, by design (see §9 air-gap).

---

## 5. Install mechanics

```
~/.openinfra/
  toolchains/
    uv/0.9.2/{uv}
    ansible/2.21.5/{venv/…, bin/ansible-playbook}
    tofu/1.13.0/{tofu}
    kubectl/1.35.9/{kubectl}
    <tool>/<version>/.openinfra-install.json      # recipe hash, digests, verification results, smoke, at
    <tool>/<version>/.ready                       # renamed into place only after smoke passes
  bin/                                            # shims, appended to PATH for user-facing shells only
  cache/downloads/<sha256>                        # content-addressed download cache (resumable, GC'd)
```

Steps for one tool (mirrors the ffmpeg precedent, made strict):

1. Resolve recipe for `(tool, version, platform)` → asset URL(s), size, digest, verification plan.
2. **Preview** (TUI card or CLI table): tool, version, licence, URL host, size, verification methods, destination,
   smoke checks, and what it will add to the workspace lock.
3. Human confirms. Confirmation text names the version and the host (`Install tofu 1.13.0 from github.com?`).
4. Download to `cache/downloads/<sha256>.part` inside a temp dir, through the sandbox with network allowed only to
   the recipe's hosts; resumable; size-capped.
5. Verify (sha256 → signature/attestation → PyPI hash). Any mismatch: delete, report the exact expected/actual,
   write nothing.
6. Unpack into a temp dir under the toolchain; run the smoke commands with a **minimal environment**.
7. `rename()` into `<tool>/<version>`, write `.openinfra-install.json`, touch `.ready`.
8. Update the workspace lock (`openinfra.lock`), print the diff (`+ tofu 1.13.0 sha256:…`), and offer to commit it.

Interruption is safe at every step: a `.part`, an unreferenced temp dir, or a directory without `.ready` is
garbage-collected on the next run. Concurrent installs of the same tool use a file lock
(`~/.openinfra/toolchains/.locks/<tool>.lock`).

---

## 6. The workspace lockfile (`openinfra.lock`)

Committed, human-readable, and **part of the plan hash**:

```toml
version = 1
workspace_id = "ws_01JBA7…"
generated_by = "openinfra 0.1.0 (build 20261022.3)"

[[tool]]
name = "ansible-core"
version = "2.21.5"
provider = "managed"
digest = "sha256:6d1f…"                 # of the installed artifact/venv manifest
python = "3.12.7"
source = "pypi:ansible-core==2.21.5"
verified = ["pypi-hash", "sha256-pinned"]
verified_at = "2026-10-22T08:11:04Z"
smoke = { cmd = "ansible --version", ok = true, at = "2026-10-22T08:11:09Z" }
collections = [
  { name = "cisco.ios", version = "9.2.1", digest = "sha256:ab…" },
  { name = "ansible.netcommon", version = "7.1.0", digest = "sha256:cd…" },
]

[[tool]]
name = "tofu"
version = "1.13.0"
provider = "managed"
digest = "sha256:2f1c…"
source = "github:opentofu/opentofu@v1.13.0"
verified = ["sha256-pinned", "gpg-checksums"]
licence = "MPL-2.0"

[[tool]]
name = "kubectl"
version = "1.35.9"
provider = "system"
digest = "sha256:5b8e…"     # digest of the detected binary, so a swap is visible
notes = "using the binary already on PATH; within the supported range"
```

**Why this is the most important artefact in the feature:** the change engine already hashes adapter versions and
EE digests. The lock adds *runtimes*. Consequence: if Ansible is upgraded under a workspace, every pending approval
becomes invalid (exit 7, "toolchain changed; re-check and re-approve"). That is the difference between an audit
trail and a story.

CLI surface: `oi tools lock [--update] [--verify]`, `oi tools diff` (lock vs installed vs detected),
`oi tools pin <tool>@<version>`, `oi tools use system <tool>`, `oi tools gc --keep 2`.

---

## 7. How tools are invoked

- The engine never relies on an inherited `PATH`. It resolves each tool through the workspace's provider table and
  passes an explicit `env` to every child: `PATH=<toolchain bins>:$PATH`,
  `ANSIBLE_CONFIG=<ws>/.openinfra/ansible/ansible.cfg`, `ANSIBLE_COLLECTIONS_PATH=<ws>/.openinfra/ansible/collections`,
  `TF_CLI_CONFIG_FILE=<ws>/.openinfra/tofu/rc`, `TF_DATA_DIR=<ws>/.openinfra/tofu/data`,
  `KUBECONFIG=<resolved read-only path>` (only for allowed namespaces/contexts), `UV_CACHE_DIR` scoped, `NO_COLOR=1`
  for machine-read output, and `TF_IN_AUTOMATION=1`.
- The agent's shell gets the same environment **when a workspace is active**, so `ansible-lint` in a `bash` tool call
  behaves like the engine's. The environment is printed by `oi doctor --env` so there is no mystery.
- Anything not provided by a provider is "not available", and the tool error says exactly which command fixes it
  (`→ oi tools install ansible-core@2.21.5`), never a generic "command not found".

---

## 8. Workspaces

### 8.1 Model

```toml
# <workspace>/.openinfra/workspace.toml   (committed)
id = "ws_01JBA7X3…"            # stable, generated once; moves and renames keep it
name = "core-network"
created = "2026-10-22T08:02:11Z"
template = "network-core"
openinfra = ">=0.1,<0.2"
owner = "you@example.com"      # informational now; the ACL field in team mode
```

```json
// ~/.openinfra/workspaces.json  (local registry, never committed)
{ "version": 1, "workspaces": [
    { "id": "ws_01JBA7X3…", "name": "core-network", "folder": "/home/you/src/core-network",
      "last_used": "2026-10-22T09:10:41Z", "remote": "git@github.com:org/core-network.git" } ] }
```

Discovery order: `--workspace` flag → `OPENINFRA_WORKSPACE` → `.openinfra/workspace.toml` in the current folder or
any parent (like git) → the folder's registration in the registry → error with a list and a suggestion.

### 8.2 Commands

```
oi workspace new <name> [--folder <path>] [--template network-core|cloud-iac|k8s-ops|lab|empty]
                        [--git init|existing|none] [--remote <url>] [--no-commit] [--private]
oi workspace list [--json] [--all]
oi workspace use <name>            # sets the default for this shell/dir (registry only)
oi workspace show [<name>]         # id, folder, git state, tools, sources, drift summary
oi workspace rename <new-name>     # title only; folder and id unchanged
oi workspace move <path>           # updates the registry; refuses across filesystems mid-run
oi workspace remove <name> [--delete-folder]   # forget vs delete; git history untouched either way
oi workspace export [--out file]   # id/name/config/lock/template only — no findings, no artifacts, no secrets
oi workspace import <file|url>
oi workspace status                # one line per workspace: drift, last run, unreadable targets
```

`oi workspace new` also accepts `--from <git-url>` (clone, then adopt as a workspace) and `--from-mise` (import an
existing toolchain file into the lock).

### 8.3 What `oi workspace new` does, in order

1. Validate the name (`[a-z0-9][a-z0-9-]{1,38}`, unique in the registry), the folder (not inside another workspace
   unless `--nested`, writable, not a network filesystem — see §8.6), and the git state.
2. Create the folder (0700 under `~/.openinfra` only for its own state; the workspace folder keeps the user's umask).
3. `git init` when asked; write `.gitignore`:

   ```gitignore
   .openinfra/cache/
   .openinfra/runs/
   .openinfra/tofu/data/
   .openinfra/ansible/collections/
   .openinfra/artifacts/
   .env
   *.tfstate
   *.tfstate.*
   ```
4. Write `.openinfra/workspace.toml`, `.openinfra/config.toml` (from the template), `openinfra.lock` (empty),
   `AGENTS.md` (workspace conventions the agent reads), `README.md` (what this workspace is, one paragraph).
5. Template files: `network-core` → `inventory/example.yaml`, `ansible/requirements.yml`, `.ansible-lint`, a drift
   schedule, and a `changes/` example; `cloud-iac` → `terraform/` skeleton with a local backend and a
   `policy/deny.rego`; `k8s-ops` → manifests folder + read-only RBAC guidance; `lab` → three fake devices so the
   demo works offline.
6. Skills override folder `.openinfra/skills/` (empty, documented).
7. Initial commit `chore: initialise OpenInfra workspace <name>` (signed if `git config commit.gpgsign` is on;
   never force, never on an existing branch with no explicit consent).
8. Register in `~/.openinfra/workspaces.json`, then print the next three commands:
   `oi doctor` · `oi tools install` · `oi tui`.

### 8.4 Workspace vs change vs worktree

| Concept | Scope | Lifetime |
|---|---|---|
| **Workspace** | one folder, one git repo, one id | years |
| **Change** | a branch `openinfra/<id>-<slug>` inside a workspace, plus `.openinfra/changes/<id>/` | hours to days |
| **Run** | one execution, journalled under `~/.openinfra/runs/<id>/` | permanent record |
| **Worktree** (optional) | a second checkout outside the repo, for a parallel change | removed after merge (reuse the pattern from `plugins/sessions`) |

Two workspaces can run at once; two changes in one workspace can be checked at once but **only one run at a time
per target** (§8.5).

### 8.5 Concurrency and leases

- SQLite WAL, `busy_timeout=5000`; every write in one transaction; schema migrations on open, versioned.
- **Target leases** (`~/.openinfra/locks/target-<hash>.lock`, JSON: pid, host, run id, started, ttl 30 min): a run
  takes the lease for each target before applying and releases after verifying. A second run on the same target
  refuses with exit 3 ("sw-c-01 has been leased by run_01J9… since 09:12") instead of racing. Stale leases (dead
  pid, expired TTL) are reclaimed with a warning.
- One TUI per workspace is the default (`oi tui` warns if another is attached: "another session is open; both may
  read, only one may run"). Reads are concurrent; applies are leased.

### 8.6 Refusals (each has a test)

| Situation | Behaviour |
|---|---|
| Folder inside another workspace | refuse unless `--nested`, and then the inner workspace shadows the outer for that subtree |
| Network filesystem (NFS/SMB/sshfs/FUSE) | refuse: WAL locking over those is unsafe; offer `--journal=delete` with a warning if the user insists (reads only) |
| Case-insensitive name collision (`Core-Network` vs `core-network`) | refuse |
| Folder is a git repo with uncommitted changes and `--git init` | refuse; suggest `--git existing` |
| Path contains a newline or a control character | refuse |
| Symlinked folder | resolve and register the real path; refuse if the target moves later |
| Removing a workspace with an active run | refuse until the run finishes or is stopped |
| `oi workspace remove --delete-folder` | require typing the workspace name; never touch git history |

---

## 9. Air-gap, mirrors, and CI

- **Mirror:** `OPENINFRA_TOOLCHAIN_MIRROR=https://mirror.internal/openinfra` rewrites only the host; digests and
  signatures still have to match the pinned values. A mirror cannot weaken verification.
- **Bundle:** `oi tools bundle --out openinfra-toolchain-<workspace>.tar.zst` (or `docker save` for EEs) collects
  every pinned artefact for every platform in the lock; `oi tools install --from-bundle` works with no network.
  Checksums of the bundle are printed for transport.
- **CI:** `oi tools install --locked --verify-only` (exit 8 on any mismatch), then jobs run with the same explicit
  `PATH`/env the engine uses. `oi tools install --locked` refuses to resolve anything the lock does not name —
  the mise `locked = true` behaviour, for the same reason.
- **Recipe canary (nightly):** every recipe is fetched and verified against a live network; a moved asset or a new
  signature scheme fails the canary before a user hits it. Failures open an issue automatically.

---

## 10. The TUI: two new surfaces

### 10.1 Setup (route 0, automatic)

Shown when there is no workspace, or the active workspace's toolchain is unsatisfied.

```
┌ Setup ───────────────────────────────────────────────────── workspace: core-network ┐
│ Workspace   ws_01JBA7X3 · ~/src/core-network · git main ✓ clean · 12 changes      │
├ Toolchain ─────────────────────────────────────────────────────────────────────────┤
│ ansible-core  2.21.5   pinned      ✓ verified pypi-hash + sha256   smoke ✓         │
│ collections   2         pinned      ✓ cisco.ios 9.2.1 · netcommon 7.1.0            │
│ tofu          1.13.0   pinned      ✓ gpg + sha256                  smoke ✓         │
│ kubectl       1.35.9   detected    ! system, within range (use pinned? i)          │
│ helm          —        missing     → needed by template "k8s-ops"                  │
│ delta         —        missing     · optional (better diffs)                       │
├ Sources ───────────────────────────────────────────────────────────────────────────┤
│ netbox        4.7.3    read-only ✓  214 devices · token ability checked            │
│ kubernetes    prod-eu  view role ✓  secrets denied ✓                               │
│ cloud         aws:1234 read-only ✓  0 write actions in policy                      │
├────────────────────────────────────────────────────────────────────────────────────┤
│ i install (1)  I install all missing  p provider  v verify  l licence  ? why  q quit│
└────────────────────────────────────────────────────────────────────────────────────┘
```

`i` opens the **install preview** — never an immediate download:

```
┌ Install ────────────────────────────────────────────────────────────────────────────┐
│ helm 4.1.2 · Apache-2.0 · from get.helm.sh (12.4 MB)                               │
│   verify  sha256-pinned (in app) → GPG provenance .prov (key 0x…)                  │
│   into    ~/.openinfra/toolchains/helm/4.1.2                                       │
│   smoke   helm version                                                             │
│   adds    openinfra.lock: helm 4.1.2 provider=managed digest=sha256:9c…            │
│                                                                                    │
│   [y] install   [n] cancel   [d] details (URL, sizes, keys, recipe)                │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Progress streams like a run (`download 62% · 7.7/12.4 MB · 1.9 MB/s` → `verify sha256 ✓ gpg ✓` → `smoke ✓` →
`lock updated`), cancellable, and every step is a line in the run journal.

### 10.2 Tools (route `:` → `tools`, or `oi tui --route tools`)

Per workspace: what is installed, by which provider, verified when, smoke result, licence, disk used; keys
`i` install · `u` upgrade (shows the version diff, the changelog link, and an **impact grep** over the workspace) ·
`p` pin provider/version · `r` repair (re-verify digests, re-run smoke) · `g` gc (keep last N) · `s` switch to
system · `b` bundle for air-gap · `e` export lock diff.

### 10.3 What the agent may and may not do

| Agent action | Allowed |
|---|---|
| Detect versions, read the lock, report `unreadable`/missing tools | yes |
| Recommend `oi tools install ansible-core@2.21.5` in its answer | yes |
| Call `oi tools install` from its shell | **denied by guard rule** |
| Change a workspace's provider | denied |
| Write the lockfile | only through `oi tools`, never by editing files |
| Read the installed tool's own docs offline (`ansible-doc`) | yes, from the pinned install |

---

## 11. Exit codes (added to the contract)

| Code | Meaning |
|---|---|
| 8 | toolchain unsatisfied, or verification/smoke failed (`oi tools doctor`, `--locked` installs) |
| 9 | no workspace / ambiguous workspace |

Everything else is unchanged from [TUI.md](TUI.md) §19.1.

---

## 12. Tests

| Area | Test |
|---|---|
| Verification | bad digest, truncated download, wrong-size asset, signature from the wrong key, cosign identity mismatch, tampered checksums file → nothing installed, exact error |
| Recipes | every recipe parses, has a licence, a digest for every platform we support, and a smoke command; canary (network) nightly |
| Install | interrupt at each of the 8 steps leaves no `.ready` and no lock entry; retry converges; concurrent installs serialise |
| Isolation | after install, the user's `which ansible` is unchanged; the engine's child sees the pinned one; `~/.ansible.cfg` unmodified |
| Lock | changing any lock entry changes the plan hash; a pending approval then fails with exit 7 |
| Python tools | `uv tool run` path and materialised-venv path produce the same smoke output; collections install into the workspace, not the user's home |
| Workspace | create/rename/move/remove round-trip keeps the id; discovery from a subfolder; nested and network-fs refusals; registry survives a folder move (offers to repair) |
| Concurrency | two runs on one target: second refuses with exit 3; stale lease reclaimed |
| Air-gap | `--from-bundle` with the network off; mirror with a mismatched digest fails |
| TUI | the Setup and Install screens under PTY: preview content includes host+digest, `n` installs nothing, progress renders, cancellation leaves no lock change |

---

## 13. Build order (adds 1.5 weeks to [TUI.md](TUI.md) §17)

| Where | Work | Acceptance |
|---|---|---|
| W1 (parallel) | `toolchain/recipes/*.yaml` + verifier + installer core (pure, no UI) | verification fixtures pass; installer interrupt test |
| W1 | uv bootstrap recipe + python-tool provider | `ansible --version` from an isolated env on a clean container |
| W2 | workspace model, registry, templates, `oi workspace new` | `lab` template creates a working demo workspace offline in < 3 s |
| W2 | lockfile, plan-hash integration, exit 8/9 | approval invalidated by a tool change |
| W3 | TUI Setup screen + install preview + progress | install helm from the preview; cancel leaves nothing |
| W4 | TUI Tools screen, upgrade with impact grep, gc, bundle | air-gap bundle installs on an offline container |
| W5 | canary CI, recipe refresh workflow, docs (`docs/TOOLCHAIN.md`, `docs/WORKSPACES.md`) | a stale recipe fails CI nightly |

---

## 14. Risks

| Risk | Why it hurts | Mitigation |
|---|---|---|
| **Recipe rot** (vendor moves a URL/asset) | install fails when a new user tries | nightly canary; assets addressed by tag+name, not by "latest"; a failing canary blocks release |
| **Supply chain** | we are a distribution point for binaries that will run on routers | pinned digests in the app + publisher signature + identity-pinned cosign; no skip flag; preview names host and digest |
| **Version skew between workspace and plan** | an approval means nothing if the runtime changed | lockfile in the plan hash; exit 7 on change |
| **Two runtimes, two behaviours** (container vs managed) | a check passes in one and fails in the other | same recipe drives both; `oi tools doctor` reports provider; verification suite runs on both in CI |
| **Python ABI/platform matrix** | ansible fails on a distro with an old Python | uv-managed Python per toolchain (no system Python), pinned in the lock |
| **Disk growth** | toolchains and caches add up to GBs | per-version dirs, `oi tools gc --keep 2`, download cache GC, `oi workspace show` prints disk used |
| **Licence surprises** | Terraform BSL, Ansible GPL, vendor tools | licence shown in the preview; Terraform requires acknowledgement and is never default; we redistribute nothing |
| **Workspace sprawl** | people make 12 workspaces and lose track | registry with `status`, last-used, drift counts; `oi workspace list` ranks by recent activity |
| **Network filesystems** | WAL corruption, silent data loss | detect fs type; refuse writes on NFS/SMB/sshfs |
| **Installing on a shared/jump host** | one user's toolchain for everyone | per-user home only; refuse if `OPENINFRA_HOME` is group-writable; system provider for shared installs |

---

## 15. Decisions

| ID | Decision | Recommendation |
|---|---|---|
| DEC-11 | Three providers (`container`/`managed`/`system`) + import from mise/asdf | yes |
| DEC-12 | `managed` toolchain in `~/.openinfra/toolchains`, never on the global `PATH` | yes |
| DEC-13 | Pinned digests shipped in the app **and** publisher signatures, both required where available | yes |
| DEC-14 | uv as the single Python bootstrap (no pipx dependency) | yes; document pipx equivalence |
| DEC-15 | Terraform detected/installed only with explicit BSL acknowledgement; OpenTofu is the default | yes |
| DEC-16 | Agent may recommend installs; only a human may run them | yes |
| DEC-17 | `openinfra.lock` is committed and enters the plan hash | yes |
| DEC-18 | Workspace `id` is stable and independent of name/folder | yes |
| DEC-19 | Target leases make concurrent applies impossible rather than unlikely | yes |
| DEC-20 | Air-gap via bundle + mirror that cannot weaken verification | yes |
