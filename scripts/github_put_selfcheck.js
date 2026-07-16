// Self-check for the consolidated GitHub Contents-API writer in docs/utils.js
// (githubPutJson / githubGetJson - the single replacement for what used to be
// 7 near-identical PUT blocks across app.js and hot-deals.html).
// No framework, no deps: extracts the real functions from utils.js and runs
// them against a mocked fetch. Run: node scripts/github_put_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');

function extract(name) {
  let at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in utils.js`);
  if (src.slice(at - 6, at) === 'async ') at -= 6; // keep the async keyword
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// eslint-disable-next-line no-eval
eval([extract('_ghHeaders'), extract('githubGetJson'), extract('githubPutJson')].join('\n'));

// ── Mock fetch ───────────────────────────────────────────────────────────────
// Scriptable queue: each entry is { status, json } consumed in call order.
let calls, queue;
function mockFetch(script) {
  calls = [];
  queue = [...script];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const next = queue.shift() || { status: 200, json: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json,
      text: async () => JSON.stringify(next.json),
    };
  };
}

const S = { user: 'u', repo: 'r', token: 't' };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const un64 = (s) => Buffer.from(s, 'base64').toString('utf8');

(async () => {
  // 1. Happy path: GET sha → PUT carries that sha, message, unicode-safe content.
  mockFetch([{ status: 200, json: { sha: 'abc' } }, { status: 200, json: {} }]);
  await githubPutJson(S, 'docs/data/x.json', { name: 'Crème Brûlée 500g' }, 'msg here');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[1].method, 'PUT');
  assert(calls[1].url.endsWith('/repos/u/r/contents/docs/data/x.json'));
  assert.strictEqual(calls[1].body.sha, 'abc');
  assert.strictEqual(calls[1].body.message, 'msg here');
  assert.strictEqual(un64(calls[1].body.content), JSON.stringify({ name: 'Crème Brûlée 500g' }, null, 2) + '\n');

  // 2. New file: GET 404 → PUT without sha.
  mockFetch([{ status: 404, json: {} }, { status: 201, json: {} }]);
  await githubPutJson(S, 'docs/data/new.json', [], 'create');
  assert.strictEqual(calls[1].body.sha, undefined);

  // 3. 409 stale sha → one retry with the freshly fetched sha, then success.
  mockFetch([
    { status: 200, json: { sha: 'old' } }, { status: 409, json: {} },
    { status: 200, json: { sha: 'new' } }, { status: 200, json: {} },
  ]);
  await githubPutJson(S, 'docs/data/x.json', {}, 'retry');
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(calls[3].body.sha, 'new');

  // 4. Persistent failure throws with the status in the message.
  mockFetch([{ status: 200, json: { sha: 'a' } }, { status: 422, json: { message: 'nope' } }]);
  await assert.rejects(() => githubPutJson(S, 'p.json', {}, 'm'), /GitHub PUT failed \(422\)/);

  // 5. githubGetJson decodes unicode base64 content (incl. GitHub's embedded newlines).
  const body = JSON.stringify({ 'Crème Brûlée': { ww: ['url'] } });
  const wrapped = b64(body).replace(/(.{20})/g, '$1\n');
  mockFetch([{ status: 200, json: { content: wrapped } }]);
  assert.deepStrictEqual(await githubGetJson(S, 'p.json'), { 'Crème Brûlée': { ww: ['url'] } });

  // 6. githubGetJson: missing file or garbage content → {} (merge-friendly).
  mockFetch([{ status: 404, json: {} }]);
  assert.deepStrictEqual(await githubGetJson(S, 'p.json'), {});
  mockFetch([{ status: 200, json: { content: '!!!not-base64-json!!!' } }]);
  assert.deepStrictEqual(await githubGetJson(S, 'p.json'), {});

  console.log('github_put_selfcheck: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
