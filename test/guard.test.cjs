const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const target = pathToFileURL(path.resolve(process.argv[2])).href;

(async () => {
  const mod = await import(target);

  /* Capture the pre-step listener the plugin installs. */
  let listener;
  let prependFlag;
  const ctx = {
    connection: { requestRejection: () => undefined },
    agents: { get: () => undefined, list: () => [] },
    effect(fn) { fn(); return () => {}; },
    webServer: { register() { return () => {}; } },
    on(name, handler, options) {
      if (name === 'agent/pre-step') {
        listener = handler;
        prependFlag = options;
      }
      return () => {};
    },
  };
  mod.apply(ctx, undefined);

  assert.equal(typeof listener, 'function', 'pre-step listener must be installed');
  assert.deepEqual(prependFlag, { prepend: true });

  const nudge = {
    id: 'dsh-button-sample-abc',
    role: 'user',
    content: [{ type: 'text', text: ' ' }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
  };

  /* 1. A continue round with projection noise keeps ONLY the nudge. */
  {
    const decision = {
      kind: 'enter',
      messages: [
        { id: 'time', role: 'user', content: [{ type: 'text', text: 'clock' }], source: { kind: 'runtime-context' } },
        nudge,
      ],
    };
    const out = await listener({}, async () => decision);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0], nudge);
  }

  /* 2. A nudge-only decision is returned untouched. */
  {
    const decision = { kind: 'enter', messages: [nudge] };
    const out = await listener({}, async () => decision);
    assert.equal(out, decision);
  }

  /* 3. A real user message alongside the nudge means the ordinary turn wins. */
  {
    const human = { id: 'h', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } };
    const decision = { kind: 'enter', messages: [nudge, human] };
    const out = await listener({}, async () => decision);
    assert.equal(out, decision);
    assert.equal(out.messages.length, 2);
  }

  /* 4. An ordinary turn with no nudge is never touched. */
  {
    const decision = { kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: { kind: 'user' } }] };
    const out = await listener({}, async () => decision);
    assert.equal(out, decision);
  }

  /* 5. A rejected step stays rejected. */
  {
    const decision = { kind: 'reject' };
    const out = await listener({}, async () => decision);
    assert.equal(out, decision);
  }

  console.log('ALL 5 PURITY GUARD CHECKS PASSED');
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
