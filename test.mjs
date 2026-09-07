import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepos, renderHtml, buildGitLogHtml } from './viz.mjs';

const temp = await mkdtemp(join(tmpdir(), 'git-log-graph-test-'));
const root = join(temp, 'super project');
const sub = join(temp, 'sub source');
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
  for (const sha of [...(await git(root, 'rev-list', '--all')).split('\n'), pinned, subTip]) assert.ok(html.includes(sha), sha);
  assert.ok(html.includes('<section data-repo=".">'));
  assert.ok(html.includes('<section data-repo="libs/sub module">'));
  const pinnedRow = html.split('\n').find(line => line.includes(`data-sha="${pinned}"`));
  assert.ok(pinnedRow.includes('superproject HEAD'));
  assert.ok(pinnedRow.includes('row pinned'));
  const mergeRow = html.split('\n').find(line => line.includes(`data-sha="${merge}"`));
  assert.equal(mergeRow.match(/data-parent-lanes="([^"]*)"/)[1].split(',').length, 2);
  const data = JSON.parse(html.match(/<script id="repos" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data[1].pinnedSha, pinned);
  assert.equal(data[1].commits.length, 2);
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('&lt;/script&gt;'));
  for (const repo of data) for (let i = 0; i < repo.rows.length - 1; i++) {
    const row = repo.rows[i];
    assert.ok(row.parentsLanes.every(lane => lane >= 0));
    if (row.parents.includes(repo.rows[i + 1].sha)) assert.equal(row.parentsLanes[row.parents.indexOf(repo.rows[i + 1].sha)], repo.rows[i + 1].lane);
  }
  assert.ok((await collectRepos(root, { limit: 1 })).every(repo => repo.commits.length === 1));
  await assert.rejects(collectRepos(root, { limit: 0 }), /positive integer/);
  assert.ok(renderHtml([], { title: '<test>' }).includes('<title>&lt;test&gt;</title>'));

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
  await git(root, 'submodule', 'deinit', '-f', '--', 'libs/sub module');
  const uninitialized = await collectRepos(root);
  assert.equal(uninitialized[0].name, '.');
  assert.ok(uninitialized[0].commits.length);
  assert.equal(uninitialized[1].pinnedSha, pinned);
  assert.deepEqual(uninitialized[1].commits, []);
  assert.ok(uninitialized[1].error.includes('uninitialized'));
  console.log('test.mjs: all checks passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
