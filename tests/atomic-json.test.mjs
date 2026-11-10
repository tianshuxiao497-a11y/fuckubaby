import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicWriteJson } from '../lib/atomic-json.mjs';

const failure = code => Object.assign(new Error(`Synthetic ${code}`), { code });

function fixture({ renameErrors = [], failAt = null, openCollisions = 0 } = {}) {
  const calls = [];
  const files = new Map([[resolve('state.json'), 'original']]);
  let currentOpenCollisions = openCollisions;
  let temporaryPath;
  let closed = false;
  const api = {
    async open(path, flags, mode) {
      calls.push(['open', path, flags, mode]);
      if (currentOpenCollisions-- > 0) throw failure('EEXIST');
      if (failAt === 'open') throw failure('EACCES');
      assert.equal(files.has(path), false);
      files.set(path, '');
      temporaryPath = path;
      return {
        async writeFile(content, encoding) {
          calls.push(['write', encoding]);
          files.set(path, content);
          if (failAt === 'write') throw failure('EIO');
        },
        async sync() {
          calls.push(['sync']);
          if (failAt === 'sync') throw failure('EIO');
        },
        async close() {
          calls.push(['close']);
          closed = true;
          if (failAt === 'close') throw failure('EBUSY');
        }
      };
    },
    async rename(from, to) {
      calls.push(['rename', from, to]);
      assert.equal(closed, true, 'the writer must close its handle before rename');
      const error = renameErrors.shift();
      if (error) throw error;
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink() { assert.fail('Existing destinations must never be unlinked'); },
    async copyFile() { assert.fail('Existing destinations must never be copied over'); }
  };
  const sleeps = [];
  const options = { fs: api, platform: 'win32', sleep: async ms => { sleeps.push(ms); } };
  return { calls, files, options, sleeps, get temporaryPath() { return temporaryPath; } };
}

test('real filesystem writes valid JSON and replaces an existing destination in one directory', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'atomic-json-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'state.json');
  const value = { version: 1, label: '虚拟仓', pending: null };
  await fs.writeFile(target, 'old state', 'utf8');
  await atomicWriteJson(target, value);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), value);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
  await atomicWriteJson(join(directory, 'new.json'), [1, 2]);
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'new.json'), 'utf8')), [1, 2]);
});

test('temp is unique, in the destination directory, exclusive and private; sync and close precede commit', async () => {
  const one = fixture();
  const two = fixture();
  await atomicWriteJson('state.json', { a: 1 }, one.options);
  await atomicWriteJson('state.json', { b: 2 }, two.options);
  assert.notEqual(one.temporaryPath, two.temporaryPath);
  assert.equal(dirname(one.temporaryPath), dirname(resolve('state.json')));
  assert.match(basename(one.temporaryPath), /^\.state\.json\.\d+\.[\da-f-]+\.tmp$/);
  assert.deepEqual(one.calls.map(call => call[0]), ['open', 'write', 'sync', 'close', 'rename']);
  assert.equal(one.calls[0][2], 'wx');
  assert.equal(one.calls[0][3], 0o600);
  assert.equal(one.calls[1][1], 'utf8');
  assert.deepEqual(JSON.parse(one.files.get(resolve('state.json'))), { a: 1 });
});

test('Windows EPERM, EACCES and EBUSY rename errors are retried with bounded delays and eventually commit', async () => {
  const f = fixture({ renameErrors: [failure('EPERM'), failure('EACCES'), failure('EBUSY')] });
  await atomicWriteJson('state.json', { a: 1 }, f.options);
  assert.deepEqual(f.sleeps, [25, 50, 100]);
  assert.equal(f.calls.filter(call => call[0] === 'rename').length, 4);
  assert.equal(f.calls.filter(call => call[0] === 'write').length, 1);
  assert.equal(f.files.has(f.temporaryPath), false);
});

test('exhausted Windows retries preserve both the original and synced temporary JSON', async () => {
  const f = fixture({ renameErrors: Array.from({ length: 20 }, () => failure('EPERM')) });
  const error = await atomicWriteJson('state.json', { pending: { id: 'fixture-only' } }, f.options).catch(e => e);
  assert.equal(error.code, 'EPERM');
  assert.equal(error.temporaryPath, f.temporaryPath);
  assert.equal(f.files.get(resolve('state.json')), 'original');
  assert.deepEqual(JSON.parse(f.files.get(error.temporaryPath)), { pending: { id: 'fixture-only' } });
  assert.deepEqual(f.sleeps, [25, 50, 100, 200, 400, 800]);
  assert.equal(f.calls.filter(call => call[0] === 'rename').length, 7);
});

test('non-retryable rename failure is surfaced immediately and keeps recovery evidence', async () => {
  const f = fixture({ renameErrors: [failure('ENOSPC')] });
  await assert.rejects(atomicWriteJson('state.json', { a: 1 }, f.options), error => {
    assert.equal(error.code, 'ENOSPC');
    assert.equal(error.temporaryPath, f.temporaryPath);
    return true;
  });
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.files.get(resolve('state.json')), 'original');
  assert.equal(f.files.has(f.temporaryPath), true);
});

test('non-Windows rename errors are not retried even if their code is EPERM', async () => {
  const f = fixture({ renameErrors: [failure('EPERM')] });
  await assert.rejects(atomicWriteJson('state.json', {}, { ...f.options, platform: 'linux' }), { code: 'EPERM' });
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.calls.filter(call => call[0] === 'rename').length, 1);
});

