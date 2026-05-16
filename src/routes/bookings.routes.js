const router     = require('express').Router();
const express    = require('express');
const verifyToken = require('../middleware/verifyToken');
const prisma     = require('../lib/prisma');
const email      = require('../lib/email');
const OpenAI     = require('openai');
const { notifyBookingNew, notifyBookingStatusChange } = require('../lib/notifications');
const { sendPush } = require('../lib/push');

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

    const { proveedorId, tipoServicio, descripcion, fechaServicio, duracionHoras, recurrencia } = req.body;

    const RECURRENCIAS_VALIDAS = ['UNICA', 'SEMANAL', 'QUINCENAL', 'MENSUAL'];
    const recurrenciaFinal = recurrencia && RECURRENCIAS_VALIDAS.includes(recurrencia) ? recurrencia : 'UNICA';

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

    // ── Anti-double-booking: detectar solapamiento con reservas activas ──
    const newStart = fechaDate;
    const newEnd   = new Date(fechaDate.getTime() + horas * 60 * 60 * 1000);
    const ventana  = 12 * 60 * 60 * 1000; // ventana de búsqueda ±12h
    const candidatas = await prisma.booking.findMany({
      where: {
        proveedorId,
        estado: { in: ['PENDIENTE', 'CONFIRMADO', 'EN_PROGRESO'] },
        fechaServicio: {
          gte: new Date(newStart.getTime() - ventana),
          lte: new Date(newEnd.getTime()   + ventana),
        },
      },
      select: { fechaServicio: true, duracionHoras: true },
    });
    const conflict = candidatas.some(b => {
      const bStart = new Date(b.fechaServicio);
      const bEnd   = new Date(bStart.getTime() + b.duracionHoras * 60 * 60 * 1000);
      return newStart < bEnd && newEnd > bStart;
    });
    if (conflict) {
      return res.status(409).json({
        error: 'El proveedor ya tiene una reserva en ese horario. Por favor elige otra fecha u hora.',
      });
    }

    const precioTotal    = proveedor.tarifaPorHora * horas;
    const comisionDutyJoy = precioTotal * parseFloat(process.env.COMMISSION_RATE || 0.15);

    // ── Instant booking: si el proveedor lo activa, la reserva va directo a CONFIRMADO ──
    const estadoInicial = proveedor.instantBooking ? 'CONFIRMADO' : 'PENDIENTE';

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
        estado: estadoInicial,
        recurrencia: recurrenciaFinal,
      },
      include: {
        proveedor: { include: { user: { select: { nombre: true, email: true } } } },
        cliente:   { select: { nombre: true, email: true } },
      },
    });

    // ── Emails ─────────────────────────────────────────────────────────
    const fechaFmt = formatFecha(fechaServicio);
    const emailBase = { tipoServicio, fecha: fechaFmt, duracion: horas, precioTotal, bookingId: booking.id };

    if (estadoInicial === 'CONFIRMADO') {
      // Instant booking: cliente recibe confirmación directa, proveedor recibe aviso de nueva reserva confirmada
      email.reservaConfirmada({
        clienteEmail:    booking.cliente.email,
        clienteNombre:   booking.cliente.nombre,
        proveedorNombre: booking.proveedor.user.nombre,
        ...emailBase,
      }).catch(() => {});
      email.reservaCreada({
        proveedorEmail:  booking.proveedor.user.email,
        proveedorNombre: booking.proveedor.user.nombre,
        clienteNombre:   booking.cliente.nombre,
        ...emailBase,
      }).catch(() => {});
    } else {
      email.reservaCreada({
        proveedorEmail:  booking.proveedor.user.email,
        proveedorNombre: booking.proveedor.user.nombre,
        clienteNombre:   booking.cliente.nombre,
        ...emailBase,
      }).catch(() => {});
      email.reservaCreadaCliente({
        clienteEmail:    booking.cliente.email,
        clienteNombre:   booking.cliente.nombre,
        proveedorNombre: booking.proveedor.user.nombre,
        ...emailBase,
      }).catch(() => {});
    }

    // ── Notificación al proveedor ───────────────────────────────────────
    notifyBookingNew({
      booking: { ...booking, proveedorId: booking.proveedor.id },
      clienteNombre: booking.cliente.nombre,
    }).catch(() => {});

    res.status(201).json({
      mensaje: estadoInicial === 'CONFIRMADO'
        ? '¡Reserva confirmada al instante! Procede con el pago para asegurarla.'
        : 'Reserva creada exitosamente',
      booking,
      instantBooking: estadoInicial === 'CONFIRMADO',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear la reserva' });
  }
});

