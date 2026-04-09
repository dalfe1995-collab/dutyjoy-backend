const router = require('express').Router();
router.get('/', (req, res) => res.json({ mensaje: 'Servicios — próximamente' }));
module.exports = router;
