// POST /api/chat — thin proxy to the Gemini API.
// The browser runs the tool loop (tools read the live dashboard data in the page);
// this function only adds the secret API key and forwards one model turn.
// Resilience: if the chosen model is busy (503/429/500) or missing (404), it retries once,
// then falls back to other Flash models this key can use (GEMINI_FALLBACK_MODELS, then auto-discovered).
const MAX_BYTES = 400000;
const BUDGET_MS = 52000; // stay under Vercel's 60 s limit
let discovered = null;

async function listFlashModels(base, key) {
  if (discovered) return discovered;
  try {
    const r = await fetch(`${base}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    discovered = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(n => /flash/i.test(n) && !/image|tts|audio|live|embed|exp/i.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch (e) { discovered = []; }
  return discovered;
}

async function callOnce(base, key, model, payload, msLeft) {
  const r = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Math.max(3000, Math.min(msLeft, 40000)))
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY is not set on the server' });

  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Body must be JSON' }); }
  if (!body || !Array.isArray(body.contents) || !body.contents.length) return res.status(400).json({ error: 'contents[] required' });
  if (JSON.stringify(body).length > MAX_BYTES) return res.status(413).json({ error: 'Conversation too long' });
  if (body.contents.length > 80) return res.status(413).json({ error: 'Too many turns' });

  const base = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
  const primary = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const generationConfig = { temperature: 0.2, maxOutputTokens: 2048 };
  if (process.env.GEMINI_THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL };
  const payload = {
    systemInstruction: { parts: [{ text: String(body.system || '').slice(0, 20000) }] },
    contents: body.contents,
    generationConfig
  };
  if (Array.isArray(body.tools) && body.tools.length) payload.tools = [{ functionDeclarations: body.tools.slice(0, 20) }];

  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const tried = [];
  let lastErr = 'Gemini did not answer';
  let lastStatus = 502;
  const retryable = s => s === 429 || s === 500 || s === 503 || s === 504;

  // Thought signatures belong to the model that produced them, so once a conversation has
  // model turns we only switch models if the primary is truly unavailable.
  let candidates = [primary, ...String(process.env.GEMINI_FALLBACK_MODELS || '').split(',').map(s => s.trim()).filter(Boolean)];
  for (let i = 0; i < candidates.length && left() > 4000; i++) {
    const model = candidates[i];
    if (tried.includes(model)) continue;
    tried.push(model);
    for (let attempt = 0; attempt < 2 && left() > 4000; attempt++) {
      let out;
      try { out = await callOnce(base, key, model, payload, left()); }
      catch (e) { lastErr = 'Gemini timed out or could not be reached (' + (e && e.name) + ')'; lastStatus = 504; break; }
      if (out.ok) {
        const cand = (out.j.candidates || [])[0] || {};
        return res.status(200).json({ content: cand.content || null, finishReason: cand.finishReason || null, model, usage: out.j.usageMetadata || null });
      }
      lastStatus = out.status;
      lastErr = (out.j.error && out.j.error.message) || ('Gemini returned HTTP ' + out.status);
      // A model that rejects signatures from another model: don't keep switching.
      if (out.status === 400 && /signature/i.test(lastErr)) return res.status(502).json({ error: lastErr, tried });
      if (!retryable(out.status)) break;
      if (attempt === 0 && left() > 6000) await new Promise(r => setTimeout(r, 1200));
    }
    if (i === candidates.length - 1 && (retryable(lastStatus) || lastStatus === 404) && left() > 6000) {
      const more = (await listFlashModels(base, key)).filter(m => !tried.includes(m) && !candidates.includes(m)).slice(0, 3);
      candidates = candidates.concat(more);
    }
  }
  const status = lastStatus === 429 ? 429 : 502;
  return res.status(status).json({ error: lastErr, tried });
};
