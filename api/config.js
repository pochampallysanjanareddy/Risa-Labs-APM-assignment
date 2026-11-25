// GET /api/config — tells the page which services are switched on.
// Only public values are returned (the Supabase anon/publishable key is designed to be public;
// the Gemini key never leaves the server).
function supabaseUrlFromKey(key) {
  // A legacy Supabase anon key is a JWT whose payload names the project ("ref").
  try {
    const part = String(key || '').split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return /^[a-z0-9]{10,40}$/.test(payload.ref || '') ? `https://${payload.ref}.supabase.co` : null;
  } catch (e) { return null; }
}

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const anon = (process.env.SUPABASE_ANON_KEY || '').trim() || null;
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '') || supabaseUrlFromKey(anon);
  res.status(200).json({
    aiEnabled: !!process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    supabaseUrl: url || null,
    supabaseAnonKey: anon
  });
};
