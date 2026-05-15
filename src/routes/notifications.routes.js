const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

// GET /notifications — listar notificaciones del usuario autenticado
router.get('/', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, soloNoLeidas } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      userId: req.user.id,
      ...(soloNoLeidas === 'true' && { leida: false }),
    };

    const [notifs, total, noLeidas] = await Promise.all([
      prisma.notificacion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.notificacion.count({ where }),
      prisma.notificacion.count({ where: { userId: req.user.id, leida: false } }),
    ]);

    res.json({ notifications: notifs, total, noLeidas, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener notificaciones' });
  }
});

// GET /notifications/count — solo el número de no leídas (para el badge)
router.get('/count', verifyToken, async (req, res) => {
  try {
    const count = await prisma.notificacion.count({
      where: { userId: req.user.id, leida: false },
    });
    res.json({ count });
  } catch {
    res.json({ count: 0 });
  }
});

// PATCH /notifications/:id/read — marcar una como leída
router.patch('/:id/read', verifyToken, async (req, res) => {
  try {
    await prisma.notificacion.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data:  { leida: true },
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al marcar notificación' });
  }
});

// PATCH /notifications/read-all — marcar todas como leídas
router.patch('/read-all', verifyToken, async (req, res) => {
  try {
    const { count } = await prisma.notificacion.updateMany({
      where: { userId: req.user.id, leida: false },
      data:  { leida: true },
    });
    res.json({ ok: true, marked: count });
  } catch (error) {
    res.status(500).json({ error: 'Error al marcar notificaciones' });
  }
});

// DELETE /notifications/old — borrar notificaciones leídas con más de 30 días
router.delete('/old', verifyToken, async (req, res) => {
  try {
    const hace30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { count } = await prisma.notificacion.deleteMany({
      where: {
        userId: req.user.id,
        leida: true,
        createdAt: { lt: hace30Dias },
      },
    });
    res.json({ ok: true, deleted: count });
  } catch {
    res.status(500).json({ error: 'Error al limpiar notificaciones' });
  }
});

// POST /notifications/device-token — registra el token de push del dispositivo
// (guarda en memoria/cache ligero — en prod almacenar en DB si se implementa push server-side)
const deviceTokens = new Map(); // userId → [{ token, platform }]

router.post('/device-token', verifyToken, async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'token requerido' });

    const uid = req.user.id;
    const existing = deviceTokens.get(uid) || [];
    // Upsert by token value (avoid duplicates)
    const filtered = existing.filter(t => t.token !== token);
    filtered.push({ token, platform: platform || 'web', registeredAt: new Date() });
    deviceTokens.set(uid, filtered.slice(-5)); // keep last 5 tokens per user

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar token' });
  }
});

module.exports = router;
