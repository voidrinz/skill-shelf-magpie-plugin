import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createFixture } from '../scripts/test-fixtures.mjs';
import { VERSION } from '../src/version.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const hostPath = process.env.MAGPIE_PLUGIN_HOST || '/Users/laz/Coding/github/magpie/internal/plugin/host.js';
const bun = process.env.BUN_BIN || 'bun';

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function rpcHost(fixture, env = {}) {
  const child = spawn(bun, [hostPath], {
    cwd: fixture.magpieDir,
    env: { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir, CFFIXED_USER_HOME: fixture.homeDir, XDG_CONFIG_HOME: path.join(fixture.homeDir, '.config'), XDG_CACHE_HOME: path.join(fixture.homeDir, '.cache'), XDG_DATA_HOME: path.join(fixture.homeDir, '.local/share'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let nextId = 0;
  const events = [];
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.event) events.push(message);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
  child.once('exit', code => {
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(`Host exited ${code}: ${stderr}`)); }
    pending.clear();
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exit;
  };
  return { child, rpc, stop, events };
}

async function eventually(check, description) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(description);
}

async function assertPagePlugin(host) {
  assert.deepEqual(await host.rpc('providers', {}), []);
}

test('the packaged options example keeps browser opening opt-in', async () => {
  const manifest = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(manifest.magpie.options.open, false);
});

test('built plugin runs the page backend without registering a provider', { timeout: 30000 }, async (t) => {
  try { await access(hostPath); } catch { t.skip('Set MAGPIE_PLUGIN_HOST to the Magpie internal/plugin/host.js checkout'); return; }
  if (spawnSync(bun, ['--version']).error) { t.skip('Bun is required for the actual Magpie host integration'); return; }
  try { await access(path.join(repo, 'dist/plugin.mjs')); } catch { t.skip('Run pnpm build before testing the packaged Magpie plugin'); return; }
  const fixture = await createFixture();
  const port = await availablePort();
  const host = rpcHost(fixture);
  const { rpc } = host;
  t.after(async () => { await host.stop(); await fixture.cleanup(); });
  const params = {
    authPath: path.join(fixture.magpieDir, 'plugin-auth.json'), directory: fixture.magpieDir, config: {},
    plugins: [{ spec: 'skill-shelf-magpie-plugin', target: path.join(repo, 'dist/plugin.mjs'), options: { port, open: false, dataDir: fixture.dataDir } }],
  };
  const loaded = await rpc('init', params);
  assert.deepEqual(loaded.plugins, [{ spec: 'skill-shelf-magpie-plugin' }]);
  await assertPagePlugin(host);
  const base = `http://127.0.0.1:${port}`;
  const identity = await fetch(`${base}/_identity`);
  assert.equal(identity.status, 200);
  const details = await identity.json();
  assert.equal(details.product, 'skill-shelf-magpie-plugin');
  assert.equal(details.version, VERSION);
  const ui = await fetch(base);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<html|<!doctype/i);
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const state = await (await fetch(`${base}/api/state`, { headers: { 'X-Shelf-Token': token } })).json();
  assert.equal(state.dataDir, fixture.dataDir);
  assert.equal(state.skills.length, 2);
  const connection = await readFile(path.join(repo, 'dist/page/connection.js'), 'utf8');
  assert.match(connection, new RegExp(base));
  assert.match(connection, /\/_magpie\/[a-f0-9]{64}\//);
  // Reloading the cached module still keeps a single backend.
  assert.deepEqual(await rpc('init', params), { plugins: [...loaded.plugins, ...loaded.plugins] });
  await assertPagePlugin(host);
  assert.equal(await readFile(path.join(fixture.magpieDir, 'plugin-auth.json'), 'utf8'), '{"sentinel":{"type":"api","key":"not-real-secret"}}\n');
  assert.equal(await readFile(path.join(fixture.magpieDir, 'preferences.json'), 'utf8'), '{"untouched":true}\n');
  assert.equal(await readFile(path.join(fixture.alpha, 'SKILL.md'), 'utf8'), fixture.alphaText);
});

test('packaged standalone CLI starts under Node with fully isolated paths', { timeout: 20000 }, async (t) => {
  const cli = path.join(repo, 'dist/cli.mjs');
  try { await access(cli); } catch { t.skip('Run pnpm build before testing the packaged CLI'); return; }
  const fixture = await createFixture();
  const port = await availablePort();
  const child = spawn(process.execPath, [cli, '--data-dir', fixture.dataDir, '--home-dir', fixture.homeDir, '--magpie-dir', fixture.magpieDir, '--port', String(port), '--no-open'], {
    cwd: fixture.root,
    env: { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir, CFFIXED_USER_HOME: fixture.homeDir, XDG_CONFIG_HOME: path.join(fixture.homeDir, '.config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exit;
    }
    await fixture.cleanup();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Packaged CLI startup timed out: ${stderr}`)), 10000);
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes(`http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged CLI exited ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base)).status, 200);
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const state = await (await fetch(`${base}/api/state`, { headers: { 'X-Shelf-Token': token } })).json();
  assert.equal(state.dataDir, fixture.dataDir);
  assert.equal(state.homeDir, fixture.homeDir);
  assert.equal(state.skills.length, 2);
  assert.equal(await readFile(path.join(fixture.magpieDir, 'preferences.json'), 'utf8'), '{"untouched":true}\n');
});

test('duplicate Magpie hosts reuse one workbench, take over on exit and stop when disabled', { timeout: 25000 }, async (t) => {
  try { await access(hostPath); await access(path.join(repo, 'dist/plugin.mjs')); } catch { t.skip('A Magpie checkout and built plugin are required'); return; }
  if (spawnSync(bun, ['--version']).error) { t.skip('Bun is required for Magpie host lifecycle integration'); return; }
  const fixture = await createFixture();
  const port = await availablePort();
  const settings = { plugins: [{ spec: repo, off: false }] };
  await writeFile(path.join(fixture.magpieDir, 'plugins.json'), JSON.stringify(settings));
  const first = rpcHost(fixture);
  const second = rpcHost(fixture);
  t.after(async () => { await first.stop(); await second.stop(); await fixture.cleanup(); });
  const params = {
    authPath: path.join(fixture.magpieDir, 'plugin-auth.json'), directory: fixture.magpieDir, config: {},
    plugins: [{ spec: repo, target: path.join(repo, 'dist/plugin.mjs'), options: { port, open: false, dataDir: fixture.dataDir } }],
  };
  const expected = { plugins: [{ spec: repo }] };
  assert.deepEqual(await first.rpc('init', params), expected);
  const base = `http://127.0.0.1:${port}`;
  const firstToken = (await (await fetch(`${base}/api/session`)).json()).token;
  assert.deepEqual(await second.rpc('init', params), expected);
  assert.equal((await (await fetch(`${base}/api/session`)).json()).token, firstToken);
  await assertPagePlugin(first);
  await assertPagePlugin(second);
  await first.stop();
  await eventually(async () => {
    const session = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(300) });
    return session.ok && (await session.json()).token !== firstToken;
  }, 'The surviving Magpie host did not take over the workbench after its owner exited.');
  const identity = await (await fetch(`${base}/_identity`)).json();
  assert.equal(identity.product, 'skill-shelf-magpie-plugin');
  await writeFile(path.join(fixture.magpieDir, 'plugins.json'), JSON.stringify({ plugins: [{ spec: repo, off: true }] }));
  await eventually(async () => {
    try { await fetch(`${base}/_identity`, { signal: AbortSignal.timeout(300) }); return false; } catch { return true; }
  }, 'Disabling the plugin did not stop its loopback workbench.');
  await assertPagePlugin(second);
  assert.equal(await readFile(path.join(fixture.magpieDir, 'plugin-auth.json'), 'utf8'), '{"sentinel":{"type":"api","key":"not-real-secret"}}\n');
  assert.equal(await readFile(path.join(fixture.alpha, 'SKILL.md'), 'utf8'), fixture.alphaText);
});

