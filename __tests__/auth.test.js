const request = require('supertest');
const app     = require('../src/app');

// ── Mocks ────────────────────────────────────────────────────────────────
jest.mock('../src/lib/email', () => ({
  bienvenida:        jest.fn(),
  verificarEmail:    jest.fn().mockResolvedValue(undefined),
  reservaCreada:     jest.fn(),
  reservaConfirmada: jest.fn(),
  recordatorio24h:   jest.fn(),
  servicioCompletado: jest.fn(),
  nuevaResena:       jest.fn(),
  resetPassword:     jest.fn(),
  disputaAdmin:      jest.fn().mockResolvedValue(undefined),
  disputaCliente:    jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/lib/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    findFirst:  jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
  },
  providerProfile: {
    create: jest.fn(),
  },
}));

const prisma = require('../src/lib/prisma');

// ── Datos de prueba reutilizables ────────────────────────────────────────
const usuarioCliente = {
  id:       'user-cliente-123',
  nombre:   'Juan Prueba',
  email:    'juan@test.com',
  password: '$2a$12$hashedpassword', // bcrypt hash simulado
  rol:      'CLIENTE',
  telefono: '3001234567',
  ciudad:   'Bogotá',
};

const usuarioProveedor = {
  id:       'user-proveedor-456',
  nombre:   'Carlos Plomero',
  email:    'carlos@test.com',
  password: '$2a$12$hashedpassword',
  rol:      'PROVEEDOR',
  telefono: '3107654321',
  ciudad:   'Ibagué',
};

// ── Limpiar mocks entre cada test ────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================
describe('POST /auth/register', () => {
// ============================================================

  it('registra un cliente nuevo exitosamente', async () => {
    prisma.user.findUnique.mockResolvedValue(null);       // email no existe
    prisma.user.create.mockResolvedValue(usuarioCliente);

    const res = await request(app).post('/auth/register').send({
      nombre:   'Juan Prueba',
      email:    'juan@test.com',
      password: 'Password123!',
      telefono: '3001234567',
      ciudad:   'Bogotá',
      rol:      'CLIENTE',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.usuario.email).toBe('juan@test.com');
    expect(res.body.usuario.rol).toBe('CLIENTE');
    expect(res.body.usuario).not.toHaveProperty('password'); // nunca exponer password
  });

  it('registra un proveedor y crea su perfil automáticamente', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(usuarioProveedor);
    prisma.providerProfile.create.mockResolvedValue({ id: 'profile-789', userId: usuarioProveedor.id });

    const res = await request(app).post('/auth/register').send({
      nombre:   'Carlos Plomero',
      email:    'carlos@test.com',
      password: 'Password123!',
      rol:      'PROVEEDOR',
    });

    expect(res.statusCode).toBe(201);
    expect(prisma.providerProfile.create).toHaveBeenCalledTimes(1);
    expect(res.body.usuario.rol).toBe('PROVEEDOR');
  });

  it('rechaza si el email ya está registrado', async () => {
    prisma.user.findUnique.mockResolvedValue(usuarioCliente); // email ya existe

    const res = await request(app).post('/auth/register').send({
      nombre:   'Otro Usuario',
      email:    'juan@test.com',
      password: 'Password123!',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/ya está registrado/);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rechaza si faltan campos requeridos', async () => {
    const res = await request(app).post('/auth/register').send({
      email: 'incompleto@test.com',
      // falta nombre y password
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/requeridos/);
  });

  it('asigna rol CLIENTE si se intenta registrar como ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ ...usuarioCliente, rol: 'CLIENTE' });

    const res = await request(app).post('/auth/register').send({
      nombre:   'Hacker Intento',
      email:    'hacker@test.com',
      password: 'Password123!',
      rol:      'ADMIN', // intento de escalada de privilegios
    });

    expect(res.statusCode).toBe(201);
    // El sistema lo crea como CLIENTE, no ADMIN
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ rol: 'CLIENTE' }) })
    );
  });
});

