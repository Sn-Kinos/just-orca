import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { collectRepos, layoutLanes, buildGitLogHtml } from './viz.mjs';
import { startServer } from './serve.mjs';

const temp = await mkdtemp(join(tmpdir(), 'git-log-graph-test-'));
const root = join(temp, 'super project');
const sub = join(temp, 'sub source');
let server;
const git = async (cwd, ...args) => (await promisify(execFile)('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const init = async path => {
  await mkdir(path);
  await git(path, 'init', '-b', 'main');
  await git(path, 'config', 'user.name', 'Graph Tester');
  await git(path, 'config', 'user.email', 'graph@example.test');
  await git(path, 'config', 'commit.gpgsign', 'false');
};
try {
  await init(sub);
  await git(sub, 'commit', '--allow-empty', '-m', 'sub first');
  const pinned = await git(sub, 'rev-parse', 'HEAD');
  await git(sub, 'commit', '--allow-empty', '-m', 'sub second');
  const subTip = await git(sub, 'rev-parse', 'HEAD');
  await init(root);
  await git(root, 'commit', '--allow-empty', '-m', 'root first');
  await git(root, 'checkout', '-b', 'feature');
  await writeFile(join(root, 'feature'), 'feature');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'feature </script><script>alert(1)</script>');
  await git(root, 'checkout', 'main');
  await writeFile(join(root, 'main'), 'main');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'main second');
  await git(root, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  const merge = await git(root, 'rev-parse', 'HEAD');
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'libs/sub module');
  await git(join(root, 'libs/sub module'), 'checkout', pinned);
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'pin submodule');

  const html = await buildGitLogHtml(root);
  const json = html.match(/<script id="repos" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const data = JSON.parse(json);
  const shas = data.flatMap(repo => repo.rows.map(row => row.sha));
  for (const sha of [...(await git(root, 'rev-list', '--all')).split('\n'), pinned, subTip]) assert.ok(shas.includes(sha), sha);
  assert.deepEqual(data.map(repo => repo.name), ['.', 'libs/sub module']);
  const pinnedRow = data[1].rows.find(row => row.sha === data[1].pinnedSha);
  assert.equal(pinnedRow.sha, pinned);
  const mergeRow = data[0].rows.find(row => row.sha === merge);
  assert.equal(mergeRow.parentsLanes.length, 2);
  assert.equal(data[1].pinnedSha, pinned);
  assert.equal(data[1].commits.length, 2);
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(!json.includes('<'));
  assert.ok(data[0].rows.some(row => row.subject === 'feature </script><script>alert(1)</script>'));
  assert.ok(!html.includes('__ORCA_GIT_LOG_DATA__'));
  assert.ok(!html.includes('__ORCA_GIT_LOG_TITLE__'));
  const template = await readFile(new URL('./graph.html', import.meta.url), 'utf8');
  assert.ok(template.includes('No data — run'));
  assert.ok(template.includes('<script id="repos" type="application/json">/*__ORCA_GIT_LOG_DATA__*/</script>'));
  assert.deepEqual(layoutLanes([]), []);
  for (const repo of data) assert.deepEqual(repo.rows, layoutLanes(repo.commits));
  for (const repo of data) for (let i = 0; i < repo.rows.length - 1; i++) {
    const row = repo.rows[i];
    assert.ok(row.parentsLanes.every(lane => lane >= 0));
    if (row.parents.includes(repo.rows[i + 1].sha)) assert.equal(row.parentsLanes[row.parents.indexOf(repo.rows[i + 1].sha)], repo.rows[i + 1].lane);
  }
  assert.ok((await collectRepos(root, { limit: 1 })).every(repo => repo.commits.length === 1));
  await assert.rejects(collectRepos(root, { limit: 0 }), /positive integer/);
  assert.ok((await buildGitLogHtml(root, { title: '<test> $&' })).includes('<title>&lt;test&gt; $&amp;</title>'));

  const stateFile = join(temp, 'server', 'state.json');
  server = await startServer({ stateFile, idleMs: 60000 });
  const base = `http://127.0.0.1:${server.port}`;
  const request = async (path, options) => {
    const response = await fetch(base + path, options);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    return response;
  };
  const register = body => request('/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['pid', 'port', 'startedAt']);
  assert.equal(state.pid, process.pid);
  assert.equal(state.port, server.port);
  assert.ok(Number.isFinite(Date.parse(state.startedAt)));
  assert.deepEqual(await (await request('/health')).json(), { ok: true, pid: process.pid });
  const registration = await register({ path: root });
  assert.equal(registration.status, 200);
  const { id } = await registration.json();
  assert.equal(id, createHash('sha1').update(root).digest('hex'));
  assert.deepEqual(await (await register({ path: root + '/.' })).json(), { id });
  const response = await request(`/data?repo=${id}`, { headers: { Origin: 'https://example.test' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), {
    title: `Git Log Graph — ${root}`,
    repos: (await collectRepos(root)).map(repo => ({ ...repo, rows: layoutLanes(repo.commits) }))
  });
  const limited = await (await request(`/data?repo=${id}&limit=1`)).json();
  assert.ok(limited.repos.every(repo => repo.commits.length === 1 && repo.rows.length === 1));
  for (const limit of ['0', '-1', '1.5', 'nope', '']) {
    assert.equal((await request(`/data?repo=${id}&limit=${limit}`)).status, 400);
  }
  const page = await request(`/?repo=${id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const servedHtml = await page.text();
  assert.ok(servedHtml.includes('id="repos"'));
  assert.equal(servedHtml, template);
  for (const path of ['/data?repo=unknown', '/?repo=unknown', '/data', '/', `/missing?repo=${id}`]) {
    assert.equal((await request(path)).status, 404);
  }
  for (const body of [{ path: join(temp, 'missing') }, {}, null, { path: '' }, { path: 42 }]) {
    const invalid = await register(body);
    assert.equal(invalid.status, 400);
    assert.ok((await invalid.json()).error);
  }
  assert.equal((await request('/register', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await register({ path: 'x'.repeat(128 * 1024) })).status, 400);
  const nonRepo = await (await register({ path: temp })).json();
  const failure = await request(`/data?repo=${nonRepo.id}`);
  assert.equal(failure.status, 500);
  assert.ok((await failure.json()).error);
  await git(root, 'commit', '--allow-empty', '-m', 'live refresh');
  const refreshed = await (await request(`/data?repo=${id}`)).json();
  assert.equal(refreshed.repos[0].head, await git(root, 'rev-parse', 'HEAD'));
  assert.ok(refreshed.repos[0].commits.some(commit => commit.subject === 'live refresh'));
  await server.close();
  await assert.rejects(fetch(`${base}/health`));

  // Exercise enclosing-parent pins for recursive modules before deinitializing.
  const checkedSub = join(root, 'libs/sub module');
  await git(checkedSub, 'config', 'user.name', 'Graph Tester');
  await git(checkedSub, 'config', 'user.email', 'graph@example.test');
  await git(checkedSub, 'config', 'commit.gpgsign', 'false');
  await git(checkedSub, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'nested');
  await git(checkedSub, 'commit', '-am', 'nested submodule');
  const nested = await collectRepos(root);
  assert.deepEqual(nested.map(repo => repo.name), ['.', 'libs/sub module', 'libs/sub module/nested']);
  assert.equal(nested[1].pinnedSha, pinned);
  assert.equal(nested[2].pinnedSha, subTip);
  await git(checkedSub, 'submodule', 'deinit', '-f', '--', 'nested');
  assert.ok((await collectRepos(root))[2].error.includes('uninitialized'));
  // A stray gitlink (committed without .gitmodules) must be reported, not abort the whole scan.
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${subTip},stray/link`);
  await git(root, 'commit', '-m', 'stray gitlink');
  const stray = (await collectRepos(root)).find(repo => repo.name === 'stray/link');
  assert.ok(stray.error.includes('not registered'));
  assert.deepEqual(stray.commits, []);
  await git(root, 'submodule', 'deinit', '-f', '--', 'libs/sub module');
  const uninitialized = await collectRepos(root);
  assert.equal(uninitialized[0].name, '.');
  assert.ok(uninitialized[0].commits.length);
  assert.equal(uninitialized[1].pinnedSha, pinned);
  assert.deepEqual(uninitialized[1].commits, []);
  assert.ok(uninitialized[1].error.includes('uninitialized'));

  server = await startServer({ stateFile, idleMs: 1000 });
  const healthUrl = `http://127.0.0.1:${server.port}/health`;
  await delay(600);
  assert.equal((await fetch(healthUrl)).status, 200);
  await delay(600);
  assert.equal((await fetch(healthUrl)).status, 200, 'requests reset the idle timer');
  await delay(1200);
  await assert.rejects(fetch(healthUrl), 'idle server stops listening');
  console.log('test.mjs: all checks passed');
} finally {
  await server?.close();
  await rm(temp, { recursive: true, force: true });
}
