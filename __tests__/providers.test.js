const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/email', () => ({
  bienvenida:        jest.fn(),
  verificarEmail:    jest.fn().mockResolvedValue(undefined),
  reservaCreada:     jest.fn(),
  reservaConfirmada: jest.fn(),
  recordatorio24h:   jest.fn(),
  servicioCompletado: jest.fn(),
  nuevaResena:       jest.fn(),
  resetPassword:     jest.fn(),
  cedulaRecibida:    jest.fn().mockResolvedValue(undefined),
  cedulaAprobada:    jest.fn().mockResolvedValue(undefined),
  cedulaRechazada:   jest.fn().mockResolvedValue(undefined),
  disputaAdmin:      jest.fn().mockResolvedValue(undefined),
  disputaCliente:    jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/lib/prisma', () => ({
  providerProfile: {
    findMany:   jest.fn(),
    findUnique: jest.fn(),
    count:      jest.fn(),
    update:     jest.fn(),
  },
  user: { findUnique: jest.fn() },
}));

const prisma = require('../src/lib/prisma');
const SECRET = process.env.JWT_SECRET || 'test_secret';

function tokenProveedor(id = 'proveedor-001') {
  return jwt.sign({ id, email: 'carlos@test.com', rol: 'PROVEEDOR' }, SECRET, { expiresIn: '1h' });
}
function tokenCliente(id = 'cliente-001') {
  return jwt.sign({ id, email: 'juan@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}

const perfilCompleto = {
  id:           'profile-001',
  userId:       'proveedor-001',
  bio:          'Experto en plomería',
  servicios:    ['plomeria', 'electricidad'],
  tarifaPorHora: 50000,
  ciudades:     ['Bogotá'],
  calificacion: 4.8,
  totalReviews: 12,
  verificado:   true,
  disponible:   true,
  cedulaUrl:    null,
  cedulaStatus: 'sin_enviar',
  cedulaNota:   null,
  createdAt:    new Date().toISOString(),
  user:         { nombre: 'Carlos Plomero', ciudad: 'Bogotá' },
  _count:       { bookings: 5, reviews: 12 },
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('GET /providers — listado público', () => {
// ============================================================

  it('devuelve lista de proveedores disponibles', async () => {
    prisma.providerProfile.findMany.mockResolvedValue([perfilCompleto]);
    prisma.providerProfile.count.mockResolvedValue(1);

    const res = await request(app).get('/providers');

    expect(res.statusCode).toBe(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.providers[0].id).toBe('profile-001');
  });

  it('filtra por ciudad', async () => {
    prisma.providerProfile.findMany.mockResolvedValue([perfilCompleto]);
    prisma.providerProfile.count.mockResolvedValue(1);

    const res = await request(app).get('/providers?ciudad=Bogot%C3%A1');

    expect(res.statusCode).toBe(200);
    expect(prisma.providerProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ciudades: { has: 'Bogotá' } }),
      })
    );
  });

  it('filtra por servicio', async () => {
    prisma.providerProfile.findMany.mockResolvedValue([perfilCompleto]);
    prisma.providerProfile.count.mockResolvedValue(1);

    const res = await request(app).get('/providers?servicio=plomeria');

    expect(res.statusCode).toBe(200);
    expect(prisma.providerProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ servicios: { has: 'plomeria' } }),
      })
    );
  });

  it('devuelve array vacío si no hay resultados', async () => {
    prisma.providerProfile.findMany.mockResolvedValue([]);
    prisma.providerProfile.count.mockResolvedValue(0);

    const res = await request(app).get('/providers?ciudad=CiudadInexistente');

    expect(res.statusCode).toBe(200);
    expect(res.body.providers).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ============================================================
describe('GET /providers/me — perfil del proveedor autenticado', () => {
// ============================================================

  it('proveedor ve su propio perfil', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(perfilCompleto);

    const res = await request(app)
      .get('/providers/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.userId).toBe('proveedor-001');
    expect(res.body.cedulaStatus).toBe('sin_enviar');
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .get('/providers/me')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(403);
  });

  it('sin token recibe 401', async () => {
    const res = await request(app).get('/providers/me');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('POST /providers/me/cedula — enviar documento de identidad', () => {
// ============================================================

  it('proveedor envía URL de cédula válida', async () => {
    const perfilActualizado = { ...perfilCompleto, cedulaStatus: 'pendiente', cedulaUrl: 'https://drive.google.com/file/d/abc123/view', user: { nombre: 'Carlos Plomero', email: 'carlos@test.com' } };
    prisma.providerProfile.update.mockResolvedValue(perfilActualizado);

    const res = await request(app)
      .post('/providers/me/cedula')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ cedulaUrl: 'https://drive.google.com/file/d/abc123/view' });

    expect(res.statusCode).toBe(200);
    expect(res.body.cedulaStatus).toBe('pendiente');
    expect(res.body.mensaje).toMatch(/48 horas/);
    expect(prisma.providerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cedulaStatus: 'pendiente' }),
      })
    );
  });

  it('rechaza URL inválida', async () => {
    const res = await request(app)
      .post('/providers/me/cedula')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ cedulaUrl: 'no-es-una-url' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/URL inválida/);
  });

  it('rechaza si falta cedulaUrl', async () => {
    const res = await request(app)
      .post('/providers/me/cedula')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/requerida/);
  });

  it('cliente no puede enviar cédula (403)', async () => {
    const res = await request(app)
      .post('/providers/me/cedula')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ cedulaUrl: 'https://drive.google.com/file/d/abc' });

    expect(res.statusCode).toBe(403);
  });

  it('sin token recibe 401', async () => {
    const res = await request(app)
      .post('/providers/me/cedula')
      .send({ cedulaUrl: 'https://drive.google.com/file/d/abc' });

    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('PUT /providers/me — actualizar perfil del proveedor', () => {
// ============================================================

  it('proveedor actualiza bio y tarifa correctamente', async () => {
    const perfilActualizado = { ...perfilCompleto, bio: 'Bio actualizada', tarifaPorHora: 60000 };
    prisma.providerProfile.update.mockResolvedValue(perfilActualizado);

    const res = await request(app)
      .put('/providers/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ bio: 'Bio actualizada', tarifaPorHora: 60000 });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/actualizado/i);
    expect(prisma.providerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bio: 'Bio actualizada', tarifaPorHora: 60000 }),
      })
    );
  });

  it('actualiza servicios con IDs válidos del catálogo', async () => {
    const perfilActualizado = { ...perfilCompleto, servicios: ['aseo', 'jardineria'] };
    prisma.providerProfile.update.mockResolvedValue(perfilActualizado);

    const res = await request(app)
      .put('/providers/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ servicios: ['aseo', 'jardineria'] });

    expect(res.statusCode).toBe(200);
    expect(prisma.providerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ servicios: ['aseo', 'jardineria'] }),
      })
    );
  });

  it('rechaza servicios que no están en el catálogo (400)', async () => {
    const res = await request(app)
      .put('/providers/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ servicios: ['servicio-inventado', 'aseo'] });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/servicio-inventado/);
  });

  it('rechaza servicios que no es un array (400)', async () => {
    const res = await request(app)
      .put('/providers/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ servicios: 'plomeria' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/array/);
  });

  it('rechaza tarifa por debajo del mínimo ($5.000) (400)', async () => {
    const res = await request(app)
      .put('/providers/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ tarifaPorHora: 1000 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/5\.000/);
  });

  it('rechaza tarifa por encima del máximo ($5.000.000) (400)', async () => {
    const res = await request(app)
      .put('/providers/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ tarifaPorHora: 9999999 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/5\.000\.000/);
  });

  it('cliente no puede actualizar perfil de proveedor (403)', async () => {
    const res = await request(app)
      .put('/providers/me')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bio: 'Intento de actualización no autorizada' });

    expect(res.statusCode).toBe(403);
  });

  it('sin token recibe 401', async () => {
    const res = await request(app)
      .put('/providers/me')
      .send({ bio: 'Sin token' });

    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /providers/:id — perfil público de un proveedor', () => {
// ============================================================

  it('devuelve perfil con reseñas', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue({ ...perfilCompleto, reviews: [] });

    const res = await request(app).get('/providers/profile-001');

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('profile-001');
  });

  it('devuelve 404 si el proveedor no existe', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/providers/no-existe');

    expect(res.statusCode).toBe(404);
  });
});
