// Endpoint serverless para ejecutar jobs de cron bajo demanda.
// Los schedules viven en .github/workflows/crons.yml (GitHub Actions),
// que llama GET /api/cron?job=<nombre> con Authorization: Bearer CRON_SECRET.
require('dotenv').config();

const jobs = require('../src/lib/cron');

const JOBS_PERMITIDOS = [
  'enviarRecordatorios',
  'cancelarReservasExpiradas',
  'completarReservasFinalizadas',
  'actualizarTiemposRespuesta',
  'actualizarTasasAceptacion',
  'generarRecurrencias',
  'generarEmbeddingsPendientes',
  'escanearResenasFraude',
  'enviarNudgesOnboarding',
  'enviarReengagementSemanal',
  'enviarDigestProveedoresSemanal',
  'auditarSeguridad',
  'snapshotSaludDatos',
  'limpiarIntentosLogin',
  'detectarAnomaliasPagos',
];

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const job = (req.query && req.query.job) || '';
  if (!JOBS_PERMITIDOS.includes(job) || typeof jobs[job] !== 'function') {
    return res.status(400).json({ ok: false, error: 'job desconocido', job });
  }

  const inicio = Date.now();
  try {
    await jobs[job]();
    return res.status(200).json({ ok: true, job, ms: Date.now() - inicio });
  } catch (err) {
    console.error(`[cron:${job}]`, err);
    return res.status(500).json({ ok: false, job, error: err.message });
  }
};
