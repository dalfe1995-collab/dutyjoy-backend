const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');
const email       = require('../lib/email');

// POST /reviews — cliente deja reseña después de servicio completado
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'CLIENTE') {
      return res.status(403).json({ error: 'Solo los clientes pueden dejar reseñas' });
    }

    const { bookingId, calificacion, comentario } = req.body;

    if (!bookingId || !calificacion) {
      return res.status(400).json({ error: 'bookingId y calificacion son requeridos' });
    }
    if (calificacion < 1 || calificacion > 5) {
      return res.status(400).json({ error: 'La calificación debe ser entre 1 y 5' });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        review: true,
        proveedor: { include: { user: { select: { nombre: true, email: true } } } },
      },
    });

    if (!booking)                            return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.clienteId !== req.user.id)   return res.status(403).json({ error: 'No autorizado' });
    if (booking.estado !== 'COMPLETADO')     return res.status(400).json({ error: 'Solo puedes reseñar servicios completados' });
    if (booking.review)                      return res.status(400).json({ error: 'Ya dejaste una reseña para esta reserva' });

    const review = await prisma.review.create({
      data: {
        bookingId,
        clienteId:   req.user.id,
        proveedorId: booking.proveedorId,
        calificacion: parseInt(calificacion),
        comentario,
      },
    });

    // Recalcular calificación promedio del proveedor
    const todasReviews = await prisma.review.findMany({
      where: { proveedorId: booking.proveedorId },
      select: { calificacion: true },
    });
    const promedio = todasReviews.reduce((acc, r) => acc + r.calificacion, 0) / todasReviews.length;

    await prisma.providerProfile.update({
      where: { id: booking.proveedorId },
      data: {
        calificacion:  Math.round(promedio * 10) / 10,
        totalReviews:  todasReviews.length,
      },
    });

    // ── Email al proveedor ─────────────────────────────────────────────
    const cliente = await prisma.user.findUnique({ where: { id: req.user.id }, select: { nombre: true } });
    email.nuevaResena({
      proveedorEmail:  booking.proveedor.user.email,
      proveedorNombre: booking.proveedor.user.nombre,
      clienteNombre:   cliente.nombre,
      calificacion:    parseInt(calificacion),
      comentario,
    });

    res.status(201).json({ mensaje: 'Reseña publicada', review });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear reseña' });
  }
});

// GET /reviews/provider/:id — reseñas públicas de un proveedor
router.get('/provider/:id', async (req, res) => {
  try {
    const reviews = await prisma.review.findMany({
      where: { proveedorId: req.params.id },
      include: { cliente: { select: { nombre: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(reviews);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener reseñas' });
  }
});

module.exports = router;
