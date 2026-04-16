const router      = require('express').Router();
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

// Inicializar cliente MP con el access token del .env
const mp = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || '',
  options: { timeout: 5000 },
});

// ─── POST /payments/create ────────────────────────────────────────────────
// Cliente genera la preferencia de pago para un booking
router.post('/create', verifyToken, async (req, res) => {
  try {
    if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(503).json({ error: 'Pagos no configurados aún. Configura MP_ACCESS_TOKEN.' });
    }

    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'bookingId requerido' });

    // Obtener booking con datos del proveedor
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        proveedor: { include: { user: { select: { nombre: true } } } },
        cliente:   { select: { nombre: true, email: true } },
      },
    });

    if (!booking)                         return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.clienteId !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
    if (booking.estado !== 'PENDIENTE')    return res.status(400).json({ error: 'Solo se pagan reservas pendientes' });

    const preference = new Preference(mp);

    const prefData = {
      items: [{
        id:          booking.id,
        title:       `DutyJoy - ${booking.tipoServicio} con ${booking.proveedor.user.nombre}`,
        description: booking.descripcion || `Servicio de ${booking.tipoServicio} - ${booking.duracionHoras}h`,
        quantity:    1,
        currency_id: 'COP',
        unit_price:  booking.precioTotal,
      }],
      payer: {
        name:  booking.cliente.nombre,
        email: booking.cliente.email,
      },
      back_urls: {
        success: `${process.env.FRONTEND_URL}/bookings?pago=exitoso`,
        failure: `${process.env.FRONTEND_URL}/bookings?pago=fallido`,
        pending: `${process.env.FRONTEND_URL}/bookings?pago=pendiente`,
      },
      auto_return:       'approved',
      external_reference: booking.id,        // Para identificar el booking en el webhook
      notification_url:  `${process.env.BACKEND_URL}/payments/webhook`,
      metadata: {
        booking_id:    booking.id,
        cliente_id:    booking.clienteId,
        proveedor_id:  booking.proveedorId,
      },
    };

    const result = await preference.create({ body: prefData });

    // Retornar URL de checkout de MercadoPago
    res.json({
      preference_id:   result.id,
      checkout_url:    result.init_point,        // Producción
      checkout_url_sb: result.sandbox_init_point, // Sandbox/testing
    });

  } catch (error) {
    console.error('[MP] Error creando preferencia:', error);
    res.status(500).json({ error: 'Error al generar el pago' });
  }
});

// ─── POST /payments/webhook ───────────────────────────────────────────────
// MercadoPago llama aquí cuando hay una actualización de pago
router.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    // Solo nos importan los eventos de pago
    if (type !== 'payment') {
      return res.status(200).json({ ok: true });
    }

    const paymentId = data?.id;
    if (!paymentId) return res.status(200).json({ ok: true });

    // Consultar detalles del pago en MP
    const paymentClient = new Payment(mp);
    const payment = await paymentClient.get({ id: paymentId });

    console.log(`[MP Webhook] Pago ${paymentId}: ${payment.status} - Booking: ${payment.external_reference}`);

    const bookingId = payment.external_reference;
    if (!bookingId) return res.status(200).json({ ok: true });

    // Actualizar estado del booking según el estado del pago
    if (payment.status === 'approved') {
      await prisma.booking.update({
        where: { id: bookingId },
        data:  { estado: 'CONFIRMADO' },
      });
      console.log(`[MP Webhook] Booking ${bookingId} → CONFIRMADO`);
    } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
      await prisma.booking.update({
        where: { id: bookingId },
        data:  { estado: 'CANCELADO' },
      });
      console.log(`[MP Webhook] Booking ${bookingId} → CANCELADO`);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[MP Webhook] Error:', error);
    // Siempre retornar 200 a MP para evitar reintentos indefinidos
    res.status(200).json({ ok: true });
  }
});

// ─── GET /payments/status/:bookingId ─────────────────────────────────────
// Frontend consulta el estado del pago de un booking
router.get('/status/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      select: { id: true, estado: true, precioTotal: true, comisionDutyJoy: true, clienteId: true },
    });

    if (!booking)                          return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.clienteId !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    res.json({ bookingId: booking.id, estado: booking.estado, precioTotal: booking.precioTotal });
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar pago' });
  }
});

module.exports = router;
