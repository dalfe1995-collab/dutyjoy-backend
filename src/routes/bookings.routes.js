const router = require('express').Router();
router.get('/', (req, res) => res.json({ mensaje: 'Bookings — próximamente' }));
module.exports = router;
