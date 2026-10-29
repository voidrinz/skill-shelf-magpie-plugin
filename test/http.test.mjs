import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile, readdir, mkdir, symlink, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ShelfService } from '../src/domain.mjs';
import { AIBridge } from '../src/ai.mjs';
import { SyncService } from '../src/sync.mjs';
import { WebDavSyncService } from '../src/webdav.mjs';
import { startServer, openFolder } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';
import { createFixture, MOCK_SUMMARY, MOCK_TRANSLATION } from '../scripts/test-fixtures.mjs';

async function setup(t, { gateway = false, opener } = {}) {
  const fixture = await createFixture({ gateway });
  t.after(fixture.cleanup);
  const webDir = path.join(fixture.root, 'web');
  await mkdir(webDir);
  await writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>Fixture workbench</title>');
  await writeFile(path.join(webDir, 'app.js'), 'console.log("fixture");');
  const service = new ShelfService(fixture);
  await service.initialize();
  const ai = gateway ? new AIBridge({ service, magpieDir: fixture.magpieDir, gatewayUrl: fixture.gateway.url }) : undefined;
  const sync = new SyncService({ service, webdav: new WebDavSyncService(path.join(fixture.dataDir, 'webdav-sync.json')) });
  const instance = await startServer({ service, ai, sync, port: 0, webDir, opener });
  t.after(() => instance.close());
  const base = instance.url.replace(/\/$/, '');
  const session = await fetch(`${base}/api/session`);
  assert.equal(session.status, 200);
  const { token } = await session.json();
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 24);
  const api = async (route, { method = 'GET', body, headers } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'X-Shelf-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    return { response, data };
  };
  return { ...fixture, ...instance, service, base, token, api };
}

function rawGet(base, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(base), { path: route, method: 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
}

function aiReference(content) {
  const bounded = content.match(/BEGIN_UNTRUSTED_SKILL_REFERENCE_JSON\n([^\n]*)\nEND_UNTRUSTED_SKILL_REFERENCE_JSON/);
  return JSON.parse(bounded ? bounded[1] : content).untrustedReference;
}

test('HTTP sync requires authentication, previews before merging, and never exports machine credentials', async t => {
  const shelf = await setup(t);
  const state = (await shelf.api('/api/state')).data;
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research');
  await shelf.service.importSkills('default', { skillIds: [alpha.id] });
  const exported = await shelf.api('/api/sync/export');
  assert.equal(exported.response.status, 200);
  assert.equal(exported.data.format, 'skill-shelf-metadata');
  assert.equal(exported.data.version, 5);
  assert.equal(exported.data.managedSkills.length, 1);
  const serialized = JSON.stringify(exported.data);
  assert.ok(!serialized.includes(shelf.homeDir));
  assert.ok(!serialized.includes('not-real-secret'));
  assert.equal((await shelf.api('/api/sync/export', { headers: { 'X-Shelf-Token': '' } })).response.status, 403);
  assert.equal((await shelf.api('/api/sync/export', { headers: { Origin: 'https://attacker.invalid' } })).response.status, 403);
  assert.equal((await shelf.api('/api/sync/extra')).response.status, 404);
  const before = await readFile(path.join(shelf.dataDir, 'state.json'));
  const document = structuredClone(exported.data);
  document.packs.push({ name: 'Imported empty Pack', description: 'HTTP fixture', folders: [{ path: ['Reading'], color: '#123abc', position: null }], skills: [] });
  const preview = await shelf.api('/api/sync/preview', { method: 'POST', body: { document } });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.mode, 'import');
  assert.deepEqual(await readFile(path.join(shelf.dataDir, 'state.json')), before);
  const applied = await shelf.api('/api/sync/apply', { method: 'POST', body: { previewId: preview.data.id, resolutions: {} } });
  assert.equal(applied.response.status, 200);
  assert.ok(applied.data.snapshot.packs.some(pack => pack.name === 'Imported empty Pack'));
  assert.equal((await shelf.api('/api/sync/apply', { method: 'POST', body: { previewId: preview.data.id, resolutions: {} } })).response.status, 409);
  assert.equal((await shelf.api('/api/sync/preview', { method: 'POST', body: { document: { format: 'skill-shelf-pack', version: 1 } } })).response.status, 400);
  assert.equal(await readFile(path.join(shelf.alpha, 'SKILL.md'), 'utf8'), shelf.alphaText);
});

