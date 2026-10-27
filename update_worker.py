# update_worker.py
import json
import subprocess
import os
from pathlib import Path
import sys

def generate_system_prompt(context_file='claude_context.json'):
    """Generate the system prompt for Claude using the extracted context"""
    with open(context_file, 'r', encoding='utf-8') as f:
        context = json.load(f)
    
    system_prompt = context['system_prompt']

    return system_prompt

# The Worker source. A plain (raw) string with one placeholder, filled by
# build_worker_code(); kept out of an f-string so the JavaScript braces stay as
# written. The workflow deploys it on every push to master, so test it first:
# build it with a dummy prompt, run `node --check` on the result, and drive its
# fetch handler under Node with a mocked fetch and env.
WORKER_TEMPLATE = r"""
const SYSTEM_PROMPT = __SYSTEM_PROMPT_JSON__;

// Model: always the newest Claude Haiku. Instead of a fixed id, the Worker asks
// Anthropic's Models API (GET /v1/models) which models this key can use, keeps
// the ids that start with MODEL_FAMILY (and whose `line` field, when present,
// says haiku), and picks the one with the latest created_at (on a tie, the
// longer id, i.e. a dated snapshot over its alias). The answer is cached in the
// isolate for MODEL_TTL_MS, so a new Haiku is picked up within about 6 hours of
// its release, per isolate, with no code change or redeploy.
// If the list call fails (non-2xx, network error or timeout, malformed JSON, no
// Haiku in the list), the error is logged, the Worker keeps the id it last
// resolved, or MODEL_FALLBACK if it has none, and tries the list again no
// sooner than MODEL_RETRY_MS later. Visitors' requests still go through.
// When a new Haiku generation ships, bump MODEL_FALLBACK to its id so the
// fallback stays current too.
const MODEL_FAMILY = 'claude-haiku-';
const MODEL_FALLBACK = 'claude-haiku-5-5';
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;   // re-check the list every 6 hours
const MODEL_RETRY_MS = 10 * 60 * 1000;     // after a failed list call, wait 10 minutes
const MODEL_LIST_TIMEOUT_MS = 5000;        // a slow list call must not stall the chat
const MAX_TOKENS = 4096;          // thinking + text together; fixed here, the client cannot raise it
const PROD_ORIGIN = 'https://keanelucas.com';
const DEV_ORIGINS = ['http://127.0.0.1:4010'];   // only when env.ENVIRONMENT === 'development'
const MAX_TURNS = 12;
const MAX_CHARS_PER_MESSAGE = 2000;
const MAX_CHARS_TOTAL = 12000;
const MAX_BODY_BYTES = 64 * 1024;
// The visitor's browser language (the widget sends navigator.languages[0] as
// `lang`). Optional; accepted only in a strict BCP 47 shape, anything else is
// ignored without an error. It becomes a SECOND system block after the cached
// first one, so the big block's cache_control prefix is unchanged.
const LANG_SHAPE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/i;
const LANG_MAX_CHARS = 35;

// Rate limits. These live in the isolate's memory, so they are best effort:
// Cloudflare runs many isolates and recycles them, each with its own counters.
// They stop a single client hammering one isolate; they are not a hard spend
// cap (that needs KV or Durable Objects, or the account's own limits).
const BUCKET_SIZE = 20;                  // about 20 requests ...
const BUCKET_WINDOW_MS = 10 * 60 * 1000; // ... per 10 minutes per IP
const BUCKET_MAX_IPS = 5000;
const DAILY_SOFT_CAP = 500;              // upstream calls per isolate per UTC day

const buckets = new Map();               // ip -> { tokens, t }
let dayKey = '';
let dayCount = 0;

// Resolved model for this isolate: id (null until the first successful list),
// t (when it was resolved), next (when the list may be fetched again).
const modelCache = { id: null, t: 0, next: 0 };
let modelPending = null;   // one list call at a time per isolate

// Tag characters (U+E0000..U+E007F) and every other Unicode format (Cf)
// character: invisible, and a known way to smuggle instructions.
const FORMAT_CHARS = /[\u{E0000}-\u{E007F}]|\p{Cf}/gu;

function allowedOrigin(origin, env) {
  if (origin === PROD_ORIGIN) return origin;
  if (env && env.ENVIRONMENT === 'development' && DEV_ORIGINS.includes(origin)) return origin;
  return null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function reply(status, obj, origin, extra) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extra || {}) };
  if (origin) Object.assign(headers, corsHeaders(origin));
  else headers['Vary'] = 'Origin';
  return new Response(JSON.stringify(obj), { status, headers });
}

function takeToken(ip, now) {
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size >= BUCKET_MAX_IPS) {
      // Forget clients whose bucket has refilled; if that frees nothing, start over.
      for (const [k, v] of buckets) {
        if (v.tokens + ((now - v.t) * BUCKET_SIZE) / BUCKET_WINDOW_MS >= BUCKET_SIZE) buckets.delete(k);
      }
      if (buckets.size >= BUCKET_MAX_IPS) buckets.clear();
    }
    b = { tokens: BUCKET_SIZE, t: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(BUCKET_SIZE, b.tokens + ((now - b.t) * BUCKET_SIZE) / BUCKET_WINDOW_MS);
  b.t = now;
  if (b.tokens < 1) {
    return Math.ceil(((1 - b.tokens) * BUCKET_WINDOW_MS) / BUCKET_SIZE / 1000);
  }
  b.tokens -= 1;
  return 0;
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object with a messages list.' };
  const list = body.messages;
  if (!Array.isArray(list) || list.length === 0) return { error: 'Expected a non-empty messages list.' };
  if (list.length > MAX_TURNS) return { error: 'Too many messages in one request (at most ' + MAX_TURNS + ').' };
  const messages = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: 'Each message must be an object.' };
    const expected = i % 2 === 0 ? 'user' : 'assistant';
    if (m.role !== expected) return { error: 'Messages must alternate user and assistant, starting with user.' };
    if (typeof m.content !== 'string') return { error: 'Message content must be a string.' };
    const content = m.content.replace(FORMAT_CHARS, '');
    if (!content.trim()) return { error: 'Messages cannot be empty.' };
    if (content.length > MAX_CHARS_PER_MESSAGE) return { error: 'A message is too long (at most ' + MAX_CHARS_PER_MESSAGE + ' characters).', status: 413 };
    total += content.length;
    if (total > MAX_CHARS_TOTAL) return { error: 'The conversation is too long (at most ' + MAX_CHARS_TOTAL + ' characters).', status: 413 };
    messages.push({ role: m.role, content });
  }
  if (messages[messages.length - 1].role !== 'user') return { error: 'The last message must come from the user.' };
  return { messages, lang: cleanLang(body.lang) };
}

function cleanLang(v) {
  if (typeof v !== 'string' || v.length > LANG_MAX_CHARS || !LANG_SHAPE.test(v)) return null;
  return v;
}

function langNote(lang) {
  return "The visitor's browser language is " + lang + '. Answer in the language the visitor writes in; ' +
    'if the message gives no clear language, answer in ' + lang + '. ' +
    'Keep page names, URLs, paper titles and code exactly as they are.';
}

function pickNewestHaiku(list) {
  let best = null, bestT = -Infinity;
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !m.id.startsWith(MODEL_FAMILY)) continue;
    if (typeof m.line === 'string' && m.line.toLowerCase() !== 'haiku') continue;
    const t = Date.parse(m.created_at);
    if (!Number.isFinite(t)) continue;
    if (t > bestT || (t === bestT && m.id.length > best.length)) { best = m.id; bestT = t; }
  }
  return best;
}

async function refreshModel(env, now) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      method: 'GET',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      // Guarded so a runtime without AbortSignal.timeout still resolves (untimed).
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) : undefined
    });
    if (!res.ok) throw new Error('models list status ' + res.status);
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('models list is not JSON'); }
    const id = pickNewestHaiku(data && Array.isArray(data.data) ? data.data : []);
    if (!id) throw new Error('no ' + MODEL_FAMILY + '* model in the list');
    modelCache.id = id;
    modelCache.t = now;
    modelCache.next = now + MODEL_TTL_MS;
  } catch (error) {
    console.error('model resolve failed, using', modelCache.id || MODEL_FALLBACK, '-', error && error.message);
    modelCache.next = now + MODEL_RETRY_MS;
  }
}

async function resolveModel(env, now) {
  if (now >= modelCache.next) {
    if (!modelPending) modelPending = refreshModel(env, now).finally(() => { modelPending = null; });
    await modelPending;
  }
  return modelCache.id || MODEL_FALLBACK;
}

function upstreamError(status) {
  if (status === 429 || status === 529) return 'The assistant is busy right now. Please try again in a minute.';
  if (status >= 500) return 'The assistant is unavailable right now. Please try again later.';
  return 'The assistant could not answer this request.';
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request.headers.get('Origin'), env);

    if (request.method === 'OPTIONS') {
      if (!origin) return reply(403, { error: 'Origin not allowed.' }, null);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return reply(405, { error: 'Method not allowed.' }, origin, { 'Allow': 'POST, OPTIONS' });
    }
    if (!origin) return reply(403, { error: 'Origin not allowed.' }, null);

    try {
      const now = Date.now();
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const wait = takeToken(ip, now);
      if (wait) {
        return reply(429, { error: 'Too many questions in a short time. Please wait a few minutes and try again.' },
          origin, { 'Retry-After': String(wait) });
      }

      const declared = Number(request.headers.get('Content-Length') || 0);
      if (declared > MAX_BODY_BYTES) return reply(413, { error: 'Request too large.' }, origin);
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return reply(413, { error: 'Request too large.' }, origin);
      let body;
      try { body = JSON.parse(raw); } catch (e) { return reply(400, { error: 'Request body must be JSON.' }, origin); }
      const checked = validate(body);
      if (checked.error) return reply(checked.status || 400, { error: checked.error }, origin);

      const today = new Date(now).toISOString().slice(0, 10);
      if (today !== dayKey) { dayKey = today; dayCount = 0; }
      if (dayCount >= DAILY_SOFT_CAP) {
        return reply(503, { error: 'The assistant has answered a lot of questions today. Please try again tomorrow.' }, origin);
      }
      dayCount++;

      const model = await resolveModel(env, now);
      const systemPrompt = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
      if (checked.lang) systemPrompt.push({ type: 'text', text: langNote(checked.lang) });
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          // Haiku 5.5 thinks by default; low effort keeps answers quick and cheap for a site FAQ bot, and the widget only renders text blocks (assets/js/chat-widget.js, sendMessage, keeps only item.type === 'text').
          output_config: { effort: 'low' },
          system: systemPrompt,
          messages: checked.messages
        })
      });

      if (!upstream.ok) {
        console.error('upstream status', upstream.status);
        const extra = {};
        const ra = upstream.headers.get('retry-after');
        if (ra) extra['Retry-After'] = ra;
        return reply(upstream.status, { error: upstreamError(upstream.status) }, origin, extra);
      }

      const data = await upstream.json();
      return reply(200, { content: Array.isArray(data.content) ? data.content : [], stop_reason: data.stop_reason || null, model }, origin);
    } catch (error) {
      console.error('worker error', error && error.message);
      return reply(500, { error: 'Something went wrong on the server. Please try again later.' }, origin);
    }
  }
};
"""