for (const open of [undefined, false, true]) test(`real Magpie hosts share, recover and restart a fallback workbench with open=${open ?? 'default'}`, { timeout: 30000 }, async t => {
  try { await access(hostPath); await access(path.join(repo, 'dist/plugin.mjs')); } catch { t.skip('A Magpie checkout and built plugin are required'); return; }
  if (spawnSync(bun, ['--version']).error) { t.skip('Bun is required for Magpie host lifecycle integration'); return; }
  if (process.platform === 'win32') { t.skip('The isolated browser-launcher fixture requires a POSIX shell'); return; }
  const fixture = await createFixture();
  const foreign = http.createServer((_request, response) => response.end('foreign application'));
  await new Promise((resolve, reject) => foreign.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = foreign.address().port;
  const binDir = path.join(fixture.root, 'bin');
  const browserLog = path.join(fixture.root, 'browser.log');
  await mkdir(binDir);
  await writeFile(path.join(binDir, process.platform === 'darwin' ? 'open' : 'xdg-open'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$SHELF_BROWSER_LOG"\n', { mode: 0o700 });
  const env = { PATH: `${binDir}:${process.env.PATH}`, SHELF_BROWSER_LOG: browserLog };
  const first = rpcHost(fixture, env);
  const second = rpcHost(fixture, env);
  let restarted;
  let squatter;
  t.after(async () => {
    await first.stop();
    await second.stop();
    await restarted?.stop();
    for (const server of [foreign, squatter].filter(Boolean)) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
    await fixture.cleanup();
  });
  await writeFile(path.join(fixture.magpieDir, 'plugins.json'), JSON.stringify({ plugins: [{ spec: repo, off: false }] }));
  const params = {
    authPath: path.join(fixture.magpieDir, 'plugin-auth.json'), directory: fixture.magpieDir, config: {},
    plugins: [{ spec: repo, target: path.join(repo, 'dist/plugin.mjs'), options: { port, ...(open === undefined ? {} : { open }), dataDir: fixture.dataDir } }],
  };
  async function assertBrowserLaunches(urls) {
    if (open === true) {
      await eventually(async () => (await readFile(browserLog, 'utf8')).trim().split('\n').join(',') === urls.join(','), 'The opted-in browser did not open the actual workbench URLs.');
    } else {
      // Browser launches are asynchronous; allow a mistaken launch to reach the isolated stub.
      await new Promise(resolve => setTimeout(resolve, 300));
      await assert.rejects(readFile(browserLog, 'utf8'), { code: 'ENOENT' });
      await assert.rejects(access(path.join(fixture.dataDir, '.browser-opened')), { code: 'ENOENT' });
    }
  }
  const loaded = await Promise.all([first.rpc('init', params), second.rpc('init', params)]);
  assert.deepEqual(loaded, [{ plugins: [{ spec: repo }] }, { plugins: [{ spec: repo }] }]);
  const endpointFile = path.join(fixture.dataDir, '.workbench.json');
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'));
  assert.notEqual(endpoint.port, port);
  const base = `http://127.0.0.1:${endpoint.port}`;
  const session = (await (await fetch(`${base}/api/session`)).json()).token;
  for (const host of [first, second]) {
    assert.ok(host.events.some(event => event.event === 'log' && event.message.endsWith(base)));
    await assertPagePlugin(host);
  }
  await assertBrowserLaunches([base]);
  await first.rpc('init', params);
  await assertBrowserLaunches([base]);
  const owner = endpoint.pid === first.child.pid ? first : second;
  const survivor = owner === first ? second : first;
  await owner.stop();
  squatter = http.createServer((_request, response) => response.end('new foreign application'));
  await new Promise((resolve, reject) => squatter.listen(endpoint.port, '127.0.0.1', resolve).once('error', reject));
  let replacement;
  await eventually(async () => {
    replacement = JSON.parse(await readFile(endpointFile, 'utf8'));
    return replacement.pid === survivor.child.pid && replacement.port !== endpoint.port;
  }, 'The surviving Magpie host did not avoid the newly occupied previous port.');
  const newBase = `http://127.0.0.1:${replacement.port}`;
  assert.notEqual((await (await fetch(`${newBase}/api/session`)).json()).token, session);
  await assertBrowserLaunches([base, newBase]);
  assert.ok(survivor.events.some(event => event.event === 'log' && event.message.endsWith(newBase)));
  assert.match(await readFile(path.join(fixture.dataDir, 'Skill Shelf.html'), 'utf8'), new RegExp(newBase));
  await survivor.stop();
  restarted = rpcHost(fixture, env);
  await restarted.rpc('init', params);
  assert.notEqual(JSON.parse(await readFile(endpointFile, 'utf8')).id, replacement.id);
  await assertBrowserLaunches([base, newBase, newBase]);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'foreign application');
  assert.equal(await (await fetch(base)).text(), 'new foreign application');
  await writeFile(path.join(fixture.magpieDir, 'plugins.json'), JSON.stringify({ plugins: [{ spec: repo, off: true }] }));
  await eventually(async () => {
    try { await fetch(`${newBase}/_identity`, { signal: AbortSignal.timeout(300) }); return false; } catch { return true; }
  }, 'Disabling the plugin did not close the fallback workbench.');
  assert.doesNotMatch(await readFile(path.join(fixture.dataDir, 'Skill Shelf.html'), 'utf8'), /href="http/);
  assert.equal(await readFile(path.join(fixture.magpieDir, 'plugin-auth.json'), 'utf8'), '{"sentinel":{"type":"api","key":"not-real-secret"}}\n');
  assert.equal(await readFile(path.join(fixture.magpieDir, 'preferences.json'), 'utf8'), '{"untouched":true}\n');
  assert.equal(await readFile(path.join(fixture.alpha, 'SKILL.md'), 'utf8'), fixture.alphaText);
});
