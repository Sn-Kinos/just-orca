# Git Log Graph — Orca plugin design

Orca plugin that renders the git log of the focused worktree **and every submodule (recursive)** as a commit DAG in an Orca browser tab. One keybinding, no external deps.

## Why a browser tab, not a sidebar panel

Verified against Orca 1.4.197 source (`src/shared/plugins/*`, `src/main/plugins/*`):

- Plugin API v0 capabilities are a closed set: `workspace:read`, `terminal:send`, `notifications:show`, `storage`, `secrets`, `events:subscribe`, `settings:own`. No fs/git/process capability, but the **worker** (`main` entry) is plain Node forked with `ELECTRON_RUN_AS_NODE`, `execArgv: []`, env allowlist incl. `PATH`/`HOME`/`TMPDIR` — so `child_process` + `git` work in the worker.
- Sidebar panels (`contributes.panels`) are `srcdoc` iframes with `sandbox="allow-scripts"` and CSP `default-src 'none'; connect-src 'none'`. Panel-callable actions are only `workspace.readContext`, `terminal.sendText`, `notifications.show`. There is **no channel worker→panel or panel→worker**, so a panel cannot show git data.
- `workspace.readContext` returns only `{ displayName, branch, terminals:[{id}] }` (no path).
- Orca's embedded browser opens `file://` URLs (verified: `orca tab create --url file:///…`).

Therefore: worker command → collect git data → write self-contained HTML → open it in the worktree's Orca browser tab via the `orca` CLI.

## Repo layout

```
orca-plugin.json        manifest
main.mjs                worker entry: activate(orca) registers command "open-graph"
viz.mjs                 core: git collection + exported lane layout + JSON/template assembly; also a CLI
graph.html              static self-contained UI: inline CSS + plain JS components
test.mjs                one runnable check (node test.mjs): temp repo + submodule → JSON/row assertions
README.md               install (devPluginPaths), usage, limits
```

## Manifest (`orca-plugin.json`)

```json
{
  "manifestVersion": 1,
  "id": "git-log-graph",
  "publisher": "kinos",
  "name": "Git Log Graph",
  "version": "0.1.0",
  "description": "Commit graph of the focused worktree including all submodules, opened in an Orca browser tab.",
  "engines": { "orca": ">=1.4.0" },
  "pluginApi": 1,
  "main": "main.mjs",
  "contributes": {
    "commands": [{ "id": "open-graph", "title": "Git Log: Open Graph (with submodules)", "context": "worktree" }],
    "keybindings": [{ "command": "open-graph", "key": "Mod+Alt+L", "when": "worktree" }]
  },
  "capabilities": [{ "kind": "workspace:read" }, { "kind": "notifications:show" }]
}
```

Validate field names/enums against the schema copy at
`/private/tmp/claude-501/-Users-Kinos-orca-workspaces-just-orca-git-log/b30f200a-f49e-49f7-a45a-f99aca5956eb/scratchpad/src/plugin-manifest.ts`
(keybinding `when` enum in particular). Host API + example plugin live next to it (`plugin-host-api.ts`, `../hello-orca/`).

## `viz.mjs` — core (pure Node, zero deps)

```js
export async function collectRepos(rootPath, { limit = 500 } = {})  // → RepoGraph[]
export function layoutLanes(commits)                               // → rows with commit fields + lane metadata
export async function buildGitLogHtml(rootPath, opts)               // collect + layout + inject JSON/title into graph.html
// CLI: node viz.mjs <repoPath> [--limit N] [--out file.html]  → prints written path
```

`RepoGraph`:
```ts
{ name: string,            // "." for root, else submodule displaypath e.g. "libs/foo"
  path: string,            // absolute
  pinnedSha: string|null,  // gitlink sha the superproject HEAD points at (root: null)
  head: string,
  commits: Array<{ sha, parents: string[], author, ts, refs: string[], subject }> }
```

Collection:
- Submodules: discovered by scanning `git ls-tree -r HEAD` gitlinks (mode 160000) per repo, recursively; `submodule foreach --recursive` is not used because it aborts when any nested repo has a gitlink missing from `.gitmodules`. Each gitlink becomes a RepoGraph. Gitlinks not registered in that repo's `.gitmodules` (read with `git config -f .gitmodules -z --get-regexp`) and uninitialized submodules (no `.git`) are listed with `commits: []` and an `error` string, not skipped silently.
- Pinned sha per submodule: `git -C <parent> ls-tree HEAD <relpath>` (mode 160000). For nested submodules the parent is the enclosing submodule.
- Log: `git log --all --date-order -n <limit> --format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s` parsed on `\x1f`. Refs from `%D` split on `, `, strip `HEAD -> `.
- All git calls via `execFile('git', […], { cwd, maxBuffer: 64MB })`. Never shell-interpolate paths.

