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
app.use('/auth/resend-verification', authLimiter);
app.use('/bookings',  apiLimiter);
app.use('/providers', apiLimiter);
app.use('/reviews',   apiLimiter);
app.use('/payments',  apiLimiter);
app.use('/admin',     apiLimiter);

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
