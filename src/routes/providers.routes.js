const router = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma = require('../lib/prisma');
const email = require('../lib/email');
const { SERVICIOS_IDS } = require('./services.routes');
const { updateProviderEmbedding, semanticSearch } = require('../lib/embeddings');

// GET /providers — listar proveedores con filtros + búsqueda semántica opcional (?q=)
router.get('/', async (req, res) => {
  try {
    const { ciudad, servicio, minCalificacion, minTarifa, maxTarifa, search, orden = 'calificacion_desc', page = 1, limit = 12, q } = req.query;

    const tarifaWhere = {};
    if (minTarifa) tarifaWhere.gte = parseFloat(minTarifa);
    if (maxTarifa) tarifaWhere.lte = parseFloat(maxTarifa);

    const where = {
      disponible: true,
      ...(ciudad && { ciudades: { has: ciudad } }),
      ...(servicio && { servicios: { has: servicio } }),
      ...(minCalificacion && { calificacion: { gte: parseFloat(minCalificacion) } }),
      ...(Object.keys(tarifaWhere).length > 0 && { tarifaPorHora: tarifaWhere }),
      ...(search && { user: { nombre: { contains: search, mode: 'insensitive' } } }),
    };

    // Búsqueda semántica con ?q=
    if (q && q.trim().length > 2) {
      const matches = await semanticSearch(q.trim(), 50);
      if (matches.length > 0) {
        const ids = matches.map(m => m.id);
        where.id = { in: ids };
        const providers = await prisma.providerProfile.findMany({
          where,
          include: { user: { select: { nombre: true, ciudad: true } } },
        });
        // Re-ordenar por similitud semántica
        const simMap = Object.fromEntries(matches.map(m => [m.id, m.similarity]));
        providers.sort((a, b) => (simMap[b.id] || 0) - (simMap[a.id] || 0));
        const pageN = parseInt(page), limitN = parseInt(limit);
        const paginated = providers.slice((pageN - 1) * limitN, pageN * limitN);
        return res.json({ providers: paginated, total: providers.length, page: pageN, totalPages: Math.ceil(providers.length / limitN), semantic: true });
      }
    }

    const ordenMap = {
      calificacion_desc: { calificacion: 'desc' },
      calificacion_asc:  { calificacion: 'asc' },
      tarifa_asc:        { tarifaPorHora: 'asc' },
      tarifa_desc:       { tarifaPorHora: 'desc' },
      recientes:         { createdAt: 'desc' },
    };
    const orderBy = ordenMap[orden] || { calificacion: 'desc' };

    const [providers, total] = await Promise.all([
      prisma.providerProfile.findMany({
        where,
        include: { user: { select: { nombre: true, ciudad: true } } },
        orderBy,
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.providerProfile.count({ where }),
    ]);

    res.json({ providers, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al buscar proveedores' });
  }
});

// GET /providers/me — perfil completo del proveedor autenticado
router.get('/me', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden acceder a este recurso' });
    }
    const profile = await prisma.providerProfile.findUnique({
      where: { userId: req.user.id },
      include: {
        _count: { select: { bookings: true, reviews: true } },
      },
    });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });
    res.json(profile);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// POST /providers/me/cedula — enviar URL de documento de identidad
router.post('/me/cedula', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden enviar documentos' });
    }

    const { cedulaUrl } = req.body;
    if (!cedulaUrl?.trim()) {
      return res.status(400).json({ error: 'La URL del documento es requerida' });
    }

    // Validar que sea una URL básica
    try { new URL(cedulaUrl); } catch {
      return res.status(400).json({ error: 'URL inválida. Sube tu documento a Google Drive y comparte el enlace.' });
    }

    const profile = await prisma.providerProfile.update({
      where:  { userId: req.user.id },
      data:   { cedulaUrl: cedulaUrl.trim(), cedulaStatus: 'pendiente', cedulaNota: null },
      include: { user: { select: { nombre: true, email: true } } },
    });

    // Fire-and-forget — confirmar recepción al proveedor
    email.cedulaRecibida({
      proveedorEmail: profile.user.email,
      proveedorNombre: profile.user.nombre,
    }).catch(() => {});

    res.json({ mensaje: 'Documento enviado. Lo revisaremos en 48 horas hábiles.', cedulaStatus: 'pendiente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al enviar el documento' });
  }
});

// PUT /providers/me — proveedor actualiza su perfil
router.put('/me', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden actualizar este perfil' });
    }

    const { bio, servicios, tarifaPorHora, ciudades, disponible } = req.body;

    // Validar servicios contra catálogo
    if (servicios !== undefined) {
      if (!Array.isArray(servicios)) {
        return res.status(400).json({ error: 'servicios debe ser un array' });
      }
      const invalidos = servicios.filter(s => !SERVICIOS_IDS.includes(s));
      if (invalidos.length > 0) {
        return res.status(400).json({ error: `Servicios no válidos: ${invalidos.join(', ')}. Válidos: ${SERVICIOS_IDS.join(', ')}` });
      }
    }

    // Validar tarifa
    if (tarifaPorHora !== undefined) {
      const tarifa = parseFloat(tarifaPorHora);
      if (isNaN(tarifa) || tarifa < 5000 || tarifa > 5000000) {
        return res.status(400).json({ error: 'La tarifa debe estar entre $5.000 y $5.000.000 COP' });
      }
    }

    const profile = await prisma.providerProfile.update({
      where: { userId: req.user.id },
      data: {
        ...(bio !== undefined && { bio }),
        ...(servicios !== undefined && { servicios }),
        ...(tarifaPorHora !== undefined && { tarifaPorHora: parseFloat(tarifaPorHora) }),
        ...(ciudades !== undefined && { ciudades }),
        ...(disponible !== undefined && { disponible }),
      },
    });

    // Regenerar embedding en background (no bloquea respuesta)
    updateProviderEmbedding(profile.id).catch(() => {});

    res.json({ mensaje: 'Perfil actualizado', profile });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// GET /providers/:id — perfil público de un proveedor
router.get('/:id', async (req, res) => {
  try {
    const provider = await prisma.providerProfile.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { nombre: true, ciudad: true, createdAt: true } },
        reviews: {
          include: { cliente: { select: { nombre: true } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!provider) return res.status(404).json({ error: 'Proveedor no encontrado' });

    res.json(provider);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener proveedor' });
  }
});

module.exports = router;
