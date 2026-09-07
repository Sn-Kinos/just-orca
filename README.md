# Git Log Graph

An Orca plugin that opens the focused worktree's commit graph, including recursive submodules, in an Orca browser tab. Requires Orca 1.4+, Git, and Node 20+. No npm dependencies or build step.

## Files

- `orca-plugin.json` — plugin manifest.
- `main.mjs` — worker command and Orca tab integration.
- `viz.mjs` — Git collection, exported lane layout, JSON/template assembly, and CLI.
- `graph.html` — self-contained UI with plain JavaScript components and inline styles.
- `test.mjs` — runnable collection, lane, and template checks.

Open `graph.html` directly to style the page; without injected data it shows “No data — run `node viz.mjs <repo>`”.

## Dev install

1. Open Orca → **Settings → Plugins** (macOS: **⌘,**, then **Plugins / 플러그인** under Experimental). Turn on **Plugin system** if it is off.
2. Expand **Development / 개발** below the catalog. Paste this checkout's absolute path into **Development plugin folder path**, then click **Add path**:
   e.g. `/Users/Kinos/Projects/just-orca`.
   This is the UI for **Dev plugin paths** (`devPluginPaths`).
3. Select the **Installed** tab; click **Refresh** if needed. Find **Git Log Graph** (`kinos.git-log-graph`), review its permissions, approve `workspace:read`, `notifications:show`, and the Node worker trust disclosure, then enable it.
4. Focus a local worktree and press **Mod+Alt+L** (**⌘⌥L** on macOS), or run **Git Log: Open Graph (with submodules)** from the command palette. Running it again regenerates the HTML and reloads the existing graph tab.

The local profile stores the paths under `settings.devPluginPaths` in
`~/Library/Application Support/orca/profiles/local-default/orca-data.json`.
Use Settings while Orca is running so changes are persisted by the app.

## Standalone

```sh
node viz.mjs /path/to/repo --limit 500 --out /tmp/g.html
orca tab create --url file:///tmp/g.html --json
```

Check CLI/worktree resolution against the running Orca (no Git collection, no tab):

```sh
node main.mjs --dry-run
```

This takes the first live Orca terminal, builds a context using its `handle`, asserts the resolved worktree id/path, and prints the path. Its `handle` match is synthetic; an actual plugin invocation logs whether `workspace.readContext` matched `handle` or `ptyId`.

## Dev-loop caveat

Because the plugin contributes a keybinding, Orca folds the live tree hash of a dev plugin into its consent fingerprint: every file save flips the plugin to "needs re-approval" until you approve it again in Settings → Plugins. Installed (non-dev) copies do not have this problem.

If you keep a separate dev plugin copy to avoid re-approving every source edit, copy `orca-plugin.json`, `main.mjs`, `viz.mjs`, and **`graph.html`** into that folder. Keep `graph.html` next to `viz.mjs`; the CLI and worker load it relative to the module.

## Limits

- Default maximum: 500 commits per repository; standalone `--limit N` overrides it. No incremental loading.
- Local worktrees only. Automatic packaged CLI discovery supports the macOS app layout, then falls back to `orca` on PATH.
- Requires a matching terminal, or a unique display-name/branch match when there are no terminals.
- Graphs are snapshots: rerun the command to refresh. No live refresh, diff viewer, or sidebar panel.
- Generated HTML lives in the OS temporary directory under `orca-git-log-graph/<sha1-of-worktree-path>.html`; it is overwritten on refresh and is not automatically removed by the plugin.
