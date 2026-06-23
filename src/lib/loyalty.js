/**
 * loyalty.js — DutyJoy Puntos (business logic)
 *
 * Earning:
 *   primera_reserva    → 150 pts (one-time)
 *   booking_completado → 100 pts per completed booking
 *   resena             → 50 pts per review
 *   recurrencia        → 25 pts for recurring bookings
 *   referido           → 200 pts when a referred user completes first booking
 *
 * Redeeming:
 *   500 pts = $5,000 COP → one-time PUNTOS-XXXX coupon (30d expiry)
 */
const prisma = require('./prisma');

const PUNTOS_POR_TIPO = {
  primera_reserva:    150,
  booking_completado: 100,
  resena:             50,
  recurrencia:        25,
  referido:           200,
};

const NIVEL_THRESHOLDS = [
  { nivel: 'platino', min: 3000 },
  { nivel: 'oro',     min: 1500 },
  { nivel: 'plata',   min: 500  },
  { nivel: 'bronce',  min: 0    },
];

const NIVEL_ICONS  = { bronce: '🥉', plata: '🥈', oro: '🥇', platino: '💎' };
const NIVEL_COLORS = { bronce: '#CD7F32', plata: '#C0C0C0', oro: '#FFD700', platino: '#0ABFBC' };
const PUNTOS_POR_CANJE = 500;
const VALOR_POR_CANJE  = 5000;

const TXN_ICONS = {
  booking_completado: '✅',
  resena:             '⭐',
  primera_reserva:    '🎉',
  recurrencia:        '🔁',
  referido:           '👥',
  canjeado:           '🎁',
  bonus:              '🎊',
};

function calcNivel(puntos) {
  return NIVEL_THRESHOLDS.find(t => puntos >= t.min)?.nivel || 'bronce';
}

function nextNivel(actual) {
  const idx = ['bronce', 'plata', 'oro', 'platino'].indexOf(actual);
  return idx >= 3 ? null : ['bronce', 'plata', 'oro', 'platino'][idx + 1];
}

function puntosParaSiguienteNivel(puntos) {
  const next = nextNivel(calcNivel(puntos));
  if (!next) return null;
  const threshold = NIVEL_THRESHOLDS.find(t => t.nivel === next)?.min || 0;
  return Math.max(0, threshold - puntos);
}

function calcProgreso(puntos, nivel) {
  const next = nextNivel(nivel);
  if (!next) return 100;
  const currentMin = NIVEL_THRESHOLDS.find(t => t.nivel === nivel)?.min || 0;
  const nextMin = NIVEL_THRESHOLDS.find(t => t.nivel === next)?.min || 1;
  const span = nextMin - currentMin || 1;
  return Math.min(100, Math.round(((puntos - currentMin) / span) * 100));
}

async function getOrCreate(userId) {
  let account = await prisma.loyaltyAccount.findUnique({ where: { userId } });
  if (!account) {
    account = await prisma.loyaltyAccount.create({ data: { userId } });
  }
  return account;
}

async function applyTransactions(accountId, newTxns) {
  if (newTxns.length === 0) return;

  await prisma.loyaltyTransaction.createMany({ data: newTxns });
  const earned = newTxns.filter(t => t.puntos > 0).reduce((s, t) => s + t.puntos, 0);
  const newPuntos = await prisma.loyaltyTransaction.aggregate({
    where: { accountId },
    _sum: { puntos: true },
  });
  const total = Math.max(0, newPuntos._sum.puntos ?? 0);
  await prisma.loyaltyAccount.update({
    where: { id: accountId },
    data: {
      puntos:       total,
      nivel:        calcNivel(total),
      totalGanados: { increment: earned },
    },
  });
}