// ============================================================
describe('POST /auth/login', () => {
// ============================================================

  it('inicia sesión exitosamente con credenciales correctas', async () => {
    // bcryptjs: comparar una contraseña real
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('Password123!', parseInt(process.env.BCRYPT_ROUNDS || '1', 10));
    prisma.user.findUnique.mockResolvedValue({ ...usuarioCliente, password: hash });

    const res = await request(app).post('/auth/login').send({
      email:    'juan@test.com',
      password: 'Password123!',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.usuario.email).toBe('juan@test.com');
    expect(res.body.usuario).not.toHaveProperty('password');
  });

  it('rechaza con contraseña incorrecta', async () => {
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('PasswordCorrecto!', parseInt(process.env.BCRYPT_ROUNDS || '1', 10));
    prisma.user.findUnique.mockResolvedValue({ ...usuarioCliente, password: hash });

    const res = await request(app).post('/auth/login').send({
      email:    'juan@test.com',
      password: 'PasswordEquivocado!',
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/incorrectos/);
  });

  it('rechaza si el email no existe', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/auth/login').send({
      email:    'noexiste@test.com',
      password: 'Password123!',
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/incorrectos/);
    // No debe indicar si el email existe o no (seguridad)
  });
});

// ============================================================
describe('GET /auth/me', () => {
// ============================================================

  it('devuelve el usuario autenticado con token válido', async () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { id: usuarioCliente.id, email: usuarioCliente.email, rol: usuarioCliente.rol },
      process.env.JWT_SECRET || 'test_secret',
      { expiresIn: '1h' }
    );

    prisma.user.findUnique.mockResolvedValue({
      ...usuarioCliente,
      providerProfile: null,
    });

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.email).toBe('juan@test.com');
    expect(res.body).not.toHaveProperty('password');
  });

  it('rechaza sin token (401)', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.statusCode).toBe(401);
  });

  it('rechaza con token inválido (401)', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', 'Bearer token.invalido.aqui');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('PUT /auth/me — actualizar datos personales', () => {
// ============================================================

  function makeToken(user = usuarioCliente) {
    const jwt = require('jsonwebtoken');
    return jwt.sign(
      { id: user.id, email: user.email, rol: user.rol },
      process.env.JWT_SECRET || 'test_secret',
      { expiresIn: '1h' },
    );
  }

  it('actualiza nombre, telefono y ciudad correctamente', async () => {
    prisma.user.update.mockResolvedValue({
      id: usuarioCliente.id, nombre: 'Juan Actualizado',
      email: usuarioCliente.email, telefono: '3109876543', ciudad: 'Medellín', rol: 'CLIENTE',
    });

    const res = await request(app)
      .put('/auth/me')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ nombre: 'Juan Actualizado', telefono: '3109876543', ciudad: 'Medellín' });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/actualizado/i);
    expect(res.body.usuario.nombre).toBe('Juan Actualizado');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nombre: 'Juan Actualizado' }),
      })
    );
  });

  it('actualiza solo un campo (telefono)', async () => {
    prisma.user.update.mockResolvedValue({ ...usuarioCliente, telefono: '3111111111' });

    const res = await request(app)
      .put('/auth/me')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ telefono: '3111111111' });

    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ telefono: '3111111111' }),
      })
    );
    // nombre no debe estar en data si no se envió
    const callArg = prisma.user.update.mock.calls[0][0];
    expect(callArg.data).not.toHaveProperty('nombre');
  });

  it('rechaza nombre vacío (400)', async () => {
    const res = await request(app)
      .put('/auth/me')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ nombre: '   ' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/vacío/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rechaza si no hay campos que actualizar (400)', async () => {
    const res = await request(app)
      .put('/auth/me')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/al menos un campo/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rechaza sin token (401)', async () => {
    const res = await request(app)
      .put('/auth/me')
      .send({ nombre: 'Sin token' });

    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('PUT /auth/me/password — cambiar contraseña', () => {
// ============================================================

  it('cambia la contraseña con credenciales correctas', async () => {
    const bcrypt = require('bcryptjs');
    const jwt    = require('jsonwebtoken');
    const hash   = await bcrypt.hash('OldPassword!', parseInt(process.env.BCRYPT_ROUNDS || '1', 10));
    const token  = jwt.sign(
      { id: usuarioCliente.id, email: usuarioCliente.email, rol: usuarioCliente.rol },
      process.env.JWT_SECRET || 'test_secret',
      { expiresIn: '1h' },
    );

    prisma.user.findUnique.mockResolvedValue({ ...usuarioCliente, password: hash });
    prisma.user.update.mockResolvedValue({});

    const res = await request(app)
      .put('/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ passwordActual: 'OldPassword!', passwordNuevo: 'NewPassword123!' });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/actualizada/);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('rechaza si la contraseña actual es incorrecta', async () => {
    const bcrypt = require('bcryptjs');
    const jwt    = require('jsonwebtoken');
    const hash   = await bcrypt.hash('CorrectPass!', 12);
    const token  = jwt.sign(
      { id: usuarioCliente.id, email: usuarioCliente.email, rol: usuarioCliente.rol },
      process.env.JWT_SECRET || 'test_secret',
      { expiresIn: '1h' },
    );

    prisma.user.findUnique.mockResolvedValue({ ...usuarioCliente, password: hash });

    const res = await request(app)
      .put('/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ passwordActual: 'WrongPass!', passwordNuevo: 'NewPassword123!' });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/incorrecta/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rechaza sin token (401)', async () => {
    const res = await request(app)
      .put('/auth/me/password')
      .send({ passwordActual: 'x', passwordNuevo: 'y' });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('POST /auth/forgot-password — solicitar reset', () => {
// ============================================================

  it('responde 200 aunque el email no exista (anti-enumeración)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'noexiste@test.com' });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/Si el email existe/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('guarda el token y envía email si el usuario existe', async () => {
    prisma.user.findUnique.mockResolvedValue(usuarioCliente);
    prisma.user.update.mockResolvedValue({});

    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'juan@test.com' });

    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resetToken:       expect.any(String),
          resetTokenExpiry: expect.any(Date),
        }),
      }),
    );
  });
});

// ============================================================
describe('POST /auth/reset-password — restablecer contraseña', () => {
// ============================================================

  it('restablece la contraseña con token válido', async () => {
    prisma.user.findFirst.mockResolvedValue(usuarioCliente);
    prisma.user.update.mockResolvedValue({});

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: 'token-valido-hex', passwordNuevo: 'NewSecurePass123!' });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/restablecida/);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resetToken:       null,
          resetTokenExpiry: null,
        }),
      }),
    );
  });

  it('rechaza con token inválido o expirado', async () => {
    prisma.user.findFirst.mockResolvedValue(null); // token no encontrado / expirado

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: 'token-invalido', passwordNuevo: 'NewPass123!' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/inválido o expirado/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rechaza si faltan campos requeridos', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: 'algun-token' }); // falta passwordNuevo

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/requeridos/);
  });
});

