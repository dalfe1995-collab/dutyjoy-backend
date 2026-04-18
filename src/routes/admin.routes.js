const router = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma = require('../lib/prisma');
const email = require('../lib/email');

// Middleware: solo ADMIN
const soloAdmin = (req, res, next) => {
  if (req.user.rol !== 'ADMIN') {
    return res.status(403).json({ error: 'Acceso restringido a administradores' });
  }
  next();
};

// GET /admin/stats — resumen general para dashboard CRM
router.get('/stats', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [
      totalUsuarios,
      totalClientes,
      totalProveedores,
      totalBookings,
      bookingsPendientes,
      bookingsCompletados,
      bookingsCancelados,
      proveedoresVerificados,
      proveedoresPendientes,
      cedulasPendientes,
      ingresosTotales,
      comisionesDutyjoy,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { rol: 'CLIENTE' } }),
      prisma.user.count({ where: { rol: 'PROVEEDOR' } }),
      prisma.booking.count(),
      prisma.booking.count({ where: { estado: 'PENDIENTE' } }),
      prisma.booking.count({ where: { estado: 'COMPLETADO' } }),
      prisma.booking.count({ where: { estado: 'CANCELADO' } }),
      prisma.providerProfile.count({ where: { verificado: true } }),
      prisma.providerProfile.count({ where: { verificado: false } }),
      prisma.providerProfile.count({ where: { cedulaStatus: 'pendiente' } }),
      prisma.booking.aggregate({ _sum: { precioTotal: true }, where: { estado: 'COMPLETADO' } }),
      prisma.booking.aggregate({ _sum: { comisionDutyJoy: true }, where: { estado: 'COMPLETADO' } }),
    ]);

    res.json({
      usuarios: { total: totalUsuarios, clientes: totalClientes, proveedores: totalProveedores },
      bookings: {
        total: totalBookings,
        pendientes: bookingsPendientes,
        completados: bookingsCompletados,
        cancelados: bookingsCancelados,
      },
      proveedores: { verificados: proveedoresVerificados, pendientes: proveedoresPendientes, cedulasPendientes },
      finanzas: {
        ingresosTotales: ingresosTotales._sum.precioTotal || 0,
        comisionesDutyjoy: comisionesDutyjoy._sum.comisionDutyJoy || 0,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// GET /admin/users — listar todos los usuarios con filtros
router.get('/users', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { rol, search, page = 1, limit = 20 } = req.query;

    const where = {
      ...(rol && { rol }),
      ...(search && {
        OR: [
          { nombre: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, nombre: true, email: true, telefono: true,
          ciudad: true, rol: true, activo: true, emailVerificado: true, createdAt: true,
          providerProfile: {
            select: { calificacion: true, totalReviews: true, verificado: true, servicios: true }
          },
          _count: { select: { bookingsComoCliente: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// GET /admin/users/:id — detalle completo de un usuario
router.get('/users/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        providerProfile: { include: { reviews: { take: 5, orderBy: { createdAt: 'desc' } } } },
        bookingsComoCliente: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { proveedor: { include: { user: { select: { nombre: true } } } } },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { password, ...userSinPassword } = user;
    res.json(userSinPassword);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// PATCH /admin/users/:id — editar usuario (activar/desactivar, cambiar rol)
router.patch('/users/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { activo, rol } = req.body;
    const data = {};
    if (activo !== undefined) data.activo = activo;
    if (rol && ['CLIENTE', 'PROVEEDOR', 'ADMIN'].includes(rol)) data.rol = rol;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, nombre: true, email: true, rol: true, activo: true },
    });

    res.json({ mensaje: 'Usuario actualizado', user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// GET /admin/providers — listar proveedores con stats
router.get('/providers', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { verificado, search, page = 1, limit = 20 } = req.query;

    const where = {
      ...(verificado !== undefined && { verificado: verificado === 'true' }),
      ...(search && {
        user: {
          OR: [
            { nombre: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
      }),
    };

    const [providers, total] = await Promise.all([
      prisma.providerProfile.findMany({
        where,
        include: {
          user: { select: { nombre: true, email: true, telefono: true, ciudad: true, createdAt: true } },
          _count: { select: { bookings: true, reviews: true } },
        },
        // cedulaUrl, cedulaStatus, cedulaNota incluidos automáticamente (campos del modelo)
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.providerProfile.count({ where }),
    ]);

    res.json({ providers, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener proveedores' });
  }
});

// PATCH /admin/providers/:id/verify — verificar/desverificar + aprobar/rechazar cédula
router.patch('/providers/:id/verify', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { verificado, cedulaStatus, cedulaNota } = req.body;

    const data = {};
    if (verificado !== undefined) data.verificado = Boolean(verificado);
    if (cedulaStatus && ['pendiente','aprobado','rechazado','sin_enviar'].includes(cedulaStatus)) {
      data.cedulaStatus = cedulaStatus;
      if (cedulaStatus === 'aprobado')  data.verificado = true;
      if (cedulaStatus === 'rechazado') data.cedulaNota = cedulaNota || null;
    }

    const profile = await prisma.providerProfile.update({
      where:   { id: req.params.id },
      data,
      include: { user: { select: { nombre: true, email: true } } },
    });

    // Emails de notificación (fire-and-forget)
    if (cedulaStatus === 'aprobado') {
      email.cedulaAprobada({
        proveedorEmail:  profile.user.email,
        proveedorNombre: profile.user.nombre,
      }).catch(() => {});
    }
    if (cedulaStatus === 'rechazado') {
      email.cedulaRechazada({
        proveedorEmail:  profile.user.email,
        proveedorNombre: profile.user.nombre,
        nota:            cedulaNota,
      }).catch(() => {});
    }

    res.json({
      mensaje: cedulaStatus
        ? `Cédula marcada como ${cedulaStatus}`
        : `Proveedor ${verificado ? 'verificado' : 'desverificado'} exitosamente`,
      profile,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar verificación' });
  }
});

// GET /admin/bookings — listar todas las reservas
router.get('/bookings', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { estado, search, page = 1, limit = 20 } = req.query;

    const where = {
      ...(estado && { estado }),
      ...(search && {
        OR: [
          { cliente: { nombre: { contains: search, mode: 'insensitive' } } },
          { cliente: { email:  { contains: search, mode: 'insensitive' } } },
          { proveedor: { user: { nombre: { contains: search, mode: 'insensitive' } } } },
          { tipoServicio: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: {
          cliente: { select: { nombre: true, email: true } },
          proveedor: { include: { user: { select: { nombre: true } } } },
          review: { select: { calificacion: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.booking.count({ where }),
    ]);

    res.json({ bookings, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener reservas' });
  }
});

// PATCH /admin/bookings/:id — admin puede cambiar cualquier estado
router.patch('/bookings/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { estado } = req.body;
    const estadosValidos = ['PENDIENTE', 'CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO', 'CANCELADO'];

    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const booking = await prisma.booking.update({
      where: { id: req.params.id },
      data: { estado },
    });

    res.json({ mensaje: 'Reserva actualizada', booking });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar reserva' });
  }
});

module.exports = router;
