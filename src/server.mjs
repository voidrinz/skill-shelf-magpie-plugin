import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { VERSION, DESKTOP_BASELINE } from './version.mjs';
import { normalizePortablePreferences } from './sync.mjs';
import { validateFinderViewOptions, portableKey } from './sync-format.mjs';

const MAX_BODY = 101 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function headers(response, embeddedBase) {
  const own = embeddedBase || "'self'";
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', embeddedBase ? 'cross-origin' : 'same-origin');
  if (embeddedBase) response.removeHeader('X-Frame-Options');
  else response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', [
    `default-src ${own}`,
    `script-src ${own}`,
    `style-src ${own} 'unsafe-inline'`,
    `font-src ${own}`,
    `img-src ${own} data:`,
    `connect-src ${own}`,
    "object-src 'none'",
    "base-uri 'none'",
    ...(!embeddedBase ? ["frame-ancestors 'none'"] : []),
    "form-action 'self'",
  ].join('; '));
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function body(request, limit = MAX_BODY) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw httpError(415, 'Use application/json for this operation.');
  }
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw httpError(413, 'Request is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(400, 'Request must contain a JSON object.');
  }
}

function matchesToken(value, token) {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.from(value);
  const expected = Buffer.from(token);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

export async function openFolder(directory, { platform = process.platform, execute = execFile } = {}) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  await new Promise((accept, reject) => {
    // Keep the validated directory as one argument, never as shell source.
    execute(command, [directory], { shell: false, windowsHide: true }, (error) => {
      if (error) reject(httpError(502, `Could not open the Skill folder: ${error.message}`));
      else accept();
    });
  });
}