/** Reconcile earned points from bookings, reviews and referrals. */
async function syncPoints(userId, accountId) {
  const [
    completedBookings,
    reviews,
    existing1st,
    existingBookingTxns,
    existingReviewTxns,
    recurringBookings,
    existingRecurringTxns,
    existingReferralTxns,
    referredUsers,
  ] = await Promise.all([
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
    prisma.loyaltyTransaction.findMany({
      where: { accountId, tipo: 'booking_completado' },
      select: { bookingId: true },
    }),
    prisma.loyaltyTransaction.findMany({
      where: { accountId, tipo: 'resena' },
      select: { bookingId: true },
    }),
    prisma.booking.findMany({
      where: { clienteId: userId, estado: 'COMPLETADO', recurrencia: { not: 'UNICA' } },
      select: { id: true },
    }),
    prisma.loyaltyTransaction.findMany({
      where: { accountId, tipo: 'recurrencia' },
      select: { bookingId: true },
    }),
    prisma.loyaltyTransaction.findMany({
      where: { accountId, tipo: 'referido' },
      select: { bookingId: true },
    }),
    prisma.user.findMany({
      where: { referredById: userId },
      select: { id: true, nombre: true },
    }),
  ]);

  const awardedBookingIds = new Set(existingBookingTxns.map(t => t.bookingId));
  const awardedReviewBookingIds = new Set(existingReviewTxns.map(t => t.bookingId));
  const awardedRecurringIds = new Set(existingRecurringTxns.map(t => t.bookingId));
  const awardedReferralBookingIds = new Set(existingReferralTxns.map(t => t.bookingId));

  const newTxns = [];

  if (!existing1st && completedBookings.length > 0) {
    newTxns.push({
      accountId,
      tipo: 'primera_reserva',
      puntos: PUNTOS_POR_TIPO.primera_reserva,
      descripcion: '¡Primera reserva completada!',
      bookingId: completedBookings[0].id,
    });
  }

  for (const b of completedBookings) {
    if (!awardedBookingIds.has(b.id)) {
      newTxns.push({
        accountId,
        tipo: 'booking_completado',
        puntos: PUNTOS_POR_TIPO.booking_completado,
        descripcion: 'Reserva completada',
        bookingId: b.id,
      });
    }
  }

  for (const r of reviews) {
    if (!awardedReviewBookingIds.has(r.bookingId)) {
      newTxns.push({
        accountId,
        tipo: 'resena',
        puntos: PUNTOS_POR_TIPO.resena,
        descripcion: 'Reseña publicada',
        bookingId: r.bookingId,
      });
    }
  }

  for (const b of recurringBookings) {
    if (!awardedRecurringIds.has(b.id)) {
      newTxns.push({
        accountId,
        tipo: 'recurrencia',
        puntos: PUNTOS_POR_TIPO.recurrencia,
        descripcion: 'Bonus reserva recurrente',
        bookingId: b.id,
      });
    }
  }

  // Referral bonus: 200 pts when a referred user completes their first booking
  if (referredUsers.length > 0) {
    const referralBookings = await prisma.booking.findMany({
      where: {
        clienteId: { in: referredUsers.map(u => u.id) },
        estado: 'COMPLETADO',
      },
      select: { id: true, clienteId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const firstBookingByUser = new Map();
    for (const b of referralBookings) {
      if (!firstBookingByUser.has(b.clienteId)) {
        firstBookingByUser.set(b.clienteId, b);
      }
    }

    for (const referred of referredUsers) {
      const firstBooking = firstBookingByUser.get(referred.id);
      if (!firstBooking || awardedReferralBookingIds.has(firstBooking.id)) continue;

      const name = referred.nombre?.split(' ')[0] || 'tu referido';
      newTxns.push({
        accountId,
        tipo: 'referido',
        puntos: PUNTOS_POR_TIPO.referido,
        descripcion: `${name} completó su primera reserva`,
        bookingId: firstBooking.id,
      });
    }
  }

  await applyTransactions(accountId, newTxns);
}

/** Sync loyalty for a user (client). Safe to call fire-and-forget. */
async function syncUserLoyalty(userId) {
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, rol: true, referredById: true },
  });
  if (!user || user.rol !== 'CLIENTE') return null;

  const account = await getOrCreate(userId);
  await syncPoints(userId, account.id);
  return prisma.loyaltyAccount.findUnique({ where: { id: account.id } });
}

/** After a booking is completed: sync client + referrer (if any). */
async function onBookingCompleted(clienteId) {
  const tasks = [syncUserLoyalty(clienteId)];

  const client = await prisma.user.findUnique({
    where: { id: clienteId },
    select: { referredById: true },
  });
  if (client?.referredById) {
    tasks.push(syncUserLoyalty(client.referredById));
  }

  await Promise.allSettled(tasks);
}

function enrichAccount(account) {
  const next = puntosParaSiguienteNivel(account.puntos);
  const nextN = nextNivel(account.nivel);
  return {
    ...account,
    icon:                NIVEL_ICONS[account.nivel],
    color:               NIVEL_COLORS[account.nivel],
    nextNivel:           nextN,
    puntosParaSiguiente: next,
    progreso:            calcProgreso(account.puntos, account.nivel),
    canCanjear:          account.puntos >= PUNTOS_POR_CANJE,
    puntosParaCanjear:   PUNTOS_POR_CANJE,
    valorCanje:          VALOR_POR_CANJE,
    canjesDisponibles:   Math.floor(account.puntos / PUNTOS_POR_CANJE),
  };
}

function mapTransaction(t) {
  return {
    ...t,
    icon:     TXN_ICONS[t.tipo] || '💰',
    positive: t.puntos > 0,
  };
}

module.exports = {
  PUNTOS_POR_TIPO,
  PUNTOS_POR_CANJE,
  VALOR_POR_CANJE,
  NIVEL_THRESHOLDS,
  calcNivel,
  nextNivel,
  puntosParaSiguienteNivel,
  getOrCreate,
  syncPoints,
  syncUserLoyalty,
  onBookingCompleted,
  enrichAccount,
  mapTransaction,
};
