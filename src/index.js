require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅  DutyJoy API  →  http://localhost:${PORT}  [${process.env.NODE_ENV}]`);
  console.log(`📋  Endpoints: /auth /providers /bookings /reviews /payments /admin`);
});
