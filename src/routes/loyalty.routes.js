/**
 * loyalty.routes.js — DutyJoy Puntos (Loyalty System)
 *
 * Earning:
 *   primera_reserva   → 150 pts (one-time bonus)
 *   booking_completado → 100 pts per booking
 *   resena            → 50 pts per review
 *   recurrencia       → 25 pts bonus for recurring bookings
 *   referido          → 200 pts when a referred user completes first booking
 *
 * Redeeming:
 *   500 pts = $5,000 COP → generates a one-time LOYALTY-XXXXX coupon (30d expiry)
 *
 * Niveles:
 *   Bronce  0–499  |  Plata  500–1,499  |  Oro  1,500–2,999  |  Platino  3,000+
 */
const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

const PUNTOS_POR_TIPO = {
  primera_reserva:    150,
  booking_completado: 100,
  resena:             50,
  recurrencia:        25,
  referido:           200,
};

const NIVEL_THRESHOLDS = [
  { nivel:'platino', min:3000 },
  { nivel:'oro',     min:1500 },
  { nivel:'plata',   min:500  },
  { nivel:'bronce',  min:0    },
];

const NIVEL_ICONS  = { bronce:'🥉', plata:'🥈', oro:'🥇', platino:'💎' };
const NIVEL_COLORS = { bronce:'#CD7F32', plata:'#C0C0C0', oro:'#FFD700', platino:'#0ABFBC' };
const PUNTOS_POR_CANJE = 500;   // pts required for one redeem
const VALOR_POR_CANJE  = 5000;  // COP per 500 pts

function calcNivel(puntos) {
  return NIVEL_THRESHOLDS.find(t => puntos >= t.min)?.nivel || 'bronce';
}
function nextNivel(actual) {
  const idx = ['bronce','plata','oro','platino'].indexOf(actual);
  return idx >= 3 ? null : ['bronce','plata','oro','platino'][idx + 1];
}
function puntosParaSiguienteNivel(puntos) {
  const next = nextNivel(calcNivel(puntos));
  if (!next) return null;
  const threshold = NIVEL_THRESHOLDS.find(t => t.nivel === next)?.min || 0;
  return threshold - puntos;
}

