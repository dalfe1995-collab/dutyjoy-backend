const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

// Middlewares
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Rutas
app.use('/auth', require('./routes/auth.routes'));
app.use('/providers', require('./routes/providers.routes'));
app.use('/services', require('./routes/services.routes'));
app.use('/bookings', require('./routes/bookings.routes'));

// Ruta de salud — verificar que el servidor está vivo
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    project: 'DutyJoy Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DutyJoy API corriendo en http://localhost:${PORT}`);
  console.log(`Verificar salud: GET http://localhost:${PORT}/health`);
});