// GET /bookings/me — ver mis reservas (cliente o proveedor)
// Query params: recurrencia (SEMANAL|QUINCENAL|MENSUAL|UNICA, comma-separated), estado, limit
router.get('/me', verifyToken, async (req, res) => {
  try {
    const { recurrencia, estado, limit } = req.query;
    const take = limit ? Math.min(parseInt(limit) || 50, 200) : undefined;

    // Build optional filters
    const recurrenciaFilter = recurrencia
      ? { recurrencia: { in: recurrencia.split(',').map(r => r.trim().toUpperCase()) } }
      : {};
    const estadoFilter = estado
      ? { estado: estado.toUpperCase() }
      : {};

    let bookings;

    if (req.user.rol === 'CLIENTE') {
      bookings = await prisma.booking.findMany({
        where: { clienteId: req.user.id, ...recurrenciaFilter, ...estadoFilter },
        include: {
          proveedor: { include: { user: { select: { nombre: true, ciudad: true, telefono: true } } } },
          review: true,
        },
        orderBy: { createdAt: 'desc' },
        ...(take && { take }),
      });
    } else if (req.user.rol === 'PROVEEDOR') {
      const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id } });
      if (!profile) return res.status(404).json({ error: 'Perfil de proveedor no encontrado' });

      bookings = await prisma.booking.findMany({
        where: { proveedorId: profile.id, ...recurrenciaFilter, ...estadoFilter },
        include: {
          cliente: { select: { nombre: true, email: true, telefono: true, ciudad: true } },
          review: true,
        },
        orderBy: { createdAt: 'desc' },
        ...(take && { take }),
      });
    } else {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    // Return as { bookings, total } when query params present, plain array otherwise (backwards compat)
    if (recurrencia || estado || limit) {
      return res.json({ bookings, total: bookings.length });
    }
    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener reservas' });
  }
});

