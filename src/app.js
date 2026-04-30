const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { Sentry } = require('./lib/sentry');

const app = express();

// ── Seguridad: Helmet + CORS ──────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3001'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS bloqueado para origin: ${origin}`));
  },
  credentials: true,
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────
// Estricto: rutas de autenticación sensibles (20 req/15min)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General: todas las demás rutas API (200 req/min)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  message: { error: 'Demasiadas peticiones. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/auth/login',               authLimiter);
app.use('/auth/register',            authLimiter);
app.use('/auth/forgot-password',     authLimiter);
app.use('/auth/reset-password',      authLimiter);
app.use('/auth/resend-verification', authLimiter);
app.use('/bookings',  apiLimiter);
app.use('/providers', apiLimiter);
app.use('/reviews',   apiLimiter);
app.use('/payments',  apiLimiter);
app.use('/admin',     apiLimiter);
app.use('/favorites', apiLimiter);

// Chat: límite más estricto para controlar costos de OpenAI (30 req/min por IP)
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Demasiados mensajes. Espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/chat', chatLimiter);

// ── Logging + Body ────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}
app.use(express.json({ limit: '10kb' }));

// ── Rutas ─────────────────────────────────────────────────────────────────
app.use('/auth',      require('./routes/auth.routes'));
app.use('/providers', require('./routes/providers.routes'));
app.use('/services',  require('./routes/services.routes'));
app.use('/bookings',  require('./routes/bookings.routes'));
app.use('/reviews',   require('./routes/reviews.routes'));
app.use('/payments',  require('./routes/payments.routes'));
app.use('/admin',     require('./routes/admin.routes'));
app.use('/chat',      require('./routes/chat.routes'));
app.use('/favorites', require('./routes/favorites.routes'));

// ── Public stats (landing page) ───────────────────────────────────────────
const prisma = require('./lib/prisma');
app.get('/stats/public', async (req, res) => {
  try {
    const [totalProveedores, verificados, totalBookings, avgCalif] = await Promise.all([
      prisma.providerProfile.count({ where: { disponible: true } }),
      prisma.providerProfile.count({ where: { verificado: true } }),
      prisma.booking.count(),
      prisma.providerProfile.aggregate({ _avg: { calificacion: true }, where: { calificacion: { gt: 0 } } }),
    ]);
    res.set('Cache-Control', 'public, max-age=300'); // 5 min cache
    res.json({
      proveedores: totalProveedores,
      verificados,
      serviciosCompletados: totalBookings,
      calificacionPromedio: avgCalif._avg.calificacion
        ? parseFloat(avgCalif._avg.calificacion.toFixed(1))
        : 4.9,
    });
  } catch { res.json({ proveedores: 0, verificados: 0, serviciosCompletados: 0, calificacionPromedio: 4.9 }); }
});

// ── Sitemap.xml (SEO) ────────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.dutyjoy.com';
app.get('/sitemap.xml', async (req, res) => {
  try {
    const providers = await prisma.providerProfile.findMany({
      where: { disponible: true },
      select: { id: true, updatedAt: true },
    });

    const staticPages = [
      { path: '/', priority: '1.0', freq: 'daily' },
      { path: '/providers', priority: '0.9', freq: 'hourly' },
      { path: '/terms', priority: '0.3', freq: 'monthly' },
      { path: '/privacy', priority: '0.3', freq: 'monthly' },
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    for (const p of staticPages) {
      xml += `\n  <url>
    <loc>${FRONTEND_URL}${p.path}</loc>
    <changefreq>${p.freq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`;
    }

    for (const p of providers) {
      const lastmod = p.updatedAt.toISOString().split('T')[0];
      xml += `\n  <url>
    <loc>${FRONTEND_URL}/providers/${p.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    }

    xml += '\n</urlset>';

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=43200'); // 12h cache
    res.send(xml);
  } catch {
    res.status(500).send('<?xml version="1.0"?><error>Error generating sitemap</error>');
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    project: 'DutyJoy Backend',
    version: '1.0.0',
    env: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Error handler global ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  // Reportar a Sentry si está activo (solo errores 5xx)
  if (process.env.SENTRY_DSN && (!err.status || err.status >= 500)) {
    Sentry.captureException(err);
  }
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  console.error(`[ERROR] ${err.stack}`);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err.message,
  });
});

module.exports = app;
