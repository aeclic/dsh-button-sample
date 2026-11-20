const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.resolve(process.argv[2]);
const source = fs.readFileSync(file, 'utf8');

/* --- controllable clock --------------------------------------------------- */
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
function tick(ms) {
  const target = clock + ms;
  for (;;) {
    let due = null;
    for (const [id, timer] of timers) {
      if (timer.at <= target && (due === null || timer.at < due.timer.at)) due = { id, timer };
    }
    if (due === null) break;
    timers.delete(due.id);
    clock = due.timer.at;
    due.timer.fn();
  }
  clock = target;
}

/* --- DOM ----------------------------------------------------------------- */
let nextNodeId = 0;
function makeNode(tag) {
  const node = {
    nodeId: nextNodeId++,
    tagName: String(tag).toUpperCase(),
    attributes: new Map(),
    children: [],
    parentNode: null,
    isConnected: false,
    disabled: false,
    className: '',
    style: {},
    _rect: { left: 100, top: 200, width: 34, height: 34 },
    getBoundingClientRect() {
      return node.isConnected ? node._rect : { left: 0, top: 0, width: 0, height: 0 };
    },
    setAttribute(name, value) {
      node.attributes.set(name, String(value));
      if (name === 'class') node.className = String(value);
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null;
    },
    hasAttribute(name) {
      return node.attributes.has(name);
    },
    removeAttribute(name) {
      node.attributes.delete(name);
    },
    appendChild(child) {
      child.parentNode = node;
      child.isConnected = true;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      child.parentNode = null;
      child.isConnected = false;
      return child;
    },
    remove() {
      if (node.parentNode !== null) node.parentNode.removeChild(node);
      node.isConnected = false;
    },
    getClientRects() {
      return node.isConnected ? [{ width: 34, height: 34 }] : [];
    },
    closest(selector) {
      let current = node;
      while (current !== null) {
        if (current.tagName === selector.toUpperCase()) return current;
        current = current.parentNode;
      }
      return null;
    },
  };
  return node;
}

const body = makeNode('body');
body.isConnected = true;

function all(node, out) {
  for (const child of node.children) {
    out.push(child);
    all(child, out);
  }
  return out;
}

/* --- MutationObserver stub ----------------------------------------------- */
const observers = [];
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.active = false;
    observers.push(this);
  }
  observe() {
    this.active = true;
  }
  disconnect() {
    this.active = false;
  }
}
function notify(targets) {
  const records = targets.map((target) => ({ target, type: 'attributes' }));
  for (const observer of observers) {
    if (observer.active) observer.callback(records);
  }
}

const doc = {
  body,
  head: makeNode('head'),
  createElement: (tag) => makeNode(tag),
  getElementById: () => null,
  querySelectorAll: () => [],
  _listeners: [],
  addEventListener(type, handler) {
    doc._listeners.push({ type, handler });
  },
  removeEventListener(type, handler) {
    const index = doc._listeners.findIndex((l) => l.type === type && l.handler === handler);
    if (index >= 0) doc._listeners.splice(index, 1);
  },
  fire(type, target) {
    for (const entry of doc._listeners.slice()) {
      if (entry.type === type) entry.handler({ type, target });
    }
  },
};

const loads = [];
const sandbox = {
  window: {
    __ModuleLoader__: { load: (spec) => loads.push(spec) },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    requestAnimationFrame: (fn) => setTimer(fn, 16),
    cancelAnimationFrame: clearTimer,
    BroadcastChannel: undefined,
    getComputedStyle: () => ({ position: 'static' }),
  },
  document: doc,
  MutationObserver: FakeMutationObserver,
  AbortController,
  fetch: () => Promise.resolve({ ok: false }),
  navigator: { language: 'zh-CN' },
  console, Symbol, Object, Array, Set, Map, Number, String, JSON, Promise, Error, URL,
  encodeURIComponent,
  setTimeout: setTimer,
  clearTimeout: clearTimer,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: file });

assert.equal(loads.length, 1);
const spec = loads[0];

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const table = {
  react: fakeReact,
  'react-dom': { createPortal: (n) => n },
  'react-dom/client': { createRoot: () => ({ render() {}, unmount() {} }) },
};
const client = spec.factory((name) => table[name]);

/** Mount a fresh plugin instance and return its stop-ring disposer. */
function mount() {
  const effects = [];
  client.apply({
    slots: {
      inject: (_key, cb) => cb(),
      register: () => () => {},
    },
    inject: (_names, cb) => cb({}),
    effect: (fn, label) => {
      const dispose = typeof fn === 'function' ? fn() : undefined;
      effects.push({ label, dispose });
      return () => {};
    },
  });
  const ring = effects.find((e) => e.label.includes('stop ring'));
  assert.ok(ring, 'stop ring effect must be registered');
  return ring.dispose;
}

/** Reset the page: every body child goes, every timer and observer goes. */
function reset() {
  for (const child of all(body, []).slice().reverse()) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
  }
  body.children.length = 0;
  timers.clear();
  observers.length = 0;
  doc._listeners.length = 0;
  clock = 0;
}

