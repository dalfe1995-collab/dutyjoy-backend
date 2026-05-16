const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/email', () => {
  const fn = () => jest.fn().mockResolvedValue(undefined);
  return {
    pagoConfirmadoProveedor: fn(),
    reservaConfirmada:       fn(),
  };
});

jest.mock('../src/lib/prisma', () => ({
  booking: {
    findUnique: jest.fn(),
    update:     jest.fn(),
  },
  providerProfile: {
    update: jest.fn(),
  },
}));

// Mock MercadoPago SDK
jest.mock('mercadopago', () => {
  const mockCreate = jest.fn();
  return {
    MercadoPagoConfig: jest.fn(),
    Preference: jest.fn().mockImplementation(() => ({ create: mockCreate })),
    Payment:    jest.fn().mockImplementation(() => ({ get: jest.fn() })),
    __mockCreate: mockCreate,
  };
});

const prisma   = require('../src/lib/prisma');
const mp       = require('mercadopago');
const SECRET   = process.env.JWT_SECRET || 'test_secret';

function tokenCliente(id = 'cliente-001') {
  return jwt.sign({ id, email: 'cliente@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}
function tokenProveedor(id = 'prov-001') {
  return jwt.sign({ id, email: 'prov@test.com', rol: 'PROVEEDOR' }, SECRET, { expiresIn: '1h' });
}

const reservaPendiente = {
  id:           'booking-001',
  clienteId:    'cliente-001',
  proveedorId:  'profile-001',
  tipoServicio: 'plomeria',
  descripcion:  'Reparar tubería',
  duracionHoras: 2,
  precioTotal:  100000,
  estado:       'PENDIENTE',
  proveedor: { user: { nombre: 'Carlos Plomero' } },
  cliente:   { nombre: 'Juan Cliente', email: 'juan@test.com' },
};

beforeEach(() => {
  jest.clearAllMocks();
  // Ensure MP_ACCESS_TOKEN is set for tests
  process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
  mp.__mockCreate.mockResolvedValue({ id: 'pref-001', init_point: 'https://mp.com/pay', sandbox_init_point: 'https://sandbox.mp.com/pay' });
});

// ============================================================
describe('POST /payments/create — generar preferencia de pago', () => {
// ============================================================

  it('cliente genera preferencia de pago exitosamente', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaPendiente);

    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001' });

    expect(res.statusCode).toBe(200);
    expect(res.body.preference_id).toBe('pref-001');
    expect(res.body.checkout_url).toContain('mp.com');
  });

  it('falla si bookingId no se envía (400)', async () => {
    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/bookingId/);
  });

  it('devuelve 404 si booking no existe', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'no-existe' });

    expect(res.statusCode).toBe(404);
  });

  it('cliente ajeno no puede pagar (403)', async () => {
    const otroToken = jwt.sign({ id: 'otro-999', email: 'otro@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
    prisma.booking.findUnique.mockResolvedValue(reservaPendiente); // clienteId = 'cliente-001'

    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${otroToken}`)
      .send({ bookingId: 'booking-001' });

    expect(res.statusCode).toBe(403);
  });

  it('no se puede pagar una reserva COMPLETADA (400)', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...reservaPendiente, estado: 'COMPLETADO' });

    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/pendientes o confirmadas/);
  });

  it('no se puede pagar una reserva CANCELADA (400)', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...reservaPendiente, estado: 'CANCELADO' });

    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001' });

    expect(res.statusCode).toBe(400);
  });

  it('devuelve 503 si MP_ACCESS_TOKEN no está configurado', async () => {
    delete process.env.MP_ACCESS_TOKEN;

    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ bookingId: 'booking-001' });

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/MP_ACCESS_TOKEN/);

    process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN'; // restore
  });

  it('proveedor no puede crear preferencia de pago', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaPendiente);

    const res = await request(app)
      .post('/payments/create')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ bookingId: 'booking-001' });

    // Should fail — clienteId doesn't match proveedor token id
    expect(res.statusCode).toBe(403);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).post('/payments/create').send({ bookingId: 'x' });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /payments/status/:bookingId — estado de pago', () => {
// ============================================================

  it('cliente ve estado de pago de su reserva', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaPendiente);

    const res = await request(app)
      .get('/payments/status/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.estado).toBe('PENDIENTE');
  });

  it('devuelve 404 si booking no existe', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/payments/status/no-existe')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(404);
  });

  it('cliente ajeno no puede ver estado (403)', async () => {
    const otroToken = jwt.sign({ id: 'otro-999', email: 'otro@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
    prisma.booking.findUnique.mockResolvedValue(reservaPendiente);

    const res = await request(app)
      .get('/payments/status/booking-001')
      .set('Authorization', `Bearer ${otroToken}`);

    expect(res.statusCode).toBe(403);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/payments/status/booking-001');
    expect(res.statusCode).toBe(401);
  });
});
