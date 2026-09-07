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
viz.mjs                 core: git collection + lane layout + HTML render; also a CLI
test.mjs                one runnable check (node test.mjs): temp repo + submodule → HTML assertions
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
export function renderHtml(repos, { title })                        // → string (self-contained HTML)
export async function buildGitLogHtml(rootPath, opts)               // collect + render
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
- Submodules: `git submodule foreach --recursive -q 'echo "$displaypath"'` from root → list; each entry becomes a RepoGraph. Uninitialized submodules (no `.git`) are listed with `commits: []` and an `error` string, not skipped silently.
- Pinned sha per submodule: `git -C <parent> ls-tree HEAD <relpath>` (mode 160000). For nested submodules the parent is the enclosing submodule.
- Log: `git log --all --date-order -n <limit> --format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s` parsed on `\x1f`. Refs from `%D` split on `, `, strip `HEAD -> `.
- All git calls via `execFile('git', […], { cwd, maxBuffer: 64MB })`. Never shell-interpolate paths.

Render:
- Single HTML, inline CSS + JS, data embedded as `<script type="application/json">` (escape `</` as `<\/`). No CDN, no fonts, works over `file://`.
- Lane layout (gitk-style): iterate commits in `--date-order`; keep an array of active lanes (each = a sha expected next). A commit takes the lane of the first active lane waiting for it (or a new lane); its first parent inherits that lane, other parents get new lanes; lanes whose sha was consumed close. Emit per-row `{ lane, parentsLanes[] }` → SVG paths (straight vertical + bezier for merges/branches). ~60 lines; O(rows × lanes).
- One section per repo, root first then submodules in foreach order, each with a collapsible header `name · branch · N commits`. Submodule section highlights the `pinnedSha` row (badge "superproject HEAD").
- Row: graph SVG cell | refs badges (branch/tag/HEAD distinct classes) | subject | author | relative date. Click sha → copies to clipboard. Filter input (author/subject/sha substring) hides rows without relayout (keeps graph honest: filtering only dims/hides text rows, graph column stays).
- Colors via `prefers-color-scheme`; lane colors = fixed 8-color cycle.
- `ponytail:` comment on the layout: capped at `limit` commits per repo; no incremental loading.

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

Creates a temp superproject with 3 commits on two branches + a merge, one submodule (`git -c protocol.file.allow=always submodule add`) with 2 commits, pins the submodule at its first commit, then asserts on `buildGitLogHtml(tmp)`:
- output contains every commit sha of both repos,
- contains a section for `.` and for the submodule path,
- the submodule's pinned sha row carries the `superproject HEAD` badge,
- merge commit row has 2 parent lanes,
- `collectRepos` on a repo with an uninitialized submodule returns `error` for it and still returns root.
Plain `assert`, no framework. Cleans up temp dir.

## Dev install / usage (README)

1. Orca → Settings → Plugins: enable plugin system (already `pluginSystemEnabled: true` on this machine), add this repo's path to **Dev plugin paths** (`devPluginPaths` in `profiles/<profile>/orca-data.json`), approve the consent dialog (workspace:read, notifications:show).
2. In any worktree press `Mod+Alt+L` or run "Git Log: Open Graph" from the command palette → a browser tab opens with the graph.
3. Standalone: `node viz.mjs /path/to/repo --out /tmp/g.html && orca tab create --url file:///tmp/g.html`.

## Out of scope (YAGNI)

Sidebar panel (API cannot carry data), live refresh, diff viewing, non-macOS CLI resolution, >500 commits per repo, remote worktrees.