test('explicit bounded retry schedule can disable retries or use deterministic test delays', async () => {
  const none = fixture({ renameErrors: [failure('EBUSY')] });
  await assert.rejects(atomicWriteJson('state.json', {}, { ...none.options, retryDelaysMs: [] }), { code: 'EBUSY' });
  assert.equal(none.calls.filter(call => call[0] === 'rename').length, 1);
  const once = fixture({ renameErrors: [failure('EPERM')] });
  await atomicWriteJson('state.json', {}, { ...once.options, retryDelaysMs: [0] });
  assert.deepEqual(once.sleeps, [0]);
});

test('invalid or excessive retry schedules fail before any filesystem access', async () => {
  for (const retryDelaysMs of [null, '1', Array(1), [1.5], [-1], [NaN], [Infinity], [1001], Array(9).fill(1), Array(6).fill(1000), [true]]) {
    const f = fixture();
    await assert.rejects(atomicWriteJson('state.json', {}, { ...f.options, retryDelaysMs }), TypeError);
    assert.deepEqual(f.calls, []);
  }
});

test('serialization failure or a non-document root never touches the filesystem', async () => {
  const circular = {};
  circular.self = circular;
  for (const value of [circular, { big: 1n }, undefined, () => 1, Symbol('fixture')]) {
    const f = fixture();
    await assert.rejects(atomicWriteJson('state.json', value, f.options), TypeError);
    assert.deepEqual(f.calls, []);
    assert.equal(f.files.get(resolve('state.json')), 'original');
  }
  const f = fixture();
  await assert.rejects(atomicWriteJson('state.json', { toJSON() { throw new Error('Synthetic serialization failure'); } }, f.options));
  assert.deepEqual(f.calls, []);
});

test('write, sync or close failure never commits, closes when possible and preserves the owned temp', async () => {
  for (const failAt of ['write', 'sync', 'close']) {
    const f = fixture({ failAt });
    await assert.rejects(atomicWriteJson('state.json', { a: 1 }, f.options), error => {
      assert.equal(error.temporaryPath, f.temporaryPath);
      return true;
    });
    assert.equal(f.calls.filter(call => call[0] === 'close').length, 1);
    assert.equal(f.calls.some(call => call[0] === 'rename'), false);
    assert.equal(f.files.get(resolve('state.json')), 'original');
    assert.equal(f.files.has(f.temporaryPath), true);
  }
});

test('even a non-Error preparation exception prevents commit and retains recovery metadata', async () => {
  const f = fixture();
  const open = f.options.fs.open;
  f.options.fs.open = async (...args) => {
    const handle = await open(...args);
    handle.sync = async () => { throw undefined; };
    return handle;
  };
  await assert.rejects(atomicWriteJson('state.json', {}, f.options), error => {
    assert.equal(error.temporaryPath, f.temporaryPath);
    return true;
  });
  assert.equal(f.calls.some(call => call[0] === 'rename'), false);
  assert.equal(f.files.get(resolve('state.json')), 'original');
});

test('exclusive temp collisions choose a fresh path and never overwrite or remove the collision', async () => {
  const f = fixture({ openCollisions: 2 });
  await atomicWriteJson('state.json', {}, f.options);
  const opened = f.calls.filter(call => call[0] === 'open');
  assert.equal(opened.length, 3);
  assert.equal(new Set(opened.map(call => call[1])).size, 3);
  assert.equal(f.calls.filter(call => call[0] === 'write').length, 1);
  assert.equal(f.files.get(resolve('state.json')), '{}\n');
});

test('temp collision attempts are bounded and no unowned file is offered as recovery evidence', async () => {
  const f = fixture({ openCollisions: 100 });
  await assert.rejects(atomicWriteJson('state.json', {}, f.options), error => {
    assert.equal(error.code, 'EEXIST');
    assert.equal(error.temporaryPath, undefined);
    return true;
  });
  assert.equal(f.calls.length, 8);
  assert.equal(f.files.get(resolve('state.json')), 'original');
});

test('an open failure does not alter the destination or invent a recovery path', async () => {
  const f = fixture({ failAt: 'open' });
  await assert.rejects(atomicWriteJson('state.json', {}, f.options), error => {
    assert.equal(error.code, 'EACCES');
    assert.equal(error.temporaryPath, undefined);
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.files.get(resolve('state.json')), 'original');
});

test('a sleep failure and a frozen filesystem error retain the temp path without masking the cause', async () => {
  const sleeping = fixture({ renameErrors: [failure('EPERM')] });
  const interruption = failure('ABORT_ERR');
  await assert.rejects(atomicWriteJson('state.json', {}, {
    ...sleeping.options, sleep: async () => { throw interruption; }
  }), error => {
    assert.equal(error, interruption);
    assert.equal(error.temporaryPath, sleeping.temporaryPath);
    return true;
  });
  const frozenError = Object.freeze(failure('ENOSPC'));
  const frozen = fixture({ renameErrors: [frozenError] });
  await assert.rejects(atomicWriteJson('state.json', {}, frozen.options), error => {
    assert.equal(error.cause, frozenError);
    assert.equal(error.code, 'ENOSPC');
    assert.equal(error.temporaryPath, frozen.temporaryPath);
    return true;
  });
});