function rings() {
  return all(body, []).filter((n) => n.hasAttribute('data-dshbs-stop-ring'));
}

function composer(label) {
  const cluster = makeNode('div');
  const button = makeNode('button');
  button.setAttribute('aria-label', label === undefined ? '停止生成' : label);
  cluster.appendChild(button);
  body.appendChild(cluster);
  return { cluster, button };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** Every check gets a clean page and its own plugin instance. */
function withPage(fn) {
  return () => {
    reset();
    const dispose = mount();
    try {
      fn();
    } finally {
      dispose();
    }
  };
}

check('a press draws nothing immediately (the stop may be instant)', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  assert.equal(rings().length, 0, 'no ring during the grace period');
  tick(349);
  assert.equal(rings().length, 0, 'still nothing just before the delay');
  tick(2);
  assert.equal(rings().length, 1, 'ring appears after the delay');
}));

check('the ring is a body-level overlay positioned over the button', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(400);
  const [ring] = rings();
  assert.equal(ring.parentNode, body, 'ring must live on the body, not inside the button');
  assert.equal(ring.className, 'dshbs-ring');
  assert.equal(ring.getAttribute('aria-hidden'), 'true');
  assert.equal(ring.style.left, '97px');
  assert.equal(ring.style.top, '197px');
  assert.equal(ring.style.width, '40px');
  assert.equal(ring.style.height, '40px');
  /* The button's own box is never touched. */
  assert.equal(button.style.position, undefined, 'no position injection');
  assert.equal(button.children.length, 0, 'no child injection');
}));

check('a second press does not stack a second ring', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(400);
  doc.fire('pointerdown', button);
  tick(400);
  assert.equal(rings().length, 1);
}));

check('a stop that settles inside the grace period never flashes a ring', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(100);
  button.remove();
  tick(600);
  assert.equal(rings().length, 0);
}));

check('the ring goes away when the Stop label disappears', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(400);
  assert.equal(rings().length, 1);
  button.setAttribute('aria-label', '发送消息');
  notify([button]);
  assert.equal(rings().length, 0, 'the observer must clear a settled ring');
}));

check('the ring goes away when the button leaves the page', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(400);
  assert.equal(rings().length, 1);
  button.remove();
  notify([button]);
  assert.equal(rings().length, 0);
}));

check('the ring follows the button while layout settles', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(400);
  const [ring] = rings();
  button._rect = { left: 20, top: 30, width: 34, height: 34 };
  tick(32);
  const live = rings()[0];
  assert.equal(live, ring);
  assert.equal(live.style.left, '17px');
  assert.equal(live.style.top, '27px');
}));

check('a press on something else does nothing', withPage(() => {
  const other = composer('发送消息').button;
  doc.fire('pointerdown', other);
  tick(600);
  assert.equal(rings().length, 0);
}));

check('a target that is not a button is ignored', withPage(() => {
  const span = makeNode('span');
  body.appendChild(span);
  doc.fire('pointerdown', span);
  tick(600);
  assert.equal(rings().length, 0);
}));

check('a disabled Stop button is ignored', withPage(() => {
  const { button } = composer();
  button.disabled = true;
  doc.fire('pointerdown', button);
  tick(600);
  assert.equal(rings().length, 0);
}));

check('a keyboard activation (click, no pointer) also rings', withPage(() => {
  const { button } = composer('Stop generating');
  doc.fire('click', button);
  tick(400);
  assert.equal(rings().length, 1);
}));

check('every shipped locale label is recognised', withPage(() => {
  const labels = [
    '停止生成', 'Stop generating', '生成を停止', 'Detener generación',
    'Arrêter la génération', 'Generierung stoppen', 'Остановить генерацию', 'Parar geração',
  ];
  for (const label of labels) {
    const { button } = composer(label);
    doc.fire('pointerdown', button);
    tick(400);
    assert.equal(rings().length, 1, 'label not recognised: ' + label);
    button.setAttribute('aria-label', 'x');
    notify([button]);
    assert.equal(rings().length, 0);
    button.remove();
  }
}));

check('the backstop takes the ring down', withPage(() => {
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(400);
  assert.equal(rings().length, 1);
  tick(16000);
  assert.equal(rings().length, 0, 'a wedged stop cannot leave a ring turning forever');
}));

check('an explicit dispose clears everything', () => {
  reset();
  const dispose = mount();
  const { button } = composer();
  doc.fire('pointerdown', button);
  tick(400);
  assert.equal(rings().length, 1);
  dispose();
  assert.equal(rings().length, 0);
  assert.equal(doc._listeners.filter((l) => l.type === 'pointerdown' || l.type === 'click').length, 0);
  assert.equal(observers.filter((o) => o.active).length, 0);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (error) {
    failed += 1;
    console.log('FAIL  ' + name + '\n      ' + error.message);
  }
}
console.log('');
console.log(failed === 0 ? 'ALL ' + checks.length + ' STOP-RING CHECKS PASSED' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
