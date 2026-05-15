/**
 * Notification helper — creates Notificacion records.
 * Fire-and-forget: always call with .catch(() => {}) to avoid blocking responses.
 */
const prisma = require('./prisma');

/**
 * createNotificacion({ userId, tipo, titulo, mensaje, data? })
 * tipo examples: 'booking_new', 'booking_status', 'review_new', 'pago_recibido', 'recurrencia_creada'
 */
async function createNotificacion({ userId, tipo, titulo, mensaje, data = null }) {
  return prisma.notificacion.create({
    data: { userId, tipo, titulo, mensaje, data },
  });
}

/**
 * notifyBookingStatusChange — sends a notification to the OTHER party.
 * When provider confirms/starts/completes → notify client.
 * When client cancels → notify provider.
 */
async function notifyBookingStatusChange({ booking, nuevoEstado, actorRol }) {
  // Resolve the user to notify (the other party)
  const proveedorProfile = await prisma.providerProfile.findUnique({
    where: { id: booking.proveedorId },
    select: { userId: true, user: { select: { nombre: true } } },
  });
  if (!proveedorProfile) return;

  const proveedorNombre = proveedorProfile.user?.nombre || 'Proveedor';
  const clienteNombre   = booking.cliente?.nombre || booking.clienteNombre || 'Cliente';

  const LABELS = {
    CONFIRMADO:   { es: 'confirmó',    emoji: '✅' },
    EN_PROGRESO:  { es: 'inició',      emoji: '🔧' },
    COMPLETADO:   { es: 'completó',    emoji: '🏅' },
    CANCELADO:    { es: 'canceló',     emoji: '❌' },
  };

  const label = LABELS[nuevoEstado];
  if (!label) return;

  const notifData = {
    bookingId: booking.id,
    tipoServicio: booking.tipoServicio,
    estado: nuevoEstado,
    fechaServicio: booking.fechaServicio,
  };

  if (actorRol === 'PROVEEDOR') {
    // Notify the client
    await createNotificacion({
      userId:  booking.clienteId,
      tipo:    'booking_status',
      titulo:  `Reserva ${label.emoji} ${nuevoEstado.toLowerCase()}`,
      mensaje: `${proveedorNombre} ${label.es} tu reserva de ${booking.tipoServicio}.`,
      data:    notifData,
    });
  } else if (actorRol === 'CLIENTE' && nuevoEstado === 'CANCELADO') {
    // Notify the provider
    await createNotificacion({
      userId:  proveedorProfile.userId,
      tipo:    'booking_status',
      titulo:  `Reserva cancelada ❌`,
      mensaje: `${clienteNombre} canceló la reserva de ${booking.tipoServicio}.`,
      data:    notifData,
    });
  }
}

/**
 * notifyBookingNew — fires when a new booking is created.
 * Notifies the provider.
 */
async function notifyBookingNew({ booking, clienteNombre }) {
  const proveedorProfile = await prisma.providerProfile.findUnique({
    where: { id: booking.proveedorId },
    select: { userId: true },
  });
  if (!proveedorProfile) return;

  await createNotificacion({
    userId:  proveedorProfile.userId,
    tipo:    'booking_new',
    titulo:  '📋 Nueva reserva recibida',
    mensaje: `${clienteNombre} reservó ${booking.tipoServicio} para el ${new Date(booking.fechaServicio).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}.`,
    data:    { bookingId: booking.id, tipoServicio: booking.tipoServicio, fechaServicio: booking.fechaServicio },
  });
}

/**
 * notifyReviewNew — fires when a client leaves a review.
 * Notifies the provider.
 */
async function notifyReviewNew({ review, clienteNombre, tipoServicio }) {
  await createNotificacion({
    userId:  review.proveedorProfile?.userId || review.proveedorUserId,
    tipo:    'review_new',
    titulo:  `⭐ Nueva reseña (${review.calificacion}/5)`,
    mensaje: `${clienteNombre} dejó una reseña de ${review.calificacion} estrellas para tu servicio de ${tipoServicio}.`,
    data:    { reviewId: review.id, calificacion: review.calificacion },
  });
}

module.exports = { createNotificacion, notifyBookingStatusChange, notifyBookingNew, notifyReviewNew };
