import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { collectRepos, layoutLanes } = await import(new URL('./viz.mjs', import.meta.url));
export const DEFAULT_STATE_FILE = join(tmpdir(), 'orca-git-log-graph', 'server.json');

// ponytail: fixed 60-minute idle timeout; add a user setting if longer sessions need it.
export async function startServer({ stateFile = DEFAULT_STATE_FILE, idleMs = 60 * 60 * 1000 } = {}) {
  const paths = new Map();
  let idleTimer;
  const server = createServer(async (request, response) => {
    idleTimer?.refresh();
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true, pid: process.pid, root: fileURLToPath(new URL('.', import.meta.url)) });
      }
      if (request.method === 'POST' && url.pathname === '/register') {
        let path;
        try {
          let body = '';
          request.setEncoding('utf8');
          for await (const chunk of request) {
            if (body.length <= 64 * 1024) body += chunk;
          }
          if (body.length > 64 * 1024) throw new Error('Registration body is too large');
          const input = JSON.parse(body);
          if (typeof input?.path !== 'string' || !input.path.trim()) throw new Error('path is required');
          path = resolve(input.path);
          await access(path);
        } catch (error) {
          return send(400, { error: error.message });
        }
        const id = createHash('sha1').update(path).digest('hex');
        paths.set(id, path);
        return send(200, { id });
      }
      const path = paths.get(url.searchParams.get('repo'));
      if (!path) return send(404, { error: 'Not found' });
      if (request.method === 'GET' && url.pathname === '/') {
        return send(200, await readFile(new URL('./graph.html', import.meta.url), 'utf8'), 'text/html; charset=utf-8');
      }
      if (['GET', 'POST'].includes(request.method) && url.pathname === '/data') {
        let options = { limit: Number(url.searchParams.get('limit') ?? 500) };
        if (request.method === 'POST') {
          try {
            let body = '';
            let bytes = 0;
            request.setEncoding('utf8');
            for await (const chunk of request) {
              bytes += Buffer.byteLength(chunk);
              if (bytes <= 256 * 1024) body += chunk;
            }
            if (bytes > 256 * 1024) throw new Error('Data body is too large');
            options = JSON.parse(body);
            if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Expected a JSON object');
            if (options.refs !== undefined && (!options.refs || typeof options.refs !== 'object' || Array.isArray(options.refs)
              || !Object.values(options.refs).every(refs => Array.isArray(refs) && refs.every(ref => typeof ref === 'string')))) {
              throw new Error('refs must map repository names to arrays of strings');
            }
          } catch (error) {
            return send(400, { error: error.message });
          }
        }
        const { limit = 500, refs } = options;
        if (!Number.isSafeInteger(limit) || limit < 1) return send(400, { error: 'limit must be a positive integer' });
        const repos = (await collectRepos(path, { limit, refs })).map(repo => ({ ...repo, rows: layoutLanes(repo.commits) }));
        return send(200, { title: `Git Log Graph — ${path}`, repos });
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      send(500, { error: error.message });
    }
  });
  let closing;
  const close = () => {
    clearTimeout(idleTimer);
    return closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  } catch (error) {
    await close();
    throw error;
  }
  idleTimer = setTimeout(() => { close().catch(console.error); }, idleMs);
  return { port, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--state' || !args[1])) {
      throw new Error('Usage: node serve.mjs [--state <file>]');
    }
    const { port } = await startServer({ stateFile: args[1] });
    console.log(`Git Log Graph: http://127.0.0.1:${port}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
