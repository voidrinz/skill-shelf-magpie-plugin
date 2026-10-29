import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import http from 'node:http';

test('the Magpie sidebar opens a working shelf inside its script-only sandbox', async ({ page, request }) => {
  const { embedUrl } = await (await request.get('/api/session')).json();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = http.createServer(async (incoming, response) => {
    const path = new URL(incoming.url!, 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      return response.end(`<!doctype html>
      <button id="shelf">Skill Shelf</button><main></main><script>
      document.getElementById('shelf').onclick = () => {
        const frame = document.createElement('iframe');
        frame.title = 'Skill Shelf'; frame.setAttribute('sandbox', 'allow-scripts');
        frame.style = 'width:100%;height:900px'; frame.src = '/plugin/index.html';
        document.querySelector('main').replaceChildren(frame);
      };
      addEventListener('message', event => {
        if (event.data.method === 'hello') event.source.postMessage({ magpie: 1, id: 1, result: { dark: false, lang: 'zh', tokens: {} } }, '*');
      });</script>`);
    }
    let body: string;
    if (path === '/plugin/_magpie/bridge.js') body = `window.magpie = { ready: new Promise(resolve => {
      addEventListener('message', event => { if (event.source === parent && event.data.id === 1) resolve(event.data.result); });
      parent.postMessage({ magpie: 1, id: 1, method: 'hello' }, '*');
    }) };`;
    else if (path === '/plugin/connection.js') body = `window.skillShelfConnection = ${JSON.stringify(embedUrl)};`;
    else body = await readFile(new URL(`../dist/page/${path.endsWith('.html') ? 'index.html' : 'boot.js'}`, import.meta.url), 'utf8');
    response.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : 'text/javascript');
    response.setHeader('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src http://${incoming.headers.host}/plugin/; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'`);
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Skill Shelf', exact: true }).click();
    const shelf = page.frameLocator('iframe');
    await expect(shelf.locator('.app-shell')).toBeVisible();
    await expect.poll(() => page.frames()[1]?.url()).toContain('/_magpie/');
    expect(page.url()).toBe(origin);
    const frame = page.frames()[1];
    await frame.evaluate(() => localStorage.setItem('shelf-embedded-check', 'saved'));
    await expect.poll(async () => {
      const { token } = await (await request.get('/api/session')).json();
      const response = await request.get('/api/window-storage', { headers: { 'X-Shelf-Token': token } });
      return (await response.json())['shelf-embedded-check'];
    }).toBe('saved');
    await frame.goto(embedUrl);
    await expect(shelf.locator('.app-shell')).toBeVisible();
    expect(await frame.evaluate(() => localStorage.getItem('shelf-embedded-check'))).toBe('saved');
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
