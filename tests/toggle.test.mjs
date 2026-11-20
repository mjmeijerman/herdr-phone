// The two accordion helpers the page runs: one screen at a time, and a finished
// section that closes again without asking the server twice.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { needsFinishedFetch, PAGE, toggleFinished, toggleTerminal } from '../server.mjs';

describe('toggleTerminal', () => {
  it('opens, closes the same row, and opens it again', () => {
    const state = { terminal: null };
    assert.equal(toggleTerminal(state, 't19b'), 't19b');
    assert.equal(state.terminal, 't19b');
    assert.equal(toggleTerminal(state, 't19b'), null);
    assert.equal(state.terminal, null);
    assert.equal(toggleTerminal(state, 't19b'), 't19b');
    assert.equal(state.terminal, 't19b');
  });

  it('switches to a different row and keeps only one open', () => {
    const state = { terminal: 't19b' };
    assert.equal(toggleTerminal(state, 't1dp'), 't1dp');
    assert.equal(state.terminal, 't1dp');
    // Tapping the other row closes the screen, never reopens the first.
    assert.equal(toggleTerminal(state, 't1dp'), null);
    assert.equal(state.terminal, null);
  });

  it('is the code the page runs, not a copy', () => {
    assert.ok(PAGE.includes('function toggleTerminal'));
    assert.ok(PAGE.includes('function toggleFinished'));
    assert.ok(PAGE.includes('function needsFinishedFetch'));
  });
});

describe('toggleFinished', () => {
  it('toggles both ways and keeps the rows it already has', () => {
    const state = { all: false, gone: [{ address: 't1' }, { address: 't2' }] };
    assert.equal(toggleFinished(state), true);
    assert.equal(state.all, true);
    assert.equal(toggleFinished(state), false);
    assert.equal(state.all, false);
    assert.equal(state.gone.length, 2);
  });
});

describe('finished rows and the ?all=1 request', () => {
  it('collapses and re-expands on one request, rows surviving in state', async () => {
    let requests = 0;
    const state = { all: false, gone: [] };
    const loadTabs = async () => {
      requests += 1;
      state.gone = [{ address: 't1' }, { address: 't2' }];
    };

    // First expand: no rows yet, so one ?all=1 request.
    toggleFinished(state);
    if (needsFinishedFetch(state)) await loadTabs();
    assert.equal(requests, 1);
    assert.equal(state.gone.length, 2);

    // Collapse: nothing is asked for, and the rows stay.
    toggleFinished(state);
    assert.equal(state.all, false);
    assert.equal(needsFinishedFetch(state), false);
    assert.equal(requests, 1);
    assert.equal(state.gone.length, 2);

    // Re-expand: still cached, so still one request in total.
    toggleFinished(state);
    if (needsFinishedFetch(state)) await loadTabs();
    assert.equal(requests, 1);
    assert.equal(state.gone.length, 2);
  });
});
