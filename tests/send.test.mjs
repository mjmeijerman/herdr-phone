// /api/send argv from a stubbed runner, the 428 confirm gate (long and
// destructive), keys, and interrupt.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { confirmReason, MAX_TEXT } from '../server.mjs';
import { boot, HC_LS, HERDR_APP_LS, makeExec } from './helper.mjs';

const ok = (value) => ({ code: 0, stdout: JSON.stringify(value) });
const table = {
  'herdr-app ls': ok(HERDR_APP_LS),
  'hc ls': ok(HC_LS),
  'hc send': { code: 0, stdout: '' },
  'hc keys': { code: 0, stdout: '' },
  'hc interrupt': { code: 0, stdout: '' },
};

describe('POST /api/send', () => {
  let app;
  before(async () => {
    app = await boot({ table });
  });
  after(async () => {
    await app.close();
  });

  it('runs `hc send ADDRESS TEXT` as argv', async () => {
    const res = await app.api('/api/send', { method: 'POST', body: { terminal: 't19b', text: 'git status' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    const call = app.exec.calls.at(-1);
    assert.equal(call.cmd, 'hc');
    assert.deepEqual(call.args, ['send', 't19b', 'git status']);
  });

  it('passes shell metacharacters through untouched, because there is no shell', async () => {
    const text = 'echo $(whoami) `id` ; && | > /tmp/x';
    const res = await app.api('/api/send', { method: 'POST', body: { terminal: 't19b', text } });
    assert.equal(res.status, 200);
    assert.deepEqual(app.exec.calls.at(-1).args, ['send', 't19b', text]);
  });

  it('428 without confirm:true over 400 characters', async () => {
    const before = app.exec.calls.length;
    const text = 'x'.repeat(MAX_TEXT + 1);
    const res = await app.api('/api/send', { method: 'POST', body: { terminal: 't19b', text } });
    assert.equal(res.status, 428);
    assert.equal(res.data.error, 'confirm_required');
    assert.equal(res.data.reason, 'long');
    assert.equal(app.exec.calls.length, before, 'nothing was sent');
  });

  it('428 without confirm:true for each destructive payload', async () => {
    for (const text of ['rm -rf /tmp/thing', 'rm -fr build', 'git push --force origin trunk', 'DROP TABLE users']) {
      const res = await app.api('/api/send', { method: 'POST', body: { terminal: 't19b', text } });
      assert.equal(res.status, 428, text);
      assert.equal(res.data.reason, 'destructive', text);
    }
  });

  it('sends the same payload with confirm:true', async () => {
    const text = 'rm -rf /tmp/thing';
    const res = await app.api('/api/send', { method: 'POST', body: { terminal: 't19b', text, confirm: true } });
    assert.equal(res.status, 200);
    assert.deepEqual(app.exec.calls.at(-1).args, ['send', 't19b', text]);
  });

  it('400 on a bad terminal or a missing text', async () => {
    for (const body of [{ terminal: 'nope', text: 'hi' }, { terminal: 't19b' }, { text: 'hi' }]) {
      const res = await app.api('/api/send', { method: 'POST', body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('502 when hc send fails, so the page does not claim a send that did not happen', async () => {
    const failing = await boot({ table: { 'hc send': { code: 2, stdout: '', stderr: 'terminal gone' } } });
    const res = await failing.api('/api/send', { method: 'POST', body: { terminal: 't19b', text: 'hi' } });
    assert.equal(res.status, 502);
    assert.equal(res.data.error, 'hc_send_failed');
    await failing.close();
  });
});

describe('POST /api/keys and /api/interrupt', () => {
  let app;
  before(async () => {
    app = await boot({ table });
  });
  after(async () => {
    await app.close();
  });

  it('passes an allowed key to hc keys', async () => {
    const res = await app.api('/api/keys', { method: 'POST', body: { terminal: 't19b', keys: ['ctrl+c'] } });
    assert.equal(res.status, 200);
    assert.deepEqual(app.exec.calls.at(-1).args, ['keys', 't19b', 'ctrl+c']);
  });

  it('accepts a space separated string of keys', async () => {
    const res = await app.api('/api/keys', { method: 'POST', body: { terminal: 't19b', keys: 'esc enter' } });
    assert.equal(res.status, 200);
    assert.deepEqual(app.exec.calls.at(-1).args, ['keys', 't19b', 'esc enter']);
  });

  it('400 for a key that is not on the allowlist', async () => {
    const res = await app.api('/api/keys', { method: 'POST', body: { terminal: 't19b', keys: ['rm'] } });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'bad_key');
  });

  it('interrupts through hc interrupt', async () => {
    const res = await app.api('/api/interrupt', { method: 'POST', body: { terminal: 't19b' } });
    assert.equal(res.status, 200);
    assert.deepEqual(app.exec.calls.at(-1).args, ['interrupt', 't19b']);
  });
});

describe('confirmReason', () => {
  it('flags length above 400 and the destructive list, nothing else', () => {
    assert.equal(confirmReason('ls -la'), null);
    assert.equal(confirmReason('git push origin feat/x'), null);
    assert.equal(confirmReason('npm run test'), null);
    assert.equal(confirmReason('x'.repeat(400)), null);
    assert.equal(confirmReason('x'.repeat(401)), 'long');
    assert.equal(confirmReason('rm -rf ~/x'), 'destructive');
    assert.equal(confirmReason('rm -r -f x'), 'destructive');
    assert.equal(confirmReason('git push -f'), 'destructive');
    assert.equal(confirmReason('psql -c "drop database prod"'), 'destructive');
    assert.equal(confirmReason(undefined), null);
  });
});
