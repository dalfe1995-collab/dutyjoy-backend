const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.dutyjoy.com';

// Reward per completed referral based on total referral count
function rewardForTier(total) {
  if (total >= 20) return 35000;
  if (total >= 10) return 25000;
  if (total >= 5)  return 20000;
  return 15000;
}

// GET /referrals/my — stats and list for authenticated user
router.get('/my', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { referralCode: true, nombre: true },
    });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const code = user.referralCode || null;
    const link = code ? `${FRONTEND_URL}/r/${code.toLowerCase()}` : null;

    // Fetch all users referred by this user
    const referidos = await prisma.user.findMany({
      where: { referredById: req.user.id },
      select: {
        id: true, nombre: true, createdAt: true,
        bookingsComoCliente: {
          where: { estado: 'COMPLETADO' },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const lista = referidos.map(r => {
      const completado = r.bookingsComoCliente.length > 0;
      return {
        nombre:     r.nombre,
        estado:     completado ? 'COMPLETADO' : 'PENDIENTE',
        fecha:      r.createdAt,
        recompensa: completado ? rewardForTier(referidos.length) : null,
      };
    });

    const completados = lista.filter(r => r.estado === 'COMPLETADO').length;
    const pendientes  = lista.filter(r => r.estado === 'PENDIENTE').length;
    const ganado      = lista.reduce((s, r) => s + (r.recompensa || 0), 0);

    res.json({
      code,
      link,
      total:            referidos.length,
      completados,
      pendientes,
      ganado,
      proxima_recompensa: rewardForTier(referidos.length),
      lista,
    });
  } catch (e) {
    console.error('[referrals/my]', e);
    res.status(500).json({ error: 'Error al obtener referidos' });
  }
});

// GET /referrals/leaderboard — top referrers (public)
router.get('/leaderboard', async (req, res) => {
  try {
    const top = await prisma.user.findMany({
      where: { referrals: { some: {} } },
      select: {
        nombre: true,
        _count: { select: { referrals: true } },
      },
      orderBy: { referrals: { _count: 'desc' } },
      take: 10,
    });

    const leaderboard = top.map(u => ({
      nombre:    u.nombre,
      referidos: u._count.referrals,
    }));

    res.json({ leaderboard });
  } catch (e) {
    console.error('[referrals/leaderboard]', e);
    res.status(500).json({ error: 'Error al obtener leaderboard' });
  }
});

module.exports = router;