Render:
- `graph.html` is the static presentation template: single HTML page with inline CSS + JS, no CDN, fonts, dependencies, or build step; works over `file://`. Open it directly to style it; the untouched data placeholder leaves a friendly “No data — run `node viz.mjs <repo>`” message.
- `buildGitLogHtml` collects repositories, runs `layoutLanes(repo.commits)` for each, reads `graph.html` relative to `import.meta.url`, and replaces `/*__ORCA_GIT_LOG_DATA__*/` inside `<script id="repos" type="application/json">`. JSON escapes `</` as `<\/` and `<` as `\u003c` to prevent script breakouts. The HTML-escaped title replaces `__ORCA_GIT_LOG_TITLE__` in `<title>`; the page copies `document.title` into its heading.
- Plain JS components `RepoSection(repo)`, `CommitRow(row, lanesWidth)`, `LaneGraph(row)`, and `RefBadge(ref)` assemble the UI from JSON. Git text is HTML-escaped before insertion. `Filter()` wires the search input; inline behaviors provide relative times and copy-SHA with a clipboard fallback.
- Server-side `layoutLanes(commits)` keeps the gitk-style active-lane algorithm, returning commit fields plus `{ lane, parentsLanes, edges, incoming, width }` per row. First parents inherit lanes, other parents get new lanes, and consumed lanes close; the template only draws the prepared edges as SVG paths.
- One collapsible section per repo, root first then submodules in collection order, with header `name · branch · N commits`. Submodule sections highlight the `pinnedSha` row with a “superproject HEAD” badge.
- Row: graph SVG | SHA button | refs badges (branch/tag/HEAD classes) | subject | author | relative date. The author/subject/SHA substring filter dims non-matching row text without changing layout or the graph column.
- Colors follow `prefers-color-scheme`; lanes use a fixed 8-color cycle.
- `ponytail:` comment on layout: O(rows × lanes), capped at `limit` commits per repo; no incremental loading.

## `main.mjs` — worker

