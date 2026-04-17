const request = require('supertest');
const app     = require('../src/app');

// ── Mock de Prisma para no tocar la base de datos real ───────────────────
jest.mock('../src/lib/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    create:     jest.fn(),
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
    const hash   = await bcrypt.hash('Password123!', 12);
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
    const hash   = await bcrypt.hash('PasswordCorrecto!', 12);
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
