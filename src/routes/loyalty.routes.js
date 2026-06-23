const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');
const loyalty     = require('../lib/loyalty');

const { PUNTOS_POR_CANJE, VALOR_POR_CANJE, PUNTOS_POR_TIPO } = loyalty;
const NIVEL_ICONS  = { bronce: '🥉', plata: '🥈', oro: '🥇', platino: '💎' };
const NIVEL_COLORS = { bronce: '#CD7F32', plata: '#C0C0C0', oro: '#FFD700', platino: '#0ABFBC' };

router.get('/status', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'CLIENTE') return res.json({ puntos: 0, nivel: 'bronce' });
  try {
    const account = await loyalty.getOrCreate(req.user.id);
    const enriched = loyalty.enrichAccount(account);
    res.json({
      puntos:              enriched.puntos,
      nivel:               enriched.nivel,
      icon:                enriched.icon,
      color:               enriched.color,
      nextNivel:           enriched.nextNivel,
      puntosParaSiguiente: enriched.puntosParaSiguiente,
      canCanjear:          enriched.canCanjear,
      puntosParaCanjear:   enriched.puntosParaCanjear,
      valorCanje:          enriched.valorCanje,
      canjesDisponibles:   enriched.canjesDisponibles,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'CLIENTE') return res.json({ account: null, transactions: [] });
  try {
    let account = await loyalty.getOrCreate(req.user.id);
    await loyalty.syncPoints(req.user.id, account.id);
    account = await prisma.loyaltyAccount.findUnique({ where: { id: account.id } });
    const transactions = await prisma.loyaltyTransaction.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    res.json({
      account:      loyalty.enrichAccount(account),
      transactions: transactions.map(loyalty.mapTransaction),
      earnRules:    PUNTOS_POR_TIPO,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/redeem', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'CLIENTE') {
    return res.status(403).json({ error: 'Solo clientes pueden canjear puntos.' });
  }

  const cantidad = Math.max(1, Math.min(10, parseInt(req.body.cantidad, 10) || 1));

  try {
    const account = await loyalty.getOrCreate(req.user.id);
    await loyalty.syncPoints(req.user.id, account.id);
    const updated = await prisma.loyaltyAccount.findUnique({ where: { id: account.id } });
    const puntosRequeridos = PUNTOS_POR_CANJE * cantidad;
    const descuentoCOP     = VALOR_POR_CANJE  * cantidad;

    if (updated.puntos < puntosRequeridos) {
      return res.status(400).json({
        error: `Necesitas ${puntosRequeridos} puntos. Tienes ${updated.puntos}.`,
      });
    }

    const codigo = `PUNTOS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

    const cupon = await prisma.cupon.create({
      data: {
        codigo,
        tipo:        'fijo',
        valor:       descuentoCOP,
        descripcion: `Canje de ${puntosRequeridos} puntos DutyJoy`,
        activo:      true,
        maxUsos:     1,
        expira:      new Date(Date.now() + 30 * 86_400_000),
        creadoPor:   req.user.id,
      },
    });

    await prisma.loyaltyTransaction.create({
      data: {
        accountId:   account.id,
        tipo:        'canjeado',
        puntos:      -puntosRequeridos,
        descripcion: `Canjeado por cupón ${codigo} ($${descuentoCOP.toLocaleString('es-CO')} COP)`,
        cuponId:     cupon.id,
      },
    });

    const newBalance = updated.puntos - puntosRequeridos;
    await prisma.loyaltyAccount.update({
      where: { id: account.id },
      data: {
        puntos:         newBalance,
        nivel:          loyalty.calcNivel(newBalance),
        totalCanjeados: { increment: puntosRequeridos },
      },
    });

    res.json({
      ok:              true,
      codigo,
      descuento:       descuentoCOP,
      puntosCanjeados: puntosRequeridos,
      puntosRestantes: newBalance,
      expira:          cupon.expira,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/award', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  const { userId, tipo, puntos: customPts, descripcion, bookingId } = req.body;
  if (!userId || !tipo) return res.status(400).json({ error: 'userId y tipo requeridos' });
  try {
    const account = await loyalty.getOrCreate(userId);
    const pts = customPts || PUNTOS_POR_TIPO[tipo] || 0;
    await prisma.loyaltyTransaction.create({
      data: { accountId: account.id, tipo, puntos: pts, descripcion: descripcion || tipo, bookingId },
    });
    const newPts = account.puntos + pts;
    await prisma.loyaltyAccount.update({
      where: { id: account.id },
      data: {
        puntos:       newPts,
        nivel:        loyalty.calcNivel(newPts),
        totalGanados: { increment: Math.max(0, pts) },
      },
    });
    res.json({ ok: true, puntosOtorgados: pts, nuevoBalance: newPts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  try {
    const accounts = await prisma.loyaltyAccount.findMany({
      include: { user: { select: { nombre: true, email: true, ciudad: true } } },
      orderBy: { puntos: 'desc' },
      take: 100,
    });
    const stats = {
      total:       accounts.length,
      platino:     accounts.filter(a => a.nivel === 'platino').length,
      oro:         accounts.filter(a => a.nivel === 'oro').length,
      plata:       accounts.filter(a => a.nivel === 'plata').length,
      bronce:      accounts.filter(a => a.nivel === 'bronce').length,
      totalPuntos: accounts.reduce((s, a) => s + a.puntos, 0),
    };
    res.json({
      accounts: accounts.map(a => ({
        ...a,
        icon:  NIVEL_ICONS[a.nivel],
        color: NIVEL_COLORS[a.nivel],
      })),
      stats,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/transactions', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const transactions = await prisma.loyaltyTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        account: {
          include: { user: { select: { id: true, nombre: true, email: true } } },
        },
      },
    });
    res.json({
      transactions: transactions.map(t => ({
        ...t,
        icon:     loyalty.mapTransaction(t).icon,
        positive: t.puntos > 0,
        user:     t.account?.user ?? null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
