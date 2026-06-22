const router = require('express').Router();
const { getServices, getServiceById } = require('../lib/catalog');

// GET /services — catálogo desde BD (ServiceCatalog)
router.get('/', async (_req, res) => {
  try {
    const services = await getServices();
    res.json({ services, total: services.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al cargar servicios' });
  }
});

// GET /services/:id — detalle de un servicio
router.get('/:id', async (req, res) => {
  try {
    const servicio = await getServiceById(req.params.id);
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json(servicio);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al cargar servicio' });
  }
});

module.exports = router;
