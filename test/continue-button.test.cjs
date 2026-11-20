const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.resolve(process.argv[2]);
const source = fs.readFileSync(file, 'utf8');

/* --- a controllable clock: no timer ever runs on its own ------------------ */
let clock = 0;
let nextTimerId = 1;
const timers = new Map();

function setTimer(fn, delay) {
  const id = nextTimerId++;
  timers.set(id, { fn, at: clock + (Number(delay) || 0) });
  return id;
}
function clearTimer(id) {
  timers.delete(id);
}
/** Advance the clock, running every timer that becomes due. */
function tick(ms) {
  const target = clock + ms;
  let guard = 0;
  for (;;) {
    let due = null;
    for (const [id, timer] of timers) {
      if (timer.at <= target && (due === null || timer.at < due.timer.at)) due = { id, timer };
    }
    if (due === null) break;
    timers.delete(due.id);
    clock = due.timer.at;
    due.timer.fn();
    guard += 1;
    if (guard > 10000) throw new Error('timer storm');
  }
  clock = target;
}
/** Let every pending promise settle. */
const settle = () => new Promise((resolve) => process.nextTick(resolve));

/* --- hook runtime --------------------------------------------------------- */
let hookIndex = 0;
let hookState = [];
let pending = [];

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) {
    const index = hookIndex++;
    if (hookState.length <= index) hookState[index] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
    };
    return [hookState[index], set];
  },
  useEffect(fn, deps) {
    const index = hookIndex++;
    const prev = hookState[index];
    const changed = prev === undefined || deps === undefined
      || prev.deps === undefined
      || deps.length !== prev.deps.length
      || deps.some((value, i) => value !== prev.deps[i]);
    if (changed) pending.push({ index, fn });
    hookState[index] = { deps, cleanup: prev === undefined ? undefined : prev.cleanup };
  },
  useRef(value) {
    const index = hookIndex++;
    if (hookState.length <= index) hookState[index] = { current: value };
    return hookState[index];
  },
  useCallback(fn) {
    const index = hookIndex++;
    if (hookState.length <= index) hookState[index] = fn;
    return hookState[index];
  },
  useMemo(fn) {
    const index = hookIndex++;
    if (hookState.length <= index) hookState[index] = fn();
    return hookState[index];
  },
};

const table = {
  react: fakeReact,
  'react-dom': { createPortal: (n) => n },
  'react-dom/client': { createRoot: () => ({ render() {}, unmount() {} }) },
};

const doc = {
  body: { appendChild() {}, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] },
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, appendChild() {}, remove() {} }),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

const fetchCalls = [];
let fetchImpl = () => Promise.resolve({ ok: false });

const sandbox = {
  window: {
    __ModuleLoader__: { load: (s) => { sandbox.__spec = s; } },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    BroadcastChannel: undefined,
    getComputedStyle: () => ({ position: 'static' }),
  },
  document: doc,
  MutationObserver: undefined,
  AbortController,
  fetch: (...args) => {
    fetchCalls.push(args);
    return fetchImpl(...args);
  },
  navigator: { language: 'zh-CN' },
  console, Symbol, Object, Array, Set, Map, Number, String, JSON, Promise, Error, URL,
  encodeURIComponent,
  setTimeout: setTimer,
  clearTimeout: clearTimer,
  requestAnimationFrame: (fn) => setTimer(fn, 16),
  cancelAnimationFrame: clearTimer,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: file });

const spec = sandbox.__spec;
const client = spec.factory((name) => table[name]);

const components = {};
client.apply({
  slots: {
    inject: (_key, cb) => cb(),
    register: (options, component) => {
      components[options.name] = component;
      return () => {};
    },
  },
  inject: (_names, cb) => cb({}),
  effect: () => () => {},
});

const ContinueButton = components['conversation.input.right'];
assert.equal(typeof ContinueButton, 'function', 'continue button must register');