```js
export default function activate(orca) {
  orca.commands.register('open-graph', async () => { … })
}
```
Steps in the handler (each failure → `notifications.show({ title: 'Git Log Graph', body: <error> })` and return `{ ok:false, error }`):
1. `ctx = await orca.host.call('workspace.readContext')`; null → error "no focused worktree".
2. Resolve the worktree path via the `orca` CLI:
   - CLI path: `join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca')` when it exists (macOS packaged app — the worker's `execPath` is the Electron binary), else `orca` from PATH. `// ponytail: macOS layout only; add Linux/Windows resolution when someone runs it there`.
   - `orca terminal list --json` → find an entry whose `handle` or `ptyId` equals any `ctx.terminals[i].id` → `worktreeId`, `worktreePath`. (Log which field matched so we learn the id format.)
   - Fallback when the worktree has no terminals: `orca worktree list --json`, match `displayName === ctx.displayName && branch endsWith ctx.branch`; exactly one match required, else error listing candidates.
3. `html = await buildGitLogHtml(worktreePath)`; write to `join(os.tmpdir(), 'orca-git-log-graph', <sha1(worktreePath)>.html)`.
4. Open: `orca tab create --url file://<file> --worktree id:<worktreeId> --json`. If a tab for that file already exists (`orca tab list --json`), `orca goto --url … --page <browserPageId>` (reload) instead of creating another.
5. Return `{ ok: true, file, worktreePath, repos: n }`.

All CLI calls via `execFile(cli, args, { timeout: 15000 })`, JSON-parsed, `ok:false` surfaced as error.

## Test (`test.mjs`, run with `node test.mjs`)

Creates a temp superproject with 3 commits on two branches + a merge, one submodule (`git -c protocol.file.allow=always submodule add`) with 2 commits, pins the submodule at its first commit, then asserts on the JSON/rows embedded by `buildGitLogHtml(tmp)`:
- rows contain every commit sha of both repos,
- repository names (section inputs) are `.` then the submodule path,
- the submodule's `pinnedSha` selects the row used for the highlight and `superproject HEAD` badge,
- merge commit row has 2 parent lanes and lanes remain continuous,
- hostile `</script>` subjects round-trip through JSON without breaking out of the data script,
- the bare template contains the “No data” message and built output contains neither placeholder,
- `collectRepos` on a repo with an uninitialized submodule returns `error` for it and still returns root.
Plain `assert`, no framework. Cleans up temp dir.

## Dev install / usage (README)

1. Orca → Settings → Plugins: enable plugin system (already `pluginSystemEnabled: true` on this machine), add this repo's path to **Dev plugin paths** (`devPluginPaths` in `profiles/<profile>/orca-data.json`), approve the consent dialog (workspace:read, notifications:show).
2. In any worktree press `Mod+Alt+L` or run "Git Log: Open Graph" from the command palette → a browser tab opens with the graph.
3. Standalone: `node viz.mjs /path/to/repo --out /tmp/g.html && orca tab create --url file:///tmp/g.html`.

## Out of scope (YAGNI)

Sidebar panel (API cannot carry data), live refresh, diff viewing, non-macOS CLI resolution, >500 commits per repo, remote worktrees.

## v0.2 — live data server + submodule sidebar (2026-09-10)

Requirements: (1) with many submodules, pick which ones to show via a sidebar of checkboxes; (2) a browser refresh must show the latest git state.

(2) cannot work over `file://` (a static page cannot run git), so the plugin serves the page from a tiny local HTTP server instead of writing a temp file. The CLI file mode (`node viz.mjs <repo>`) stays as a standalone fallback.

### `serve.mjs` — local data server (zero deps, `node:http` only)

- Start: `node serve.mjs [--state <file>]`. Listens on `127.0.0.1`, port `0` (OS-assigned). Writes `{ pid, port, startedAt }` to the state file (default `join(os.tmpdir(), 'orca-git-log-graph', 'server.json')`) once listening. Exits after 60 minutes without any request (`// ponytail:` fixed idle timeout). Never binds a non-loopback address.
- Routes (all JSON unless noted, `Cache-Control: no-store`):
  - `GET /health` → `{ ok: true, pid }`
  - `POST /register` body `{ path }` → `{ id }` where `id = sha1(resolve(path))`. Stores `id → path` in memory. 404 for anything not registered. Path must exist (`fs.access`), else 400.
  - `GET /?repo=<id>` → `graph.html` as `text/html` (template untouched: placeholders left as-is; the page fetches its data). 404 if id unknown.
  - `GET /data?repo=<id>&limit=<n>` → `{ title, repos }` where `repos` = `collectRepos(path, { limit })` with `rows: layoutLanes(commits)` per repo (same shape as the embedded JSON). Each call re-runs git → refresh = fresh. 500 with `{ error }` on failure. Default limit 500.
  - No CORS headers (other origins must not read repo data).
- `export function startServer({ stateFile, idleMs })` returning `{ port, close }` so `test.mjs` can start it in-process on port 0 and hit it with `fetch`.

### `graph.html` changes

- Data source, in order: (a) embedded JSON in `#repos` (CLI file mode) → (b) if `location.protocol` is `http:`, `fetch('/data' + location.search)` → (c) otherwise "No data" message. While fetching show "Loading…"; on fetch error show the error text in `#status`.
- Sidebar (left column, fixed width ~240px, scrollable; main content to the right): one checkbox per repo, root first, label = repo name plus commit count and an "error" marker when `repo.error` is set; "All" / "None" buttons. Unchecked repos hide their `<section>`. Selection persists in `localStorage` under key `git-log-graph:` + `location.search` (per repo id), so a refresh keeps the choice. Default: all checked. Layout: CSS grid `sidebar main`; on narrow widths (<720px) sidebar stacks above.
- Add a "Refresh" button next to the filter that calls `location.reload()` (only shown in http mode).
- Keep all existing components; render is a pure function of `(repos, selection)`.

### `main.mjs` changes

Replace steps 3–4 of the command handler:
3. `ensureServer()`: read state file → `GET http://127.0.0.1:<port>/health` (1 s timeout). If unhealthy/missing: spawn `process.execPath serve.mjs` **detached** (`detached: true, stdio: 'ignore', unref()`, env `{ ...process.env, ELECTRON_RUN_AS_NODE: '1' }` — the worker's `execPath` is Orca's Electron binary, which runs as Node with that flag; under plain `node` it is just node) and poll the state file + `/health` up to 5 s. The server outlives the worker (Orca reaps idle workers after 5 min).
4. `POST /register { path: worktreePath }` → `{ id }`; open `http://127.0.0.1:<port>/?repo=<id>` in the worktree's Orca browser tab: reuse an existing tab whose URL matches (`tab list --worktree all`, then `goto --page`), else `tab create`.
- `--dry-run` additionally starts/reuses the server, registers the resolved path, fetches `/data` and prints the repo count.
- Return `{ ok: true, url, worktreePath, repos }`.

### Tests (`test.mjs`)

Add: start server in-process (`startServer({ stateFile: tmp, idleMs: 60000 })`), `POST /register` the temp superproject, `GET /data?repo=<id>` returns the same repo names/pinnedSha as `collectRepos`; unknown id → 404; `GET /?repo=<id>` returns HTML containing `id="repos"`; register a non-existent path → 400. Close the server at the end.

## v0.3 — per-repo branch selection (2026-09-10)

Requirement: for each repo (root and every submodule) choose which branches are shown.

Server-side re-query, not client filtering: `--all -n 500` truncates, so filtering loaded commits by reachability would drop history that a narrower query would include.

### Data (`viz.mjs`)

- `collectRepos(root, { limit, refs })` — `refs` is `{ [repoName]: string[] }` (repoName as in `RepoGraph.name`, `.` for root). Each `RepoGraph` gains `branches: string[]` = `git for-each-ref --format=%(refname:short) refs/heads refs/remotes` (local first, then remote, `origin/HEAD` excluded) and `selectedRefs: string[] | null` (null = all).
- When `refs[name]` is present and non-empty, run `git log --date-order -n <limit> <ref…> --` with only names that exist in `branches` (unknown names are dropped; if none remain fall back to `--all`). Otherwise `--all` as today. Never pass client strings that are not in `branches` to git.

### Server (`serve.mjs`)

- `POST /data?repo=<id>` with JSON body `{ limit?: number, refs?: { [repoName]: string[] } }` → same response shape as GET (`{ title, repos }`), repos now carrying `branches` and `selectedRefs`. `GET /data` stays (= all refs). Body cap 256 KiB, 400 on malformed JSON or non-string ref names.

### UI (`graph.html`)

- Sidebar: under each checked repo, a collapsed `<details>` "branches (n/m)" listing one checkbox per branch (local, then remote), plus per-repo All/None links. Unchecked repo → its branch list hidden.
- Changing any branch checkbox re-fetches `/data` via POST with the current `refs` map (only repos whose selection is not "all" are sent) and re-renders; show "Loading…" in `#status` during the fetch, keep the old graph visible until the new data arrives.
- Persist in `localStorage` (same key as before) as `{ repos: string[], refs: { [repoName]: string[] } }`; migrate the old plain-array format (treat as `repos`). On load, if saved `refs` exist, the first fetch already uses them.
- File mode (embedded JSON, no server): branch lists are rendered disabled with a tooltip "branch selection needs the live server".
- Section header shows `name · branch · N commits · refs: all|k selected`.

### Tests (`test.mjs`)

- `collectRepos(root, { refs: { '.': ['feature'] } })` returns only commits reachable from `feature` (no `main second`/merge), `branches` includes `main` and `feature`, `selectedRefs` equals `['feature']`; unknown ref names are ignored; `refs: { '.': ['nope'] }` falls back to all.
- Server: `POST /data` with `{ refs: { '.': ['feature'] } }` matches `collectRepos` output; malformed body → 400.

## v0.4 — fixed-width rows, ellipsis, expandable commit detail (2026-09-10)

Problem: `.row{min-width:max-content}` + `white-space:nowrap` lets a long subject push author/time off to the right, so columns misalign and the section scrolls horizontally.

### Data (`viz.mjs`)

- Add `body: string` to each commit. Use `git log -z` with format `%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f%b`; records are `\0`-separated (bodies contain newlines), fields `\x1f`-separated. Trim trailing whitespace of `body`.

### UI (`graph.html`)

- Row fits the container: remove `min-width:max-content` from `.row`; `.text{min-width:0}`; `.subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`; author/time `flex-shrink:0`; badges in a `.badges{flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` wrapper. Only the graph SVG column has a fixed width. `.history` keeps `overflow-x:auto` only as a safety net; with normal content there must be no horizontal scrollbar.
- Full subject in `title=` on `.subject`.
- Expand/collapse: the row (`role="button"`, `tabindex="0"`, `aria-expanded`) toggles on click or Enter/Space, except clicks on the SHA copy button. Expanded state adds a `.detail` block directly under that row (inside a `.commit` wrapper that holds `.row` + `.detail`) with: full subject, body (`white-space:pre-wrap`, monospace-ish, empty → omitted), full SHA (copy button), parents as short-SHA copy buttons, author, absolute ISO date, refs badges. Multiple rows may be open at once. Expanded state is not persisted.
- Lane continuity: the detail block has the same left column width as the graph column and draws a vertical line for every lane passing through between this row and the next: for each `edge` of the row, `<line x1=x(edge.to) x2=x(edge.to) y1=0 y2=100% stroke=colors[edge.from % 8]>` inside an SVG that stretches to the detail height (`height="100%"`, container `display:flex; align-items:stretch`). Verified visually: the graph must look unbroken when a row is expanded.
- Filter continues to work on collapsed rows; an expanded row that no longer matches is dimmed like any other.

### Tests (`test.mjs`)

- Commit with a multi-line body (`-m subject -m "line1\nline2"`) → `body === 'line1\nline2'`; subject with `\x1f`/`\0`-free content unchanged; template contains `.detail` and `aria-expanded`.

## v0.5 — visual redesign of the page and sidebar (2026-09-10)

Problem: the sidebar is a bare list of native checkboxes with no hierarchy; branch names wrap; refs show as `heads/main` / `main/HEAD`; the header is a huge H1 with a filesystem path.

### Direction: an instrument panel for git

- **Type**: identifiers (SHA, refs, branch names, counts, dates) in `ui-monospace, "SF Mono", Menlo, Consolas, monospace` 12px with `font-variant-numeric: tabular-nums`; prose (subjects, labels) in `system-ui, -apple-system, "Segoe UI", sans-serif` 13px. Section titles 13px semibold, letter-spacing 0.01em. No web fonts (must work offline over file://).
- **Palette** (tokens on `:root`, dark first because Orca is dark; light under `prefers-color-scheme: light`):
  - dark: `--bg #0f1216`, `--panel #161b22`, `--panel-2 #1c2230`, `--line #262d38`, `--fg #e6e9ef`, `--muted #8b95a5`, `--accent #5b9cff`, `--pin #f2b441`.
  - light: `--bg #f7f8fa`, `--panel #ffffff`, `--panel-2 #f0f2f6`, `--line #e3e7ee`, `--fg #1b2230`, `--muted #5f6b7c`, `--accent #2f6fe4`, `--pin #b7791f`.
  - lanes: `#5b9cff #f2994a #2ec4a6 #b388ff #ff6b8a #c9c22f #23b5d3 #a58b6f`.
- **Signature**: the sidebar is a *manifest tree* that mirrors the graph: a thin vertical rail on the left, one colored dot per repository (root uses lane 0; submodules use lanes 1..n cycling), nested submodules indented under their parent along the rail. Under each submodule a one-line mono note `pinned 5b5a7d7` (first 7 of `pinnedSha`, amber dot when the submodule's HEAD differs from the pin, muted when equal). This is the one place the page spends its visual budget; everything else is quiet.

### Layout

```
┌ header: [repo basename]  /full/path (mono, muted, truncates)     [search……] [Refresh] ┐
├ aside 260px ────────────┬ main ─────────────────────────────────────────────────────┤
│ REPOSITORIES  all·none  │ ▾ sherry-main  main  67  all refs            (section bar) │
│ ●─ sherry-main    67    │  ● 89c900ee  ⟨main/…⟩ merge: main → 워크트리…   Sn-Kinos 4일 │
│ │  branches 11/11 ▸     │ …                                                          │
│ ├● sherry        102    │                                                            │
│ │  pinned 5b5a7d7       │                                                            │
│ ├● sherry-backend 500   │                                                            │
│ │  branches 28/28 ▾     │                                                            │
│ │   local  all·none     │                                                            │
│ │   ☑ develop           │                                                            │
│ │   remotes/origin      │                                                            │
│ │   ☑ origin/develop    │                                                            │
```
- Header is a single 48px bar: repo basename (semibold) + full path (mono, muted, `text-overflow: ellipsis`), search input (mono placeholder `filter: author, subject, sha`) and Refresh (http mode only) on the right. `<title>` keeps the full title.
- Aside: 260px, sticky, own scroll, `--panel` background, 1px `--line` right border. Root repo is labeled by the repo folder basename with a tiny `root` tag, not `.`. Each repo row: checkbox → name (mono, ellipsis, `title=` full name) → count right-aligned (mono, muted). Rows have 32px height and a hover background `--panel-2`.
- Checkboxes: native inputs with `accent-color: var(--accent)`, 14px, aligned to the text baseline; no custom checkbox drawing.
- Branch picker: a `branches k/m` toggle row (chevron rotates 90° when open; `transition: transform 120ms`, disabled under `prefers-reduced-motion`). When open: groups `local` and `remotes/<remote>` (one group per remote name) with a small `all · none` text-button pair per group; each branch row = checkbox + mono name single line with ellipsis and `title=`. Group headers 11px uppercase muted, letter-spacing 0.06em.
- Section bar (per repo in main): 36px, `--panel-2` background, contents as mono chips: name (semibold), current branch, commit count, `all refs` or `k of m refs`. Chevron on the left toggles the section (keep `<details>`).
- Row: unchanged structure; badges become chips: HEAD = filled `--accent` with `--bg` text; branch = 1px `--line` outline, mono; tag = amber outline; `pinned by superproject` = filled `--pin` with dark text. Row hover `--panel-2`. Expanded detail: `--panel` background, 1px `--line` top/bottom, same rail lines as v0.4.
- Focus rings: 2px `--accent` on every interactive element. Filter dims to `opacity: .25`.
- Responsive: under 720px the aside becomes a collapsible top panel (a `Repositories` toggle button in the header).

### Data changes (`viz.mjs`)

- `branches` becomes `Array<{ name, label, remote }>`: `name` = `%(refname:short)` (the exact value passed back to git), `label` = full ref minus `refs/heads/` or `refs/remotes/`, `remote` = remote name for `refs/remotes/*` else `null`. Exclude every `refs/remotes/*/HEAD`, not only origin's. Order: locals (by name), then remotes grouped by remote name. `selectedRefs` and the `refs` request still use `name`.
- Each `RepoGraph` gains `basename` (folder name) and `parent` (parent repo name or `null`) so the sidebar can indent nested submodules.

### Tests (`test.mjs`)

- `branches` objects have `name/label/remote`; a remote named `main` with a `HEAD` ref is excluded; `label` of `refs/heads/main` is `main` even when `refname:short` says `heads/main`; nested submodule has `parent === 'libs/sub module'`; root has `basename === 'super project'`.

## v0.6 — readability pass (2026-09-11)

The v0.5 look is right; the reading experience regressed. Fix with the following exact changes and nothing else.

### Type scale and contrast
- Body/subject/sidebar names: 14px system sans (was 12–13px mono). Mono stays only for SHA, dates, counts, refs/branch names, and it is 13px, `--fg` (not muted) except where noted.
- Muted tone lifted for contrast: dark `--muted #a9b3c2`, light `--muted #55617a`. Anything at 12px must use `--fg` or this lifted muted, never a third dimmer tone.
- Line height 1.4 everywhere; row height 40px.

### Sidebar (aside)
- Width 300px.
- One repository = **two lines max**: line 1 = checkbox · name (14px sans, `--fg`, semibold for root, ellipsis + `title`) · count right (13px mono, muted). Line 2 = `pinned d7cd18d · branches 28/28 ▸` in 12px on one line; `pinned <sha>` in mono `--fg`, the dot before it stays amber when HEAD ≠ pin; `branches k/m` is the toggle (chevron). Root has no pinned part. Remove the separate pinned row.
- Indent per nesting level 16px; rail and dots stay.
- Branch list rows 28px, names 13px mono `--fg`, group headers 11px uppercase muted.
- Sticky top of aside: `REPOSITORIES  all · none` stays.

### Commit rows (main)
- Subject 14px sans `--fg`, `flex: 1`, ellipsis; it must get the space first.
- Author: 13px sans muted, `max-width: 10ch`, ellipsis, `title` full name. Date: 12px mono muted, `width: 8ch`, right-aligned. Author+date group `flex-shrink: 0`; total right group ≤ 20ch.
- SHA button 13px mono `--fg`, 9ch.
- Badges: 12px, ≤ 3 shown inline, the rest collapsed into a `+n` chip (full list in the detail panel); `.badges max-width: 32%`.
- Hover row background `--panel-2`; keep 2px lane graph.

### Section bar
- Repo name 14px semibold sans; the other chips 12px mono.

### Header
- Repo name 15px semibold; path 12px mono muted; filter input 13px.

### Verification
- Screenshot at 1040px wide: the subject column must show ≥ 45 characters of a typical `chore: bump …` subject; sidebar rows for `sherry-booth-register` must show the full name (300px allows it); no horizontal overflow in `.history`.
