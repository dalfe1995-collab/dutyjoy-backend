const router    = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma    = require('../lib/prisma');
const { VAPID_PUBLIC } = require('../lib/push');

/* GET /push/vapid-public-key */
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

/* POST /push/subscribe — save or refresh a subscription */
router.post('/subscribe', verifyToken, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Subscription inválida' });
    }
    await prisma.pushSubscription.upsert({
      where:  { endpoint },
      update: { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth },
      create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[push subscribe]', e);
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});

/* DELETE /push/subscribe — remove by endpoint */
router.delete('/subscribe', verifyToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await prisma.pushSubscription.deleteMany({
        where: { endpoint, userId: req.user.id },
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar suscripción' });
  }
});

module.exports = router;
