const router      = require('express').Router();
const crypto      = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');
const email       = require('../lib/email');
const { audit }   = require('../lib/audit');

/**
 * Verify MercadoPago webhook signature.
 * MP sends: x-signature: ts=TIMESTAMP,v1=HMAC
 * Manifest: "id:{data.id};request-date:{timestamp};"
 * HMAC-SHA256(MP_WEBHOOK_SECRET, manifest)
 */
function verifyMpSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured (dev mode)

  const sigHeader = req.headers['x-signature'];
  if (!sigHeader) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const ts   = parts['ts'];
  const v1   = parts['v1'];
  if (!ts || !v1) return false;

  const dataId   = req.body?.data?.id;
  const manifest = `id:${dataId};request-date:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

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
    if (!['PENDIENTE', 'CONFIRMADO'].includes(booking.estado)) {
      return res.status(400).json({ error: 'Solo se pueden pagar reservas pendientes o confirmadas' });
    }

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
        success: `${process.env.FRONTEND_URL}/my-bookings?pago=exitoso`,
        failure: `${process.env.FRONTEND_URL}/my-bookings?pago=fallido`,
        pending: `${process.env.FRONTEND_URL}/my-bookings?pago=pendiente`,
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
  // Always return 200 first — MP retries on non-200
  res.status(200).json({ ok: true });

  try {
    // ── Signature verification ──────────────────────────────────────────
    if (!verifyMpSignature(req)) {
      console.error('[MP Webhook] Firma inválida — descartado');
      audit({ accion: 'webhook_firma_invalida', entidad: 'Payment', despues: { headers: req.headers['x-signature'], ip: req.headers['x-forwarded-for'] } }).catch(() => {});
      return;
    }

    const { type, data } = req.body;
    if (type !== 'payment') return;

    const paymentId = data?.id;
    if (!paymentId) return;

    // ── Idempotency: skip if already processed ──────────────────────────
    const yaExiste = await prisma.pago.findFirst({
      where: { referencia: String(paymentId), tipo: 'CLIENTE_RECIBIDO' },
    });
    if (yaExiste) {
      console.log(`[MP Webhook] Pago ${paymentId} ya procesado — omitido`);
      return;
    }

    const paymentClient = new Payment(mp);
    const payment       = await paymentClient.get({ id: paymentId });

    const bookingId = payment.external_reference;
    if (!bookingId) return;

    console.log(`[MP Webhook] Pago ${paymentId}: ${payment.status} - Booking: ${bookingId}`);

    if (payment.status === 'approved') {
      const booking = await prisma.booking.update({
        where: { id: bookingId },
        data:  { estado: 'CONFIRMADO' },
        include: {
          cliente:   { select: { nombre: true, email: true, id: true } },
          proveedor: { include: { user: { select: { nombre: true, email: true } } } },
        },
      });

      await prisma.pago.create({
        data: {
          bookingId,
          proveedorId: booking.proveedorId,
          tipo:        'CLIENTE_RECIBIDO',
          monto:       booking.precioTotal,
          estado:      'COMPLETADO',
          referencia:  String(paymentId),
          metodo:      payment.payment_type_id || 'MercadoPago',
          notas:       `Pago aprobado MP. Net: $${(booking.precioTotal - booking.comisionDutyJoy).toLocaleString('es-CO')} proveedor + $${booking.comisionDutyJoy.toLocaleString('es-CO')} comisión DutyJoy`,
          fechaPago:   new Date(),
        },
      });

      audit({ accion: 'pago_aprobado', userId: booking.cliente.id, entidad: 'Booking', entidadId: bookingId, despues: { paymentId, monto: booking.precioTotal } }).catch(() => {});

      const fechaFmt = new Date(booking.fechaServicio).toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      email.reservaConfirmada({ clienteEmail: booking.cliente.email, clienteNombre: booking.cliente.nombre, proveedorNombre: booking.proveedor.user.nombre, tipoServicio: booking.tipoServicio, fecha: fechaFmt, precioTotal: booking.precioTotal }).catch(() => {});
      email.pagoConfirmadoProveedor({ proveedorEmail: booking.proveedor.user.email, proveedorNombre: booking.proveedor.user.nombre, clienteNombre: booking.cliente.nombre, tipoServicio: booking.tipoServicio, fecha: fechaFmt, precioTotal: booking.precioTotal, comision: booking.comisionDutyJoy }).catch(() => {});

    } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
      await prisma.booking.update({ where: { id: bookingId }, data: { estado: 'CANCELADO' } });
      audit({ accion: 'pago_rechazado', entidad: 'Booking', entidadId: bookingId, despues: { paymentId, status: payment.status } }).catch(() => {});
    }

  } catch (error) {
    console.error('[MP Webhook] Error:', error.message);
  }
});

// ─── POST /payments/booking-completed ────────────────────────────────────
// Llamado internamente cuando un booking pasa a COMPLETADO
// Crea el registro de pago pendiente al proveedor (ventana 48h)
async function createProviderPayout(bookingId) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { pagos: { where: { tipo: 'PROVEEDOR_PENDIENTE' } } },
    });
    if (!booking || booking.pagos.length > 0) return; // already created

    const montoProveedor = booking.precioTotal - booking.comisionDutyJoy;
    await prisma.pago.create({
      data: {
        bookingId,
        proveedorId:  booking.proveedorId,
        tipo:         'PROVEEDOR_PENDIENTE',
        monto:        montoProveedor,
        estado:       'PENDIENTE',
        notas:        `Pago pendiente: $${montoProveedor.toLocaleString('es-CO')} COP (85% de $${booking.precioTotal.toLocaleString('es-CO')}). Disponible 48h tras finalización.`,
      },
    });
    console.log(`[Pago] Payout pendiente creado para booking ${bookingId}: $${montoProveedor}`);
  } catch (e) {
    console.error('[createProviderPayout]', e.message);
  }
}
exports.createProviderPayout = createProviderPayout;

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

// ─── GET /payments/provider/payouts ──────────────────────────────────────
// Proveedor consulta sus pagos pendientes y pasados
router.get('/provider/payouts', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

    const pagos = await prisma.pago.findMany({
      where: { proveedorId: profile.id },
      include: {
        booking: { select: { tipoServicio: true, fechaServicio: true, cliente: { select: { nombre: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const pendiente   = pagos.filter(p => p.tipo === 'PROVEEDOR_PENDIENTE' && p.estado === 'PENDIENTE').reduce((s, p) => s + p.monto, 0);
    const totalGanado = pagos.filter(p => p.tipo === 'PROVEEDOR_PAGADO').reduce((s, p) => s + p.monto, 0);

    res.json({ pagos, resumen: { pendiente, totalGanado } });
  } catch (error) {
    console.error('[provider/payouts]', error);
    res.status(500).json({ error: 'Error al consultar pagos' });
  }
});

// ─── PUT /payments/provider/payment-info ─────────────────────────────────
// Proveedor registra/actualiza su método de cobro
router.put('/provider/payment-info', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const { metodoCobro, numeroCobro, titularCobro, bancoCobro, tipoCuentaCobro } = req.body;

    const METODOS_VALIDOS = ['Nequi', 'Daviplata', 'Bancolombia', 'Davivienda', 'PSE', 'Otro'];
    if (metodoCobro && !METODOS_VALIDOS.includes(metodoCobro)) {
      return res.status(400).json({ error: `Método inválido. Válidos: ${METODOS_VALIDOS.join(', ')}` });
    }

    const updated = await prisma.providerProfile.update({
      where: { userId: req.user.id },
      data: {
        ...(metodoCobro    !== undefined && { metodoCobro }),
        ...(numeroCobro    !== undefined && { numeroCobro }),
        ...(titularCobro   !== undefined && { titularCobro }),
        ...(bancoCobro     !== undefined && { bancoCobro }),
        ...(tipoCuentaCobro !== undefined && { tipoCuentaCobro }),
      },
      select: { metodoCobro: true, numeroCobro: true, titularCobro: true, bancoCobro: true, tipoCuentaCobro: true },
    });

    res.json({ mensaje: 'Información de cobro actualizada', cobro: updated });
  } catch (error) {
    console.error('[provider/payment-info]', error);
    res.status(500).json({ error: 'Error al actualizar info de cobro' });
  }
});

// ─── GET /payments/admin/dashboard ───────────────────────────────────────
router.get('/admin/dashboard', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo admins' });

    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    const startOfPrev  = new Date(startOfMonth); startOfPrev.setMonth(startOfPrev.getMonth() - 1);
    const endOfPrev    = new Date(startOfMonth); endOfPrev.setMilliseconds(-1);

    const [clientesMes, clientesPrev, pagosProvMes, pagosProvPrev, pendientes, totalPagado] = await Promise.all([
      prisma.pago.aggregate({ where: { tipo: 'CLIENTE_RECIBIDO', estado: 'COMPLETADO', fechaPago: { gte: startOfMonth } }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'CLIENTE_RECIBIDO', estado: 'COMPLETADO', fechaPago: { gte: startOfPrev, lte: endOfPrev } }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'PROVEEDOR_PAGADO', fechaPago: { gte: startOfMonth } }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'PROVEEDOR_PAGADO', fechaPago: { gte: startOfPrev, lte: endOfPrev } }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'PROVEEDOR_PENDIENTE', estado: 'PENDIENTE' }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'PROVEEDOR_PAGADO' }, _sum: { monto: true }, _count: true }),
    ]);

    const gmvMes      = clientesMes._sum.monto  || 0;
    const gmvPrev     = clientesPrev._sum.monto  || 0;
    const comisionesMes = gmvMes - (pagosProvMes._sum.monto || 0);

    res.json({
      gmvMes,
      gmvPrev,
      gmvGrowth:       gmvPrev > 0 ? ((gmvMes - gmvPrev) / gmvPrev * 100).toFixed(1) : null,
      comisionesMes,
      transaccionesMes: clientesMes._count,
      pagosProveedorMes: pagosProvMes._sum.monto || 0,
      payoutsPendientesMonto: pendientes._sum.monto || 0,
      payoutsPendientesCount: pendientes._count,
      totalPagadoHistorico:   totalPagado._sum.monto || 0,
    });
  } catch (error) {
    console.error('[admin/dashboard]', error);
    res.status(500).json({ error: 'Error al obtener dashboard' });
  }
});

// ─── GET /payments/admin/pending-payouts ─────────────────────────────────
router.get('/admin/pending-payouts', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo admins' });

    const { estado = 'PENDIENTE', page = '1', limit = '50' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [pagos, total] = await Promise.all([
      prisma.pago.findMany({
        where: { tipo: { in: ['PROVEEDOR_PENDIENTE', 'PROVEEDOR_PAGADO'] }, ...(estado !== 'TODOS' && { estado }) },
        include: {
          proveedor: {
            select: {
              id: true, metodoCobro: true, numeroCobro: true, titularCobro: true, bancoCobro: true, tipoCuentaCobro: true,
              user: { select: { nombre: true, email: true } },
            },
          },
          booking: { select: { tipoServicio: true, fechaServicio: true, updatedAt: true } },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.pago.count({ where: { tipo: { in: ['PROVEEDOR_PENDIENTE', 'PROVEEDOR_PAGADO'] }, ...(estado !== 'TODOS' && { estado }) } }),
    ]);

    // Flag payouts ready (48h passed since booking completed)
    const now = Date.now();
    const result = pagos.map(p => ({
      ...p,
      listo48h: p.booking?.updatedAt ? (now - new Date(p.booking.updatedAt).getTime()) >= 48 * 3600 * 1000 : false,
    }));

    res.json({ pagos: result, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    console.error('[admin/pending-payouts]', error);
    res.status(500).json({ error: 'Error al obtener pagos pendientes' });
  }
});

// ─── POST /payments/admin/process-payout/:pagoId ─────────────────────────
router.post('/admin/process-payout/:pagoId', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo admins' });

    const { referencia, notas } = req.body;
    const pago = await prisma.pago.findUnique({ where: { id: req.params.pagoId } });

    if (!pago) return res.status(404).json({ error: 'Pago no encontrado' });
    if (pago.tipo !== 'PROVEEDOR_PENDIENTE') return res.status(400).json({ error: 'Solo se pueden procesar pagos PROVEEDOR_PENDIENTE' });
    if (pago.estado === 'COMPLETADO') return res.status(400).json({ error: 'Este pago ya fue procesado' });

    const updated = await prisma.pago.update({
      where: { id: req.params.pagoId },
      data: {
        tipo:         'PROVEEDOR_PAGADO',
        estado:       'COMPLETADO',
        fechaPago:    new Date(),
        procesadoPor: req.user.id,
        ...(referencia && { referencia }),
        ...(notas      && { notas }),
      },
    });

    console.log(`[Admin] Payout ${pago.id} procesado por ${req.user.id}: $${pago.monto}`);
    res.json({ mensaje: 'Pago procesado exitosamente', pago: updated });
  } catch (error) {
    console.error('[admin/process-payout]', error);
    res.status(500).json({ error: 'Error al procesar el pago' });
  }
});

// ─── GET /payments/admin/cashflow ────────────────────────────────────────
// Aggregated monthly cashflow from real Pago records
router.get('/admin/cashflow', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo admins' });

    const { months = '6' } = req.query;
    const nMonths = Math.min(24, parseInt(months));
    const result  = [];

    for (let i = nMonths - 1; i >= 0; i--) {
      const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0); start.setMonth(start.getMonth() - i);
      const end   = new Date(start); end.setMonth(end.getMonth() + 1); end.setMilliseconds(-1);

      const [entradas, salidas] = await Promise.all([
        prisma.pago.aggregate({ where: { tipo: 'CLIENTE_RECIBIDO', estado: 'COMPLETADO', fechaPago: { gte: start, lte: end } }, _sum: { monto: true } }),
        prisma.pago.aggregate({ where: { tipo: { in: ['PROVEEDOR_PAGADO', 'REEMBOLSO_CLIENTE'] }, fechaPago: { gte: start, lte: end } }, _sum: { monto: true } }),
      ]);

      const entrada = entradas._sum.monto || 0;
      const salida  = salidas._sum.monto  || 0;
      result.push({
        mes:     start.toLocaleDateString('es-CO', { month: 'short', year: '2-digit' }),
        mesISO:  start.toISOString().slice(0, 7),
        entrada,
        salida,
        neto:    entrada - salida,
        comision: Math.round((entrada - salida) * 1),
      });
    }

    // Running accumulated
    let acum = 0;
    result.forEach(m => { acum += m.neto; m.acum = acum; });

    res.json({ cashflow: result });
  } catch (error) {
    console.error('[admin/cashflow]', error);
    res.status(500).json({ error: 'Error al obtener cashflow' });
  }
});

// ─── GET /payments/admin/reconciliation ──────────────────────────────────
router.get('/admin/reconciliation', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo admins' });

    const [clienteRecibido, proveedorPendiente, proveedorPagado, reembolsos] = await Promise.all([
      prisma.pago.aggregate({ where: { tipo: 'CLIENTE_RECIBIDO', estado: 'COMPLETADO' }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'PROVEEDOR_PENDIENTE', estado: 'PENDIENTE' }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'PROVEEDOR_PAGADO' }, _sum: { monto: true }, _count: true }),
      prisma.pago.aggregate({ where: { tipo: 'REEMBOLSO_CLIENTE' }, _sum: { monto: true }, _count: true }),
    ]);

    const totalEntradas    = clienteRecibido._sum.monto  || 0;
    const totalProvPagado  = proveedorPagado._sum.monto  || 0;
    const totalProvPend    = proveedorPendiente._sum.monto || 0;
    const totalReembolsos  = reembolsos._sum.monto       || 0;
    const comisionesTotales = totalEntradas - totalProvPagado - totalProvPend - totalReembolsos;

    res.json({
      totalEntradas,
      totalProveedoresPagados: totalProvPagado,
      totalProveedoresPendientes: totalProvPend,
      totalReembolsos,
      comisionesRetenidas: comisionesTotales,
      balance: totalEntradas - totalProvPagado - totalProvPend - totalReembolsos,
      conteos: {
        transacciones: clienteRecibido._count,
        payoutsPagados: proveedorPagado._count,
        payoutsPendientes: proveedorPendiente._count,
        reembolsos: reembolsos._count,
      },
    });
  } catch (error) {
    console.error('[admin/reconciliation]', error);
    res.status(500).json({ error: 'Error al obtener reconciliación' });
  }
});

module.exports = router;