/** Render once, running the effects this render queued. */
function render(props) {
  hookIndex = 0;
  pending = [];
  const tree = ContinueButton(props);
  const queued = pending;
  pending = [];
  for (const effect of queued) {
    const cleanup = effect.fn();
    const slot = hookState[effect.index];
    if (slot !== undefined) slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  }
  return tree;
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await settle();
  tick(0);
  for (let i = 0; i < 6; i += 1) await settle();
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function reset() {
  hookState = [];
  hookIndex = 0;
  pending = [];
  timers.clear();
}

const okJson = (body) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

check('renders nothing when the Host reports nothing to continue', async () => {
  reset();
  fetchImpl = okJson({ ok: true, enabled: true, canContinue: false });
  render({ sessionId: 'sess-1' });
  await flush();
  assert.equal(render({ sessionId: 'sess-1' }), null);
});

check('renders a button for a continuable error turn', async () => {
  reset();
  fetchImpl = okJson({ ok: true, enabled: true, canContinue: true, prefill: true, reason: { kind: 'error', code: 'E' } });
  render({ sessionId: 'sess-1' });
  await flush();
  const out = render({ sessionId: 'sess-1' });
  assert.ok(out !== null, 'button must render');
  assert.equal(out.type, 'button');
  assert.ok(String(out.props.className).includes('dshbs-continue'));
  assert.equal(out.props['aria-label'], '上一轮因报错中断，可从这里继续');
  assert.equal(out.props['data-dsh-button-sample'], 'continue');
  assert.equal(out.props['data-busy'], '0');
});

check('every continuable kind gets its own title', async () => {
  const cases = [
    [{ kind: 'max-tokens' }, true, '上一轮输出被长度上限截断，可从这里接着写'],
    [{ kind: 'aborted' }, true, '上一轮被手动停止，可从这里接着写'],
    [{ kind: 'interrupted' }, true, '上一轮被手动停止，可从这里接着写'],
    [{ kind: 'error', code: 'X' }, true, '上一轮因报错中断，可从这里继续'],
    [{ kind: 'blocked' }, false, '重新生成'],
    [{ kind: 'forked' }, false, '重新生成'],
  ];
  for (const [reason, prefill, expected] of cases) {
    reset();
    fetchImpl = okJson({ ok: true, enabled: true, canContinue: true, prefill, reason });
    render({ sessionId: 'sess-1' });
    await flush();
    const out = render({ sessionId: 'sess-1' });
    assert.ok(out !== null, 'button must render for ' + reason.kind);
    assert.equal(out.props['aria-label'], expected, 'title for ' + reason.kind);
  }
});

check('a click posts the sessionId to the continue route', async () => {
  reset();
  const before = fetchCalls.length;
  fetchImpl = okJson({ ok: true, canContinue: true, prefill: true, reason: { kind: 'max-tokens' } });
  render({ sessionId: 'sess-1' });
  await flush();
  const out = render({ sessionId: 'sess-1' });
  assert.ok(out !== null);
  await out.props.onClick();
  await flush();
  const posted = fetchCalls.slice(before).filter((call) => call[1] !== undefined && call[1].method === 'POST');
  assert.equal(posted.length, 1, 'exactly one POST');
  assert.ok(String(posted[0][0]).includes('continue'));
  assert.deepEqual(JSON.parse(posted[0][1].body), { sessionId: 'sess-1' });
  assert.equal(posted[0][1].credentials, 'same-origin');
});

check('the button shows a spinner while the request is in flight', async () => {
  reset();
  fetchImpl = okJson({ ok: true, canContinue: true, prefill: true, reason: { kind: 'max-tokens' } });
  render({ sessionId: 'sess-1' });
  await flush();
  const out = render({ sessionId: 'sess-1' });
  let release;
  fetchImpl = () => new Promise((resolve) => { release = resolve; });
  const pendingClick = out.props.onClick();
  const busyTree = render({ sessionId: 'sess-1' });
  assert.equal(busyTree.props['data-busy'], '1');
  assert.equal(busyTree.props['aria-label'], '正在继续…');
  assert.equal(busyTree.props.disabled, true);
  const glyphElement = busyTree.children[0];
  /* A function component is not rendered by this fake runtime, so render it. */
  const glyph = typeof glyphElement.type === 'function' ? glyphElement.type(glyphElement.props) : glyphElement;
  assert.ok(String(glyph.props.className).includes('dshbs-spin'), 'spinner arc must be shown');
  release({ ok: true, json: () => Promise.resolve({ ok: true }) });
  await pendingClick;
  await flush();
});

check('a refused continue marks the button failed', async () => {
  reset();
  fetchImpl = okJson({ ok: true, canContinue: true, prefill: true, reason: { kind: 'max-tokens' } });
  render({ sessionId: 'sess-1' });
  await flush();
  const out = render({ sessionId: 'sess-1' });
  fetchImpl = () => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) });
  await out.props.onClick();
  await flush();
  const failed = render({ sessionId: 'sess-1' });
  assert.equal(failed.props['data-failed'], '1');
  assert.equal(failed.props['aria-label'], '继续失败');
});

check('a switch already off on the Host hides the button', async () => {
  reset();
  fetchImpl = okJson({ ok: true, enabled: false, canContinue: true });
  render({ sessionId: 'sess-2' });
  await flush();
  assert.equal(render({ sessionId: 'sess-2' }), null);
});

check('unmounting stops the poller', async () => {
  reset();
  let calls = 0;
  fetchImpl = () => {
    calls += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, enabled: true, canContinue: false }) });
  };
  render({ sessionId: 'sess-3' });
  await flush();
  const afterMount = calls;
  assert.ok(afterMount >= 1);
  /* Unmount the way React does: run every cleanup the hooks registered. */
  for (const slot of hookState) {
    if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup();
  }
  /* Advance well past the poll interval: the timer must be gone. */
  tick(60000);
  await flush();
  assert.equal(calls, afterMount, 'no further reads after unmount');
});

check('a transport failure keeps the button hidden without throwing', async () => {
  reset();
  fetchImpl = () => Promise.reject(new Error('offline'));
  render({ sessionId: 'sess-4' });
  await flush();
  assert.equal(render({ sessionId: 'sess-4' }), null);
});

const run = async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log('PASS  ' + name);
    } catch (error) {
      failed += 1;
      console.log('FAIL  ' + name + '\n      ' + error.message);
    }
  }
  timers.clear();
  console.log('');
  console.log(failed === 0 ? 'ALL ' + checks.length + ' CONTINUE-BUTTON CHECKS PASSED' : failed + ' FAILED');
  process.exit(failed === 0 ? 0 : 1);
};
run();
