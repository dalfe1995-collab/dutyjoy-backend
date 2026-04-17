const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/email', () => ({
  bienvenida:        jest.fn(),
  reservaCreada:     jest.fn(),
  reservaConfirmada: jest.fn(),
  recordatorio24h:   jest.fn(),
  servicioCompletado: jest.fn(),
  nuevaResena:       jest.fn(),
  resetPassword:     jest.fn(),
}));

jest.mock('../src/lib/prisma', () => ({
  review: {
    create:   jest.fn(),
    findMany: jest.fn(),
  },
  booking: {
    findUnique: jest.fn(),
  },
  providerProfile: {
    update: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
}));

const prisma = require('../src/lib/prisma');
const SECRET = process.env.JWT_SECRET || 'test_secret';

function tokenCliente(id = 'cliente-001') {
  return jwt.sign({ id, email: 'cliente@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}
function tokenProveedor(id = 'proveedor-001') {
  return jwt.sign({ id, email: 'proveedor@test.com', rol: 'PROVEEDOR' }, SECRET, { expiresIn: '1h' });
}

const reservaCompletada = {
  id:          'booking-001',
  clienteId:   'cliente-001',
  proveedorId: 'profile-001',
  estado:      'COMPLETADO',
  review:      null,
  proveedor: {
    user: { nombre: 'Carlos Plomero', email: 'carlos@test.com' },
  },
};

const reviewCreada = {
  id:          'review-001',
  bookingId:   'booking-001',
  clienteId:   'cliente-001',
  proveedorId: 'profile-001',
  calificacion: 5,
  comentario:  'Excelente trabajo',
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('POST /reviews — crear reseña', () => {
// ============================================================

  it('cliente crea reseña de servicio completado', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaCompletada);
    prisma.review.create.mockResolvedValue(reviewCreada);
    prisma.review.findMany.mockResolvedValue([reviewCreada]);
    prisma.providerProfile.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ nombre: 'Juan Prueba' });

    const res = await request(app)
      .post('/reviews')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001', calificacion: 5, comentario: 'Excelente trabajo' });

    expect(res.statusCode).toBe(201);
    expect(res.body.review.calificacion).toBe(5);
    expect(res.body.review.comentario).toBe('Excelente trabajo');
    // Verifica que se actualizó el promedio del proveedor
    expect(prisma.providerProfile.update).toHaveBeenCalledTimes(1);
  });

  it('rechaza si la reserva NO está completada', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...reservaCompletada, estado: 'CONFIRMADO' });

    const res = await request(app)
      .post('/reviews')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001', calificacion: 4 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/completados/);
  });

  it('rechaza si la reserva ya tiene reseña (no duplicar)', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...reservaCompletada, review: reviewCreada });

    const res = await request(app)
      .post('/reviews')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001', calificacion: 3 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Ya dejaste una reseña/);
  });

  it('rechaza calificación fuera de rango (1-5)', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaCompletada);

    const res = await request(app)
      .post('/reviews')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001', calificacion: 10 }); // fuera de rango

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/entre 1 y 5/);
  });

  it('rechaza si el cliente reseña una reserva que no es suya', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...reservaCompletada,
      clienteId: 'otro-cliente-999', // reserva de otro cliente
    });

    const res = await request(app)
      .post('/reviews')
      .set('Authorization', `Bearer ${tokenCliente('cliente-001')}`)
      .send({ bookingId: 'booking-001', calificacion: 5 });

    expect(res.statusCode).toBe(403);
  });

  it('proveedor NO puede dejar reseñas', async () => {
    const res = await request(app)
      .post('/reviews')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ bookingId: 'booking-001', calificacion: 5 });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/clientes/);
  });

  it('rechaza si faltan campos requeridos', async () => {
    const res = await request(app)
      .post('/reviews')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ comentario: 'Sin calificación ni bookingId' });

    expect(res.statusCode).toBe(400);
  });

  it('rechaza sin autenticación (401)', async () => {
    const res = await request(app).post('/reviews').send({});
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /reviews/provider/:id — reseñas públicas', () => {
// ============================================================

  it('devuelve reseñas de un proveedor (ruta pública)', async () => {
    prisma.review.findMany.mockResolvedValue([reviewCreada]);

    const res = await request(app).get('/reviews/provider/profile-001');

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].calificacion).toBe(5);
  });

  it('devuelve array vacío si el proveedor no tiene reseñas', async () => {
    prisma.review.findMany.mockResolvedValue([]);

    const res = await request(app).get('/reviews/provider/perfil-sin-reviews');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('es pública — no requiere token', async () => {
    prisma.review.findMany.mockResolvedValue([]);
    // Sin Authorization header
    const res = await request(app).get('/reviews/provider/cualquier-id');
    expect(res.statusCode).toBe(200);
  });
});
