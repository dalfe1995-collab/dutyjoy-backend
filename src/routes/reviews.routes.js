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
    const cal = parseInt(calificacion);
    if (isNaN(cal) || cal < 1 || cal > 5) {
      return res.status(400).json({ error: 'La calificación debe ser entre 1 y 5' });
    }
    if (comentario && comentario.trim().length > 1000) {
      return res.status(400).json({ error: 'El comentario no puede superar 1000 caracteres' });
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
        calificacion: cal,
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
      calificacion:    cal,
      comentario,
    }).catch(() => {});

    res.status(201).json({ mensaje: 'Reseña publicada', review });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear reseña' });
  }
});

// PATCH /reviews/:id/respond — proveedor responde a una reseña (pública)
router.patch('/:id/respond', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden responder reseñas' });
    }
    const { respuesta } = req.body;
    if (!respuesta || typeof respuesta !== 'string' || respuesta.trim().length === 0) {
      return res.status(400).json({ error: 'La respuesta no puede estar vacía' });
    }
    if (respuesta.trim().length > 800) {
      return res.status(400).json({ error: 'La respuesta no puede superar 800 caracteres' });
    }

    // Verificar que la reseña pertenece a este proveedor
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

    const review = await prisma.review.findUnique({ where: { id: req.params.id } });
    if (!review) return res.status(404).json({ error: 'Reseña no encontrada' });
    if (review.proveedorId !== profile.id) return res.status(403).json({ error: 'No autorizado' });
    if (review.respuestaProveedor) return res.status(400).json({ error: 'Ya respondiste esta reseña' });

    const updated = await prisma.review.update({
      where: { id: req.params.id },
      data:  { respuestaProveedor: respuesta.trim() },
    });

    res.json({ mensaje: 'Respuesta publicada', review: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al guardar respuesta' });
  }
});

// GET /reviews/provider/:id — reseñas públicas de un proveedor (?sort=recent|best|worst, ?rating=1-5)
router.get('/provider/:id', async (req, res) => {
  try {
    const { sort = 'recent', rating } = req.query;
    const orderBy = sort === 'best'  ? { calificacion: 'desc' }
                  : sort === 'worst' ? { calificacion: 'asc' }
                  : { createdAt: 'desc' };
    const ratingFilter = rating ? { calificacion: parseInt(rating, 10) } : {};
    const reviews = await prisma.review.findMany({
      where: { proveedorId: req.params.id, fraudOculta: false, ...ratingFilter },
      include: {
        cliente: { select: { nombre: true } },
        booking: { select: { tipoServicio: true } },
      },
      orderBy,
    });
    res.json(reviews);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener reseñas' });
  }
});

// POST /reviews/:id/suggest-response — AI suggests a polite public reply for the provider
router.post('/:id/suggest-response', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden solicitar sugerencias' });
    }
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

    const review = await prisma.review.findUnique({
      where: { id: req.params.id },
      include: { cliente: { select: { nombre: true } } },
    });
    if (!review) return res.status(404).json({ error: 'Reseña no encontrada' });
    if (review.proveedorId !== profile.id) return res.status(403).json({ error: 'No autorizado' });

    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Eres un proveedor de servicios del hogar en Colombia respondiendo públicamente a una reseña.

Reseña recibida:
- Calificación: ${review.calificacion}/5
- Cliente: ${review.cliente?.nombre || 'Cliente'}
- Comentario: "${review.comentario || '(sin comentario)'}"

Escribe una respuesta pública breve (máx 180 palabras) que sea:
- Agradecida y profesional
- En español colombiano natural y cálido
- Específica al comentario (nunca genérica)
- Si calificación ≤ 3: empática, constructiva, ofrece solución
- Si calificación ≥ 4: agradece, refuerza confianza, invita a volver

Devuelve SOLO el texto de la respuesta.`,
      }],
      max_tokens: 280,
      temperature: 0.75,
    });

    res.json({ sugerencia: completion.choices[0].message.content.trim() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error generando sugerencia' });
  }
});

module.exports = router;
