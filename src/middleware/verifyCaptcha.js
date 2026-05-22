/**
 * verifyCaptcha.js
 * Verifies Cloudflare Turnstile token sent in request body as `cfToken`.
 * Skipped in development / test env — set TURNSTILE_SECRET_KEY in prod.
 */

const https = require('https');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(url, options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON from Turnstile')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Express middleware — verifies cfToken in req.body.
 * Attach after body-parser, before route handler.
 */
async function verifyCaptcha(req, res, next) {
  // Skip in dev/test — no CAPTCHA friction during local development
  if (!process.env.TURNSTILE_SECRET_KEY || process.env.NODE_ENV !== 'production') {
    return next();
  }

  const token = req.body?.cfToken;
  if (!token) {
    return res.status(400).json({ error: 'Verificación de seguridad requerida.' });
  }

  try {
    const result = await postJson(TURNSTILE_VERIFY_URL, {
      secret:   process.env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
    });

    if (!result.success) {
      const codes = result['error-codes']?.join(', ') || 'unknown';
      console.warn(`[CAPTCHA] fail — ${codes} — ${req.path}`);
      return res.status(400).json({ error: 'Verificación fallida. Intenta de nuevo.' });
    }

    next();
  } catch (err) {
    // Network error → let request through (fail open) to avoid blocking legit users
    console.error('[CAPTCHA] verify error (fail-open):', err.message);
    next();
  }
}

module.exports = { verifyCaptcha };
