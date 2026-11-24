// POST /api/generate  {idea, tier}
// Streams Claude's blueprint as plain text while it is written, then a NUL byte and a
// JSON trailer: {"token": "..."} on success (proof for /api/builds) or {"error": "..."}.
import { DIRECT_MODELS, MODELS, allow, buildPrompt, clientIp, json, sameOrigin, signResult, str } from '../lib/shared.js';

// Claude is reached through Vercel AI Gateway by default. Set ANTHROPIC_API_KEY to call
// Anthropic's API directly with your own key instead.
const GATEWAY = process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1/messages';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const PER_IP = Number(process.env.CLAUDELAND_BUILDS_PER_IP || 6); // per 15 minutes
const PER_HOUR = Number(process.env.CLAUDELAND_BUILDS_PER_HOUR || 200);

const MESSAGES = {
  rate_limited: 'You’ve asked for a lot of builds in a short time. Try again in a few minutes.',
  busy: 'The island is very busy right now. Try again in a little while.',
  out_of_credits: 'Claude is resting for now. The island’s build budget is used up, so try again later.',
  not_configured: 'Building isn’t switched on for this island yet.',
  upstream: 'Couldn’t reach Claude. Try again.',
};
const problem = (code, status) => json({ error: MESSAGES[code], code }, status);

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    if (!sameOrigin(request)) return json({ error: 'Builds can only be made from the island itself.', code: 'forbidden' }, 403);
    if (!process.env.CLAUDELAND_SECRET) return problem('not_configured', 503);
    if (!allow('gen:' + clientIp(request), PER_IP, 15 * 60e3)) return problem('rate_limited', 429);
    if (!allow('gen:all', PER_HOUR, 60 * 60e3)) return problem('busy', 429);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request.', code: 'bad_request' }, 400); }
    const idea = str(body && body.idea, 240);
    if (!idea) return json({ error: 'Describe what Claude should build.', code: 'bad_request' }, 400);
    const tier = body.tier === 'quick' ? 'quick' : 'default';

    // On Vercel the function receives a short-lived OIDC token, so AI Gateway needs no API key.
    const direct = process.env.ANTHROPIC_API_KEY;
    const key = direct || process.env.AI_GATEWAY_API_KEY || request.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN;
    if (!key) return problem('not_configured', 503);
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    if (!direct) headers.authorization = `Bearer ${key}`;

    let upstream;
    try {
      upstream = await fetch(direct ? ANTHROPIC : GATEWAY, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: (direct ? DIRECT_MODELS : MODELS)[tier], max_tokens: 6000, stream: true, messages: [{ role: 'user', content: buildPrompt(idea) }] }),
        signal: request.signal,
      });
    } catch (e) {
      console.error('gateway unreachable', e && e.message);
      return problem('upstream', 502);
    }
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error('gateway error', upstream.status, detail.slice(0, 600));
      const code = upstream.status === 402 || /credit|billing|balance/i.test(detail) && upstream.status !== 403 ? 'out_of_credits' : upstream.status === 429 ? 'busy' : [401, 403].includes(upstream.status) ? 'not_configured' : 'upstream';
      return problem(code, code === 'busy' ? 429 : 503);
    }

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = s => { try { controller.enqueue(enc.encode(s)); } catch {} };
        const reader = upstream.body.getReader(), dec = new TextDecoder();
        let buf = '', text = '', stop = '', failed = false;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let cut;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              const event = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
              if (!data || data === '[DONE]') continue;
              let d;
              try { d = JSON.parse(data); } catch { continue; }
              if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta' && typeof d.delta.text === 'string') {
                text += d.delta.text;
                send(d.delta.text);
              } else if (d.type === 'message_delta' && d.delta && d.delta.stop_reason) {
                stop = d.delta.stop_reason;
              } else if (d.type === 'error') {
                failed = true;
                console.error('stream error', JSON.stringify(d).slice(0, 400));
              }
            }
          }
        } catch (e) {
          failed = true;
          if (!request.signal.aborted) console.error('stream broke', e && e.message);
        }
        const trailer = failed || !text ? { error: 'upstream' } : { token: signResult(tier, idea, text), truncated: stop === 'max_tokens' };
        send('\u0000' + JSON.stringify(trailer));
        try { controller.close(); } catch {}
      },
      cancel() { try { upstream.body.cancel(); } catch {} },
    });
    return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  },
};
