const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const target = pathToFileURL(path.resolve(process.argv[2])).href;

function makeAgent(options) {
  const opts = options || {};
  const events = opts.events || [];
  const followups = [];
  return {
    status: opts.status || 'idle',
    inbox: {
      nextTurn: opts.nextTurn || [],
      nextStep: opts.nextStep || [],
      hasPending() {
        return (opts.nextTurn || []).length + (opts.nextStep || []).length > 0;
      },
    },
    session: {
      snapshotEvents() {
        return events;
      },
    },
    followup(message) {
      followups.push(message);
    },
    followups,
  };
}

function captureRoutes(mod, agentsById) {
  const seen = [];
  const ctx = {
    connection: { requestRejection: () => undefined },
    agents: {
      get: (id) => agentsById[id],
      list: () => Object.values(agentsById),
    },
    logger: { warn() {}, debug() {} },
    effect(fn) {
      fn();
      return () => {};
    },
    webServer: {
      register(route) {
        seen.push(route);
        return () => {};
      },
    },
    on() {
      return () => {};
    },
  };
  mod.apply(ctx, undefined);
  return seen;
}

async function call(route, options) {
  const req = {
    method: options.method || 'GET',
    url: options.url || route.path,
    headers: Object.assign({ host: '127.0.0.1:53301', 'sec-fetch-site': 'same-origin' }, options.headers),
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(options.body, 'utf8');
    },
  };
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
    },
  };
  await route.handler(req, res);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed };
}

