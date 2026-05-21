const jwt    = require('jsonwebtoken');
const prisma = require('../lib/prisma');

// In-memory cache: userId → { activo, rol, exp }
// TTL 5 min — deactivated users blocked within 5 minutes of DB change
const CACHE_TTL = 5 * 60 * 1000;
const _cache    = new Map();

function cacheGet(userId) {
  const entry = _cache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.exp) { _cache.delete(userId); return null; }
  return entry;
}
function cacheSet(userId, activo, rol) {
  _cache.set(userId, { activo, rol, exp: Date.now() + CACHE_TTL });
}

// Prune stale entries every 10 minutes to avoid memory leak
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) if (now > v.exp) _cache.delete(k);
}, 10 * 60 * 1000).unref();

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token      = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  // Check user is still active (cached 5 min to minimise DB hits)
  let cached = cacheGet(decoded.id);
  if (!cached) {
    try {
      const u = await prisma.user.findUnique({
        where:  { id: decoded.id },
        select: { activo: true, rol: true },
      });
      if (!u) return res.status(401).json({ error: 'Usuario no encontrado' });
      cacheSet(decoded.id, u.activo, u.rol);
      cached = { activo: u.activo, rol: u.rol };
    } catch {
      // DB unreachable — fall back to JWT claims rather than hard-block
      cached = { activo: true, rol: decoded.rol };
    }
  }

  if (!cached.activo) return res.status(403).json({ error: 'Cuenta desactivada' });

  // Always use DB role (not stale JWT claim)
  req.user = { ...decoded, rol: cached.rol };
  next();
};

/** Call this to immediately evict a user from the auth cache (e.g. after ban) */
function invalidateAuthCache(userId) {
  _cache.delete(userId);
}

module.exports = verifyToken;
module.exports.invalidateAuthCache = invalidateAuthCache;
