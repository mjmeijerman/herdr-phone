// /api/tabs shape from a stubbed `herdr-app ls` + `hc ls`, and the fallback when
// herdr-app is missing. Also /api/screen: honest 502 and no ANSI noise.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { cleanScreen, readTabs } from '../server.mjs';
import { boot, HC_LS, HERDR_APP_LS, makeExec } from './helper.mjs';

const ok = (value) => ({ code: 0, stdout: JSON.stringify(value) });
const table = { 'herdr-app ls': ok(HERDR_APP_LS), 'hc ls': ok(HC_LS) };

describe('GET /api/tabs', () => {
  let app;
  before(async () => {
    app = await boot({ table });
  });
  after(async () => {
    await app.close();
  });

  it('returns one row per space with its tabs and live state', async () => {
    const res = await app.api('/api/tabs');
    assert.equal(res.status, 200);
    const { spaces, ok: flag, at, problems } = res.data;
    assert.equal(flag, true);
    assert.equal(typeof at, 'string');
    assert.deepEqual(problems, []);

    assert.equal(spaces.length, 2);
    assert.equal(spaces[0].name, 'big-boss-pi');
    assert.equal(spaces[0].active, true);
    assert.equal(spaces[0].tabs.length, 2);

    const live = spaces[0].tabs[0];
    assert.equal(live.name, 'Pi (bare)');
    assert.equal(live.terminals.length, 1);
    assert.deepEqual(live.terminals[0], {
      address: 't19b',
      agent: 'pi',
      cwd: '/home/mark/big-boss-pi',
      state: 'live',
      status: 'working',
      working: true,
      turn: 128,
      app: 'pi',
      label: null,
    });

    assert.equal(spaces[0].tabs[1].terminals[0].status, 'done');
    assert.equal(spaces[0].tabs[1].terminals[0].working, false);

    // A tab with no terminal is kept, so the page can show it greyed out.
    assert.deepEqual(spaces[1].tabs[0].terminals, []);
  });

  it('keeps the shape when herdr-app is missing, rebuilding from hc where', async () => {
    const exec = makeExec({
      'herdr-app ls': { code: 127, stdout: '', stderr: 'not found' },
      'hc ls': ok(HC_LS),
    });
    const data = await readTabs(exec);
    assert.deepEqual(data.problems, ['herdr-app ls']);
    assert.equal(data.spaces.length, 1);
    assert.equal(data.spaces[0].name, 'big-boss-pi');
    assert.deepEqual(
      data.spaces[0].tabs.map((t) => t.name),
      ['Pi (bare)', 'spare'],
    );
    assert.equal(data.spaces[0].tabs[0].terminals[0].address, 't19b');
    assert.equal(data.spaces[0].tabs[0].terminals[0].working, true);
  });

  it('reports both sources missing instead of throwing', async () => {
    const exec = makeExec({
      'herdr-app ls': { code: -1, stdout: '', stderr: 'boom' },
      'hc ls': { code: -1, stdout: 'not json', stderr: 'boom' },
    });
    const data = await readTabs(exec);
    assert.deepEqual(data.problems.sort(), ['hc ls', 'herdr-app ls']);
    assert.deepEqual(data.spaces, []);
  });

  it('drops terminal ids that do not look like a Herdr address', async () => {
    const exec = makeExec({
      'herdr-app ls': ok({
        spaces: [{ name: 'x', active: true, tabs: [{ name: 't', active: true, terminals: [{ terminal: '../../etc' }] }] }],
      }),
      'hc ls': ok({ terminals: [] }),
    });
    const data = await readTabs(exec);
    assert.deepEqual(data.spaces[0].tabs[0].terminals, []);
  });
});

describe('GET /api/screen', () => {
  let app;
  before(async () => {
    app = await boot({
      table: {
        ...table,
        'hc read': { code: 0, stdout: '\x1b[1m\u2713 bash\x1b[0m\r\nhello\r\n\x1b]0;title\x07bye\r\n' },
        'hc interrupt': { code: 0, stdout: '' },
      },
    });
  });
  after(async () => {
    await app.close();
  });

  it('returns a cleaned screen for a valid terminal', async () => {
    const res = await app.api('/api/screen?terminal=t19b');
    assert.equal(res.status, 200);
    assert.equal(res.data.terminal, 't19b');
    assert.equal(res.data.screen, '\u2713 bash\nhello\nbye');
  });

  it('passes the address as argv, never through a shell', async () => {
    await app.api('/api/screen?terminal=t1dp');
    const argv = app.exec.argv();
    assert.ok(argv.some((a) => a.length === 3 && a[0] === 'hc' && a[1] === 'read' && a[2] === 't1dp'));
  });

  it('rejects a terminal id that is not a Herdr address', async () => {
    for (const bad of ['../../etc/passwd', 't19b;rm', '', 'x19b']) {
      const res = await app.api(`/api/screen?terminal=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, bad);
    }
  });

  it('is 502, not 200 with an empty screen, when hc read fails', async () => {
    const failing = await boot({ table: { 'hc read': { code: 1, stdout: '', stderr: 'no such terminal' } } });
    const res = await failing.api('/api/screen?terminal=t19b');
    assert.equal(res.status, 502);
    assert.equal(res.data.error, 'hc_read_failed');
    await failing.close();
  });

  it('cleanScreen drops CSI, OSC and control bytes but keeps newlines and tabs', () => {
    assert.equal(cleanScreen('\x1b[31mred\x1b[0m\tok\x07\x00\n\n\n\n\nend\r\n'), 'red\tok\n\n\nend');
  });
});
