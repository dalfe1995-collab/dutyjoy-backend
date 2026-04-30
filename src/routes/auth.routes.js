const router      = require('express').Router();
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const crypto      = require('crypto');
const verifyToken = require('../middleware/verifyToken');
const { updateProviderEmbedding } = require('../lib/embeddings');
const prisma      = require('../lib/prisma');
const email       = require('../lib/email');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

// ── Helpers ───────────────────────────────────────────────────────────────
const ACCESS_TOKEN_TTL  = '1h';   // short-lived
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

// Regex PRD: min 8, 1 uppercase, 1 number, 1 symbol
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_ERROR = 'La contraseña debe tener mínimo 8 caracteres, una mayúscula, un número y un símbolo';

function issueTokens(user) {
  const payload = { id: user.id, email: user.email, rol: user.rol };
  const accessToken  = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenExp = new Date(Date.now() + REFRESH_TOKEN_TTL);
  return { accessToken, refreshToken, refreshTokenExp };
}

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { nombre, email: emailAddr, password, telefono, ciudad, rol } = req.body;

    if (!nombre || !emailAddr || !password) {
      return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    }

    // Validación de contraseña (PRD)
    if (!PASSWORD_REGEX.test(password)) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: emailAddr } });
    if (existingUser) {
      return res.status(400).json({ error: 'Este email ya está registrado' });
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const emailVerifToken = crypto.randomBytes(32).toString('hex');

    const { accessToken, refreshToken, refreshTokenExp } = issueTokens({ id: 'tmp', email: emailAddr, rol: rol === 'PROVEEDOR' ? 'PROVEEDOR' : 'CLIENTE' });

    const user = await prisma.user.create({
      data: {
        nombre,
        email:           emailAddr,
        password:        hashedPassword,
        telefono,
        ciudad:          ciudad || 'Ibagué',
        rol:             rol === 'PROVEEDOR' ? 'PROVEEDOR' : 'CLIENTE',
        emailVerifToken,
        refreshToken,
        refreshTokenExp,
      },
    });

    // Re-sign with real user id
    const { accessToken: finalAccess, refreshToken: finalRefresh, refreshTokenExp: finalExp } = issueTokens(user);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken: finalRefresh, refreshTokenExp: finalExp } });

    // Si es proveedor, crear perfil vacío + generar embedding inicial
    if (user.rol === 'PROVEEDOR') {
      const profile = await prisma.providerProfile.create({ data: { userId: user.id } });
      updateProviderEmbedding(profile.id).catch(() => {});
    }

    // Emails (fire-and-forget)
    email.bienvenida({ email: user.email, nombre: user.nombre, rol: user.rol });
    email.verificarEmail({ email: user.email, nombre: user.nombre, token: emailVerifToken });

    res.status(201).json({
      mensaje:      'Usuario registrado exitosamente',
      token:        finalAccess,
      refreshToken: finalRefresh,
      usuario:      { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email: emailAddr, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email: emailAddr } });
    if (!user) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const { accessToken, refreshToken, refreshTokenExp } = issueTokens(user);
    await prisma.user.update({
      where: { id: user.id },
      data:  { refreshToken, refreshTokenExp },
    });

    res.json({
      token:        accessToken,
      refreshToken,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /auth/me — obtener usuario autenticado
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:   { id: req.user.id },
      include: { providerProfile: true },
    });
    const { password, resetToken, resetTokenExpiry, emailVerifToken, ...userSinPassword } = user;
    res.json(userSinPassword);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// PUT /auth/me — actualizar datos personales del usuario
router.put('/me', verifyToken, async (req, res) => {
  try {
    const { nombre, telefono, ciudad } = req.body;

    const data = {};
    if (nombre !== undefined) {
      if (!nombre.trim()) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
      data.nombre = nombre.trim();
    }
    if (telefono !== undefined) data.telefono = telefono.trim() || null;
    if (ciudad   !== undefined) data.ciudad   = ciudad.trim()   || null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Debes enviar al menos un campo para actualizar' });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { id: true, nombre: true, email: true, telefono: true, ciudad: true, rol: true },
    });

    res.json({ mensaje: 'Perfil actualizado correctamente', usuario: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar el perfil' });
  }
});

