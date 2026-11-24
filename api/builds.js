// GET    /api/builds            every build on the island (CDN-cached until something changes)
// POST   /api/builds            place a build Claude made (signed by /api/generate)
// DELETE /api/builds?id=...     remove a build (its builder, or the island owner)
import { MAXR, MAX_BUILDS, allow, cleanBP, clientIp, isAdmin, json, newId, parseBlueprint, sameOrigin, sha256, str, verifyResult } from '../lib/shared.js';
import { CACHE_TAG, clearCache, readIsland, update, writeIsland } from '../lib/store.js';
import SEEDS from '../lib/seeds.js';

const PLOT = /^-?\d{1,2},-?\d{1,2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const visible = b => ({ id: b.id, plot: b.plot, at: b.at, sig: b.sig, prompt: b.prompt, name: b.name, blurb: b.blurb, palette: b.palette, glow: b.glow, ops: b.ops, parts: b.parts });

function fresh() {
  const now = Date.now();
  return { v: 1, seeded: true, builds: SEEDS.map((s, n) => ({ ...s, at: now - (SEEDS.length - n) * 300000, owner: null, tok: null })) };
}

const fail = (status, code, error) => Object.assign(new Error(code), { status, code, error });

async function list() {
  let { data } = await readIsland();
  if (!data) {
    const first = fresh();
    try { await writeIsland(first, null); data = first; } catch { data = (await readIsland()).data || first; }
  }
  return json({ builds: (data.builds || []).map(visible) }, 200, {
    'cache-control': 'public, max-age=0, must-revalidate',
    'vercel-cdn-cache-control': 'public, max-age=86400',
    'vercel-cache-tag': CACHE_TAG,
  });
}

async function create(req) {
  if (!sameOrigin(req)) return json({ error: 'Builds can only be placed from the island itself.', code: 'forbidden' }, 403);
  if (Number(req.headers.get('content-length') || 0) > 200000) return json({ error: 'That build is too big.', code: 'too_big' }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request.', code: 'bad_request' }, 400); }
  const admin = isAdmin(req);
  if (!admin && !allow('place:' + clientIp(req), 8, 15 * 60e3)) return json({ error: 'You’ve placed a lot of builds in a short time. Try again in a few minutes.', code: 'rate_limited' }, 429);

  const plot = typeof body.plot === 'string' && PLOT.test(body.plot) ? body.plot : null;
  const [i, j] = plot ? plot.split(',').map(Number) : [0, 0];
  if (!plot || Math.abs(i) > MAXR || Math.abs(j) > MAXR || (!i && !j)) return json({ error: 'Pick a free spot first.', code: 'bad_plot' }, 400);

  let bp, prompt = '', tok = null;
  if (typeof body.text === 'string' && typeof body.token === 'string') {
    const idea = str(body.idea, 240);
    if (body.text.length > 60000 || !verifyResult(body.token, idea, body.text)) return json({ error: 'That build couldn’t be checked. Build it again and place it within a few hours.', code: 'bad_token' }, 403);
    bp = parseBlueprint(body.text);
    prompt = idea;
    tok = body.token.split('.')[2];
  } else if (admin && body.bp) {
    bp = cleanBP(body.bp);
    prompt = str(body.prompt, 300);
  } else {
    return json({ error: 'There’s no build to place.', code: 'bad_request' }, 400);
  }
  if (!bp || !bp.ops.length) return json({ error: 'That build came out empty. Try describing it differently.', code: 'empty' }, 422);

  const key = typeof body.ownerKey === 'string' && body.ownerKey.length >= 16 && body.ownerKey.length <= 128 ? body.ownerKey : '';
  const rec = { id: newId(), plot, at: Date.now(), sig: str(body.sig, 24), prompt, ...bp, owner: key ? sha256(key) : null, tok };
  try {
    await update(data => {
      const d = data || fresh();
      if (tok && d.builds.some(b => b.tok === tok)) throw fail(409, 'duplicate', 'That build is already on the island.');
      if (d.builds.length >= MAX_BUILDS) throw fail(409, 'full', 'The island is full right now. Check back soon.');
      return { ...d, builds: [...d.builds, rec] };
    });
  } catch (e) {
    if (e.status) return json({ error: e.error, code: e.code }, e.status);
    if (e.busy) return json({ error: 'The island is busy. Try again in a moment.', code: 'busy' }, 503);
    throw e;
  }
  await clearCache();
  return json({ build: visible(rec) }, 201);
}

async function remove(req) {
  if (!sameOrigin(req)) return json({ error: 'Builds can only be removed from the island itself.', code: 'forbidden' }, 403);
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!ID.test(id)) return json({ error: 'Bad request.', code: 'bad_request' }, 400);
  const admin = isAdmin(req);
  const key = req.headers.get('x-owner-key') || '';
  const owner = key.length >= 16 ? sha256(key) : null;
  try {
    await update(data => {
      const d = data || fresh();
      const b = d.builds.find(x => x.id === id);
      if (!b) throw fail(404, 'missing', 'That build is already gone.');
      if (!admin && !(owner && b.owner === owner)) throw fail(403, 'not_yours', 'Only the person who placed it, or the island’s owner, can remove this build.');
      return { ...d, builds: d.builds.filter(x => x.id !== id) };
    });
  } catch (e) {
    if (e.status) return json({ error: e.error, code: e.code }, e.status);
    if (e.busy) return json({ error: 'The island is busy. Try again in a moment.', code: 'busy' }, 503);
    throw e;
  }
  await clearCache();
  return json({ ok: true });
}

export default {
  async fetch(request) {
    try {
      if (request.method === 'GET') return await list();
      if (request.method === 'POST') return await create(request);
      if (request.method === 'DELETE') return await remove(request);
      return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST, DELETE' });
    } catch (e) {
      console.error('builds failed', e && (e.stack || e.message));
      return json({ error: 'Something went wrong. Try again.', code: 'error' }, 500);
    }
  },
};
