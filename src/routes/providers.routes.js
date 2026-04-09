const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const verifyToken = require('../middleware/verifyToken');

const prisma = new PrismaClient();

// GET /providers — listar proveedores disponibles
router.get('/', async (req, res) => {
  try {
    const { ciudad, servicio } = req.query;

    const providers = await prisma.providerProfile.findMany({
      where: {
        disponible: true,
        verificado: true,
        ...(ciudad && { ciudades: { has: ciudad } }),
        ...(servicio && { servicios: { has: servicio } })
      },
      include: {
        user: { select: { nombre: true, ciudad: true } }
      },
      orderBy: { calificacion: 'desc' }
    });

    res.json(providers);
  } catch (error) {
    res.status(500).json({ error: 'Error al buscar proveedores' });
  }
});

// PUT /providers/me — proveedor actualiza su perfil
router.put('/me', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden actualizar este perfil' });
    }

    const { bio, servicios, tarifaPorHora, ciudades, disponible } = req.body;

    const profile = await prisma.providerProfile.update({
      where: { userId: req.user.id },
      data: { bio, servicios, tarifaPorHora, ciudades, disponible }
    });

    res.json({ mensaje: 'Perfil actualizado', profile });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

module.exports = router;