export async function startServer({ service, ai, assistant, skills, sync, access, instructions, sources, discovery, port = 47822, webDir, allowedOrigins = [], opener = openFolder }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw httpError(400, 'Invalid port.');
  if (!service || !webDir) throw new Error('A service and web directory are required.');
  const token = randomBytes(32).toString('hex');
  const embedPath = `/_magpie/${randomBytes(32).toString('hex')}/`;
  const webRoot = await realpath(webDir);
  const snapshot = await service.snapshot();
  const profile = createHash('sha256').update(snapshot.dataDir).digest('hex');
  let actualPort;

  const server = http.createServer(async (request, response) => {
    headers(response);
    try {
      const host = request.headers.host;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!hosts.includes(host)) throw httpError(403, 'Only the local workbench host is allowed.');
      const url = new URL(request.url, `http://${host}`);
      const embedded = url.pathname.startsWith(embedPath);
      if (embedded) {
        headers(response, `http://${host}${embedPath}`);
        url.pathname = '/' + url.pathname.slice(embedPath.length);
        if (request.headers.origin === 'null') {
          response.setHeader('Access-Control-Allow-Origin', 'null');
          response.setHeader('Vary', 'Origin');
        }
        if (request.method === 'OPTIONS' && request.headers.origin === 'null') {
          response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
          response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shelf-Token');
          response.writeHead(204);
          return response.end();
        }
      }
      const origins = [...hosts.map((value) => `http://${value}`), ...allowedOrigins];
      if (request.headers.origin && !origins.includes(request.headers.origin) && !(embedded && request.headers.origin === 'null')) {
        throw httpError(403, 'Cross-origin requests are not allowed.');
      }
      const api = url.pathname.startsWith('/api/') || url.pathname === '/_identity';
      if (api && request.headers['sec-fetch-site'] === 'cross-site' && !embedded) {
        throw httpError(403, 'Cross-site requests are not allowed.');
      }
      if (request.method === 'OPTIONS') throw httpError(403, 'Cross-origin requests are not allowed.');
      if (request.method === 'GET' && url.pathname === '/_identity') {
        return json(response, 200, { product: 'skill-shelf-magpie-plugin', profile, version: VERSION, desktopBaseline: DESKTOP_BASELINE });
      }
      if (request.method === 'GET' && url.pathname === '/api/session') {
        return json(response, 200, { token, ...(!embedded ? { embedUrl: `http://127.0.0.1:${actualPort}${embedPath}` } : {}) });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!matchesToken(request.headers['x-shelf-token'], token)) {
          throw httpError(403, 'Workbench session expired. Reload the page.');
        }
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const method = request.method;
        const operation = `${method} ${parts.slice(0, 2).join('/')}`;
        let result;
        switch (operation) {
          case 'GET api/window-storage':
            if (parts.length === 2) result = service.state.windowStorage ?? {};
            break;
          case 'PUT api/window-storage':
            if (parts.length === 2) {
              const values = await body(request, 1024 * 1024);
              if (Object.entries(values).some(([key, value]) => !key.startsWith('shelf-') || typeof value !== 'string')) throw httpError(400, 'Invalid window preferences.');
              result = await service.mutate(async () => { service.state.windowStorage = values; });
            }
            break;
          case 'POST api/open-url':
            if (parts.length === 2) {
              const target = new URL((await body(request)).url);
              if (!['http:', 'https:'].includes(target.protocol)) throw httpError(400, 'Only web links can be opened.');
              await opener(target.href);
              result = { ok: true };
            }
            break;
          case 'POST api/exports':
            if (parts.length === 2) {
              const input = await body(request);
              if (!['pack', 'sync'].includes(input.type)) throw httpError(400, 'Unknown export type.');
              const document = input.type === 'pack' ? (sync ? await sync.exportPack(input.id) : await service.exportPack(input.id)) : await sync.exportDocument();
              const directory = resolve(snapshot.dataDir, 'exports');
              await mkdir(directory, { recursive: true, mode: 0o700 });
              const file = resolve(directory, `skill-shelf-${Date.now()}-${randomBytes(4).toString('hex')}.skill-shelf-${input.type}.json`);
              await writeFile(file, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' });
              await opener(directory);
              result = { file };
            }
            break;
          case 'GET api/state':
            if (parts.length === 2) result = await service.snapshot();
            break;
          case 'PATCH api/preferences':
            if (parts.length === 2) {
              const preferences = normalizePortablePreferences(await body(request));
              result = await service.mutate(async () => { service.state.portablePreferences = { ...service.state.portablePreferences, ...preferences }; });
            }
            break;
          case 'PATCH api/view-options':
            if (parts.length === 2) {
              const input = await body(request);
              validateFinderViewOptions(input.viewOptions);
              result = await service.mutate(async () => {
                const { scopeId, folderId = null, viewOptions } = input;
                service.scope(scopeId);
                const folder = folderId === null ? null : service.folder(folderId);
                if (folder && folder.scopeId !== scopeId) throw httpError(400, 'Folder is outside the selected scope.');
                if (folder) folder.viewOptions = viewOptions;
                else (service.state.rootViewOptions ??= {})[scopeId] = viewOptions;
                if (scopeId.startsWith('pack:')) {
                  const pack = service.pack(scopeId.slice(5));
                  const names = [];
                  let current = folder;
                  while (current) { names.unshift(portableKey(current.name)); current = current.parentId ? service.folder(current.parentId) : null; }
                  (pack.viewOptions ??= {})[folder ? JSON.stringify(names) : 'root'] = viewOptions;
                }
              });
            }
            break;
          case 'GET api/workbench':
            if (parts.length === 2) result = await service.workbenchSnapshot();
            break;
          case 'POST api/workbench':
            if (parts.length === 3 && parts[2] === 'open-directory') result = await service.openWorkbenchDirectory(await body(request), opener);
            break;
          case 'GET api/agent-access':
            if (parts.length === 2 && access) result = await access.get(url.searchParams.get('id'));
            break;
          case 'POST api/agent-access':
            if (parts.length === 3 && access) {
              const input = await body(request);
              if (parts[2] === 'preview') result = await access.preview(input);
              else if (parts[2] === 'apply') result = await access.apply(input.id);
              else if (parts[2] === 'discard') result = await access.discard(input.id);
              else if (parts[2] === 'open-folder') result = await access.openFolder(input, opener);
            }
            break;
          case 'GET api/skill':
            if (parts.length === 2) result = await service.readSkill(url.searchParams.get('id'));
            else if (parts.length === 3 && parts[2] === 'files') result = await service.skillFiles(url.searchParams.get('id'));
            else if (parts.length === 3 && parts[2] === 'file') result = await service.readSkillFile(url.searchParams.get('id'), url.searchParams.get('path'));
            break;
          case 'POST api/skill':
            if (parts.length === 3 && parts[2] === 'open-folder') result = await service.openSkillFolder(await body(request), opener);
            break;
          case 'POST api/rescan':
            if (parts.length === 2) { await body(request); result = await service.rescan(); }
            break;
          case 'GET api/skills':
            if (parts.length === 4 && parts[2] === 'install' && sources) {
              if (parts[3] === 'agents') result = sources.agents();
              else if (parts[3] === 'status') result = sources.status();
            }
            if (parts.length === 3 && parts[2] === 'status') {
              if (!skills) throw httpError(503, 'Skill 服务暂不可用。');
              result = skills.status();
            }
            break;
          case 'POST api/skills':
            if (sources && parts.length === 3 && ['install', 'remove'].includes(parts[2])) {
              const input = await body(request);
              result = parts[2] === 'install' ? await sources.install(input) : await sources.remove(input);
            } else if (sources && parts.length === 4 && parts[2] === 'remove' && parts[3] === 'preview') {
              result = await sources.previewRemoval(await body(request));
            }
            if (parts.length === 3 && ['scan', 'update'].includes(parts[2])) {
              if (!skills) throw httpError(503, 'Skill 服务暂不可用。');
              const input = await body(request);
              result = parts[2] === 'scan' ? await skills.scanUpdates() : await skills.update(input);
            }
            break;
          case 'GET api/discovery':
            if (parts.length === 3 && parts[2] === 'catalog' && discovery) result = await discovery.catalog({
              section: url.searchParams.get('section') || 'all', query: url.searchParams.get('query') || '',
              path: url.searchParams.get('path') || undefined, refresh: url.searchParams.get('refresh') === 'true',
            });
            break;
          case 'POST api/discovery':
            if (parts.length === 3 && parts[2] === 'detail' && discovery) result = await discovery.detail(await body(request));
            break;
          case 'POST api/roots':
            if (parts.length === 2) result = await service.addRoot(await body(request));
            break;
          case 'DELETE api/roots':
            if (parts.length === 3) result = await service.removeRoot(parts[2]);
            break;
          case 'POST api/projects':
            if (parts.length === 2) result = await service.addProject(await body(request));
            else if (parts.length === 5 && parts[3] === 'instructions' && parts[4] === 'claude' && instructions) {
              const input = await body(request);
              result = await service.read(() => instructions.connectClaude({ ...input, projectId: parts[2] }));
            }
            break;
          case 'GET api/projects':
            if (parts.length === 4 && parts[3] === 'instructions' && instructions) result = await service.read(() => instructions.get(parts[2]));
            break;
          case 'PUT api/projects':
            if (parts.length === 4 && parts[3] === 'instructions' && instructions) {
              const input = await body(request);
              result = await service.read(() => instructions.save({ ...input, projectId: parts[2] }));
            }
            break;
          case 'DELETE api/projects':
            if (parts.length === 3) result = await service.removeProject(parts[2]);
            break;
          case 'POST api/folders':
            if (parts.length === 2) result = await service.createFolder(await body(request));
            break;
          case 'PATCH api/folders':
            if (parts.length === 3) result = await service.updateFolder(parts[2], await body(request));
            break;
          case 'DELETE api/folders':
            if (parts.length === 3) result = await service.deleteFolder(parts[2]);
            break;
          case 'PATCH api/organization':
            if (parts.length === 2) result = await service.organize(await body(request));
            break;
          case 'PATCH api/finder':
            if (parts.length === 2) result = await service.layout(await body(request));
            break;
          case 'GET api/ai':
            if (parts.length === 3 && parts[2] === 'status') {
              result = ai ? await ai.status() : { available: false, baseUrl: '', models: [], reason: 'Magpie AI bridge is not running.' };
            } else if (parts.length === 3 && parts[2] === 'result') {
              if (!ai) throw httpError(503, 'Magpie AI bridge is not running.');
              result = await ai.results(url.searchParams.get('id'));
            } else if (parts.length === 3 && parts[2] === 'annotations') {
              if (!ai) throw httpError(503, 'Magpie AI bridge is not running.');
              result = await ai.list();
            } else if (parts.length === 3 && ['chat', 'conversations'].includes(parts[2])) {
              if (!assistant) throw httpError(503, 'Skill 助手暂不可用。');
              const id = url.searchParams.get('id');
              result = parts[2] === 'chat' ? assistant.get(id) : id ? await assistant.getConversation(id) : await assistant.listConversations();
            }
            break;
          case 'POST api/ai':
            if (parts.length === 3 && ['generate', 'save', 'source-copy'].includes(parts[2])) {
              if (!ai) throw httpError(503, 'Magpie AI bridge is not running.');
              const input = await body(request);
              const controller = new AbortController();
              response.once('close', () => { if (!response.writableEnded) controller.abort(); });
              result = parts[2] === 'generate' ? await ai.generate(input, { signal: controller.signal })
                : parts[2] === 'source-copy' ? await ai.saveSourceCopy(input, { signal: controller.signal })
                : await ai.save(input, { signal: controller.signal });
            } else if ((parts.length === 3 && ['chat', 'conversations'].includes(parts[2])) || (parts.length === 4 && parts[2] === 'chat' && parts[3] === 'stop')) {
              if (!assistant) throw httpError(503, 'Skill 助手暂不可用。');
              const input = await body(request);
              result = parts[2] === 'conversations' ? await assistant.saveConversation(input) : parts.length === 4 ? assistant.stop(input) : await assistant.start(input);
            }
            break;
          case 'DELETE api/ai':
            if (parts.length === 4 && parts[2] === 'conversations') {
              if (!assistant) throw httpError(503, 'Skill 助手暂不可用。');
              result = await assistant.deleteConversation(parts[3]);
            }
            break;
          case 'GET api/sync':
            if (parts.length === 3 && ['export', 'webdav'].includes(parts[2])) {
              if (!sync) throw httpError(503, 'Skill Shelf sync is not running.');
              if (parts[2] === 'export') {
                response.setHeader('Content-Disposition', 'attachment; filename="skill-shelf-sync.json"');
                result = await sync.exportDocument();
              } else result = await sync.webdav.getStatus();
            }
            break;
          case 'POST api/sync':
            if (parts.length === 3 && ['webdav', 'test', 'preview', 'pull', 'upload', 'apply'].includes(parts[2])) {
              if (!sync) throw httpError(503, 'Skill Shelf sync is not running.');
              // Desktop v5 snapshots can exceed the ordinary Pack/API body limit.
              const input = await body(request, parts[2] === 'preview' ? 100 * 1024 * 1024 + 1024 : MAX_BODY);
              switch (parts[2]) {
                case 'webdav': result = await sync.webdav.save(input); sync.invalidatePreviews(); break;
                case 'test': await sync.webdav.test(); result = { connected: true }; break;
                case 'preview': result = await sync.previewImport(input.document); break;
                case 'pull': result = await sync.previewPull(); break;
                case 'upload': result = await sync.previewUpload(); break;
                case 'apply': result = await sync.apply(input); break;
              }
            }
            break;
          case 'POST api/packs':
            if (parts.length === 2) result = await service.createPack(await body(request));
            else if (parts.length === 3 && parts[2] === 'preview' && sync) {
              result = await sync.previewPack((await body(request)).document);
            }
            else if (parts.length === 3 && parts[2] === 'import') {
              result = await service.importPack((await body(request)).document);
            } else if (parts.length === 4 && parts[3] === 'skills') {
              result = await service.importSkills(parts[2], await body(request));
            }
            break;
          case 'PATCH api/packs':
            if (parts.length === 3) result = await service.updatePack(parts[2], await body(request));
            break;
          case 'DELETE api/packs':
            if (parts.length === 3) result = await service.deletePack(parts[2]);
            break;
          case 'GET api/packs':
            if (parts.length === 4 && parts[3] === 'export') {
              const document = sync ? await sync.exportPack(parts[2]) : await service.exportPack(parts[2]);
              response.setHeader('Content-Disposition', 'attachment; filename="skill-shelf-pack.json"');
              return json(response, 200, document);
            }
            break;
          case 'DELETE api/managed':
            if (parts.length === 3) result = await service.deleteManagedSkill(parts[2]);
            break;
          case 'POST api/deploy':
            if (parts.length === 2) result = await service.deploy(await body(request));
            break;
          case 'POST api/deployments':
            if (parts.length === 3 && parts[2] === 'remove') result = await service.removeDeployment(await body(request));
            break;
        }
        if (result === undefined) throw httpError(404, 'Unknown workbench operation.');
        return json(response, 200, result);
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw httpError(405, 'Method not allowed.');
      let raw;
      try { raw = decodeURIComponent(embedded ? '/' + request.url.split('?')[0].slice(embedPath.length) : (request.url || '/').split('?')[0]); }
      catch { throw httpError(400, 'Invalid path.'); }
      if (raw.includes('\\') || raw.includes('\0') || raw.split('/').some((part) => part === '..' || part === '.')) {
        throw httpError(400, 'Invalid path.');
      }
      const filename = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
      const candidate = resolve(webRoot, filename);
      const rel = relative(webRoot, candidate);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw httpError(404, 'File not found.');
      let file;
      try {
        file = await realpath(candidate);
        const realRelative = relative(webRoot, file);
        if (realRelative.startsWith('..') || isAbsolute(realRelative) || !(await stat(file)).isFile()) {
          throw new Error();
        }
      } catch { throw httpError(404, 'File not found.'); }
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (status === 500) console.error('Skill Shelf operation failed:', error.message);
      json(response, status, { error: status === 500 ? 'Local operation failed. Check the plugin log.' : error.message });
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); });
  });
  actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((accept, reject) => {
      assistant?.close();
      ai?.close?.();
      skills?.close?.();
      sources?.close?.();
      discovery?.close?.();
      server.close((error) => error ? reject(error) : accept());
      server.closeIdleConnections?.();
    }),
  };
}
