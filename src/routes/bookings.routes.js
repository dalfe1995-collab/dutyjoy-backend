const router     = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma     = require('../lib/prisma');
const email      = require('../lib/email');
const OpenAI     = require('openai');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

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

    // Validar que la fecha sea futura (mínimo 1 hora desde ahora)
    const fechaDate = new Date(fechaServicio);
    if (isNaN(fechaDate.getTime())) {
      return res.status(400).json({ error: 'Fecha de servicio inválida' });
    }
    if (fechaDate <= new Date(Date.now() + 60 * 60 * 1000)) {
      return res.status(400).json({ error: 'La fecha del servicio debe ser al menos 1 hora en el futuro' });
    }

    const proveedor = await prisma.providerProfile.findUnique({
      where: { id: proveedorId },
      include: { user: { select: { nombre: true, email: true } } },
    });
    if (!proveedor) return res.status(404).json({ error: 'Proveedor no encontrado' });
    if (!proveedor.disponible) return res.status(400).json({ error: 'Este proveedor no está disponible actualmente' });

    // Validar que el servicio solicitado esté en el catálogo del proveedor
    if (proveedor.servicios?.length > 0 && !proveedor.servicios.includes(tipoServicio)) {
      return res.status(400).json({ error: `El proveedor no ofrece el servicio "${tipoServicio}"` });
    }

    const horas          = parseFloat(duracionHoras) || 2;
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
    // Clientes no pueden cancelar con menos de 2 horas de anticipación
    if (esCliente && estado === 'CANCELADO') {
      const twoHoursBeforeService = new Date(booking.fechaServicio).getTime() - 2 * 60 * 60 * 1000;
      if (Date.now() > twoHoursBeforeService) {
        return res.status(400).json({ error: 'No puedes cancelar con menos de 2 horas de anticipación. Contacta al proveedor.' });
      }
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

// POST /bookings/:id/report — cliente reporta un problema
router.post('/:id/report', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'CLIENTE') {
      return res.status(403).json({ error: 'Solo los clientes pueden reportar problemas' });
    }

    const { mensaje } = req.body;
    if (!mensaje?.trim()) {
      return res.status(400).json({ error: 'El mensaje es requerido' });
    }
    if (mensaje.trim().length < 10) {
      return res.status(400).json({ error: 'El mensaje debe tener al menos 10 caracteres' });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        cliente:   { select: { nombre: true, email: true } },
        proveedor: { include: { user: { select: { nombre: true } } } },
      },
    });

    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.clienteId !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Fire-and-forget — nunca bloquea la respuesta
    email.disputaAdmin({
      bookingId:       booking.id,
      clienteNombre:   booking.cliente.nombre,
      clienteEmail:    booking.cliente.email,
      proveedorNombre: booking.proveedor.user.nombre,
      tipoServicio:    booking.tipoServicio,
      fechaServicio:   booking.fechaServicio,
      mensaje:         mensaje.trim(),
    }).catch(() => {});

    email.disputaCliente({
      clienteEmail:  booking.cliente.email,
      clienteNombre: booking.cliente.nombre,
      bookingId:     booking.id,
    }).catch(() => {});

    res.json({ ok: true, mensaje: 'Reporte enviado. Te contactaremos en las próximas 24 horas hábiles.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al enviar el reporte' });
  }
});

// POST /bookings/parse — analiza texto libre y extrae campos de reserva con IA
router.post('/parse', verifyToken, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'IA no configurada' });

  const { texto, serviciosDisponibles = [] } = req.body;
  if (!texto || texto.trim().length < 5) {
    return res.status(400).json({ error: 'Describe lo que necesitas (mínimo 5 caracteres)' });
  }

  const ahora = new Date().toISOString();
  const listaServicios = serviciosDisponibles.length
    ? serviciosDisponibles.join(', ')
    : 'plomería, electricidad, limpieza, jardinería, pintura, cerrajería, mudanzas, aire acondicionado, carpintería, fumigación';

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 250,
      temperature: 0,
      messages: [{
        role: 'system',
        content: `Eres un asistente de DutyJoy (Colombia). Fecha/hora actual: ${ahora}.
Extrae campos de reserva del texto del usuario. Responde SOLO con JSON válido (sin markdown):
{
  "tipoServicio": "ID del servicio de esta lista: [${listaServicios}] — elige el más apropiado o null",
  "descripcion": "descripción limpia del problema en máx 200 chars",
  "fechaServicio": "ISO 8601 datetime o null si no menciona fecha/hora",
  "duracionHoras": número entero 1-8 estimado según la tarea, o 2 si no se puede determinar,
  "ciudad": "ciudad mencionada o null"
}`,
      }, {
        role: 'user',
        content: texto.trim().substring(0, 500),
      }],
    });

    const raw = completion.choices[0].message.content.trim()
      .replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(raw);
    res.json({ parsed });
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(422).json({ error: 'No pude entender la solicitud. Intenta ser más específico.' });
    console.error('[bookings/parse]', e.message);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

module.exports = router;