// ============================================================
describe('GET /auth/verify-email — verificar email', () => {
// ============================================================

  it('verifica el email con token válido', async () => {
    prisma.user.findFirst.mockResolvedValue(usuarioCliente);
    prisma.user.update.mockResolvedValue({});

    const res = await request(app)
      .get('/auth/verify-email?token=token-valido-de-64-chars');

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/verificado/);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailVerificado: true,
          emailVerifToken: null,
        }),
      }),
    );
  });

  it('rechaza con token inválido o ya usado', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/auth/verify-email?token=token-que-no-existe');

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/inválido/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rechaza si no se provee token', async () => {
    const res = await request(app).get('/auth/verify-email');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Token requerido/);
  });
});

// ============================================================
describe('POST /auth/refresh — renovar access token', () => {
// ============================================================

  const activeUser = {
    id: 'user-001', email: 'juan@test.com', rol: 'CLIENTE', nombre: 'Juan',
    activo: true, refreshToken: 'valid-refresh-token-xyz',
    refreshTokenExp: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days ahead
  };

  it('renueva el token con refresh token válido', async () => {
    prisma.user.findFirst.mockResolvedValue(activeUser);
    prisma.user.update.mockResolvedValue(activeUser);

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'valid-refresh-token-xyz' });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // New refresh token should be different (rotation)
    expect(res.body.refreshToken).not.toBe('valid-refresh-token-xyz');
  });

  it('rechaza con refresh token inválido (401)', async () => {
    prisma.user.findFirst.mockResolvedValue(null); // token not found

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'token-invalido' });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/inválido/);
  });

  it('rechaza sin refresh token (400)', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/requerido/);
  });
});

