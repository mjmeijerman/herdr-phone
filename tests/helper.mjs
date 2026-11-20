// Shared test harness: a real herdr-phone server on an ephemeral loopback port,
// with every `hc` / `herdr-app` call stubbed. No network, no real Herdr.
import { createApp, listen } from '../server.mjs';

export const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** A runner stub that records argv and answers from a table. */
export function makeExec(table = {}) {
  const calls = [];
  const exec = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const key = [cmd, args[0]].join(' ');
    const answer = table[key];
    if (typeof answer === 'function') return answer(cmd, args, opts);
    if (answer) return answer;
    return { code: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  /** argv of every recorded call, `[cmd, ...args]`. */
  exec.argv = () => calls.map((c) => [c.cmd, ...c.args]);
  return exec;
}

export async function boot(opts = {}) {
  const exec = opts.exec ?? makeExec(opts.table ?? {});
  const token = opts.token ?? TOKEN;
  const app = createApp({ exec, token, log: false });
  const bound = await listen(app, 0);
  const url = `http://127.0.0.1:${bound.port}`;
  return {
    url,
    port: bound.port,
    token,
    exec,
    cookie: app.cookie,
    close: () => new Promise((resolve) => bound.server.close(resolve)),
    async fetch(path, init = {}) {
      return globalThis.fetch(url + path, init);
    },
    /** fetch with a Bearer token, JSON body in and out. */
    async api(path, { method = 'GET', body, bearer = TOKEN } = {}) {
      const headers = {};
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await globalThis.fetch(url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
}

export const HERDR_APP_LS = {
  spaces: [
    {
      id: 'sp1',
      name: 'big-boss-pi',
      folder: '/home/mark/big-boss-pi',
      machine: null,
      active: true,
      tabs: [
        {
          id: 'tb1',
          name: 'Pi (bare)',
          active: true,
          settled: false,
          terminals: [{ terminal: 't19b', pane: 'p1', status: 'working', app: 'pi', name: null, sub_agents: [] }],
        },
        {
          id: 'tb2',
          name: 'spare',
          active: false,
          settled: false,
          terminals: [{ terminal: 't1dp', pane: 'p2', status: 'done', app: 'pi', name: null, sub_agents: [] }],
        },
      ],
    },
    {
      id: 'sp2',
      name: 'Apps',
      folder: '/home/mark',
      machine: null,
      active: false,
      tabs: [{ id: 'tb3', name: 'Pull requests', active: true, settled: false, terminals: [] }],
    },
  ],
};

export const HC_LS = {
  hidden_finished: 3,
  terminals: [
    {
      address: 't19b',
      agent: 'pi',
      cwd: '/home/mark/big-boss-pi',
      state: 'live',
      status: 'working',
      turn: 128,
      where: 'big-boss-pi / Pi (bare)',
    },
    {
      address: 't1dp',
      agent: 'pi',
      cwd: '/home/mark/.pi',
      state: 'live',
      status: 'done',
      turn: 1,
      where: 'big-boss-pi / spare',
    },
  ],
};
