const router = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma = require('../lib/prisma');
const { invalidateCatalogCache } = require('../lib/catalog');

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== 'ADMIN') {
    return res.status(403).json({ error: 'Acceso restringido a administradores' });
  }
  next();
};

const SLUG_REGEX = /^[a-z0-9_]+$/;

function normalizeSlug(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ── Servicios ─────────────────────────────────────────────────────────────

router.get('/services', verifyToken, soloAdmin, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const services = await prisma.serviceCatalog.findMany({
      where: includeInactive ? {} : { activo: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    });
    res.json({ services, total: services.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al listar servicios' });
  }
});

router.post('/services', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { id, nombre, icon, descripcion, color, activo = true, orden = 0 } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'nombre es requerido' });

    const slug = normalizeSlug(id || nombre);
    if (!slug || !SLUG_REGEX.test(slug)) {
      return res.status(400).json({ error: 'id inválido — use letras minúsculas, números y guión bajo' });
    }

    const existing = await prisma.serviceCatalog.findUnique({ where: { id: slug } });
    if (existing) return res.status(400).json({ error: 'Ya existe un servicio con ese id' });

    const service = await prisma.serviceCatalog.create({
      data: {
        id: slug,
        nombre: nombre.trim(),
        icon: icon?.trim() || null,
        descripcion: descripcion?.trim() || null,
        color: color?.trim() || null,
        activo: Boolean(activo),
        orden: parseInt(orden, 10) || 0,
      },
    });
    invalidateCatalogCache();
    res.status(201).json({ mensaje: 'Servicio creado', service });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear servicio' });
  }
});

router.put('/services/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { nombre, icon, descripcion, color, activo, orden } = req.body;
    const data = {};
    if (nombre !== undefined) {
      if (!nombre.trim()) return res.status(400).json({ error: 'nombre no puede estar vacío' });
      data.nombre = nombre.trim();
    }
    if (icon !== undefined) data.icon = icon?.trim() || null;
    if (descripcion !== undefined) data.descripcion = descripcion?.trim() || null;
    if (color !== undefined) data.color = color?.trim() || null;
    if (activo !== undefined) data.activo = Boolean(activo);
    if (orden !== undefined) data.orden = parseInt(orden, 10) || 0;

    const service = await prisma.serviceCatalog.update({
      where: { id: req.params.id },
      data,
    });
    invalidateCatalogCache();
    res.json({ mensaje: 'Servicio actualizado', service });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Servicio no encontrado' });
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar servicio' });
  }
});

router.patch('/services/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { activo, orden } = req.body;
    const data = {};
    if (activo !== undefined) data.activo = Boolean(activo);
    if (orden !== undefined) data.orden = parseInt(orden, 10) || 0;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    const service = await prisma.serviceCatalog.update({
      where: { id: req.params.id },
      data,
    });
    invalidateCatalogCache();
    res.json({ mensaje: 'Servicio actualizado', service });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Servicio no encontrado' });
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar servicio' });
  }
});

// ── Ciudades ──────────────────────────────────────────────────────────────

router.get('/cities', verifyToken, soloAdmin, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const cities = await prisma.cityCatalog.findMany({
      where: includeInactive ? {} : { activo: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    });
    res.json({ cities, total: cities.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al listar ciudades' });
  }
});

router.post('/cities', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { id, nombre, lat, lng, activo = true, orden = 0 } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'nombre es requerido' });

    const slug = normalizeSlug(id || nombre);
    if (!slug || !SLUG_REGEX.test(slug)) {
      return res.status(400).json({ error: 'id inválido — use letras minúsculas, números y guión bajo' });
    }

    const existing = await prisma.cityCatalog.findUnique({ where: { id: slug } });
    if (existing) return res.status(400).json({ error: 'Ya existe una ciudad con ese id' });

    const city = await prisma.cityCatalog.create({
      data: {
        id: slug,
        nombre: nombre.trim(),
        lat: lat != null && lat !== '' ? parseFloat(lat) : null,
        lng: lng != null && lng !== '' ? parseFloat(lng) : null,
        activo: Boolean(activo),
        orden: parseInt(orden, 10) || 0,
      },
    });
    invalidateCatalogCache();
    res.status(201).json({ mensaje: 'Ciudad creada', city });
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'Ya existe una ciudad con ese nombre' });
    console.error(error);
    res.status(500).json({ error: 'Error al crear ciudad' });
  }
});

router.put('/cities/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { nombre, lat, lng, activo, orden } = req.body;
    const data = {};
    if (nombre !== undefined) {
      if (!nombre.trim()) return res.status(400).json({ error: 'nombre no puede estar vacío' });
      data.nombre = nombre.trim();
    }
    if (lat !== undefined) data.lat = lat != null && lat !== '' ? parseFloat(lat) : null;
    if (lng !== undefined) data.lng = lng != null && lng !== '' ? parseFloat(lng) : null;
    if (activo !== undefined) data.activo = Boolean(activo);
    if (orden !== undefined) data.orden = parseInt(orden, 10) || 0;

    const city = await prisma.cityCatalog.update({
      where: { id: req.params.id },
      data,
    });
    invalidateCatalogCache();
    res.json({ mensaje: 'Ciudad actualizada', city });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Ciudad no encontrada' });
    if (error.code === 'P2002') return res.status(400).json({ error: 'Ya existe una ciudad con ese nombre' });
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar ciudad' });
  }
});

router.patch('/cities/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { activo, orden } = req.body;
    const data = {};
    if (activo !== undefined) data.activo = Boolean(activo);
    if (orden !== undefined) data.orden = parseInt(orden, 10) || 0;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    const city = await prisma.cityCatalog.update({
      where: { id: req.params.id },
      data,
    });
    invalidateCatalogCache();
    res.json({ mensaje: 'Ciudad actualizada', city });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Ciudad no encontrada' });
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar ciudad' });
  }
});

module.exports = router;