// ============================================================
describe('POST /auth/logout — cerrar sesión', () => {
// ============================================================
  const { sign } = require('jsonwebtoken');
  const SECRET = process.env.JWT_SECRET || 'test_secret';

  it('cierra sesión invalidando el refresh token', async () => {
    prisma.user.update.mockResolvedValue({});

    const token = sign({ id: 'user-001', email: 'j@t.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/cerrada/);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { refreshToken: null, refreshTokenExp: null },
      })
    );
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('POST /auth/resend-verification — reenviar email', () => {
// ============================================================
  const { sign } = require('jsonwebtoken');
  const SECRET = process.env.JWT_SECRET || 'test_secret';

  const token = () => sign({ id: 'user-001', email: 'j@t.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });

  it('reenvía email de verificación si no está verificado', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'j@t.com', nombre: 'Juan', emailVerificado: false,
    });
    prisma.user.update.mockResolvedValue({});

    const res = await request(app)
      .post('/auth/resend-verification')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/reenviado/);
  });

  it('responde OK si ya está verificado (no falla)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'j@t.com', nombre: 'Juan', emailVerificado: true,
    });

    const res = await request(app)
      .post('/auth/resend-verification')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/ya está verificado/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).post('/auth/resend-verification');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('POST /auth/register — referral code generation', () => {
// ============================================================

  it('registro incluye referralCode en respuesta', async () => {
    const userConCodigo = {
      id: 'new-001', nombre: 'María López', email: 'maria@test.com',
      rol: 'CLIENTE', referralCode: 'MARIA4872',
      refreshToken: 'rt', refreshTokenExp: new Date(),
    };
    prisma.user.findUnique.mockResolvedValue(null); // email not exists
    prisma.user.create.mockResolvedValue(userConCodigo);
    prisma.user.update.mockResolvedValue(userConCodigo);

    const res = await request(app)
      .post('/auth/register')
      .send({ nombre: 'María López', email: 'maria@test.com', password: 'Segura#2025!' });

    expect(res.statusCode).toBe(201);
    expect(res.body.usuario.referralCode).toBeDefined();
  });

  it('acepta código de referido (ref) en registro', async () => {
    const referrer = { id: 'ref-001', referralCode: 'JUAN1234' };
    const newUser = {
      id: 'new-002', nombre: 'Pedro V.', email: 'pedro@test.com',
      rol: 'CLIENTE', referralCode: 'PEDRO5678', referredById: 'ref-001',
      refreshToken: 'rt', refreshTokenExp: new Date(),
    };
    // findUnique: 1st call = email check (null), 2nd = referralCode lookup (referrer), 3rd = collision check (null)
    prisma.user.findUnique
      .mockResolvedValueOnce(null)     // email not exists
      .mockResolvedValueOnce(referrer) // referral code lookup
      .mockResolvedValueOnce(null);    // no collision on generated code
    prisma.user.create.mockResolvedValue(newUser);
    prisma.user.update.mockResolvedValue(newUser);

    const res = await request(app)
      .post('/auth/register')
      .send({ nombre: 'Pedro V.', email: 'pedro@test.com', password: 'Segura#2025!', ref: 'JUAN1234' });

    expect(res.statusCode).toBe(201);
    // The create should have been called with referredById
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ referredById: 'ref-001' }),
      })
    );
  });
});
