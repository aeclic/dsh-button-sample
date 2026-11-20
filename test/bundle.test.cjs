const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');

const loads = [];
const FakeWindow = {
  __ModuleLoader__: {
    load(spec) {
      loads.push(spec);
    },
  },
  BroadcastChannel: undefined,
  setTimeout,
  clearTimeout,
  getComputedStyle: () => ({ position: 'static' }),
  addEventListener() {},
  removeEventListener() {},
};

const sandbox = {
  window: FakeWindow,
  document: {
    getElementById: () => null,
    createElement: () => ({
      style: { setProperty() {}, removeProperty() {} },
      setAttribute() {},
      appendChild() {},
      remove() {},
      classList: { add() {}, remove() {} },
      textContent: '',
      id: '',
    }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  },
  MutationObserver: undefined,
  AbortController,
  fetch: () => Promise.resolve({ ok: false }),
  navigator: { language: 'zh-CN' },
  console,
  Symbol,
  Object,
  Array,
  Set,
  Map,
  Number,
  String,
  JSON,
  Promise,
  Error,
  URL,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(source, sandbox, { filename: file });
} catch (error) {
  console.error('EVAL FAILED:', error.message);
  console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

if (loads.length !== 1) {
  console.error('expected exactly one __ModuleLoader__.load call, got ' + loads.length);
  process.exit(1);
}
const spec = loads[0];
console.log('id =', spec.id);

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useRef(value) {
    return { current: value };
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
};
const fakeReactDom = { createPortal: (node) => node };
const fakeReactDomClient = { createRoot: () => ({ render() {}, unmount() {} }) };

const table = {
  react: fakeReact,
  'react-dom': fakeReactDom,
  'react-dom/client': fakeReactDomClient,
};

let exportsObject;
try {
  exportsObject = spec.factory((name) => {
    if (!(name in table)) throw new Error('unexpected require: ' + name);
    return table[name];
  });
} catch (error) {
  console.error('FACTORY FAILED:', error.message);
  console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

console.log('exports =', Object.keys(exportsObject).join(','));
if (typeof exportsObject.apply !== 'function') {
  console.error('apply is not a function');
  process.exit(1);
}
console.log('inject =', JSON.stringify(exportsObject.inject));

// Drive apply() against a stub ctx so registration paths actually execute.
const registered = [];
const effects = [];
const ctx = {
  slots: {
    inject(key, callback) {
      registered.push({ key, kind: 'inject' });
      return callback();
    },
    register(options, component) {
      registered.push({ key: options.name, id: options.id, kind: 'register', component });
      return () => {};
    },
  },
  inject(names, callback) {
    registered.push({ key: names.join('+'), kind: 'inject-service' });
    return callback({});
  },
  effect(fn, label) {
    const dispose = typeof fn === 'function' ? fn() : undefined;
    effects.push({ label, dispose });
    return () => {};
  },
};

try {
  exportsObject.apply(ctx);
} catch (error) {
  console.error('APPLY FAILED:', error.message);
  console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}

console.log('registrations:');
for (const entry of registered) {
  console.log('  ' + entry.kind + ' -> ' + entry.key + (entry.id ? ' [' + entry.id + ']' : ''));
}
console.log('effects:', effects.map((e) => e.label).join(' | '));

for (const effect of effects) {
  if (typeof effect.dispose === 'function') effect.dispose();
}
console.log('disposal OK');