(async () => {
  const mod = await import(target);
  assert.equal(mod.name, 'dsh-button-sample');
  assert.deepEqual(mod.inject, ['webServer', 'connection', 'agents']);

  const checks = [];
  function check(name, fn) {
    checks.push({ name, fn });
  }

  const tail = (reason, extra) => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: {} },
    { type: 'assistant/message', data: {}, ...(extra || {}) },
    { type: 'turn/end', data: { turn: 1, reason } },
  ];

  check('max-tokens is continuable with prefill', async () => {
    const agent = makeAgent({ events: tail({ kind: 'max-tokens' }) });
    const routes = captureRoutes(mod, { s1: agent });
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { url: '/api/dsh-button-sample/continue-state?sessionId=s1' });
    assert.equal(out.status, 200);
    assert.equal(out.body.canContinue, true);
    assert.equal(out.body.prefill, true);
    assert.equal(out.body.reason.kind, 'max-tokens');
    assert.equal(out.body.enabled, true);
  });

  check('aborted (user Stop) is continuable', async () => {
    const agent = makeAgent({ events: tail({ kind: 'aborted', reason: { kind: 'user' } }) });
    const routes = captureRoutes(mod, { s1: agent });
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { url: '/api/dsh-button-sample/continue-state?sessionId=s1' });
    assert.equal(out.body.canContinue, true);
    assert.equal(out.body.prefill, true);
  });

  check('error is continuable and carries the failure code', async () => {
    const agent = makeAgent({
      events: tail({ kind: 'error', error: { message: 'upstream exploded', code: 'PROVIDER_500' } }),
    });
    const routes = captureRoutes(mod, { s1: agent });
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { url: '/api/dsh-button-sample/continue-state?sessionId=s1' });
    assert.equal(out.body.canContinue, true);
    assert.equal(out.body.reason.kind, 'error');
    assert.equal(out.body.reason.code, 'PROVIDER_500');
    assert.equal(out.body.reason.message, 'upstream exploded');
  });

  check('blocked is continuable without prefill', async () => {
    const agent = makeAgent({
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: {} },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } },
      ],
    });
    const routes = captureRoutes(mod, { s1: agent });
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { url: '/api/dsh-button-sample/continue-state?sessionId=s1' });
    assert.equal(out.body.canContinue, true);
    assert.equal(out.body.prefill, false);
  });

  check('completed is NOT continuable', async () => {
    const agent = makeAgent({ events: tail({ kind: 'completed' }) });
    const routes = captureRoutes(mod, { s1: agent });
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { url: '/api/dsh-button-sample/continue-state?sessionId=s1' });
    assert.equal(out.body.canContinue, false);
  });

  check('running agent is NOT continuable', async () => {
    const agent = makeAgent({ status: 'running', events: tail({ kind: 'error', error: { code: 'X', message: 'y' } }) });
    const routes = captureRoutes(mod, { s1: agent });
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { url: '/api/dsh-button-sample/continue-state?sessionId=s1' });
    assert.equal(out.body.canContinue, false);
  });

  check('unknown session reports absent', async () => {
    const routes = captureRoutes(mod, {});
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { url: '/api/dsh-button-sample/continue-state?sessionId=nope' });
    assert.equal(out.status, 200);
    assert.equal(out.body.live, false);
    assert.equal(out.body.canContinue, false);
  });

  check('continue POST queues a transparent nudge', async () => {
    const agent = makeAgent({ events: tail({ kind: 'error', error: { code: 'E', message: 'm' } }) });
    const routes = captureRoutes(mod, { s1: agent });
    const cont = routes.find((r) => r.path === '/api/dsh-button-sample/continue');
    const out = await call(cont, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1' }),
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(agent.followups.length, 1);
    const nudge = agent.followups[0];
    assert.equal(nudge.role, 'user');
    assert.equal(nudge.source.kind, 'runtime-context');
    assert.ok(nudge.id.startsWith('dsh-button-sample-'));
  });

  check('continue POST refuses a completed turn with 409', async () => {
    const agent = makeAgent({ events: tail({ kind: 'completed' }) });
    const routes = captureRoutes(mod, { s1: agent });
    const cont = routes.find((r) => r.path === '/api/dsh-button-sample/continue');
    const out = await call(cont, { method: 'POST', body: JSON.stringify({ sessionId: 's1' }) });
    assert.equal(out.status, 409);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.code, 'not-continuable');
    assert.equal(agent.followups.length, 0);
  });

  check('continue POST requires a sessionId', async () => {
    const routes = captureRoutes(mod, {});
    const cont = routes.find((r) => r.path === '/api/dsh-button-sample/continue');
    const out = await call(cont, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(out.status, 400);
    assert.equal(out.body.code, 'bad-session');
  });

  check('continue-state rejects POST', async () => {
    const routes = captureRoutes(mod, {});
    const state = routes.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, { method: 'POST' });
    assert.equal(out.status, 405);
  });

  check('cross-site requests are refused by the Host fence', async () => {
    const agentsById = {};
    const seen = [];
    const ctx = {
      connection: {
        requestRejection: (req) => (req.headers['sec-fetch-site'] === 'cross-site' ? 403 : undefined),
      },
      agents: { get: (id) => agentsById[id] },
      effect(fn) { fn(); return () => {}; },
      webServer: { register(route) { seen.push(route); return () => {}; } },
      on() { return () => {}; },
    };
    mod.apply(ctx, undefined);
    const state = seen.find((r) => r.path === '/api/dsh-button-sample/continue-state');
    const out = await call(state, {
      url: '/api/dsh-button-sample/continue-state?sessionId=s1',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'forbidden');
  });

  check('config round-trips the third switch', async () => {
    const routes = captureRoutes(mod, {});
    const config = routes.find((r) => r.path === '/api/dsh-button-sample/config');
    const get = await call(config, {});
    assert.equal(get.body.continueButton, true);
    const post = await call(config, { method: 'POST', body: JSON.stringify({ continueButton: false }) });
    assert.equal(post.body.continueButton, false);
    assert.equal(post.body.floating, true);
    const after = await call(config, {});
    assert.equal(after.body.continueButton, false);
  });

  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log('PASS  ' + name);
    } catch (error) {
      failed += 1;
      console.log('FAIL  ' + name);
      console.log('      ' + error.message);
    }
  }
  console.log('');
  console.log(failed === 0 ? 'ALL ' + checks.length + ' CHECKS PASSED' : failed + ' of ' + checks.length + ' CHECKS FAILED');
  process.exit(failed === 0 ? 0 : 1);
})();
