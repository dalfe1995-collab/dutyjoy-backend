const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

// ── Guard: user must be cliente or proveedor of this booking ─────────────
async function getBookingOrFail(bookingId, userId, res) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { proveedor: { select: { userId: true } } },
  });
  if (!booking) { res.status(404).json({ error: 'Reserva no encontrada' }); return null; }
  const isCliente   = booking.clienteId === userId;
  const isProveedor = booking.proveedor.userId === userId;
  if (!isCliente && !isProveedor) {
    res.status(403).json({ error: 'No tienes acceso a este chat' }); return null;
  }
  return booking;
}

// ── GET /messages/:bookingId — obtener mensajes (últimos 100) ─────────────
router.get('/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;

    const mensajes = await prisma.mensajeChat.findMany({
      where: { bookingId: req.params.bookingId },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: {
        autor: { select: { id: true, nombre: true, rol: true } },
      },
    });

    // Mark messages from the other party as read
    await prisma.mensajeChat.updateMany({
      where: {
        bookingId: req.params.bookingId,
        autorId: { not: req.user.id },
        leido: false,
      },
      data: { leido: true },
    });

    res.json(mensajes);
  } catch (e) {
    console.error('[messages GET]', e);
    res.status(500).json({ error: 'Error al cargar mensajes' });
  }
});

// ── GET /messages/:bookingId/unread — count unread for this booking ───────
router.get('/:bookingId/unread', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;
    const count = await prisma.mensajeChat.count({
      where: { bookingId: req.params.bookingId, autorId: { not: req.user.id }, leido: false },
    });
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

// ── GET /messages/unread/all — total unread across all bookings ───────────
router.get('/unread/all', verifyToken, async (req, res) => {
  try {
    // Get all bookings the user is part of
    const bookings = await prisma.booking.findMany({
      where: {
        OR: [
          { clienteId: req.user.id },
          { proveedor: { userId: req.user.id } },
        ],
        estado: { not: 'CANCELADO' },
      },
      select: { id: true },
    });
    const bookingIds = bookings.map(b => b.id);
    if (bookingIds.length === 0) return res.json({ count: 0 });

    const count = await prisma.mensajeChat.count({
      where: {
        bookingId: { in: bookingIds },
        autorId: { not: req.user.id },
        leido: false,
      },
    });
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

// ── POST /messages/:bookingId — enviar mensaje ────────────────────────────
router.post('/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;

    if (['CANCELADO', 'COMPLETADO'].includes(booking.estado)) {
      return res.status(400).json({ error: 'No se pueden enviar mensajes en reservas canceladas o completadas' });
    }

    const { contenido } = req.body;
    if (!contenido || typeof contenido !== 'string' || !contenido.trim()) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }
    if (contenido.trim().length > 1000) {
      return res.status(400).json({ error: 'El mensaje no puede superar 1000 caracteres' });
    }

    const mensaje = await prisma.mensajeChat.create({
      data: {
        bookingId: req.params.bookingId,
        autorId:   req.user.id,
        contenido: contenido.trim(),
      },
      include: {
        autor: { select: { id: true, nombre: true, rol: true } },
      },
    });

    // Notificar al otro participante
    const recipientId = booking.clienteId === req.user.id
      ? booking.proveedor.userId
      : booking.clienteId;

    await prisma.notificacion.create({
      data: {
        userId:  recipientId,
        tipo:    'mensaje_nuevo',
        titulo:  `💬 Nuevo mensaje`,
        mensaje: `${req.user.nombre}: "${contenido.trim().substring(0, 80)}${contenido.trim().length > 80 ? '…' : ''}"`,
        data:    { bookingId: booking.id, autorId: req.user.id },
      },
    }).catch(() => {}); // Non-blocking

    res.status(201).json(mensaje);
  } catch (e) {
    console.error('[messages POST]', e);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

// ── DELETE /messages/:bookingId/:msgId — delete own message ──────────────
router.delete('/:bookingId/:msgId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;

    const msg = await prisma.mensajeChat.findUnique({ where: { id: req.params.msgId } });
    if (!msg || msg.bookingId !== req.params.bookingId) {
      return res.status(404).json({ error: 'Mensaje no encontrado' });
    }
    if (msg.autorId !== req.user.id) {
      return res.status(403).json({ error: 'Solo puedes eliminar tus propios mensajes' });
    }
    // Only allow delete within 5 minutes of sending
    if (Date.now() - new Date(msg.createdAt).getTime() > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Solo puedes eliminar mensajes dentro de los primeros 5 minutos' });
    }
    await prisma.mensajeChat.delete({ where: { id: req.params.msgId } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar mensaje' });
  }
});

module.exports = router;