// GET /bookings/stats — estadísticas de reservas del usuario autenticado
router.get('/stats', verifyToken, async (req, res) => {
  try {
    let whereBase;

    if (req.user.rol === 'PROVEEDOR') {
      const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id } });
      if (!profile) return res.status(404).json({ error: 'Perfil de proveedor no encontrado' });
      whereBase = { proveedorId: profile.id };
    } else if (req.user.rol === 'CLIENTE') {
      whereBase = { clienteId: req.user.id };
    } else {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const now             = new Date();
    const startOfMonth    = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth  = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [allCompleted, thisMonth, lastMonth, pendingCount] = await Promise.all([
      prisma.booking.aggregate({
        where: { ...whereBase, estado: 'COMPLETADO' },
        _sum: { precioTotal: true, comisionDutyJoy: true },
        _count: true,
      }),
      prisma.booking.aggregate({
        where: { ...whereBase, estado: 'COMPLETADO', updatedAt: { gte: startOfMonth } },
        _sum: { precioTotal: true },
        _count: true,
      }),
      prisma.booking.aggregate({
        where: { ...whereBase, estado: 'COMPLETADO', updatedAt: { gte: startOfLastMonth, lte: endOfLastMonth } },
        _sum: { precioTotal: true },
        _count: true,
      }),
      prisma.booking.count({
        where: { ...whereBase, estado: { in: ['PENDIENTE', 'CONFIRMADO'] } },
      }),
    ]);

    const totalBruto   = allCompleted._sum.precioTotal    || 0;
    const totalComision = allCompleted._sum.comisionDutyJoy || 0;
    const mesBruto     = thisMonth._sum.precioTotal       || 0;
    const mesPasado    = lastMonth._sum.precioTotal        || 0;
    const tendencia    = mesPasado > 0 ? Math.round((mesBruto - mesPasado) / mesPasado * 100) : null;

    res.json({
      totalCompletados:  allCompleted._count,
      totalBruto,
      totalComision,
      totalNeto:         req.user.rol === 'PROVEEDOR' ? (totalBruto - totalComision) : totalBruto,
      mesActualBruto:    mesBruto,
      mesActualCount:    thisMonth._count,
      mesPasadoBruto:    mesPasado,
      tendencia,                      // % vs mes anterior, null si no hay datos
      reservasPendientes: pendingCount,
    });
  } catch (error) {
    console.error('[bookings/stats]', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
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
    const { estado, motivoCancelacion } = req.body;
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
    if (esProveedor && !['CONFIRMADO', 'COMPLETADO', 'CANCELADO'].includes(estado)) {
      return res.status(403).json({ error: 'Transición de estado no permitida. Para iniciar el servicio usa POST /bookings/:id/verify-code' });
    }

    const updateData = { estado };
    if (estado === 'CANCELADO' && motivoCancelacion?.trim()) {
      updateData.motivoCancelacion = motivoCancelacion.trim().slice(0, 500);
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: updateData,
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

    if (estado === 'CANCELADO') {
      if (esCliente) {
        // Notificar al proveedor
        email.reservaCancelada({
          destinatarioEmail:  booking.proveedor.user.email,
          destinatarioNombre: booking.proveedor.user.nombre,
          canceladoPor:       booking.cliente.nombre + ' (cliente)',
          tipoServicio:       booking.tipoServicio,
          fecha,
        });
      } else {
        // Proveedor o admin cancela — notificar al cliente
        email.reservaCancelada({
          destinatarioEmail:  booking.cliente.email,
          destinatarioNombre: booking.cliente.nombre,
          canceladoPor:       booking.proveedor.user.nombre + ' (proveedor)',
          tipoServicio:       booking.tipoServicio,
          fecha,
        });
      }
    }

    // ── Notificación a la otra parte ─────────────────────────────────────
    notifyBookingStatusChange({
      booking: { ...booking, clienteId: booking.clienteId, clienteNombre: booking.cliente.nombre },
      nuevoEstado: estado,
      actorRol: req.user.rol,
    }).catch(() => {});

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

    // ── Persist dispute to DB ────────────────────────────────────────────
    const disputa = await prisma.disputa.create({
      data: {
        bookingId:  booking.id,
        clienteId:  req.user.id,
        mensaje:    mensaje.trim(),
        estado:     'abierta',
      },
    });

    // Fire-and-forget emails — nunca bloquean la respuesta
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

    res.json({ ok: true, disputaId: disputa.id, mensaje: 'Reporte enviado. Te contactaremos en las próximas 24 horas hábiles.' });
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

/* ── POST /bookings/:id/photos — proveedor sube fotos antes/después ─── */
router.post('/:id/photos',
  verifyToken,
  express.json({ limit: '10mb' }), // override for photos
  async (req, res) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: { proveedor: { select: { userId: true } }, cliente: { select: { nombre: true, email: true } } },
      });
      if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
      if (booking.proveedor.userId !== req.user.id) {
        return res.status(403).json({ error: 'Solo el proveedor puede subir fotos' });
      }
      if (!['EN_PROGRESO', 'COMPLETADO'].includes(booking.estado)) {
        return res.status(400).json({ error: 'Solo se pueden subir fotos en reservas en progreso o completadas' });
      }

      const { fotos } = req.body;
      if (!Array.isArray(fotos) || fotos.length === 0) {
        return res.status(400).json({ error: 'Se requiere al menos una foto' });
      }
      if (fotos.length > 8) return res.status(400).json({ error: 'Máximo 8 fotos por reserva' });

      // Validate each is a base64 image under 1.5MB
      for (const f of fotos) {
        if (typeof f !== 'string' || !f.startsWith('data:image/')) {
          return res.status(400).json({ error: 'Formato de imagen inválido' });
        }
        if (f.length > 2_000_000) return res.status(400).json({ error: 'Cada imagen no puede superar 1.5MB' });
      }

      const updated = await prisma.booking.update({
        where: { id: req.params.id },
        data: { fotos },
      });

      // Notify client via push + email
      sendPush(booking.clienteId, {
        title: '📸 Reporte fotográfico disponible',
        body: `Tu proveedor subió ${fotos.length} foto(s) del servicio.`,
        url: `/booking-chat/${booking.id}`,
        tag: 'fotos',
      }).catch(() => {});

      res.json({ ok: true, fotosCount: fotos.length });
    } catch (e) {
      console.error('[bookings photos]', e);
      res.status(500).json({ error: 'Error al guardar fotos' });
    }
  }
);

// GET /bookings/:id/provider-location — cliente ve ubicación en tiempo real del proveedor
router.get('/:id/provider-location', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'CLIENTE') {
      return res.status(403).json({ error: 'Solo el cliente puede ver la ubicación del proveedor' });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        proveedor: {
          select: {
            id: true,
            location: true,
            user: { select: { nombre: true } },
          },
        },
      },
    });

    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.clienteId !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    if (!['CONFIRMADO', 'EN_PROGRESO'].includes(booking.estado)) {
      return res.status(400).json({ error: 'La ubicación solo está disponible cuando la reserva está CONFIRMADA o EN PROGRESO' });
    }

    const loc = booking.proveedor.location;
    if (!loc || !loc.activo) {
      return res.json({ disponible: false, motivo: 'El proveedor no ha compartido su ubicación' });
    }

    // Stale check: > 10 min → provider offline
    const staleMs = 10 * 60 * 1000;
    const age = Date.now() - new Date(loc.updatedAt).getTime();
    if (age > staleMs) {
      return res.json({ disponible: false, motivo: 'Ubicación desactualizada (más de 10 minutos)' });
    }

    res.json({
      disponible: true,
      lat: loc.lat,
      lng: loc.lng,
      proveedorNombre: booking.proveedor.user.nombre,
      actualizadoHace: Math.round(age / 1000), // segundos
      updatedAt: loc.updatedAt,
    });
  } catch (e) {
    console.error('[bookings/provider-location]', e);
    res.status(500).json({ error: 'Error al obtener ubicación' });
  }
});

