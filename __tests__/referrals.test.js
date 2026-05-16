const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    findMany:   jest.fn(),
  },
}));

const prisma = require('../src/lib/prisma');
const SECRET = process.env.JWT_SECRET || 'test_secret';

function token(id = 'user-001') {
  return jwt.sign({ id, email: 'user@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('GET /referrals/my — estadísticas de referidos', () => {
// ============================================================

  it('devuelve código, link y lista de referidos', async () => {
    prisma.user.findUnique.mockResolvedValue({ referralCode: 'JUAN1234', nombre: 'Juan' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'ref-001', nombre: 'Carlos M.', createdAt: new Date(), bookingsComoCliente: [{ id: 'b1' }] },
      { id: 'ref-002', nombre: 'Paola R.',  createdAt: new Date(), bookingsComoCliente: [] },
    ]);

    const res = await request(app)
      .get('/referrals/my')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.code).toBe('JUAN1234');
    expect(res.body.link).toContain('juan1234');
    expect(res.body.total).toBe(2);
    expect(res.body.completados).toBe(1);
    expect(res.body.pendientes).toBe(1);
    expect(res.body.ganado).toBeGreaterThan(0);
    expect(Array.isArray(res.body.lista)).toBe(true);
  });

  it('devuelve code:null si usuario aún no tiene código', async () => {
    prisma.user.findUnique.mockResolvedValue({ referralCode: null, nombre: 'Ana' });
    prisma.user.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/referrals/my')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.code).toBeNull();
    expect(res.body.total).toBe(0);
    expect(res.body.ganado).toBe(0);
  });

  it('lista referido COMPLETADO cuando tiene booking completado', async () => {
    prisma.user.findUnique.mockResolvedValue({ referralCode: 'DANIE2847', nombre: 'Daniel' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'ref-001', nombre: 'Pedro A.', createdAt: new Date(), bookingsComoCliente: [{ id: 'b1' }] },
    ]);

    const res = await request(app)
      .get('/referrals/my')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.lista[0].estado).toBe('COMPLETADO');
    expect(res.body.lista[0].recompensa).toBeGreaterThan(0);
  });

  it('lista referido PENDIENTE cuando no tiene bookings completados', async () => {
    prisma.user.findUnique.mockResolvedValue({ referralCode: 'DANIE2847', nombre: 'Daniel' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'ref-002', nombre: 'María J.', createdAt: new Date(), bookingsComoCliente: [] },
    ]);

    const res = await request(app)
      .get('/referrals/my')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.lista[0].estado).toBe('PENDIENTE');
    expect(res.body.lista[0].recompensa).toBeNull();
    expect(res.body.ganado).toBe(0);
  });

  it('devuelve 404 si usuario no existe', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/referrals/my')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(404);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/referrals/my');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /referrals/leaderboard — top referrers', () => {
// ============================================================

  it('devuelve leaderboard público sin auth', async () => {
    prisma.user.findMany.mockResolvedValue([
      { nombre: 'Diego P.', _count: { referrals: 23 } },
      { nombre: 'Sofía M.', _count: { referrals: 18 } },
    ]);

    const res = await request(app).get('/referrals/leaderboard');

    expect(res.statusCode).toBe(200);
    expect(res.body.leaderboard).toHaveLength(2);
    expect(res.body.leaderboard[0].referidos).toBe(23);
  });

  it('leaderboard vacío si nadie ha referido', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    const res = await request(app).get('/referrals/leaderboard');

    expect(res.statusCode).toBe(200);
    expect(res.body.leaderboard).toHaveLength(0);
  });
});

// ============================================================
describe('Reward tier logic', () => {
// ============================================================

  it('tier 1 (1–4 referidos): $15.000 por completado', async () => {
    prisma.user.findUnique.mockResolvedValue({ referralCode: 'TEST0001', nombre: 'Test' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'r1', nombre: 'A', createdAt: new Date(), bookingsComoCliente: [{ id: 'b1' }] },
    ]);

    const res = await request(app).get('/referrals/my').set('Authorization', `Bearer ${token()}`);
    expect(res.body.lista[0].recompensa).toBe(15000);
    expect(res.body.proxima_recompensa).toBe(15000);
  });

  it('tier 2 (5–9 referidos): $20.000 por completado', async () => {
    prisma.user.findUnique.mockResolvedValue({ referralCode: 'TEST0002', nombre: 'Test' });
    const cinco = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, nombre: `User${i}`, createdAt: new Date(),
      bookingsComoCliente: [{ id: `b${i}` }],
    }));
    prisma.user.findMany.mockResolvedValue(cinco);

    const res = await request(app).get('/referrals/my').set('Authorization', `Bearer ${token()}`);
    expect(res.body.lista[0].recompensa).toBe(20000);
    expect(res.body.proxima_recompensa).toBe(20000);
  });
});
