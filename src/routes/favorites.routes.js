const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

// GET /favorites — lista los proveedores guardados del cliente autenticado
router.get('/', verifyToken, async (req, res) => {
  try {
    const favoritos = await prisma.favorito.findMany({
      where: { clienteId: req.user.id },
      include: {
        proveedor: {
          include: { user: { select: { nombre: true, ciudad: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(favoritos.map(f => ({ ...f.proveedor, favoritoId: f.id })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener favoritos' });
  }
});

// POST /favorites/:proveedorId — agregar a favoritos
router.post('/:proveedorId', verifyToken, async (req, res) => {
  try {
    if (req.user.rol === 'PROVEEDOR') {
      return res.status(403).json({ error: 'Los proveedores no pueden guardar favoritos' });
    }

    const proveedor = await prisma.providerProfile.findUnique({
      where: { id: req.params.proveedorId },
    });
    if (!proveedor) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const favorito = await prisma.favorito.upsert({
      where: {
        clienteId_proveedorId: {
          clienteId: req.user.id,
          proveedorId: req.params.proveedorId,
        },
      },
      update: {},
      create: {
        clienteId: req.user.id,
        proveedorId: req.params.proveedorId,
      },
    });

    res.status(201).json({ ok: true, favoritoId: favorito.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar favorito' });
  }
});

// DELETE /favorites/:proveedorId — quitar de favoritos
router.delete('/:proveedorId', verifyToken, async (req, res) => {
  try {
    await prisma.favorito.deleteMany({
      where: {
        clienteId: req.user.id,
        proveedorId: req.params.proveedorId,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar favorito' });
  }
});

// GET /favorites/ids — solo los IDs de proveedores guardados (para el estado del corazón)
router.get('/ids', verifyToken, async (req, res) => {
  try {
    const favoritos = await prisma.favorito.findMany({
      where: { clienteId: req.user.id },
      select: { proveedorId: true },
    });
    res.json(favoritos.map(f => f.proveedorId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener IDs de favoritos' });
  }
});

module.exports = router;
