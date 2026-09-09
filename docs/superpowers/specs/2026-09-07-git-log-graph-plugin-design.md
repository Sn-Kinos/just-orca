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
