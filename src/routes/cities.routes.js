const router = require('express').Router();
const { getCities, getCityBySlug } = require('../lib/catalog');

// GET /cities — ciudades activas desde BD (CityCatalog)
router.get('/', async (_req, res) => {
  try {
    const cities = await getCities();
    res.json({ cities, total: cities.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al cargar ciudades' });
  }
});

// GET /cities/:slug — detalle por slug (bogota, ibague, …)
router.get('/:slug', async (req, res) => {
  try {
    const city = await getCityBySlug(req.params.slug);
    if (!city) return res.status(404).json({ error: 'Ciudad no encontrada' });
    res.json(city);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al cargar ciudad' });
  }
});

module.exports = router;
