# Git Log Graph

An Orca plugin that opens the focused worktree's commit graph, including recursive submodules, in an Orca browser tab. Requires Orca 1.4+, Git, and Node 20+. No npm dependencies or build step.

## Files

- `orca-plugin.json` — plugin manifest.
- `main.mjs` — worker command and Orca tab integration.
- `serve.mjs` — loopback HTTP server for the page and fresh Git data.
- `viz.mjs` — Git collection, exported lane layout, JSON/template assembly, and CLI.
- `graph.html` — self-contained UI with plain JavaScript components and inline styles.
- `test.mjs` — runnable collection, lane, template, and server checks (`node test.mjs`).

Open `graph.html` directly to style the page; without injected data it shows “No data — run `node viz.mjs <repo>`”.

## Dev install

1. Open Orca → **Settings → Plugins** (macOS: **⌘,**, then **Plugins / 플러그인** under Experimental). Turn on **Plugin system** if it is off.
2. Expand **Development / 개발** below the catalog. Paste this checkout's absolute path into **Development plugin folder path**, then click **Add path**:
   e.g. `/Users/Kinos/Projects/just-orca`.
   This is the UI for **Dev plugin paths** (`devPluginPaths`).
3. Select the **Installed** tab; click **Refresh** if needed. Find **Git Log Graph** (`kinos.git-log-graph`), review its permissions, approve `workspace:read`, `notifications:show`, and the Node worker trust disclosure, then enable it.
4. Focus a local worktree and press **Mod+Alt+L** (**⌘⌥L** on macOS), or run **Git Log: Open Graph (with submodules)** from the command palette. Running it again reloads the existing graph tab.

The local profile stores the paths under `settings.devPluginPaths` in
`~/Library/Application Support/orca/profiles/local-default/orca-data.json`.
Use Settings while Orca is running so changes are persisted by the app.

## Live server

The plugin automatically starts or reuses `serve.mjs`, using only Node's built-in HTTP server. It listens on **127.0.0.1 only**, on an OS-assigned port. The page and `/data` responses use `Cache-Control: no-store`, with no CORS access. Only paths registered by the worker are available through repository IDs.

Refreshing the browser tab reloads live Git data, including submodules. The server survives worker shutdown and exits after **60 minutes without a request**. Its `{ pid, port, startedAt }` state file is at `join(os.tmpdir(), 'orca-git-log-graph', 'server.json')` (`$TMPDIR/orca-git-log-graph/server.json` on macOS). The worker checks `/health` before reusing it and replaces stale state when starting a server.

For manual use, run `node serve.mjs [--state /path/to/server.json]`, POST JSON `{ "path": "/path/to/repo" }` to `/register`, and open `http://127.0.0.1:<port>/?repo=<returned-id>`. `GET /data?repo=<id>&limit=500` returns the title and repositories with prepared lane rows.

## Standalone

```sh
node viz.mjs /path/to/repo --limit 500 --out /tmp/g.html
orca tab create --url file:///tmp/g.html --json
```

Check CLI/worktree resolution and live data against the running Orca (does not open a tab):

```sh
node main.mjs --dry-run
```

This takes the first live Orca terminal, builds a context using its `handle`, asserts the resolved worktree id/path, starts or reuses the server, registers the path, fetches `/data`, and prints the path, URL, and repo count. Its `handle` match is synthetic; an actual plugin invocation logs whether `workspace.readContext` matched `handle` or `ptyId`.

## Dev-loop caveat

Because the plugin contributes a keybinding, Orca folds the live tree hash of a dev plugin into its consent fingerprint: every file save flips the plugin to "needs re-approval" until you approve it again in Settings → Plugins. Installed (non-dev) copies do not have this problem.

If you keep a separate dev plugin copy to avoid re-approving every source edit, copy `orca-plugin.json`, `main.mjs`, `serve.mjs`, `viz.mjs`, and **`graph.html`** into that folder. Keep these files together; the CLI and server load the template relative to their modules. Restart the server after changing its code; refreshing the page reads the current `graph.html`.

## Limits

- Default maximum: 500 commits per repository; standalone `--limit N` or the server's `/data?repo=<id>&limit=N` overrides it. No incremental loading.
- Local worktrees only. Automatic packaged CLI discovery supports the macOS app layout, then falls back to `orca` on PATH.
- Requires a matching terminal, or a unique display-name/branch match when there are no terminals.
- Data updates on refresh, with no background polling or diff viewer. After an idle server exit, rerun the plugin command to reconnect.
- Standalone `node viz.mjs` output remains a static snapshot. Without `--out`, generated HTML lives in the OS temporary directory under `orca-git-log-graph/<sha1-of-worktree-path>.html` and is not automatically removed.
