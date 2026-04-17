const Sentry = require('@sentry/node');

/**
 * Inicializa Sentry para monitoreo de errores en producción.
 * Llamar UNA VEZ al inicio (index.js), antes de require('./app').
 *
 * Requiere: SENTRY_DSN en variables de entorno.
 * Si no está configurado, no hace nada (silencioso).
 */
function iniciarSentry() {
  if (!process.env.SENTRY_DSN) {
    if (process.env.NODE_ENV !== 'test') {
      console.log('ℹ️   Sentry desactivado (SENTRY_DSN no configurado)');
    }
    return;
  }

  Sentry.init({
    dsn:              process.env.SENTRY_DSN,
    environment:      process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    // Captura errores no manejados y promesas rechazadas
    integrations: [
      Sentry.httpIntegration(),
    ],
  });

  console.log('🔭  Sentry activo → monitoreo de errores en producción');
}

module.exports = { Sentry, iniciarSentry };