// POST /bookings/:id/generate-code — cliente genera código de inicio
router.post('/:id/generate-code', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'CLIENTE') {
      return res.status(403).json({ error: 'Solo el cliente puede generar el código de inicio' });
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.clienteId !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
    if (booking.estado !== 'CONFIRMADO') {
      return res.status(400).json({ error: 'El código solo se puede generar cuando la reserva está CONFIRMADA' });
    }
    if (booking.startCodeUsedAt) {
      return res.status(400).json({ error: 'El servicio ya fue iniciado con un código anterior' });
    }

    const code   = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
    const expiry = new Date(Date.now() + 30 * 60 * 1000);               // 30 min

    await prisma.booking.update({
      where: { id: req.params.id },
      data: { startCode: code, startCodeExpiry: expiry, startCodeAttempts: 0 },
    });

    res.json({ startCode: code, expiraEn: expiry });
  } catch (e) {
    console.error('[generate-code]', e);
    res.status(500).json({ error: 'Error al generar el código' });
  }
});

// POST /bookings/:id/verify-code — proveedor ingresa código → EN_PROGRESO
router.post('/:id/verify-code', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo el proveedor puede verificar el código' });
    }

    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'El código es requerido' });

    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.status(404).json({ error: 'Perfil de proveedor no encontrado' });

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        cliente:   { select: { id: true, nombre: true, email: true } },
        proveedor: { include: { user: { select: { nombre: true, email: true } } } },
      },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.proveedorId !== profile.id) return res.status(403).json({ error: 'No autorizado' });
    if (booking.estado !== 'CONFIRMADO') {
      return res.status(400).json({ error: 'La reserva no está en estado CONFIRMADO' });
    }
    if (booking.startCodeUsedAt) {
      return res.status(400).json({ error: 'El servicio ya fue iniciado' });
    }
    if (!booking.startCode) {
      return res.status(400).json({ error: 'El cliente aún no ha generado el código de inicio' });
    }

    // Max intentos
    const MAX_ATTEMPTS = 3;
    if (booking.startCodeAttempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. El cliente debe generar un nuevo código.' });
    }

    // Expirado
    if (booking.startCodeExpiry && new Date() > booking.startCodeExpiry) {
      return res.status(400).json({ error: 'El código ha expirado. El cliente debe generar uno nuevo.' });
    }

    // Código incorrecto
    if (booking.startCode !== String(code)) {
      const attempts = booking.startCodeAttempts + 1;
      await prisma.booking.update({
        where: { id: req.params.id },
        data: { startCodeAttempts: attempts },
      });
      const restantes = MAX_ATTEMPTS - attempts;
      if (restantes <= 0) {
        // Notify client via push
        sendPush(booking.cliente.id, {
          title: '⚠️ Código de inicio bloqueado',
          body: 'Hubo demasiados intentos fallidos. Genera un nuevo código.',
          url: `/my-bookings`,
          tag: 'start-code-blocked',
        }).catch(() => {});
        return res.status(429).json({ error: 'Demasiados intentos fallidos. El cliente debe generar un nuevo código.' });
      }
      return res.status(400).json({ error: 'Código incorrecto', intentosRestantes: restantes });
    }

    // ✅ Código correcto → EN_PROGRESO
    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { estado: 'EN_PROGRESO', startCodeUsedAt: new Date() },
    });

    notifyBookingStatusChange({
      booking: { ...booking, clienteId: booking.clienteId, clienteNombre: booking.cliente.nombre },
      nuevoEstado: 'EN_PROGRESO',
      actorRol: 'PROVEEDOR',
    }).catch(() => {});

    sendPush(booking.cliente.id, {
      title: '🔧 Servicio iniciado',
      body: `${booking.proveedor.user.nombre} comenzó el servicio.`,
      url: `/booking-chat/${booking.id}`,
      tag: 'service-started',
    }).catch(() => {});

    res.json({ mensaje: 'Servicio iniciado exitosamente', booking: updated });
  } catch (e) {
    console.error('[verify-code]', e);
    res.status(500).json({ error: 'Error al verificar el código' });
  }
});

module.exports = router;
