const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/prisma', () => ({
  favorito: {
    findMany:   jest.fn(),
    upsert:     jest.fn(),
    deleteMany: jest.fn(),
  },
  providerProfile: {
    findUnique: jest.fn(),
  },
}));

const prisma = require('../src/lib/prisma');
const SECRET = process.env.JWT_SECRET || 'test_secret';

function tokenCliente(id = 'cliente-001') {
  return jwt.sign({ id, email: 'cliente@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}
function tokenProveedor(id = 'prov-001') {
  return jwt.sign({ id, email: 'prov@test.com', rol: 'PROVEEDOR' }, SECRET, { expiresIn: '1h' });
}

const perfilProveedor = {
  id: 'profile-001', userId: 'prov-001',
  calificacion: 4.8, disponible: true, verificado: true,
  user: { nombre: 'Carlos Plomero', ciudad: 'Bogotá' },
};

const favoritoRecord = {
  id: 'fav-001', clienteId: 'cliente-001', proveedorId: 'profile-001',
  proveedor: perfilProveedor,
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('GET /favorites — listar favoritos del cliente', () => {
// ============================================================

  it('cliente ve sus favoritos', async () => {
    prisma.favorito.findMany.mockResolvedValue([favoritoRecord]);

    const res = await request(app)
      .get('/favorites')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].favoritoId).toBe('fav-001');
  });

  it('devuelve array vacío si no hay favoritos', async () => {
    prisma.favorito.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/favorites')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/favorites');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /favorites/ids — IDs de favoritos', () => {
// ============================================================

  it('devuelve array de IDs de proveedores guardados', async () => {
    prisma.favorito.findMany.mockResolvedValue([{ proveedorId: 'profile-001' }, { proveedorId: 'profile-002' }]);

    const res = await request(app)
      .get('/favorites/ids')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(['profile-001', 'profile-002']);
  });

  it('devuelve array vacío si no hay favoritos', async () => {
    prisma.favorito.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/favorites/ids')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/favorites/ids');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('POST /favorites/:proveedorId — agregar favorito', () => {
// ============================================================

  it('cliente agrega proveedor a favoritos', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(perfilProveedor);
    prisma.favorito.upsert.mockResolvedValue({ id: 'fav-001' });

    const res = await request(app)
      .post('/favorites/profile-001')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.favoritoId).toBe('fav-001');
  });

  it('proveedor no puede guardar favoritos (403)', async () => {
    const res = await request(app)
      .post('/favorites/profile-001')
      .set('Authorization', `Bearer ${tokenProveedor()}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/proveedores no pueden/);
  });

  it('devuelve 404 si el proveedor no existe', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/favorites/no-existe')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/no encontrado/);
  });

  it('idempotente — guardar dos veces no falla (upsert)', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(perfilProveedor);
    prisma.favorito.upsert.mockResolvedValue({ id: 'fav-001' });

    await request(app).post('/favorites/profile-001').set('Authorization', `Bearer ${tokenCliente()}`);
    const res = await request(app).post('/favorites/profile-001').set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(201);
    expect(prisma.favorito.upsert).toHaveBeenCalledTimes(2);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).post('/favorites/profile-001');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('DELETE /favorites/:proveedorId — quitar favorito', () => {
// ============================================================

  it('cliente elimina favorito exitosamente', async () => {
    prisma.favorito.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .delete('/favorites/profile-001')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.favorito.deleteMany).toHaveBeenCalledWith({
      where: { clienteId: 'cliente-001', proveedorId: 'profile-001' },
    });
  });

  it('eliminar favorito que no existe no falla (deleteMany es idempotente)', async () => {
    prisma.favorito.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete('/favorites/no-guardado')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).delete('/favorites/profile-001');
    expect(res.statusCode).toBe(401);
  });
});
