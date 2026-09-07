# Git Log Graph

An Orca plugin that opens the focused worktree's commit graph, including recursive submodules, in an Orca browser tab. Requires Orca 1.4+, Git, and the companion `viz.mjs` in this directory. No npm dependencies or build step.

## Dev install

1. Open Orca → **Settings → Plugins** (macOS: **⌘,**, then **Plugins / 플러그인** under Experimental). Turn on **Plugin system** if it is off.
2. Expand **Development / 개발** below the catalog. Paste this checkout's absolute path into **Development plugin folder path**, then click **Add path**:
   `/Users/Kinos/orca/workspaces/just-orca/gitlog-plugin-shell`.
   This is the UI for **Dev plugin paths** (`devPluginPaths`).
3. Select the **Installed** tab; click **Refresh** if needed. Find **Git Log Graph** (`kinos.git-log-graph`), review its permissions, approve `workspace:read`, `notifications:show`, and the Node worker trust disclosure, then enable it.
4. Focus a local worktree and press **Mod+Alt+L** (**⌘⌥L** on macOS), or run **Git Log: Open Graph (with submodules)** from the command palette. Running it again regenerates the HTML and reloads the existing graph tab.

The local profile stores the paths under `settings.devPluginPaths` in
`~/Library/Application Support/orca/profiles/local-default/orca-data.json`.
Use Settings while Orca is running so changes are persisted by the app.

## Standalone

With `viz.mjs` present and Node.js installed:

```sh
node viz.mjs /path/to/repo --limit 500 --out /tmp/g.html
orca tab create --url file:///tmp/g.html --json
```

Check CLI/worktree resolution without `viz.mjs`, Git collection, or creating a tab:

```sh
node main.mjs --dry-run
```

This takes the first live Orca terminal, builds a context using its `handle`, asserts the resolved worktree id/path, and prints the path. Its `handle` match is synthetic; an actual plugin invocation logs whether `workspace.readContext` matched `handle` or `ptyId`.

## Shell integration check (2026-09-07)

Verified against running Orca 1.4.197:

- The manifest exactly matches the design spec and passes the installed Orca manifest schema, including command context, keybinding normalization/`when`, and capabilities. The supplied TypeScript schema copy was read; its missing imports were checked in the installed app's compiled schema.
- `node main.mjs --dry-run` passed: CLI `orca`, terminal field `handle`, resolved path `/Users/Kinos/Projects/brightmon`. Separate live checks passed for `ptyId`, terminal-less name/branch fallback, stale-terminal rejection, and the no-focused-worktree notification.
- A temporary HTML file with spaces, `#`, and Korean characters opened in this worktree. Opening it again retained the same `browserPageId` and one tab. The temporary tab and file were cleaned up.
- **Manual installation remains necessary:** Settings → Plugins was reachable, but desktop input failed with `window_not_focused` even with `--restore-window`. `settings.devPluginPaths` remains empty. Follow the exact Development → Add path steps above; discovery and consent were not verified.
- No `[plugins]` or `git-log-graph` lines were found under `~/Library/Application Support/orca/logs`. This does not establish successful discovery. After adding the path, confirm the plugin appears under Installed without validation errors, and inspect that log directory (or the plugin's logs in Settings) if it does not.

The real host's `workspace.readContext` terminal-id format and end-to-end graph generation still need a plugin invocation after installation and the companion `viz.mjs` are available.

## Limits

- Default maximum: 500 commits per repository; standalone `--limit N` overrides it. No incremental loading.
- Local worktrees only. Automatic packaged CLI discovery supports the macOS app layout, then falls back to `orca` on PATH.
- Requires a matching terminal, or a unique display-name/branch match when there are no terminals.
- Graphs are snapshots: rerun the command to refresh. No live refresh, diff viewer, or sidebar panel.
- Generated HTML lives in the OS temporary directory under `orca-git-log-graph/<sha1-of-worktree-path>.html`; it is overwritten on refresh and is not automatically removed by the plugin.
- Until the companion `viz.mjs` is available, the shell can be discovered and dry-run, but opening a graph reports the missing module through a notification.
