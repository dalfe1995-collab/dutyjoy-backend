const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');
const { sendPush } = require('../lib/push');

/* ── Contact-info detection ─────────────────────────────────────────────────
   Detects Colombian phone numbers, WhatsApp links, emails, Telegram, etc.
   When found: message is saved normally PLUS a system warning is inserted.
   This protects the platform's commission and both parties' guarantees.
────────────────────────────────────────────────────────────────────────── */
const CONTACT_PATTERNS = [
  /\b3\d{2}[\s\-.]?\d{3}[\s\-.]?\d{4}\b/,            // Colombian mobile 3XX XXX XXXX
  /\+57[\s\-.]?3\d{9}/,                               // +57 3XXXXXXXXX intl
  /\b60\d[\s\-.]?\d{7}\b/,                            // Colombian landline
  /(?:https?:\/\/)?(?:wa\.me|whatsapp\.me)\//i,       // WhatsApp links
  /\bwsp\b|\bwhats\s*app\b/i,                         // "wsp" / "whatsapp" mentions
  /(?:https?:\/\/)?t\.me\//i,                         // Telegram
  /(?:https?:\/\/)?instagram\.com\//i,                // Instagram
  /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/, // Email
];

const WARN_MSG = `⚠️ *DutyJoy:* Detectamos información de contacto externo en tu mensaje.

Toda la comunicación y los pagos deben realizarse dentro de la plataforma. Ventajas de quedarte en DutyJoy:
• ✅ Pagos seguros con MercadoPago
• 🛡️ Sistema de disputas si algo sale mal
• 📋 Historial oficial del servicio
• 💪 Garantía sobre la reserva

Las transacciones fuera de la plataforma no están cubiertas por nuestras garantías ni nuestro mecanismo de resolución de conflictos (Ley 1480/2011).`;

function hasContactInfo(text) {
  return CONTACT_PATTERNS.some(p => p.test(text));
}

/* ── Guard ─────────────────────────────────────────────────────────────── */
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

/* ── GET /messages/:bookingId ────────────────────────────────────────────── */
router.get('/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;

    const mensajes = await prisma.mensajeChat.findMany({
      where: { bookingId: req.params.bookingId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    await prisma.mensajeChat.updateMany({
      where: { bookingId: req.params.bookingId, autorId: { not: req.user.id }, leido: false },
      data: { leido: true },
    });

    res.json(mensajes);
  } catch (e) {
    console.error('[messages GET]', e);
    res.status(500).json({ error: 'Error al cargar mensajes' });
  }
});

/* ── GET /messages/:bookingId/unread ─────────────────────────────────────── */
router.get('/:bookingId/unread', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;
    const count = await prisma.mensajeChat.count({
      where: { bookingId: req.params.bookingId, autorId: { not: req.user.id }, leido: false },
    });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

/* ── GET /messages/unread/all ────────────────────────────────────────────── */
router.get('/unread/all', verifyToken, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        OR: [{ clienteId: req.user.id }, { proveedor: { userId: req.user.id } }],
        estado: { not: 'CANCELADO' },
      },
      select: { id: true },
    });
    const bookingIds = bookings.map(b => b.id);
    if (bookingIds.length === 0) return res.json({ count: 0 });
    const count = await prisma.mensajeChat.count({
      where: { bookingId: { in: bookingIds }, autorId: { not: req.user.id }, leido: false },
    });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

