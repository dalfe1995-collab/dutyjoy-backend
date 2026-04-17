const router     = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma     = require('../lib/prisma');
const email      = require('../lib/email');

// ── Helpers ───────────────────────────────────────────────────────────
function formatFecha(date) {
  return new Date(date).toLocaleDateString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// POST /bookings — cliente crea una reserva
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'CLIENTE') {
      return res.status(403).json({ error: 'Solo los clientes pueden crear reservas' });
    }

    const { proveedorId, tipoServicio, descripcion, fechaServicio, duracionHoras } = req.body;

    if (!proveedorId || !tipoServicio || !fechaServicio) {
      return res.status(400).json({ error: 'proveedorId, tipoServicio y fechaServicio son requeridos' });
    }

    const proveedor = await prisma.providerProfile.findUnique({
      where: { id: proveedorId },
      include: { user: { select: { nombre: true, email: true } } },
    });
    if (!proveedor) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const horas          = duracionHoras || 2;
    const precioTotal    = proveedor.tarifaPorHora * horas;
    const comisionDutyJoy = precioTotal * parseFloat(process.env.COMMISSION_RATE || 0.15);

    const booking = await prisma.booking.create({
      data: {
        clienteId: req.user.id,
        proveedorId,
        tipoServicio,
        descripcion,
        fechaServicio: new Date(fechaServicio),
        duracionHoras: horas,
        precioTotal,
        comisionDutyJoy,
      },
      include: {
        proveedor: { include: { user: { select: { nombre: true, email: true } } } },
        cliente:   { select: { nombre: true, email: true } },
      },
    });

    // ── Email al proveedor ────────────────────────────────────────────
    email.reservaCreada({
      proveedorEmail: booking.proveedor.user.email,
      proveedorNombre: booking.proveedor.user.nombre,
      clienteNombre:   booking.cliente.nombre,
      tipoServicio,
      fecha:           formatFecha(fechaServicio),
      duracion:        horas,
      precioTotal,
      bookingId:       booking.id,
    });

    res.status(201).json({ mensaje: 'Reserva creada exitosamente', booking });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear la reserva' });
  }
});

// GET /bookings/me — ver mis reservas (cliente o proveedor)
router.get('/me', verifyToken, async (req, res) => {
  try {
    let bookings;

    if (req.user.rol === 'CLIENTE') {
      bookings = await prisma.booking.findMany({
        where: { clienteId: req.user.id },
        include: {
          proveedor: { include: { user: { select: { nombre: true, ciudad: true } } } },
          review: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } else if (req.user.rol === 'PROVEEDOR') {
      const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id } });
      if (!profile) return res.status(404).json({ error: 'Perfil de proveedor no encontrado' });

      bookings = await prisma.booking.findMany({
        where: { proveedorId: profile.id },
        include: {
          cliente: { select: { nombre: true, email: true, telefono: true, ciudad: true } },
          review: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener reservas' });
  }
});

// GET /bookings/:id — detalle de una reserva
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        cliente:  { select: { nombre: true, email: true, telefono: true } },
        proveedor: { include: { user: { select: { nombre: true, ciudad: true } } } },
        review: true,
      },
    });

    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });

    const profile    = req.user.rol === 'PROVEEDOR'
      ? await prisma.providerProfile.findUnique({ where: { userId: req.user.id } })
      : null;
    const esCliente  = booking.clienteId === req.user.id;
    const esProveedor = profile && booking.proveedorId === profile.id;
    const esAdmin    = req.user.rol === 'ADMIN';

    if (!esCliente && !esProveedor && !esAdmin) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener la reserva' });
  }
});

// PATCH /bookings/:id/status — cambiar estado de una reserva
router.patch('/:id/status', verifyToken, async (req, res) => {
  try {
    const { estado } = req.body;
    const estadosValidos = ['PENDIENTE', 'CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO', 'CANCELADO'];

    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido. Válidos: ${estadosValidos.join(', ')}` });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        cliente:  { select: { nombre: true, email: true } },
        proveedor: { include: { user: { select: { nombre: true, email: true } } } },
      },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });

    const profile     = req.user.rol === 'PROVEEDOR'
      ? await prisma.providerProfile.findUnique({ where: { userId: req.user.id } })
      : null;
    const esCliente   = booking.clienteId === req.user.id;
    const esProveedor = profile && booking.proveedorId === profile.id;
    const esAdmin     = req.user.rol === 'ADMIN';

    if (!esCliente && !esProveedor && !esAdmin) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (esCliente && !['CANCELADO'].includes(estado)) {
      return res.status(403).json({ error: 'El cliente solo puede cancelar reservas' });
    }
    if (esProveedor && !['CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO', 'CANCELADO'].includes(estado)) {
      return res.status(403).json({ error: 'Transición de estado no permitida' });
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { estado },
    });

    // ── Emails según nuevo estado ─────────────────────────────────────
    const fecha = formatFecha(booking.fechaServicio);

    if (estado === 'CONFIRMADO') {
      email.reservaConfirmada({
        clienteEmail:    booking.cliente.email,
        clienteNombre:   booking.cliente.nombre,
        proveedorNombre: booking.proveedor.user.nombre,
        tipoServicio:    booking.tipoServicio,
        fecha,
        precioTotal:     booking.precioTotal,
      });
    }

    if (estado === 'COMPLETADO') {
      email.servicioCompletado({
        proveedorEmail:  booking.proveedor.user.email,
        proveedorNombre: booking.proveedor.user.nombre,
        clienteNombre:   booking.cliente.nombre,
        tipoServicio:    booking.tipoServicio,
        precioTotal:     booking.precioTotal,
        comision:        booking.comisionDutyJoy,
      });
    }

    res.json({ mensaje: 'Estado actualizado', booking: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

module.exports = router;
