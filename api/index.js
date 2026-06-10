// Vercel serverless entrypoint — wraps the Express app.
// Crons (src/lib/cron) no corren en serverless; se ejecutan vía
// Vercel Cron Jobs si se configuran en vercel.json más adelante.
require('dotenv').config();
const { iniciarSentry } = require('../src/lib/sentry');
iniciarSentry();

const app = require('../src/app');

module.exports = app;