/* ── POST /messages/:bookingId ───────────────────────────────────────────── */
router.post('/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;

    if (['CANCELADO', 'COMPLETADO'].includes(booking.estado)) {
      return res.status(400).json({ error: 'No se pueden enviar mensajes en reservas canceladas o completadas' });
    }

    const { contenido, tipo = 'texto' } = req.body;
    if (!contenido || typeof contenido !== 'string' || !contenido.trim()) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }

    if (tipo === 'imagen') {
      if (contenido.length > 800_000) {
        return res.status(400).json({ error: 'La imagen es demasiado grande. Máximo 600KB.' });
      }
    } else if (contenido.trim().length > 2000) {
      return res.status(400).json({ error: 'El mensaje no puede superar 2000 caracteres' });
    }

    const allowedTypes = ['texto', 'imagen', 'pago_solicitado'];
    const msgTipo = allowedTypes.includes(tipo) ? tipo : 'texto';

    const mensaje = await prisma.mensajeChat.create({
      data: {
        bookingId: req.params.bookingId,
        autorId:   req.user.id,
        contenido: tipo === 'imagen' ? contenido : contenido.trim(),
        tipo:      msgTipo,
      },
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    // ── Contact-info guard ──
    const contactDetected = msgTipo === 'texto' && hasContactInfo(contenido);
    let warnMsg = null;
    if (contactDetected) {
      warnMsg = await prisma.mensajeChat.create({
        data: {
          bookingId: req.params.bookingId,
          autorId:   req.user.id,
          contenido: WARN_MSG,
          tipo:      'sistema',
        },
        include: { autor: { select: { id: true, nombre: true, rol: true } } },
      });
    }

    // Notify recipient
    const recipientId = booking.clienteId === req.user.id
      ? booking.proveedor.userId
      : booking.clienteId;

    const previewText = msgTipo === 'imagen' ? '📷 Imagen' : contenido.trim().substring(0, 80);
    const notifMsg = `${req.user.nombre}: "${previewText}${contenido.trim().length > 80 ? '…' : ''}"`;
    await Promise.allSettled([
      prisma.notificacion.create({
        data: {
          userId:  recipientId,
          tipo:    'mensaje_nuevo',
          titulo:  '💬 Nuevo mensaje',
          mensaje: notifMsg,
          data:    { bookingId: booking.id, autorId: req.user.id },
        },
      }),
      sendPush(recipientId, {
        title: '💬 Nuevo mensaje',
        body:  notifMsg,
        url:   `/booking-chat/${booking.id}`,
        tag:   `chat-${booking.id}`,
      }),
    ]);

    res.status(201).json({ mensaje, warnMsg, contactDetected });
  } catch (e) {
    console.error('[messages POST]', e);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

/* ── POST /messages/:bookingId/request-payment ───────────────────────────── */
router.post('/:bookingId/request-payment', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden solicitar pagos' });
    }
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;
    if (!['CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO'].includes(booking.estado)) {
      return res.status(400).json({ error: 'Estado de reserva no permite solicitar pago' });
    }

    const mensaje = await prisma.mensajeChat.create({
      data: {
        bookingId: req.params.bookingId,
        autorId:   req.user.id,
        contenido: JSON.stringify({
          monto:     booking.precioTotal,
          bookingId: booking.id,
          servicio:  booking.tipoServicio,
        }),
        tipo: 'pago_solicitado',
      },
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    await prisma.notificacion.create({
      data: {
        userId:  booking.clienteId,
        tipo:    'pago_recibido',
        titulo:  '💳 Solicitud de pago',
        mensaje: `${req.user.nombre} solicita el pago de $${(booking.precioTotal || 0).toLocaleString('es-CO')}`,
        data:    { bookingId: booking.id },
      },
    }).catch(() => {});

    res.status(201).json(mensaje);
  } catch (e) {
    console.error('[messages payment-request]', e);
    res.status(500).json({ error: 'Error al enviar solicitud de pago' });
  }
});

/* ── Typing indicators (in-memory, ephemeral) ────────────────────────────── */
const typingStore = new Map();

router.get('/:bookingId/typing', verifyToken, async (req, res) => {
  try {
    await getBookingOrFail(req.params.bookingId, req.user.id, res);
    const entry  = typingStore.get(req.params.bookingId);
    const typing = entry && entry.userId !== req.user.id && Date.now() - entry.ts < 4000;
    res.json({ typing: !!typing });
  } catch { res.json({ typing: false }); }
});

router.post('/:bookingId/typing', verifyToken, async (req, res) => {
  try {
    if (req.body.typing) {
      typingStore.set(req.params.bookingId, { userId: req.user.id, ts: Date.now() });
    } else {
      const entry = typingStore.get(req.params.bookingId);
      if (entry?.userId === req.user.id) typingStore.delete(req.params.bookingId);
    }
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

/* ── DELETE /messages/:bookingId/:msgId ──────────────────────────────────── */
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
    if (Date.now() - new Date(msg.createdAt).getTime() > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Solo puedes eliminar mensajes dentro de los primeros 5 minutos' });
    }
    await prisma.mensajeChat.delete({ where: { id: req.params.msgId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar mensaje' }); }
});

module.exports = router;