test('HTTP saved sync credentials stay private and account saves invalidate old previews without contacting the network', async t => {
  const shelf = await setup(t);
  const document = (await shelf.api('/api/sync/export')).data;
  const preview = (await shelf.api('/api/sync/preview', { method: 'POST', body: { document } })).data;
  const saved = await shelf.api('/api/sync/webdav', { method: 'POST', body: { url: 'https://dav.example.invalid/dav/', username: 'fixture', password: 'fixture-app-password' } });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.hasPassword, true);
  assert.equal(saved.data.passwordNeedsReentry, false);
  assert.ok(!JSON.stringify(saved.data).includes('fixture-app-password'));
  const status = await shelf.api('/api/sync/webdav');
  assert.deepEqual(status.data, saved.data);
  assert.equal((await shelf.api('/api/sync/apply', { method: 'POST', body: { previewId: preview.id, resolutions: {} } })).response.status, 409);
  const exported = await shelf.api('/api/sync/export');
  assert.ok(!JSON.stringify(exported.data).includes('fixture-app-password'));
  assert.equal((await lstat(path.join(shelf.dataDir, 'webdav-sync.json'))).mode & 0o777, 0o600);
});

test('native folder opener uses one literal argument without a shell on each platform and propagates errors', async () => {
  for (const [platform, command, directory] of [
    ['darwin', 'open', '/tmp/Skill Folder ; $(touch injected)'],
    ['win32', 'explorer.exe', 'C:\\Skills\\Folder & "name"'],
    ['linux', 'xdg-open', '/tmp/Skill Folder ; $(touch injected)'],
  ]) {
    let calls = 0;
    await openFolder(directory, { platform, execute: (file, args, options, done) => {
      calls += 1;
      assert.equal(file, command);
      assert.deepEqual(args, [directory]);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      done(null);
    } });
    assert.equal(calls, 1);
  }
  await assert.rejects(openFolder('/tmp/skill', { execute: (_file, _args, _options, done) => {
    done(Object.assign(new Error('Desktop opener is unavailable.'), { code: 'ENOENT' }));
  } }), error => error.status === 502 && /Desktop opener is unavailable/.test(error.message));
});

test('HTTP opens only authenticated scanned or managed Skill folders and never writes sources or symlink aliases', async (t) => {
  const opened = [];
  const shelf = await setup(t, { opener: async directory => { opened.push(directory); } });
  const alias = path.join(shelf.homeDir, '.claude', 'skills', 'alpha-alias');
  await mkdir(path.dirname(alias), { recursive: true });
  await symlink(shelf.alpha, alias);
  const state = (await shelf.api('/api/rescan', { method: 'POST', body: {} })).data;
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research');
  const imported = await shelf.api('/api/packs/default/skills', { method: 'POST', body: { skillIds: [alpha.id] } });
  const managed = imported.data.managedSkills[0];
  const beforeState = await readFile(path.join(shelf.dataDir, 'state.json'));
  const beforeSource = await lstat(path.join(shelf.alpha, 'SKILL.md'));
  const beforeAlias = await lstat(alias);
  for (const skill of [alpha, managed]) {
    const result = await shelf.api('/api/skill/open-folder', { method: 'POST', body: { id: skill.id } });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data, { opened: true });
  }
  assert.deepEqual(opened, [alpha.path, managed.path]);
  assert.deepEqual(await readFile(path.join(shelf.dataDir, 'state.json')), beforeState);
  const afterSource = await lstat(path.join(shelf.alpha, 'SKILL.md'));
  assert.equal(afterSource.mtimeMs, beforeSource.mtimeMs);
  assert.equal(afterSource.mode, beforeSource.mode);
  assert.equal(await readFile(path.join(shelf.alpha, 'SKILL.md'), 'utf8'), shelf.alphaText);
  const afterAlias = await lstat(alias);
  assert.equal(afterAlias.isSymbolicLink(), true);
  assert.equal(afterAlias.ino, beforeAlias.ino);
  assert.equal(afterAlias.mtimeMs, beforeAlias.mtimeMs);
});

