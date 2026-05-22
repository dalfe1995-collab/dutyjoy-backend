const router          = require('express').Router();
const bcrypt          = require('bcryptjs');
const jwt             = require('jsonwebtoken');
const crypto          = require('crypto');
const verifyToken     = require('../middleware/verifyToken');
const { verifyCaptcha } = require('../middleware/verifyCaptcha');
const { updateProviderEmbedding } = require('../lib/embeddings');
const prisma      = require('../lib/prisma');
const email       = require('../lib/email');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const { audit }     = require('../lib/audit');

// ── Helpers ───────────────────────────────────────────────────────────────
const ACCESS_TOKEN_TTL  = '1h';
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

// Max failed login attempts before lockout
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MS   = 15 * 60 * 1000; // 15 min

// Regex PRD: min 8, 1 uppercase, 1 number, 1 symbol
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_ERROR = 'La contraseña debe tener mínimo 8 caracteres, una mayúscula, un número y un símbolo';

// Hash refresh token with SHA-256 before DB storage (tokens are already 80-char random hex)
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function issueTokens(user) {
  const payload      = { id: user.id, email: user.email, rol: user.rol };
  const accessToken  = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
  const rawRefresh   = crypto.randomBytes(40).toString('hex');
  const refreshToken = hashToken(rawRefresh); // stored hash
  const refreshTokenExp = new Date(Date.now() + REFRESH_TOKEN_TTL);
  return { accessToken, rawRefresh, refreshToken, refreshTokenExp };
}

// IP helper
function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
}

// Check brute-force lockout (email-based, not IP — avoid penalising NAT)
async function checkBruteForce(emailAddr) {
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
  const fails = await prisma.loginAttempt.count({
    where: { email: emailAddr, exitoso: false, createdAt: { gte: since } },
  });
  return fails >= MAX_FAILED_ATTEMPTS;
}

function generateReferralCode(nombre) {
  const prefix = (nombre || 'USER').replace(/\s+/g, '').toUpperCase().slice(0, 5);
  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  return prefix + suffix;
}

