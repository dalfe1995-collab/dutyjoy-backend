const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');
const crypto       = require('crypto');
const { Sentry }   = require('./lib/sentry');

const app = express();

// ── Gzip compression (before anything else for max coverage) ─────────────
app.use(compression({
  level: 6,           // good balance of speed vs size
  threshold: 1024,    // only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// ── HTTPS enforcement (production behind Railway/Render proxy) ────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers['host']}${req.url}`);
    }
    next();
  });
}

// ── Seguridad: Helmet + CORS ──────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // CSP managed at edge (Vercel)
}));

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
app.use('/auth/refresh',             authLimiter);
app.use('/bookings',      apiLimiter);
app.use('/providers',     apiLimiter);
app.use('/reviews',       apiLimiter);
app.use('/payments',      apiLimiter);
app.use('/admin',         apiLimiter);
app.use('/favorites',     apiLimiter);
app.use('/notifications', apiLimiter);
app.use('/messages',      apiLimiter);
app.use('/referrals',     apiLimiter);

// Chat: límite más estricto para controlar costos de OpenAI (30 req/min por IP)
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Demasiados mensajes. Espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/chat', chatLimiter);

// ── Cache-Control for public GET endpoints ────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'GET') {
    // Public provider/service lists → 60s shared cache
    if (/^\/(providers|services)(\?|\/|$)/.test(req.path)) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    }
    // Health check → 30s
    else if (req.path === '/health') {
      res.set('Cache-Control', 'public, max-age=30');
    }
    // Auth'd resources → no public cache
    else {
      res.set('Cache-Control', 'no-store');
    }
  }
  next();
});

// ── Request ID + Response Timing ─────────────────────────────────────────
app.use((req, res, next) => {
  const id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  req.requestId = id;
  res.set('X-Request-ID', id);
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    res.set('X-Response-Time', `${ms}ms`);
    // Log slow requests (> 800ms) outside of test env
    if (ms > 800 && process.env.NODE_ENV !== 'test') {
      console.warn(`[SLOW] ${req.method} ${req.path} — ${ms}ms (reqId: ${id})`);
    }
  });
  next();
});

// ── Logging + Body ────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  // Include request ID in morgan log token
  morgan.token('reqid', req => req.requestId);
  const fmt = process.env.NODE_ENV === 'production'
    ? ':reqid :method :url :status :response-time ms'
    : 'dev';
  app.use(morgan(fmt));
}
app.use(express.json({ limit: '10kb' }));

// ── Rutas ─────────────────────────────────────────────────────────────────
app.use('/auth',          require('./routes/auth.routes'));
app.use('/providers',     require('./routes/providers.routes'));
app.use('/services',      require('./routes/services.routes'));
app.use('/bookings',      require('./routes/bookings.routes'));
app.use('/reviews',       require('./routes/reviews.routes'));
app.use('/payments',      require('./routes/payments.routes'));
app.use('/admin',         require('./routes/admin.routes'));
app.use('/chat',          require('./routes/chat.routes'));
app.use('/favorites',     require('./routes/favorites.routes'));
app.use('/notifications', require('./routes/notifications.routes'));
app.use('/messages',      require('./routes/messages.routes'));
app.use('/marketing',     require('./routes/marketing.routes'));
app.use('/ads',           require('./routes/ads.routes'));
app.use('/hr',            require('./routes/hr.routes'));
app.use('/projects',      require('./routes/projects.routes'));
app.use('/cs',            require('./routes/cs.routes'));
app.use('/predictions',   require('./routes/predictions.routes'));
app.use('/automations',   require('./routes/automations.routes'));
app.use('/coupons',       require('./routes/coupons.routes'));
app.use('/recommend',     require('./routes/recommend.routes'));
app.use('/loyalty',       require('./routes/loyalty.routes'));
app.use('/zone',          require('./routes/zone.routes'));
app.use('/push',          require('./routes/push.routes'));
app.use('/referrals',     require('./routes/referrals.routes'));

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

    const CIUDADES_SLUG = { 'Bogotá':'bogota','Medellín':'medellin','Cali':'cali','Ibagué':'ibague','Barranquilla':'barranquilla','Cartagena':'cartagena','Bucaramanga':'bucaramanga','Pereira':'pereira' };
    const SERVICIOS_SLUG = ['limpieza','plomeria','electricidad','pintura','jardineria','cerrajeria','mudanzas','aire_acondicionado','carpinteria','fumigacion'];
    const staticPages = [
      { path: '/', priority: '1.0', freq: 'daily' },
      { path: '/providers', priority: '0.9', freq: 'hourly' },
      { path: '/como-funciona', priority: '0.8', freq: 'weekly' },
      { path: '/planes', priority: '0.7', freq: 'weekly' },
      { path: '/historias', priority: '0.6', freq: 'weekly' },
      { path: '/cobertura', priority: '0.6', freq: 'weekly' },
      { path: '/proveedor-registro', priority: '0.8', freq: 'weekly' },
      { path: '/ayuda', priority: '0.6', freq: 'weekly' },
      { path: '/terms', priority: '0.3', freq: 'monthly' },
      { path: '/privacy', priority: '0.3', freq: 'monthly' },
      // SEO service+city pages
      ...Object.entries(CIUDADES_SLUG).flatMap(([ciudad, slug]) =>
        SERVICIOS_SLUG.map(s => ({ path: `/servicios/${s}/${slug}`, priority: '0.8', freq: 'weekly' }))
      ),
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

// ── Health check (deep — checks DB connectivity) ──────────────────────────
app.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status:    'ok',
      project:   'DutyJoy Backend',
      version:   '1.0.0',
      env:       process.env.NODE_ENV,
      db:        'ok',
      dbLatency: `${Date.now() - start}ms`,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status:    'degraded',
      project:   'DutyJoy Backend',
      version:   '1.0.0',
      db:        'error',
      timestamp: new Date().toISOString(),
    });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: `Ruta no encontrada: ${req.method} ${req.path}`,
    code:  'NOT_FOUND',
    requestId: req.requestId,
  });
});

// ── Error handler global ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || 500;

  // Report to Sentry (5xx only)
  if (process.env.SENTRY_DSN && status >= 500) {
    Sentry.captureException(err);
  }

  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message, code: 'CORS_BLOCKED', requestId: req.requestId });
  }

  // Never log 4xx as errors — only 5xx
  if (status >= 500) {
    console.error(`[ERROR ${status}] ${req.method} ${req.path} reqId=${req.requestId} — ${err.message}`);
  }

  res.status(status).json({
    error: process.env.NODE_ENV === 'production' && status >= 500
      ? 'Error interno del servidor'
      : err.message,
    code:      err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    requestId: req.requestId,
  });
});

module.exports = app;