def build_worker_code(prompt):
    """Return the Worker JavaScript with the system prompt embedded as a JSON string."""
    # json.dumps gives a valid JavaScript string literal; escape U+2028/2029 too.
    encoded = json.dumps(prompt).replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    return WORKER_TEMPLATE.replace('__SYSTEM_PROMPT_JSON__', encoded, 1)


def update_worker(prompt):
    """Update the Cloudflare Worker with the new system prompt"""
    print("Starting worker update...")

    worker_code = build_worker_code(prompt)

    try:
        print("Writing worker.js...")
        with open('worker.js', 'w') as f:
            f.write(worker_code)
        print("Successfully wrote worker.js")
        
        print("Deploying with wrangler...")
        # Pass through all environment variables
        env = os.environ.copy()
        
        # Try deployment
        try:
            result = subprocess.run(
                ['wrangler', 'deploy', 'worker.js'],
                env=env,
                text=True,
                capture_output=True,
                check=False  # Don't raise exception immediately
            )
            
            print("Deployment output:")
            if result.stdout:
                print(result.stdout)
            
            if result.stderr:
                print("Stderr output:")
                print(result.stderr)
            
            # Check return code
            if result.returncode != 0:
                print(f"Deployment failed with code: {result.returncode}")
                raise subprocess.CalledProcessError(result.returncode, ['wrangler', 'deploy'])
                
            print("Deploy successful!")
            return True
            
        except subprocess.CalledProcessError as e:
            print(f"Deployment failed: {str(e)}")
            print(f"Output: {e.output if hasattr(e, 'output') else 'No output'}")
            raise
            
    except Exception as e:
        print(f"Error during deployment: {str(e)}")
        raise


if __name__ == "__main__":
    try:
        print("Starting update process...")
        system_prompt = generate_system_prompt()
        update_worker(system_prompt)
    except Exception as e:
        print(f"Fatal error: {e}")
        sys.exit(1)