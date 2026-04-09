const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const verifyToken = require('../middleware/verifyToken');

const prisma = new PrismaClient();

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { nombre, email, password, telefono, ciudad, rol } = req.body;

    if (!nombre || !email || !password) {
      return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Este email ya está registrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        nombre,
        email,
        password: hashedPassword,
        telefono,
        ciudad: ciudad || 'Ibagué',
        rol: rol === 'PROVEEDOR' ? 'PROVEEDOR' : 'CLIENTE'
      }
    });

    // Si es proveedor, crear perfil vacío automáticamente
    if (user.rol === 'PROVEEDOR') {
      await prisma.providerProfile.create({
        data: { userId: user.id }
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      mensaje: 'Usuario registrado exitosamente',
      token,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /auth/me — obtener usuario autenticado
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { providerProfile: true }
    });
    const { password, ...userSinPassword } = user;
    res.json(userSinPassword);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

module.exports = router;
