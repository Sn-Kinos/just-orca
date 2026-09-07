import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function collectRepos(rootPath, { limit = 500 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const root = resolve(rootPath);
  await access(root).catch(() => { throw new Error(`Repository path not found: ${root}`); });
  const git = async (cwd, ...args) => (await promisify(execFile)('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const names = ['.', ...(await git(root, 'submodule', 'foreach', '--recursive', '-q', 'echo "$displaypath"')).split('\n').filter(Boolean)];
  const pins = new Map();
  const repos = [];
  for (const name of names) {
    const path = name === '.' ? root : resolve(root, name);
    const repo = { name, path, pinnedSha: pins.get(name) ?? null, head: '', commits: [] };
    repos.push(repo);
    try {
      if (name !== '.') {
        try { await access(join(path, '.git')); }
        catch { throw new Error('Submodule is uninitialized (no .git); run git submodule update --init --recursive'); }
      }
      const log = await git(path, 'log', '--all', '--date-order', '-n', String(limit), '--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s');
      repo.commits = log.split('\n').filter(Boolean).map(line => {
        const [sha, parents, author, ts, refs, ...subject] = line.split('\x1f');
        return { sha, parents: parents ? parents.split(' ') : [], author, ts: Number(ts), refs: refs ? refs.split(', ').map(ref => ref.replace(/^HEAD -> /, '')) : [], subject: subject.join('\x1f') };
      });
      try { repo.head = (await git(path, 'rev-parse', '--verify', 'HEAD')).trim(); }
      catch { if (repo.commits.length) throw new Error('Cannot resolve repository HEAD'); }
      if (!repo.head) continue;
      // foreach omits uninitialized modules; HEAD gitlinks supply their names and pins.
      for (const entry of (await git(path, 'ls-tree', '-r', '-z', 'HEAD')).split('\0')) {
        const match = /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
        if (!match) continue;
        const child = name === '.' ? match[2] : `${name}/${match[2]}`;
        pins.set(child, match[1]);
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

export function renderHtml(repos, { title = 'Git Log Graph' } = {}) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const colors = ['#3b82f6', '#e87924', '#16a085', '#b56be3', '#e0527b', '#9b9423', '#00a6b2', '#8d7768'];
  const data = repos.map(repo => {
    let lanes = [];
    // ponytail: O(rows × lanes), capped at limit commits per repo; add incremental loading for larger histories.
    const rows = repo.commits.map(commit => {
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
    return { ...repo, rows };
  });
  const sections = data.map(repo => {
    const head = repo.commits.find(commit => commit.sha === repo.head);
    const branch = head?.refs.find(ref => ref !== 'HEAD' && !ref.startsWith('tag: ')) ?? (repo.head.slice(0, 8) || (repo.error ? 'unavailable' : 'unborn'));
    const width = Math.max(1, ...repo.rows.map(row => row.width)) * 20 + 16;
    const rows = repo.rows.map(row => {
      const x = lane => 16 + lane * 20;
      const paths = row.edges.map(edge => `<path stroke="${colors[edge.from % 8]}" d="M${x(edge.from)},${edge.top} C${x(edge.from)},27 ${x(edge.to)},27 ${x(edge.to)},36"/>`).join('');
      const refs = [...(row.sha === repo.head ? ['HEAD'] : []), ...row.refs.filter(ref => ref !== 'HEAD')].map(ref => `<span class="badge ${ref === 'HEAD' ? 'head' : ref.startsWith('tag: ') ? 'tag' : 'branch'}">${escape(ref)}</span>`).join('');
      return `<div class="row${row.sha === repo.pinnedSha ? ' pinned' : ''}" data-sha="${escape(row.sha)}" data-parent-lanes="${row.parentsLanes.join(',')}" data-search="${escape(`${row.sha} ${row.author} ${row.subject}`.toLowerCase())}"><svg width="${width}" height="36" aria-hidden="true" fill="none" stroke-width="2">${paths}${row.incoming ? `<path stroke="${colors[row.lane % 8]}" d="M${x(row.lane)},0 V18"/>` : ''}<circle cx="${x(row.lane)}" cy="18" r="4" fill="${colors[row.lane % 8]}"/></svg><div class="text"><button class="sha" data-copy="${escape(row.sha)}" title="Copy full commit SHA">${escape(row.sha.slice(0, 8))}</button>${refs}${row.sha === repo.pinnedSha ? '<span class="badge pin">superproject HEAD</span>' : ''}<span class="subject">${escape(row.subject)}</span><span class="author">${escape(row.author)}</span><time data-ts="${row.ts}" title="${escape(new Date(row.ts * 1000).toISOString())}">${escape(new Date(row.ts * 1000).toISOString().slice(0, 10))}</time></div></div>`;
    }).join('\n');
    return `<section data-repo="${escape(repo.name)}"><details open><summary>${escape(repo.name)} · ${escape(branch)} · ${repo.commits.length} commits</summary><div class="history">${repo.error ? `<p role="alert">${escape(repo.error)}</p>` : rows || '<p>No commits</p>'}</div></details></section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#20242c;--muted:#626976;--line:#dce0e6;--badge:#e5eaf1;--pin:#fff0c4}
@media(prefers-color-scheme:dark){:root{--bg:#15181e;--fg:#e0e5ed;--muted:#a2abba;--line:#303744;--badge:#293242;--pin:#40371e}}
*{box-sizing:border-box}body{margin:24px;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}h1{font-size:22px}input{padding:9px;width:min(100%,480px);margin:8px 0 20px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--fg)}section{margin-bottom:16px;border:1px solid var(--line);border-radius:6px}summary{padding:12px;cursor:pointer;font-weight:600}.history{overflow-x:auto;padding:0 12px 12px}.row{display:flex;height:36px;min-width:max-content;align-items:center}.row svg{flex-shrink:0}.text{display:flex;align-items:center;gap:8px;flex:1;height:100%;white-space:nowrap}.row.filtered .text{opacity:.15}.pinned{background:var(--pin)}.badge{background:var(--badge);border-radius:4px;padding:2px 5px;font-size:12px}.head{color:#b56be3}.branch{border-left:3px solid #3b82f6}.tag{border-left:3px solid #e87924}.pin{font-weight:600}.subject{min-width:220px;flex:1}.author,time{color:var(--muted);font-size:12px}.author{margin-left:20px}time{width:105px;text-align:right}.sha{border:0;background:none;color:var(--fg);font:12px monospace;cursor:pointer;padding:4px}.sha:hover{text-decoration:underline}button:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}#status{margin-left:12px;font-size:12px}
</style><h1>${escape(title)}</h1><label for="filter">Filter commits</label><br><input id="filter" type="search" placeholder="Author, subject or SHA"><span id="status" role="status"></span><main>${sections}</main>
<script id="repos" type="application/json">${JSON.stringify(data).replace(/<\//g, '<\\/').replace(/</g, '\\u003c')}</script>
<script>
const rows = [...document.querySelectorAll('.row')];
document.querySelector('#filter').addEventListener('input', event => {
  const query = event.target.value.toLowerCase();
  rows.forEach(row => row.classList.toggle('filtered', !row.dataset.search.includes(query)));
});
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
for (const time of document.querySelectorAll('time')) {
  const seconds = Number(time.dataset.ts) - Date.now() / 1000;
  const [unit, size] = Math.abs(seconds) >= 86400 ? ['day',86400] : Math.abs(seconds) >= 3600 ? ['hour',3600] : ['minute',60];
  time.textContent = relative.format(Math.round(seconds / size), unit);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const status = document.querySelector('#status');
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    status.textContent = 'Copied ' + button.dataset.copy;
  } catch {
    const input = document.createElement('textarea');
    input.value = button.dataset.copy;
    document.body.append(input);
    input.select();
    status.textContent = document.execCommand('copy') ? 'Copied ' + input.value : 'Copy failed: ' + input.value;
    input.remove();
    button.focus();
  }
});
</script></html>`;
}

export async function buildGitLogHtml(rootPath, opts = {}) {
  return renderHtml(await collectRepos(rootPath, opts), { title: opts.title ?? `Git Log Graph — ${resolve(rootPath)}` });
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
