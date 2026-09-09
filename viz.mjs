import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function collectRepos(rootPath, { limit = 500, refs = {} } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const root = resolve(rootPath);
  await access(root).catch(() => { throw new Error(`Repository path not found: ${root}`); });
  const git = async (cwd, ...args) => (await promisify(execFile)('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
  // Discovered from gitlinks only: `submodule foreach --recursive` aborts on any stray gitlink missing from .gitmodules.
  const names = ['.'];
  const pins = new Map();
  const registered = new Set();
  const repos = [];
  for (const name of names) {
    const path = name === '.' ? root : resolve(root, name);
    const repo = { name, path, pinnedSha: pins.get(name) ?? null, head: '', commits: [], branches: [], selectedRefs: null };
    repos.push(repo);
    try {
      if (name !== '.') {
        if (!registered.has(name)) throw new Error('Gitlink is not registered in .gitmodules; skipped');
        try { await access(join(path, '.git')); }
        catch { throw new Error('Submodule is uninitialized (no .git); run git submodule update --init --recursive'); }
      }
      // Git can shorten origin/HEAD to just "origin", so exclude it by its full name.
      repo.branches = (await git(path, 'for-each-ref', '--format=%(refname:short)%00%(refname)', 'refs/heads', 'refs/remotes'))
        .split('\n').filter(Boolean).map(line => line.split('\0'))
        .filter(([, full]) => full !== 'refs/remotes/origin/HEAD').map(([short]) => short);
      const selected = Array.isArray(refs[name]) ? [...new Set(refs[name].filter(ref => repo.branches.includes(ref)))] : [];
      repo.selectedRefs = selected.length ? selected : null;
      const log = await git(path, 'log', '-z', '--date-order', '-n', String(limit), '--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f%b',
        ...(repo.selectedRefs ? ['--end-of-options', ...repo.selectedRefs] : ['--all']), '--');
      repo.commits = log.split('\0').filter(Boolean).map(record => {
        const [sha, parents, author, ts, refs, subject, ...body] = record.split('\x1f');
        return { sha, parents: parents ? parents.split(' ') : [], author, ts: Number(ts), refs: refs ? refs.split(', ').map(ref => ref.replace(/^HEAD -> /, '')) : [], subject, body: body.join('\x1f').trimEnd() };
      });
      try { repo.head = (await git(path, 'rev-parse', '--verify', 'HEAD')).trim(); }
      catch { if (repo.commits.length) throw new Error('Cannot resolve repository HEAD'); }
      if (!repo.head) continue;
      // -z: key and value separated by \n, entries by \0, so paths with spaces survive.
      const modulePaths = new Set((await git(path, 'config', '-f', '.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.path$').catch(() => ''))
        .split('\0').filter(Boolean).map(entry => entry.split('\n')[1]));
      for (const entry of (await git(path, 'ls-tree', '-r', '-z', 'HEAD')).split('\0')) {
        const match = /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
        if (!match) continue;
        const child = name === '.' ? match[2] : `${name}/${match[2]}`;
        pins.set(child, match[1]);
        if (modulePaths.has(match[2])) registered.add(child);
        if (!names.includes(child)) names.push(child);
      }
    } catch (error) {
      if (name === '.') throw error;
      repo.error = error.message;
      repo.commits = [];
    }
  }
  return repos;
}

export function layoutLanes(commits) {
  let lanes = [];
  // ponytail: O(rows × lanes), capped at limit commits per repo; add incremental loading for larger histories.
  return commits.map(commit => {
    let lane = lanes.indexOf(commit.sha);
    const incoming = lane >= 0;
    if (lane < 0) { lane = lanes.length; lanes.push(commit.sha); }
    const before = [...lanes];
    lanes[lane] = commit.parents[0] ?? null;
    for (const parent of commit.parents.slice(1)) if (!lanes.includes(parent)) lanes.push(parent);
    lanes = [...new Set(lanes.filter(Boolean))];
    const parentsLanes = commit.parents.map(parent => lanes.indexOf(parent));
    const edges = before.flatMap((sha, from) => sha === commit.sha ? [] : [{ from, to: lanes.indexOf(sha), top: 0 }]);
    edges.push(...parentsLanes.map(to => ({ from: lane, to, top: 18 })));
    return { ...commit, lane, parentsLanes, edges, incoming, width: Math.max(before.length, lanes.length) };
  });
}

export async function buildGitLogHtml(rootPath, opts = {}) {
  const repos = (await collectRepos(rootPath, opts)).map(repo => ({ ...repo, rows: layoutLanes(repo.commits) }));
  const template = await readFile(new URL('./graph.html', import.meta.url), 'utf8');
  const data = JSON.stringify(repos).replace(/<\//g, '<\\/').replace(/</g, '\\u003c');
  const title = String(opts.title ?? `Git Log Graph — ${resolve(rootPath)}`)
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return template.replace('__ORCA_GIT_LOG_TITLE__', () => title)
    .replace('/*__ORCA_GIT_LOG_DATA__*/', () => data);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [rootPath, ...args] = process.argv.slice(2);
    if (!rootPath || rootPath.startsWith('--')) throw new Error('Usage: node viz.mjs <repoPath> [--limit N] [--out file.html]');
    const opts = {};
    let out;
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i + 1] || !['--limit', '--out'].includes(args[i])) throw new Error('Expected --limit N or --out file.html');
      if (args[i] === '--limit') opts.limit = Number(args[i + 1]);
      else out = resolve(args[i + 1]);
    }
    out ??= join(tmpdir(), 'orca-git-log-graph', `${createHash('sha1').update(resolve(rootPath)).digest('hex')}.html`);
    const html = await buildGitLogHtml(rootPath, opts);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, html);
    console.log(out);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
