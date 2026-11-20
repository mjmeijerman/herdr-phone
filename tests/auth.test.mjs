// The token gate: 401 with an empty body without a credential, 200 with one,
// the page reachable without auth, and the token never in the HTML or a URL.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp, ensureToken, listen, PAGE, tokenMatches } from '../server.mjs';
import { boot, HC_LS, HERDR_APP_LS, makeExec, TOKEN } from './helper.mjs';

const table = { 'herdr-app ls': { code: 0, stdout: JSON.stringify(HERDR_APP_LS) }, 'hc ls': { code: 0, stdout: JSON.stringify(HC_LS) } };

describe('token gate', () => {
  let app;
  before(async () => {
    app = await boot({ table });
  });
  after(async () => {
    await app.close();
  });

  it('GET / is reachable without a credential and serves the page', async () => {
    const res = await app.fetch('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /herdr-phone/);
  });

  it('the page never contains the token', async () => {
    assert.equal(PAGE.includes(TOKEN), false);
    const html = await (await app.fetch('/')).text();
    assert.equal(html.includes(TOKEN), false);
  });

  it('API without a credential is 401 with an empty body', async () => {
    for (const path of ['/api/tabs', '/api/screen?terminal=t19b']) {
      const res = await app.fetch(path);
      assert.equal(res.status, 401, path);
      assert.equal(await res.text(), '', path);
    }
    const post = await app.fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 't19b', text: 'hi' }),
    });
    assert.equal(post.status, 401);
    assert.equal(await post.text(), '');
  });

  it('API with a Bearer token is 200', async () => {
    const res = await app.api('/api/tabs');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  });

  it('a wrong token is 401, not 403 with a hint', async () => {
    const res = await app.api('/api/tabs', { bearer: 'f'.repeat(32) });
    assert.equal(res.status, 401);
    assert.equal(res.text, '');
  });

  it('POST /login sets the hp cookie, which then opens the API', async () => {
    const login = await app.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(login.status, 204);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie, 'no Set-Cookie');
    assert.match(setCookie, /^hp=[0-9a-f]{64};/);
    assert.match(setCookie, /HttpOnly/);
    assert.equal(setCookie.includes(TOKEN), false, 'the cookie must not carry the raw token');
    const cookie = setCookie.split(';')[0];
    const res = await app.fetch('/api/tabs', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
  });

  it('POST /login with a wrong token is 401 with an empty body', async () => {
    const res = await app.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(res.status, 401);
    assert.equal(await res.text(), '');
  });

  it('unknown paths are 404 with an empty body', async () => {
    const res = await app.api('/api/nothing');
    assert.equal(res.status, 404);
    assert.equal(res.text, '');
  });
});

describe('token file', () => {
  it('is 32 hex characters, mode 0600, and stable across calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herdr-phone-token-'));
    const file = join(dir, 'token');
    const first = await ensureToken(file);
    assert.match(first, /^[0-9a-f]{32}$/);
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode.toString(8), '600');
    assert.equal((await readFile(file, 'utf8')).trim(), first);
    assert.equal(await ensureToken(file), first);
    await chmod(file, 0o644);
    assert.equal(await ensureToken(file), first);
    assert.equal(((await stat(file)).mode & 0o777).toString(8), '600', 'a loose mode is tightened');
  });

  it('replaces a corrupt token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herdr-phone-token-'));
    const file = join(dir, 'token');
    await ensureToken(file);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not-a-token\n');
    const fresh = await ensureToken(file);
    assert.match(fresh, /^[0-9a-f]{32}$/);
  });

  it('compares in constant time and rejects empty or non-strings', () => {
    assert.equal(tokenMatches('abc', 'abc'), true);
    assert.equal(tokenMatches('abc', 'abd'), false);
    assert.equal(tokenMatches('', ''), false);
    assert.equal(tokenMatches(undefined, 'abc'), false);
    assert.equal(tokenMatches('a'.repeat(32), TOKEN), false);
  });
});

describe('binding', () => {
  it('refuses anything but loopback', async () => {
    const app = createApp({ token: TOKEN, exec: makeExec(table) });
    await assert.rejects(() => listen(app, 0, '0.0.0.0'), /127\.0\.0\.1 only/);
    await assert.rejects(() => listen(app, 0, '192.168.1.10'), /127\.0\.0\.1 only/);
  });
});