// POST /auth/register
router.post('/register', verifyCaptcha, async (req, res) => {
  try {
    const { nombre, email: emailAddr, password, telefono, ciudad, rol, ref,
            utmSource, utmMedium, utmCampaign, utmContent, utmTerm } = req.body;

    if (!nombre || !emailAddr || !password) {
      return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    }

    // Length guards
    if (nombre.length > 120)    return res.status(400).json({ error: 'Nombre demasiado largo' });
    if (emailAddr.length > 254) return res.status(400).json({ error: 'Email inválido' });
    if (password.length > 128)  return res.status(400).json({ error: 'Contraseña demasiado larga' });
    if (telefono && telefono.length > 20) return res.status(400).json({ error: 'Teléfono inválido' });
    if (ciudad && ciudad.length > 80)     return res.status(400).json({ error: 'Ciudad inválida' });

    // Validación de contraseña (PRD)
    if (!PASSWORD_REGEX.test(password)) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: emailAddr } });
    if (existingUser) {
      return res.status(400).json({ error: 'Este email ya está registrado' });
    }

    const hashedPassword  = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const rawVerifToken   = crypto.randomBytes(32).toString('hex');
    const emailVerifToken = hashToken(rawVerifToken); // store hash; send raw in email

    const { accessToken, rawRefresh, refreshToken, refreshTokenExp } = issueTokens({ id: 'tmp', email: emailAddr, rol: rol === 'PROVEEDOR' ? 'PROVEEDOR' : 'CLIENTE' });

    // Resolve referrer (optional)
    let referredById = null;
    if (ref) {
      const referrer = await prisma.user.findUnique({ where: { referralCode: ref.toUpperCase() }, select: { id: true } });
      if (referrer) referredById = referrer.id;
    }

    // Generate unique referral code
    let referralCode = generateReferralCode(nombre);
    const existing = await prisma.user.findUnique({ where: { referralCode } });
    if (existing) referralCode = generateReferralCode(nombre); // retry once on collision

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
        referralCode,
        referredById,
        ...(utmSource   && { utmSource }),
        ...(utmMedium   && { utmMedium }),
        ...(utmCampaign && { utmCampaign }),
        ...(utmContent  && { utmContent }),
        ...(utmTerm     && { utmTerm }),
      },
    });

    // Re-sign with real user id
    const { accessToken: finalAccess, rawRefresh: finalRaw, refreshToken: finalRefresh, refreshTokenExp: finalExp } = issueTokens(user);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken: finalRefresh, refreshTokenExp: finalExp } });

    // Si es proveedor, crear perfil vacío + generar embedding inicial
    if (user.rol === 'PROVEEDOR') {
      const profile = await prisma.providerProfile.create({ data: { userId: user.id } });
      updateProviderEmbedding(profile.id).catch(() => {});
    }

    // Emails (fire-and-forget)
    email.bienvenida({ email: user.email, nombre: user.nombre, rol: user.rol });
    email.verificarEmail({ email: user.email, nombre: user.nombre, token: rawVerifToken }); // send raw

    audit({ accion: 'registro', userId: user.id, entidad: 'User', entidadId: user.id, req }).catch(() => {});

    res.status(201).json({
      mensaje:      'Usuario registrado exitosamente',
      token:        finalAccess,
      refreshToken: finalRaw,  // send raw token; DB stores hash
      usuario:      { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol, referralCode: user.referralCode },
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

    if (!emailAddr || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (emailAddr.length > 254 || password.length > 128) return res.status(400).json({ error: 'Credenciales inválidas' });

    // Brute-force lockout check
    const locked = await checkBruteForce(emailAddr.toLowerCase()).catch(() => false);
    if (locked) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    }

    const ip = getIp(req);
    const ua = req.headers['user-agent']?.slice(0, 500);

    const user = await prisma.user.findUnique({ where: { email: emailAddr } });
    if (!user || !await bcrypt.compare(password, user.password)) {
      // Record failed attempt (fire-and-forget)
      prisma.loginAttempt.create({ data: { email: emailAddr.toLowerCase(), ip, exitoso: false, userAgent: ua } }).catch(() => {});
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    if (!user.activo) return res.status(403).json({ error: 'Cuenta desactivada. Contacta soporte.' });

    // Record successful login
    prisma.loginAttempt.create({ data: { email: emailAddr.toLowerCase(), ip, exitoso: true, userAgent: ua } }).catch(() => {});
    audit({ accion: 'login', userId: user.id, entidad: 'User', entidadId: user.id, req }).catch(() => {});

    const { accessToken, rawRefresh, refreshToken, refreshTokenExp } = issueTokens(user);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken, refreshTokenExp } });

    res.json({
      token:        accessToken,
      refreshToken: rawRefresh,  // send raw; DB stores hash
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
      where: { emailVerifToken: hashToken(token) }, // compare hash
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
    const rawVerif = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { id: user.id },
      data:  { emailVerifToken: hashToken(rawVerif) },
    });

    email.verificarEmail({ email: user.email, nombre: user.nombre, token: rawVerif }); // send raw

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
router.post('/forgot-password', verifyCaptcha, async (req, res) => {
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

    const rawReset          = crypto.randomBytes(32).toString('hex');
    const resetToken        = hashToken(rawReset); // store hash; send raw in email
    const resetTokenExpiry  = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await prisma.user.update({
      where: { id: user.id },
      data:  { resetToken, resetTokenExpiry },
    });

    // Email de reset (fire-and-forget) — send raw token in link
    email.resetPassword({ email: user.email, nombre: user.nombre, resetToken: rawReset });

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
        resetToken:       hashToken(token), // compare hash
        resetTokenExpiry: { gt: new Date() },
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
    const { refreshToken: incoming } = req.body;
    if (!incoming) return res.status(400).json({ error: 'refreshToken requerido' });
    if (incoming.length > 200) return res.status(400).json({ error: 'Token inválido' });

    const tokenHash = hashToken(incoming);

    const user = await prisma.user.findFirst({
      where: {
        refreshToken:    tokenHash,
        refreshTokenExp: { gt: new Date() },
        activo:          true,
      },
    });

    if (!user) return res.status(401).json({ error: 'Refresh token inválido o expirado. Inicia sesión nuevamente.' });

    // Emite nuevo par de tokens (rotation — invalida el anterior)
    const { accessToken, rawRefresh: newRaw, refreshToken: newHash, refreshTokenExp } = issueTokens(user);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken: newHash, refreshTokenExp } });

    res.json({ token: accessToken, refreshToken: newRaw });
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

// DELETE /auth/me — GDPR: anonymise account (soft-delete, preserves booking history)
router.delete('/me', verifyToken, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Confirma con tu contraseña' });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Contraseña incorrecta' });

    // Anonymise — don't hard-delete to preserve booking/payment history integrity
    await prisma.user.update({
      where: { id: user.id },
      data: {
        email:            `deleted_${user.id}@deleted.dutyjoy.com`,
        nombre:           'Usuario eliminado',
        password:         await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
        telefono:         null,
        refreshToken:     null,
        refreshTokenExp:  null,
        emailVerifToken:  null,
        resetToken:       null,
        resetTokenExpiry: null,
        activo:           false,
      },
    });

    require('../middleware/verifyToken').invalidateAuthCache(user.id);
    audit({ accion: 'cuenta_eliminada_gdpr', userId: user.id, entidad: 'User', entidadId: user.id, req }).catch(() => {});

    res.json({ mensaje: 'Tu cuenta ha sido eliminada. Tus datos personales han sido borrados.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar la cuenta' });
  }
});

// POST /auth/revoke-all-sessions — force logout all devices
router.post('/revoke-all-sessions', verifyToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data:  { refreshToken: null, refreshTokenExp: null },
    });
    require('../middleware/verifyToken').invalidateAuthCache(req.user.id);
    audit({ accion: 'sesiones_revocadas', userId: req.user.id, entidad: 'User', entidadId: req.user.id, req }).catch(() => {});
    res.json({ mensaje: 'Todas las sesiones han sido cerradas. Inicia sesión nuevamente.' });
  } catch (error) {
    res.status(500).json({ error: 'Error al revocar sesiones' });
  }
});

module.exports = router;
