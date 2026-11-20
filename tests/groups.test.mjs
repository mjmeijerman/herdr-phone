// /api/tabs groups: the flat `agents` array (working, then done, then idle,
// newest activity first inside a group), the counts, finished terminals from
// `hc ls --all`, and ?all=1. Plus the page's chip row, which filters without a
// request.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { cwdBase, groupAgents, PAGE } from '../server.mjs';
import { boot } from './helper.mjs';

const ok = (value) => ({ code: 0, stdout: JSON.stringify(value) });

/**
 * Like the shared stub, but keyed on the whole argv, so `hc ls` and
 * `hc ls --all` can answer differently. Falls back to the first argument.
 */
function tableExec(table) {
  const calls = [];
  const exec = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const answer = table[[cmd, ...args].join(' ')] ?? table[[cmd, args[0]].join(' ')];
    if (typeof answer === 'function') return answer(cmd, args, opts);
    if (answer) return answer;
    return { code: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  exec.argv = () => calls.map((c) => [c.cmd, ...c.args]);
  return exec;
}

const APP_LS = {
  spaces: [
    {
      name: 'big-boss-pi',
      active: true,
      tabs: [
        { name: 'Pi (bare)', active: true, terminals: [{ terminal: 't19b', app: 'pi', name: 'boss' }] },
        { name: 'spare', active: false, terminals: [{ terminal: 't1dp', app: 'pi' }] },
      ],
    },
    {
      name: 'Apps',
      active: false,
      tabs: [
        { name: 'queue', active: true, terminals: [] },
        { name: 'worker', active: false, terminals: [{ terminal: 't1bb', app: 'pi' }] },
      ],
    },
  ],
};

const term = (address, status, turn, recent, extra = {}) => ({
  address,
  agent: 'pi',
  cwd: `/home/mark/projects/${address}`,
  state: 'live',
  status,
  turn,
  where: `${extra.space ?? 'big-boss-pi'} / ${extra.tab ?? 'Pi (bare)'}`,
  recent_status_ms: recent,
  ...extra,
});

// Deliberately unsorted: an idle first, and two working terminals where the
// older one comes first in hc's output.
const HC_LS = {
  hidden_finished: 0,
  terminals: [
    term('t1aa', 'idle', 3, 500, { where: 'Apps / queue' }),
    term('t19b', 'working', 128, 100),
    term('t1dp', 'done', 9, 800, { where: 'big-boss-pi / spare' }),
    term('t1bb', 'working', 12, 900, { where: 'Apps / worker' }),
  ],
};

const FINISHED = [
  term('t1f1', 'done', 1, 10, { space: 'big-boss-pi', tab: 'old' }),
  term('t1f2', 'done', 2, 20, { space: 'big-boss-pi', tab: 'old' }),
  term('t1f3', 'done', 3, 30, { space: 'Apps', tab: 'gone' }),
];

const HC_ALL = { hidden_finished: 3, terminals: [...HC_LS.terminals, ...FINISHED] };

const table = {
  'herdr-app ls': ok(APP_LS),
  'hc ls': ok(HC_LS),
  'hc ls --all': ok(HC_ALL),
};

describe('GET /api/tabs groups', () => {
  let app;
  before(async () => {
    app = await boot({ exec: tableExec(table) });
  });
  after(async () => {
    await app.close();
  });

  it('sorts working first, then done, then idle, newest activity first', async () => {
    const res = await app.api('/api/tabs');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.groups, { working: 2, done: 1, idle: 1, finished: 3 });

    assert.deepEqual(
      res.data.agents.map((a) => [a.address, a.status]),
      [
        ['t1bb', 'working'], // newest activity in the working group, not hc's order
        ['t19b', 'working'],
        ['t1dp', 'done'],
        ['t1aa', 'idle'],
      ],
    );

    // The counts add up to the live terminal count, which is the measurement.
    const g = res.data.groups;
    assert.equal(g.working + g.done + g.idle, HC_LS.terminals.length);
  });

  it('carries the row fields the page draws', async () => {
    const { agents } = (await app.api('/api/tabs')).data;
    const boss = agents.find((a) => a.address === 't19b');
    assert.deepEqual(boss, {
      space: 'big-boss-pi',
      tab: 'Pi (bare)',
      address: 't19b',
      agent: 'pi',
      label: 'boss',
      status: 'working',
      turn: 128,
      cwdBase: 't19b',
    });
  });

  it('counts finished terminals from hc ls --all and keeps them out of agents', async () => {
    const { groups, agents } = (await app.api('/api/tabs')).data;
    assert.equal(groups.finished, FINISHED.length);
    assert.equal(agents.length, HC_LS.terminals.length);
    assert.equal(agents.some((a) => a.address === 't1f1'), false);
  });

  it('lists finished terminals only when ?all=1 is passed', async () => {
    const res = await app.api('/api/tabs?all=1');
    assert.equal(res.status, 200);
    assert.equal(res.data.agents.length, HC_ALL.terminals.length);
    const finished = res.data.agents.filter((a) => a.status === 'finished');
    assert.equal(finished.length, FINISHED.length);
    assert.deepEqual(
      finished.map((a) => a.address),
      ['t1f3', 't1f2', 't1f1'], // newest activity first inside the group
    );
    // Their space and tab come from hc's `where` when the app tree is silent.
    assert.equal(finished[0].space, 'Apps');
    assert.equal(finished[0].tab, 'gone');
    // A finished group is always drawn last.
    assert.equal(res.data.agents.at(-1).status, 'finished');
  });

  it('falls back to hc hidden_finished when hc ls --all is unavailable', async () => {
    const exec = tableExec({
      'herdr-app ls': ok(APP_LS),
      'hc ls': { code: 0, stdout: JSON.stringify({ hidden_finished: 7, terminals: HC_LS.terminals }) },
      'hc ls --all': { code: 127, stdout: '', stderr: 'not found' },
    });
    const app2 = await boot({ exec });
    try {
      const { groups, agents } = (await app2.api('/api/tabs')).data;
      assert.equal(groups.finished, 7);
      assert.equal(agents.length, HC_LS.terminals.length);
    } finally {
      await app2.close();
    }
  });
});