/* ── Sync points from real data (reconciliation) ─────────────────────────── */
async function syncPoints(userId, accountId) {
  const [completedBookings, reviews, existing1st, existingBookingTxns, existingReviewTxns, recurringBookings, existingRecurringTxns] = await Promise.all([
    prisma.booking.findMany({
      where: { clienteId: userId, estado: 'COMPLETADO' },
      select: { id: true, recurrencia: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.review.findMany({
      where: { clienteId: userId },
      select: { id: true, bookingId: true },
    }),
    prisma.loyaltyTransaction.findFirst({ where: { accountId, tipo: 'primera_reserva' } }),
    prisma.loyaltyTransaction.findMany({ where: { accountId, tipo: 'booking_completado' }, select: { bookingId: true } }),
    prisma.loyaltyTransaction.findMany({ where: { accountId, tipo: 'resena' }, select: { bookingId: true } }),
    prisma.booking.findMany({
      where: { clienteId: userId, estado: 'COMPLETADO', recurrencia: { not: 'UNICA' } },
      select: { id: true },
    }),
    prisma.loyaltyTransaction.findMany({ where: { accountId, tipo: 'recurrencia' }, select: { bookingId: true } }),
  ]);

  const awardedBookingIds   = new Set(existingBookingTxns.map(t => t.bookingId));
  const awardedReviewBookingIds = new Set(existingReviewTxns.map(t => t.bookingId));
  const awardedRecurringIds = new Set(existingRecurringTxns.map(t => t.bookingId));

  const newTxns = [];

  // First booking bonus (one-time)
  if (!existing1st && completedBookings.length > 0) {
    newTxns.push({ accountId, tipo:'primera_reserva', puntos:150, descripcion:'🎉 ¡Primera reserva completada!', bookingId: completedBookings[0].id });
  }

  // Per completed booking
  for (const b of completedBookings) {
    if (!awardedBookingIds.has(b.id)) {
      newTxns.push({ accountId, tipo:'booking_completado', puntos:100, descripcion:'Reserva completada', bookingId: b.id });
    }
  }

  // Per review
  for (const r of reviews) {
    if (!awardedReviewBookingIds.has(r.bookingId)) {
      newTxns.push({ accountId, tipo:'resena', puntos:50, descripcion:'Reseña publicada', bookingId: r.bookingId });
    }
  }

  // Recurring booking bonus
  for (const b of recurringBookings) {
    if (!awardedRecurringIds.has(b.id)) {
      newTxns.push({ accountId, tipo:'recurrencia', puntos:25, descripcion:'Bonus reserva recurrente', bookingId: b.id });
    }
  }

  if (newTxns.length > 0) {
    await prisma.loyaltyTransaction.createMany({ data: newTxns });
    const earned = newTxns.filter(t => t.puntos > 0).reduce((s, t) => s + t.puntos, 0);
    const newPuntos = await prisma.loyaltyTransaction.aggregate({
      where: { accountId },
      _sum: { puntos: true },
    });
    const total = newPuntos._sum.puntos ?? 0;
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: {
        puntos:      Math.max(0, total),
        nivel:       calcNivel(Math.max(0, total)),
        totalGanados: { increment: earned },
      },
    });
  }
}

/* ── Get or create account ───────────────────────────────────────────────── */
async function getOrCreate(userId) {
  let account = await prisma.loyaltyAccount.findUnique({ where: { userId } });
  if (!account) {
    account = await prisma.loyaltyAccount.create({ data: { userId } });
  }
  return account;
}

/* ══════════════════════════════════════════════════════════════════════════
   GET /loyalty/status — lightweight widget data (no sync, quick load)
══════════════════════════════════════════════════════════════════════════ */
router.get('/status', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'CLIENTE') return res.json({ puntos:0, nivel:'bronce' });
  try {
    const account = await getOrCreate(req.user.id);
    const next    = puntosParaSiguienteNivel(account.puntos);
    const nextN   = nextNivel(account.nivel);
    res.json({
      puntos:    account.puntos,
      nivel:     account.nivel,
      icon:      NIVEL_ICONS[account.nivel],
      color:     NIVEL_COLORS[account.nivel],
      nextNivel: nextN,
      puntosParaSiguiente: next,
      canCanjear: account.puntos >= PUNTOS_POR_CANJE,
      puntosParaCanjear: PUNTOS_POR_CANJE,
      valorCanje: VALOR_POR_CANJE,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /loyalty/me — full account with synced transactions
══════════════════════════════════════════════════════════════════════════ */
router.get('/me', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'CLIENTE') return res.json({ account: null });
  try {
    let account = await getOrCreate(req.user.id);
    await syncPoints(req.user.id, account.id);
    // Re-fetch after sync
    account = await prisma.loyaltyAccount.findUnique({ where: { id: account.id } });
    const transactions = await prisma.loyaltyTransaction.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    const next  = puntosParaSiguienteNivel(account.puntos);
    const nextN = nextNivel(account.nivel);
    const progreso = nextN
      ? Math.round(((account.puntos - (NIVEL_THRESHOLDS.find(t => t.nivel === account.nivel)?.min || 0)) /
          (NIVEL_THRESHOLDS.find(t => t.nivel === nextN)?.min - NIVEL_THRESHOLDS.find(t => t.nivel === account.nivel)?.min || 1)) * 100)
      : 100;

    res.json({
      account: {
        ...account,
        icon:      NIVEL_ICONS[account.nivel],
        color:     NIVEL_COLORS[account.nivel],
        nextNivel: nextN,
        puntosParaSiguiente: next,
        progreso:  Math.min(100, progreso),
        canCanjear: account.puntos >= PUNTOS_POR_CANJE,
        puntosParaCanjear: PUNTOS_POR_CANJE,
        valorCanje: VALOR_POR_CANJE,
        canjesDisponibles: Math.floor(account.puntos / PUNTOS_POR_CANJE),
      },
      transactions: transactions.map(t => ({
        ...t,
        icon: { booking_completado:'✅', resena:'⭐', primera_reserva:'🎉', recurrencia:'🔁', referido:'👥', canjeado:'🎁', bonus:'🎊' }[t.tipo] || '💰',
        positive: t.puntos > 0,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /loyalty/redeem — redeem points for a coupon
══════════════════════════════════════════════════════════════════════════ */
router.post('/redeem', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'CLIENTE') return res.status(403).json({ error: 'Solo clientes pueden canjear puntos.' });
  const { cantidad = 1 } = req.body; // how many "500-pt blocks" to redeem

  try {
    const account = await getOrCreate(req.user.id);
    await syncPoints(req.user.id, account.id);
    const updated = await prisma.loyaltyAccount.findUnique({ where: { id: account.id } });
    const puntosRequeridos = PUNTOS_POR_CANJE * cantidad;
    const descuentoCOP     = VALOR_POR_CANJE  * cantidad;

    if (updated.puntos < puntosRequeridos) {
      return res.status(400).json({ error: `Necesitas ${puntosRequeridos} puntos. Tienes ${updated.puntos}.` });
    }

    // Generate unique coupon code
    const codigo = `PUNTOS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,5).toUpperCase()}`;

    // Create coupon
    const cupon = await prisma.cupon.create({
      data: {
        codigo,
        tipo:        'fijo',
        valor:       descuentoCOP,
        descripcion: `Canjeo de ${puntosRequeridos} puntos DutyJoy`,
        activo:      true,
        maxUsos:     1,
        expira:      new Date(Date.now() + 30 * 86_400_000), // 30 days
        creadoPor:   req.user.id,
      },
    });

    // Deduct points
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
        puntos:        newBalance,
        nivel:         calcNivel(newBalance),
        totalCanjeados: { increment: puntosRequeridos },
      },
    });

    res.json({
      ok:     true,
      codigo,
      descuento: descuentoCOP,
      puntosCanjeados: puntosRequeridos,
      puntosRestantes: newBalance,
      expira: cupon.expira,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /loyalty/award — manually award points (admin or internal)
══════════════════════════════════════════════════════════════════════════ */
router.post('/award', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  const { userId, tipo, puntos: customPts, descripcion, bookingId } = req.body;
  if (!userId || !tipo) return res.status(400).json({ error: 'userId y tipo requeridos' });
  try {
    const account = await getOrCreate(userId);
    const pts     = customPts || PUNTOS_POR_TIPO[tipo] || 0;
    await prisma.loyaltyTransaction.create({
      data: { accountId: account.id, tipo, puntos: pts, descripcion: descripcion || tipo, bookingId },
    });
    const newPts = account.puntos + pts;
    await prisma.loyaltyAccount.update({
      where: { id: account.id },
      data: { puntos: newPts, nivel: calcNivel(newPts), totalGanados: { increment: Math.max(0, pts) } },
    });
    res.json({ ok: true, puntosOtorgados: pts, nuevoBalance: newPts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /loyalty — admin: all accounts leaderboard
══════════════════════════════════════════════════════════════════════════ */
router.get('/', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  try {
    const accounts = await prisma.loyaltyAccount.findMany({
      include: { user: { select: { nombre: true, email: true, ciudad: true } } },
      orderBy: { puntos: 'desc' },
      take: 100,
    });
    const stats = {
      total:     accounts.length,
      platino:   accounts.filter(a => a.nivel === 'platino').length,
      oro:       accounts.filter(a => a.nivel === 'oro').length,
      plata:     accounts.filter(a => a.nivel === 'plata').length,
      bronce:    accounts.filter(a => a.nivel === 'bronce').length,
      totalPuntos: accounts.reduce((s, a) => s + a.puntos, 0),
    };
    res.json({ accounts: accounts.map(a => ({ ...a, icon: NIVEL_ICONS[a.nivel], color: NIVEL_COLORS[a.nivel] })), stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