test('HTTP folder opening rejects bad permissions, extra arguments, unknown IDs and missing or replaced directories', async (t) => {
  const opened = [];
  const shelf = await setup(t, { opener: async directory => { opened.push(directory); } });
  const alpha = (await shelf.api('/api/state')).data.skills.find(skill => skill.name === 'Alpha Research');
  const route = '/api/skill/open-folder';
  const input = { id: alpha.id };
  const post = (body, headers = {}) => shelf.api(route, { method: 'POST', body, headers });
  for (const headers of [
    { 'X-Shelf-Token': '' }, { 'X-Shelf-Token': 'wrong-token' },
    { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await post(input, headers)).response.status, 403, JSON.stringify(headers));
  const forbiddenHost = await new Promise((accept, reject) => {
    const request = httpRequest(new URL(shelf.base + route), { method: 'POST', headers: {
      Host: 'attacker.invalid', 'X-Shelf-Token': shelf.token, 'Content-Type': 'application/json',
    } }, response => { response.resume(); response.on('end', () => accept(response.statusCode)); });
    request.on('error', reject);
    request.end(JSON.stringify(input));
  });
  assert.equal(forbiddenHost, 403);
  for (const invalid of [{}, { id: '' }, { id: null }, { id: 1 }, { id: [alpha.id] }, { id: alpha.id, path: shelf.magpieDir }, { path: alpha.path }, { id: alpha.id, ids: [alpha.id] }]) {
    assert.equal((await post(invalid)).response.status, 400);
  }
  assert.equal((await post(input, { 'Content-Type': 'text/plain' })).response.status, 415);
  assert.equal((await post({ id: 'unknown-skill' })).response.status, 404);
  assert.equal((await post({ id: shelf.magpieDir })).response.status, 404);
  assert.equal((await shelf.api(route)).response.status, 404);
  assert.equal((await shelf.api(route + '/extra', { method: 'POST', body: input })).response.status, 404);
  await rename(shelf.alpha, `${shelf.alpha}.backup`);
  const missing = await post(input);
  assert.equal(missing.response.status, 409);
  assert.match(missing.data.error, /directory has changed/);
  await symlink(shelf.magpieDir, shelf.alpha);
  assert.equal((await post(input)).response.status, 409);
  assert.deepEqual(opened, []);
});

test('HTTP folder opening reports native launch failure instead of a false success and recovers', async (t) => {
  let fail = true;
  const shelf = await setup(t, { opener: directory => openFolder(directory, { execute: (_file, _args, _options, done) => {
    done(fail ? new Error('Native opener failed.') : null);
  } }) });
  const alpha = (await shelf.api('/api/state')).data.skills.find(skill => skill.name === 'Alpha Research');
  const request = () => shelf.api('/api/skill/open-folder', { method: 'POST', body: { id: alpha.id } });
  const rejected = await request();
  assert.equal(rejected.response.status, 502);
  assert.match(rejected.data.error, /Native opener failed/);
  fail = false;
  assert.deepEqual((await request()).data, { opened: true });
});

test('HTTP identity, static assets and non-cacheable authenticated snapshot', async (t) => {
  const shelf = await setup(t);
  const identity = await fetch(`${shelf.base}/_identity`);
  assert.equal(identity.status, 200);
  const details = await identity.json();
  assert.equal(details.product, 'skill-shelf-magpie-plugin');
  assert.equal(details.version, VERSION);
  const index = await fetch(`${shelf.base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Fixture workbench/);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const asset = await fetch(`${shelf.base}/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  const { response, data } = await shelf.api('/api/state');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(data.version, 1);
  assert.deepEqual(data.skills.map((skill) => skill.name).sort(), ['Alpha Research', 'Beta Design']);
  assert.ok(data.packs.some((pack) => pack.id === 'default'));
  const alpha = data.skills.find((skill) => skill.name === 'Alpha Research');
  const detail = await shelf.api(`/api/skill?id=${encodeURIComponent(alpha.id)}`);
  assert.equal(detail.data.text, shelf.alphaText);
  assert.equal((await shelf.api('/api/rescan', { method: 'POST', body: {} })).response.status, 200);
});

test('HTTP read-only Skill file browsing is authenticated and cannot escape a selected Skill', async (t) => {
  const shelf = await setup(t);
  const state = (await shelf.api('/api/state')).data;
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research');
  const id = encodeURIComponent(alpha.id);
  const tree = await shelf.api(`/api/skill/files?id=${id}`);
  assert.equal(tree.response.status, 200);
  assert.equal(tree.data.truncated, false);
  assert.equal(tree.data.files.find(entry => entry.name === 'references').children[0].path, 'references/context.md');
  const preview = await shelf.api(`/api/skill/file?id=${id}&path=references%2Fcontext.md`);
  assert.equal(preview.response.status, 200);
  assert.match(preview.data.text, /Keep citations precise/);
  assert.match(preview.response.headers.get('cache-control'), /no-store/);
  for (const route of [`/api/skill/files?id=${id}`, `/api/skill/file?id=${id}&path=SKILL.md`]) {
    assert.equal((await fetch(shelf.base + route)).status, 403);
  }
  assert.equal((await shelf.api(`/api/skill/file?id=${id}&path=..%2Fsecret.txt`)).response.status, 400);
  await symlink(shelf.magpieDir, path.join(shelf.alpha, 'outside'));
  const escaped = await shelf.api(`/api/skill/file?id=${id}&path=outside%2Fplugin-auth.json`);
  assert.equal(escaped.response.status, 403);
  assert.ok(!JSON.stringify(escaped.data).includes('not-real-secret'));
  assert.equal(await readFile(path.join(shelf.alpha, 'SKILL.md'), 'utf8'), shelf.alphaText);
});

test('HTTP session blocks CSRF, DNS rebinding and unauthenticated data access', async (t) => {
  const shelf = await setup(t);
  for (const route of ['/api/state', '/api/skill?id=missing', '/api/packs/default/export']) {
    const response = await fetch(shelf.base + route);
    assert.equal(response.status, 403);
  }
  assert.equal((await shelf.api('/api/state', { headers: { 'X-Shelf-Token': 'wrong-token' } })).response.status, 403);
  for (const origin of ['https://attacker.invalid', 'null', 'http://localhost:1']) {
    const session = await fetch(`${shelf.base}/api/session`, { headers: { Origin: origin } });
    assert.equal(session.status, 403);
    assert.equal(session.headers.get('access-control-allow-origin'), null);
    const mutation = await shelf.api('/api/packs', { method: 'POST', body: { name: 'Forbidden' }, headers: { Origin: origin } });
    assert.equal(mutation.response.status, 403);
  }
  assert.equal((await rawGet(shelf.base, '/api/session', { Host: 'attacker.invalid' })).status, 403);
  assert.equal((await rawGet(shelf.base, '/api/state', { Host: 'attacker.invalid', 'X-Shelf-Token': shelf.token })).status, 403);
  assert.equal((await rawGet(shelf.base, '/', { Host: 'attacker.invalid' })).status, 403);
  const crossSite = await fetch(`${shelf.base}/api/session`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const goodSession = await fetch(`${shelf.base}/api/session`, { headers: { Origin: shelf.base } });
  assert.equal(goodSession.status, 200);
  assert.equal((await goodSession.json()).token, shelf.token);
  assert.equal((await shelf.api('/api/state')).data.packs.length, 1);
});

test('Magpie sandbox requests use a private path and retain authenticated operations', async t => {
  const opened = [];
  const shelf = await setup(t, { opener: async target => { opened.push(target); } });
  const { embedUrl } = await (await fetch(`${shelf.base}/api/session`)).json();
  const headers = { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' };
  const entry = await fetch(embedUrl, { headers });
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get('x-frame-options'), null);
  assert.equal(entry.headers.get('access-control-allow-origin'), 'null');
  assert.equal((await fetch(shelf.base)).headers.get('x-frame-options'), 'DENY');
  const wrong = await fetch(`${shelf.base}/_magpie/${'0'.repeat(64)}/api/session`, { headers });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers.get('access-control-allow-origin'), null);
  const session = await (await fetch(`${embedUrl}api/session`, { headers })).json();
  assert.equal(session.token, shelf.token);
  assert.equal((await fetch(`${embedUrl}api/state`, { headers })).status, 403);
  const preflight = await fetch(`${embedUrl}api/window-storage`, { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,x-shelf-token' } });
  assert.equal(preflight.status, 204);
  const embeddedRequest = (route, body) => fetch(`${embedUrl}api/${route}`, {
    method: route === 'window-storage' ? 'PUT' : 'POST',
    headers: { ...headers, 'X-Shelf-Token': shelf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal((await embeddedRequest('window-storage', { 'shelf-theme': '"dark"' })).status, 200);
  assert.equal(JSON.parse(await readFile(shelf.service.stateFile, 'utf8')).windowStorage['shelf-theme'], '"dark"');
  for (const type of ['pack', 'sync']) {
    const exported = await embeddedRequest('exports', { type, id: 'default' });
    assert.equal(exported.status, 200);
    const { file } = await exported.json();
    assert.equal(path.dirname(file), path.join(shelf.dataDir, 'exports'));
    assert.equal(typeof JSON.parse(await readFile(file, 'utf8')), 'object');
  }
  assert.equal((await embeddedRequest('open-url', { url: 'https://skills.sh/' })).status, 200);
  assert.deepEqual(opened, [path.join(shelf.dataDir, 'exports'), path.join(shelf.dataDir, 'exports'), 'https://skills.sh/']);
});

test('HTTP validates JSON, body size, unknown endpoints and static path containment', async (t) => {
  const shelf = await setup(t);
  const request = (body, contentType = 'application/json') => fetch(`${shelf.base}/api/packs`, {
    method: 'POST', headers: { 'X-Shelf-Token': shelf.token, Origin: shelf.base, 'Content-Type': contentType }, body,
  });
  assert.equal((await request('{invalid')).status, 400);
  assert.equal((await request('{"name":"Unsafe"}', 'text/plain')).status, 415);
  const huge = await request(JSON.stringify({ name: 'Huge', description: 'x'.repeat(25 * 1024 * 1024) }));
  assert.equal(huge.status, 413);
  const missing = await shelf.api('/api/not-real');
  assert.equal(missing.response.status, 404);
  assert.equal(typeof missing.data.error, 'string');
  await writeFile(path.join(shelf.root, 'secret.txt'), 'NOT_PUBLIC');
  for (const route of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%00', '/app.js/../../secret.txt']) {
    const result = await rawGet(shelf.base, route);
    assert.ok(result.status >= 400, `${route} unexpectedly returned ${result.status}`);
    assert.ok(!result.text.includes('NOT_PUBLIC'));
  }
  assert.equal((await shelf.api('/api/packs', { method: 'POST', body: { name: '' } })).response.status, 400);
});

test('HTTP organization and Pack workflow preserves originals and Magpie configuration', async (t) => {
  const shelf = await setup(t);
  let state = (await shelf.api('/api/state')).data;
  const alpha = state.skills.find((skill) => skill.name === 'Alpha Research');
  let result = await shelf.api('/api/folders', { method: 'POST', body: { name: 'Research', scopeId: 'global', color: '#ed6a4a' } });
  assert.equal(result.response.status, 200);
  const folder = result.data.folders.find((item) => item.name === 'Research');
  result = await shelf.api('/api/organization', { method: 'PATCH', body: { ids: [alpha.id], folderId: folder.id, tags: ['research', 'daily'] } });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.organization[alpha.id], { folderId: folder.id, tags: ['research', 'daily'] });
  result = await shelf.api(`/api/folders/${folder.id}`, { method: 'PATCH', body: { name: 'Field Notes' } });
  assert.equal(result.data.folders.find((item) => item.id === folder.id).name, 'Field Notes');
  result = await shelf.api('/api/packs', { method: 'POST', body: { name: 'Team Starter', description: 'Reusable research tools' } });
  const pack = result.data.packs.find((item) => item.name === 'Team Starter');
  assert.ok(pack);
  result = await shelf.api(`/api/packs/${pack.id}/skills`, { method: 'POST', body: { skillIds: [alpha.id] } });
  assert.equal(result.response.status, 200);
  const managed = result.data.managedSkills.find((skill) => skill.packId === pack.id);
  assert.ok(managed);
  assert.notEqual(managed.path, alpha.path);
  assert.equal(await readFile(path.join(managed.path, 'SKILL.md'), 'utf8'), shelf.alphaText);
  const exported = await shelf.api(`/api/packs/${pack.id}/export`);
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get('content-disposition'), /attachment/);
  assert.equal(exported.data.format, 'skill-shelf-pack');
  assert.equal(exported.data.skills.length, 1);
  const documentJson = JSON.stringify(exported.data);
  for (const secret of [shelf.homeDir, shelf.magpieDir, 'not-real-secret', 'targetPath']) assert.ok(!documentJson.includes(secret));
  assert.ok(exported.data.skills[0].files.some((file) => file.path === 'scripts/run.sh' && file.executable));
  result = await shelf.api('/api/packs/import', { method: 'POST', body: { document: exported.data } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.packs.length, 3);
  assert.equal(new Set(result.data.managedSkills.map((skill) => skill.id)).size, 2);
  const targetPath = path.join(shelf.root, 'deployment');
  result = await shelf.api('/api/deploy', { method: 'POST', body: { skillIds: [managed.id], targetPath, mode: 'copy' } });
  assert.equal(result.response.status, 200);
  const deployment = result.data.managedSkills.find((skill) => skill.id === managed.id).deployments[0];
  assert.ok(deployment);
  assert.equal(await readFile(path.join(deployment.targetPath, 'SKILL.md'), 'utf8'), shelf.alphaText);
  assert.equal((await shelf.api('/api/deploy', { method: 'POST', body: { skillIds: [managed.id], targetPath, mode: 'copy' } })).response.status, 409);
  result = await shelf.api('/api/deployments/remove', { method: 'POST', body: { skillId: managed.id, deploymentId: deployment.id } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.managedSkills.find((skill) => skill.id === managed.id).deployments.length, 0);
  result = await shelf.api(`/api/folders/${folder.id}`, { method: 'DELETE' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.organization[alpha.id].folderId, null);
  assert.deepEqual(result.data.organization[alpha.id].tags, ['research', 'daily']);
  result = await shelf.api(`/api/packs/${pack.id}`, { method: 'DELETE' });
  assert.equal(result.response.status, 200);
  assert.ok(!result.data.managedSkills.some((skill) => skill.packId === pack.id));
  assert.equal((await shelf.api('/api/packs/default', { method: 'DELETE' })).response.status, 409);
  const reloaded = new ShelfService(shelf);
  await reloaded.initialize();
  state = await reloaded.snapshot();
  assert.equal(state.packs.length, 2);
  assert.deepEqual(state.organization[alpha.id].tags, ['research', 'daily']);
  assert.equal(await readFile(path.join(shelf.alpha, 'SKILL.md'), 'utf8'), shelf.alphaText);
  assert.deepEqual((await readdir(shelf.alpha)).sort(), ['SKILL.md', 'references', 'scripts']);
  assert.equal(await readFile(path.join(shelf.magpieDir, 'plugin-auth.json'), 'utf8'), '{"sentinel":{"type":"api","key":"not-real-secret"}}\n');
  assert.equal(await readFile(path.join(shelf.magpieDir, 'preferences.json'), 'utf8'), '{"untouched":true}\n');
});

test('HTTP roots, projects and protected symlink deployment lifecycle', async (t) => {
  const shelf = await setup(t);
  const customRoot = path.join(shelf.root, 'custom-skills');
  const projectPath = path.join(shelf.root, 'project');
  await mkdir(path.join(customRoot, 'gamma-skill'), { recursive: true });
  await writeFile(path.join(customRoot, 'gamma-skill/SKILL.md'), '---\nname: Gamma Reports\ndescription: Summarize local reports.\n---\n\n# Reports\n');
  await mkdir(path.join(projectPath, '.claude/skills/project-skill'), { recursive: true });
  await writeFile(path.join(projectPath, '.claude/skills/project-skill/SKILL.md'), '---\nname: Project Helper\ndescription: Keep project conventions.\n---\n\n# Project Helper\n');
  let result = await shelf.api('/api/roots', { method: 'POST', body: { path: customRoot, label: 'Custom Library' } });
  assert.equal(result.response.status, 200);
  const root = result.data.roots.find((item) => item.path === customRoot);
  assert.ok(root);
  assert.ok(result.data.skills.some((item) => item.name === 'Gamma Reports'));
  result = await shelf.api('/api/projects', { method: 'POST', body: { path: projectPath, name: 'Fixture Project' } });
  assert.equal(result.response.status, 200);
  const project = result.data.projects.find((item) => item.path === projectPath);
  assert.ok(project);
  assert.ok(result.data.skills.some((item) => item.name === 'Project Helper' && item.scopeId === `project:${project.id}`));
  const alpha = result.data.skills.find((item) => item.name === 'Alpha Research');
  result = await shelf.api('/api/packs/default/skills', { method: 'POST', body: { skillIds: [alpha.id] } });
  const managed = result.data.managedSkills[0];
  result = await shelf.api('/api/deploy', { method: 'POST', body: { skillIds: [managed.id], targetPath: path.join(shelf.root, 'linked-skills'), mode: 'symlink' } });
  assert.equal(result.response.status, 200);
  const deployment = result.data.managedSkills.find((item) => item.id === managed.id).deployments[0];
  assert.equal((await shelf.api(`/api/managed/${managed.id}`, { method: 'DELETE' })).response.status, 409);
  assert.equal((await shelf.api('/api/deployments/remove', { method: 'POST', body: { skillId: managed.id, deploymentId: deployment.id } })).response.status, 200);
  assert.equal((await shelf.api(`/api/managed/${managed.id}`, { method: 'DELETE' })).response.status, 200);
  assert.equal((await shelf.api(`/api/projects/${project.id}`, { method: 'DELETE' })).response.status, 200);
  result = await shelf.api(`/api/roots/${root.id}`, { method: 'DELETE' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.skills.length, 2);
  await writeFile(path.join(shelf.root, 'secret.txt'), 'NOT_PUBLIC');
  await symlink(path.join(shelf.root, 'secret.txt'), path.join(shelf.root, 'web/secret-link.txt'));
  assert.equal((await fetch(`${shelf.base}/secret-link.txt`)).status, 404);
  const options = await fetch(`${shelf.base}/api/packs`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.invalid', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(options.status, 403);
  assert.equal(options.headers.get('access-control-allow-origin'), null);
});

test('HTTP Finder layout persists mixed item positions and atomic hierarchy moves without moving source files', async (t) => {
  const shelf = await setup(t);
  const alpha = (await shelf.api('/api/state')).data.skills.find(item => item.name === 'Alpha Research');
  let result = await shelf.api('/api/folders', { method: 'POST', body: { name: 'Destination', scopeId: 'global' } });
  const destination = result.data.folders.find(item => item.name === 'Destination');
  result = await shelf.api('/api/folders', { method: 'POST', body: { name: 'Movable Folder', scopeId: 'global' } });
  const folder = result.data.folders.find(item => item.name === 'Movable Folder');
  result = await shelf.api('/api/finder', { method: 'PATCH', body: { scopeId: 'global', items: [
    { kind: 'skill', id: alpha.id, position: { x: 37, y: 84 } },
    { kind: 'folder', id: folder.id, position: { x: 242, y: 93 } },
  ] } });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.finderPositions[`skill:${alpha.id}`], { x: 37, y: 84 });
  assert.deepEqual(result.data.finderPositions[`folder:${folder.id}`], { x: 242, y: 93 });
  result = await shelf.api('/api/finder', { method: 'PATCH', body: { scopeId: 'global', parentId: destination.id, items: [
    { kind: 'skill', id: alpha.id, position: { x: 40, y: 52 } },
    { kind: 'folder', id: folder.id, position: { x: 230, y: 52 } },
  ] } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.organization[alpha.id].folderId, destination.id);
  assert.equal(result.data.folders.find(item => item.id === folder.id).parentId, destination.id);
  const reloaded = new ShelfService(shelf);
  const saved = await reloaded.initialize();
  assert.deepEqual(saved.finderPositions[`skill:${alpha.id}`], { x: 40, y: 52 });
  assert.deepEqual(saved.finderPositions[`folder:${folder.id}`], { x: 230, y: 52 });
  assert.equal(await readFile(path.join(shelf.alpha, 'SKILL.md'), 'utf8'), shelf.alphaText);
  assert.equal(saved.skills.find(item => item.id === alpha.id).path, alpha.path);
  const invalid = await shelf.api('/api/finder', { method: 'PATCH', body: { scopeId: 'global', parentId: folder.id, items: [{ kind: 'folder', id: destination.id }, { kind: 'skill', id: alpha.id }] } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.data.error.length > 0, true);
  assert.deepEqual((await shelf.api('/api/state')).data.finderPositions, saved.finderPositions);
  assert.equal((await shelf.api('/api/state')).data.organization[alpha.id].folderId, destination.id);
  assert.equal((await shelf.api('/api/finder', { method: 'PATCH', body: { scopeId: 'global', items: [{ kind: 'skill', id: alpha.id, position: { x: -1, y: 0 } }] } })).response.status, 400);
});

test('HTTP AI discovers only text models and requires explicit generate then save using a fake Magpie gateway', async (t) => {
  const shelf = await setup(t, { gateway: true });
  const alpha = (await shelf.api('/api/state')).data.skills.find(item => item.name === 'Alpha Research');
  for (const route of ['/api/ai/status', `/api/ai/result?id=${alpha.id}`]) assert.equal((await fetch(shelf.base + route)).status, 403);
  const status = await shelf.api('/api/ai/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.data.available, true);
  assert.equal(status.data.baseUrl, shelf.gateway.url);
  assert.deepEqual(status.data.models.map(item => item.id), ['fixture/text', 'fixture/other']);
  assert.deepEqual((await shelf.api(`/api/ai/result?id=${alpha.id}`)).data, { translations: [] });
  assert.equal(shelf.gateway.requests.length, 0, 'Discovery and loading annotations must not trigger inference.');
  const summary = await shelf.api('/api/ai/generate', { method: 'POST', body: { skillId: alpha.id, kind: 'summary', model: 'fixture/text', language: 'en' } });
  assert.equal(summary.response.status, 200);
  assert.equal(summary.data.text, MOCK_SUMMARY);
  assert.equal(summary.data.model, 'fixture/text');
  assert.match(summary.data.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(shelf.gateway.requests.length, 1);
  assert.equal(shelf.gateway.requests[0].authorization, 'Bearer magpie-skill-shelf');
  assert.equal(shelf.gateway.requests[0].body.stream, false);
  assert.equal(aiReference(shelf.gateway.requests[0].body.messages[1].content), shelf.alphaText);
  assert.deepEqual((await shelf.api(`/api/ai/result?id=${alpha.id}`)).data, { translations: [] });
  const saved = await shelf.api('/api/ai/save', { method: 'POST', body: { draftId: summary.data.draftId } });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.stale, false);
  assert.equal(typeof saved.data.savedAt, 'string');
  assert.equal(saved.data.draftId, undefined);
  const translation = await shelf.api('/api/ai/generate', { method: 'POST', body: { skillId: alpha.id, kind: 'translation', model: 'fixture/other', language: 'zh-CN' } });
  assert.equal(translation.response.status, 200);
  assert.equal(translation.data.text, MOCK_TRANSLATION);
  assert.equal(aiReference(shelf.gateway.requests[1].body.messages[1].content), 'Research and summarize reliable sources.');
  assert.equal((await shelf.api('/api/ai/save', { method: 'POST', body: { draftId: translation.data.draftId } })).response.status, 200);
  const reloaded = new AIBridge({ service: shelf.service, magpieDir: shelf.magpieDir, gatewayUrl: shelf.gateway.url });
  const annotations = await reloaded.results(alpha.id);
  assert.equal(annotations.summary.text, MOCK_SUMMARY);
  assert.equal(annotations.translations.length, 1);
  assert.equal(annotations.translations[0].language, 'zh-CN');
  assert.equal(shelf.gateway.requests.length, 2, 'Saving and reloading annotations must not call inference.');
  assert.equal(await readFile(path.join(shelf.alpha, 'SKILL.md'), 'utf8'), shelf.alphaText);
  assert.equal(await readFile(path.join(shelf.magpieDir, 'plugin-auth.json'), 'utf8'), '{"sentinel":{"type":"api","key":"not-real-secret"}}\n');
});

test('HTTP AI rejects invalid prompts, handles deterministic gateway errors and protects stale drafts', async (t) => {
  const shelf = await setup(t, { gateway: true });
  const alpha = (await shelf.api('/api/state')).data.skills.find(item => item.name === 'Alpha Research');
  const input = { skillId: alpha.id, kind: 'summary', model: 'fixture/text', language: 'en' };
  for (const invalid of [{ ...input, prompt: 'Arbitrary instructions are forbidden' }, { ...input, gatewayUrl: 'https://attacker.invalid' }, { ...input, model: 'fixture/image' }, { ...input, kind: 'execute' }, { ...input, language: 'unknown' }]) {
    assert.equal((await shelf.api('/api/ai/generate', { method: 'POST', body: invalid })).response.status, 400);
  }
  assert.equal(shelf.gateway.requests.length, 0);
  shelf.gateway.setFailure(true);
  const failed = await shelf.api('/api/ai/generate', { method: 'POST', body: input });
  assert.equal(failed.response.status, 502);
  assert.equal(typeof failed.data.error, 'string');
  assert.deepEqual((await shelf.api(`/api/ai/result?id=${alpha.id}`)).data, { translations: [] });
  shelf.gateway.setFailure(false);
  const first = (await shelf.api('/api/ai/generate', { method: 'POST', body: input })).data;
  assert.equal((await shelf.api('/api/ai/save', { method: 'POST', body: { draftId: first.draftId } })).response.status, 200);
  const pending = (await shelf.api('/api/ai/generate', { method: 'POST', body: input })).data;
  await writeFile(path.join(shelf.alpha, 'SKILL.md'), shelf.alphaText + '\nChanged only in this isolated test fixture.\n');
  const rejected = await shelf.api('/api/ai/save', { method: 'POST', body: { draftId: pending.draftId } });
  assert.equal(rejected.response.status, 409);
  const results = (await shelf.api(`/api/ai/result?id=${alpha.id}`)).data;
  assert.equal(results.summary.stale, true);
  assert.equal(results.summary.savedAt, (JSON.parse(await readFile(path.join(shelf.dataDir, 'ai-results.json'), 'utf8'))).annotations[0].savedAt);
  assert.equal((await shelf.api('/api/ai/save', { method: 'POST', body: { draftId: 'not-a-real-draft' } })).response.status, 404);
});