// GET /auth/verify-email?token=xxx — activar email
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Token requerido' });
    }

    const user = await prisma.user.findFirst({
      where: { emailVerifToken: token },
    });

    if (!user) {
      return res.status(400).json({ error: 'Token inválido o ya utilizado' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data:  { emailVerificado: true, emailVerifToken: null },
    });

    res.json({ mensaje: '¡Email verificado correctamente! Ya puedes usar todas las funciones de DutyJoy.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al verificar el email' });
  }
});

// POST /auth/resend-verification — reenviar email de verificación (JWT)
router.post('/resend-verification', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.emailVerificado) {
      return res.json({ mensaje: 'Tu email ya está verificado' });
    }

    // Genera un token nuevo (invalida el anterior)
    const emailVerifToken = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { id: user.id },
      data:  { emailVerifToken },
    });

    email.verificarEmail({ email: user.email, nombre: user.nombre, token: emailVerifToken });

    res.json({ mensaje: 'Email de verificación reenviado. Revisa tu bandeja de entrada.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al reenviar el email' });
  }
});

// PUT /auth/me/password — cambiar contraseña (requiere contraseña actual)
router.put('/me/password', verifyToken, async (req, res) => {
  try {
    const { passwordActual, passwordNuevo } = req.body;

    if (!passwordActual || !passwordNuevo) {
      return res.status(400).json({ error: 'passwordActual y passwordNuevo son requeridos' });
    }
    if (!PASSWORD_REGEX.test(passwordNuevo)) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(passwordActual, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
    }

    const hashed = await bcrypt.hash(passwordNuevo, 12);
    await prisma.user.update({
      where: { id: req.user.id },
      data:  { password: hashed },
    });

    res.json({ mensaje: 'Contraseña actualizada correctamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
});

// POST /auth/forgot-password — enviar email con token de reset
router.post('/forgot-password', async (req, res) => {
  try {
    const { email: emailAddr } = req.body;

    if (!emailAddr) {
      return res.status(400).json({ error: 'El email es requerido' });
    }

    const user = await prisma.user.findUnique({ where: { email: emailAddr } });

    // Siempre responder 200 para no revelar si el email existe (seguridad)
    if (!user) {
      return res.json({ mensaje: 'Si el email existe, recibirás las instrucciones en breve' });
    }

    const resetToken        = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry  = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await prisma.user.update({
      where: { id: user.id },
      data:  { resetToken, resetTokenExpiry },
    });

    // Email de reset (fire-and-forget)
    email.resetPassword({ email: user.email, nombre: user.nombre, resetToken });

    res.json({ mensaje: 'Si el email existe, recibirás las instrucciones en breve' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

// POST /auth/reset-password — establecer nueva contraseña con token
router.post('/reset-password', async (req, res) => {
  try {
    const { token, passwordNuevo } = req.body;

    if (!token || !passwordNuevo) {
      return res.status(400).json({ error: 'token y passwordNuevo son requeridos' });
    }
    if (!PASSWORD_REGEX.test(passwordNuevo)) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    const user = await prisma.user.findFirst({
      where: {
        resetToken:       token,
        resetTokenExpiry: { gt: new Date() }, // token no expirado
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }

    const hashed = await bcrypt.hash(passwordNuevo, 12);
    await prisma.user.update({
      where: { id: user.id },
      data:  {
        password:         hashed,
        resetToken:       null,
        resetTokenExpiry: null,
      },
    });

    res.json({ mensaje: 'Contraseña restablecida correctamente. Ya puedes iniciar sesión.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al restablecer la contraseña' });
  }
});

// POST /auth/refresh — renueva el access token usando el refresh token
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken requerido' });

    const user = await prisma.user.findFirst({
      where: {
        refreshToken,
        refreshTokenExp: { gt: new Date() },
        activo: true,
      },
    });

    if (!user) return res.status(401).json({ error: 'Refresh token inválido o expirado. Inicia sesión nuevamente.' });

    // Emite nuevo par de tokens (rotation — invalida el anterior)
    const { accessToken, refreshToken: newRefresh, refreshTokenExp } = issueTokens(user);
    await prisma.user.update({
      where: { id: user.id },
      data:  { refreshToken: newRefresh, refreshTokenExp },
    });

    res.json({ token: accessToken, refreshToken: newRefresh });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al renovar sesión' });
  }
});

// POST /auth/logout — invalida el refresh token del usuario
router.post('/logout', verifyToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data:  { refreshToken: null, refreshTokenExp: null },
    });
    res.json({ mensaje: 'Sesión cerrada correctamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al cerrar sesión' });
  }
});

module.exports = router;