describe('groupAgents', () => {
  it('takes a cwd basename, tolerating a trailing slash and root', () => {
    assert.equal(cwdBase('/home/mark/projects/herdr-phone/'), 'herdr-phone');
    assert.equal(cwdBase('/'), '/');
    assert.equal(cwdBase(null), null);
    assert.equal(cwdBase(''), null);
  });

  it('never reports a live terminal twice when --all repeats it', () => {
    const { groups, finished } = groupAgents(HC_LS.terminals, HC_ALL.terminals);
    assert.equal(groups.finished, FINISHED.length);
    assert.equal(finished.length, FINISHED.length);
  });
});

describe('the chip row', () => {
  // No browser in the tests: the page source is the assertion. The chips set a
  // filter and re-render from the data already in hand, so tapping one makes no
  // request.
  const chips = PAGE.slice(PAGE.indexOf('class="chips"'), PAGE.indexOf('</div>', PAGE.indexOf('class="chips"')));
  const setFilter = PAGE.slice(PAGE.indexOf('function setFilter'), PAGE.indexOf('el.chips.addEventListener'));

  it('offers All, Working, Done and Idle', () => {
    for (const key of ['all', 'working', 'done', 'idle']) {
      assert.match(chips, new RegExp(`data-filter="${key}"`));
    }
    assert.equal(typeof chips, 'string');
  });

  it('filters client-side: no fetch, no reload in the handler', () => {
    assert.ok(setFilter.includes('renderAgents'));
    assert.equal(setFilter.includes('api('), false);
    assert.equal(setFilter.includes('loadTabs'), false);
    assert.equal(setFilter.includes('location.reload'), false);
  });

  it('asks for ?all=1 only after the finished line is tapped', () => {
    const loadTabs = PAGE.slice(PAGE.indexOf('function loadTabs'), PAGE.indexOf('function esc('));
    assert.match(loadTabs, /\?all=1/);
    assert.match(loadTabs, /state\.all/);
    // The default request carries no query string at all.
    assert.match(PAGE, /state\.all \? '\?all=1' : ''/);
  });
});
