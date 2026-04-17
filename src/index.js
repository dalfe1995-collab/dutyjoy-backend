require('dotenv').config();
const { iniciarSentry } = require('./lib/sentry');
iniciarSentry(); // debe ir ANTES de require('./app')

const app              = require('./app');
const { iniciarCrons } = require('./lib/cron');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅  DutyJoy API  →  http://localhost:${PORT}  [${process.env.NODE_ENV}]`);
  console.log(`📋  Endpoints: /auth /providers /bookings /reviews /payments /admin`);
  iniciarCrons();
});
