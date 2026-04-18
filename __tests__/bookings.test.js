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
  disputaAdmin:      jest.fn().mockResolvedValue(undefined),
  disputaCliente:    jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/lib/prisma', () => ({
  booking: {
    create:     jest.fn(),
    findMany:   jest.fn(),
    findUnique: jest.fn(),
    update:     jest.fn(),
  },
  providerProfile: {
    findUnique: jest.fn(),
  },
}));

const prisma = require('../src/lib/prisma');

const SECRET = process.env.JWT_SECRET || 'test_secret';

// ── Helpers para generar tokens de prueba ────────────────────────────────
function tokenCliente(id = 'cliente-001') {
  return jwt.sign({ id, email: 'cliente@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}
function tokenProveedor(id = 'proveedor-001') {
  return jwt.sign({ id, email: 'proveedor@test.com', rol: 'PROVEEDOR' }, SECRET, { expiresIn: '1h' });
}
function tokenAdmin(id = 'admin-001') {
  return jwt.sign({ id, email: 'admin@dutyjoy.com', rol: 'ADMIN' }, SECRET, { expiresIn: '1h' });
}

// ── Datos de prueba ───────────────────────────────────────────────────────
const perfilProveedor = {
  id:           'profile-proveedor-001',
  userId:       'proveedor-001',
  tarifaPorHora: 50000,
  calificacion:  4.5,
  disponible:    true,
  servicios:     ['plomeria', 'electricidad'],
};

const reservaBase = {
  id:             'booking-001',
  clienteId:      'cliente-001',
  proveedorId:    'profile-proveedor-001',
  tipoServicio:   'plomeria',
  descripcion:    'Reparar tubería',
  fechaServicio:  new Date('2026-05-01T09:00:00').toISOString(),
  duracionHoras:  2,
  precioTotal:    100000,
  comisionDutyJoy: 15000,
  estado:         'PENDIENTE',
  review:         null,
  proveedor: {
    user: { nombre: 'Carlos Plomero', email: 'carlos@test.com' },
  },
  cliente: { nombre: 'Juan Prueba', email: 'juan@test.com' },
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('POST /bookings — crear reserva', () => {
// ============================================================

  it('cliente crea reserva exitosamente', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(perfilProveedor);
    prisma.booking.create.mockResolvedValue(reservaBase);

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({
        proveedorId:   'profile-proveedor-001',
        tipoServicio:  'plomeria',
        descripcion:   'Reparar tubería',
        fechaServicio: '2026-05-01T09:00:00',
        duracionHoras: 2,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.booking.estado).toBe('PENDIENTE');
    expect(res.body.booking.clienteId).toBe('cliente-001');
  });

  it('calcula precio total correctamente (tarifa × horas)', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(perfilProveedor); // $50.000/hora
    prisma.booking.create.mockResolvedValue({ ...reservaBase, precioTotal: 150000, duracionHoras: 3 });

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({
        proveedorId:   'profile-proveedor-001',
        tipoServicio:  'plomeria',
        fechaServicio: '2026-05-01T09:00:00',
        duracionHoras: 3,
      });

    expect(res.statusCode).toBe(201);
    // Verifica que se llamó create con el precio correcto: 50000 × 3 = 150000
    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ precioTotal: 150000 })
      })
    );
  });

  it('proveedor NO puede crear reservas (403)', async () => {
    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ proveedorId: 'x', tipoServicio: 'plomeria', fechaServicio: '2026-05-01' });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/clientes/);
  });

  it('devuelve 404 si el proveedor no existe', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ proveedorId: 'no-existe', tipoServicio: 'plomeria', fechaServicio: '2026-05-01' });

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Proveedor no encontrado/);
  });

  it('devuelve 400 si faltan campos requeridos', async () => {
    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ tipoServicio: 'plomeria' }); // falta proveedorId y fechaServicio

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/requeridos/);
  });

  it('rechaza sin autenticación (401)', async () => {
    const res = await request(app).post('/bookings').send({});
    expect(res.statusCode).toBe(401);
  });

  it('rechaza fecha en el pasado (400)', async () => {
    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({
        proveedorId:   'profile-proveedor-001',
        tipoServicio:  'plomeria',
        fechaServicio: '2020-01-01T09:00:00',
        duracionHoras: 2,
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/futuro/);
  });

  it('rechaza si el proveedor no está disponible (400)', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue({ ...perfilProveedor, disponible: false });

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({
        proveedorId:   'profile-proveedor-001',
        tipoServicio:  'plomeria',
        fechaServicio: '2026-05-01T09:00:00',
        duracionHoras: 2,
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/disponible/);
  });

  it('rechaza servicio que el proveedor no ofrece (400)', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(perfilProveedor);

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({
        proveedorId:   'profile-proveedor-001',
        tipoServicio:  'jardineria', // no está en servicios del proveedor
        fechaServicio: '2026-05-01T09:00:00',
        duracionHoras: 2,
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/jardineria/);
  });
});

// ============================================================
describe('GET /bookings/me — mis reservas', () => {
// ============================================================

  it('cliente ve sus propias reservas', async () => {
    prisma.booking.findMany.mockResolvedValue([reservaBase]);

    const res = await request(app)
      .get('/bookings/me')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('proveedor ve las reservas de su perfil', async () => {
    prisma.providerProfile.findUnique.mockResolvedValue(perfilProveedor);
    prisma.booking.findMany.mockResolvedValue([reservaBase]);

    const res = await request(app)
      .get('/bookings/me')
      .set('Authorization', `Bearer ${tokenProveedor()}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('admin recibe 403 (debe usar /admin/bookings)', async () => {
    const res = await request(app)
      .get('/bookings/me')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(403);
  });

  it('rechaza sin token (401)', async () => {
    const res = await request(app).get('/bookings/me');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('PATCH /bookings/:id/status — cambiar estado', () => {
// ============================================================

  it('proveedor puede confirmar una reserva pendiente', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaBase);
    prisma.providerProfile.findUnique.mockResolvedValue(perfilProveedor);
    prisma.booking.update.mockResolvedValue({ ...reservaBase, estado: 'CONFIRMADO' });

    const res = await request(app)
      .patch('/bookings/booking-001/status')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ estado: 'CONFIRMADO' });

    expect(res.statusCode).toBe(200);
    expect(res.body.booking.estado).toBe('CONFIRMADO');
  });

  it('cliente puede cancelar una reserva', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaBase);
    prisma.providerProfile.findUnique.mockResolvedValue(null);
    prisma.booking.update.mockResolvedValue({ ...reservaBase, estado: 'CANCELADO' });

    const res = await request(app)
      .patch('/bookings/booking-001/status')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ estado: 'CANCELADO' });

    expect(res.statusCode).toBe(200);
    expect(res.body.booking.estado).toBe('CANCELADO');
  });

  it('cliente NO puede confirmar (solo puede cancelar)', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaBase);
    prisma.providerProfile.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/bookings/booking-001/status')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ estado: 'CONFIRMADO' });

    expect(res.statusCode).toBe(403);
  });

  it('rechaza un estado inválido', async () => {
    const res = await request(app)
      .patch('/bookings/booking-001/status')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ estado: 'ESTADO_INVENTADO' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Estado inválido/);
  });

  it('devuelve 404 si la reserva no existe', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/bookings/no-existe/status')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ estado: 'CONFIRMADO' });

    expect(res.statusCode).toBe(404);
  });

  it('tercero no puede modificar una reserva ajena (403)', async () => {
    // Reserva es del cliente-001, pero el token es de otro cliente
    const otroToken = jwt.sign({ id: 'otro-cliente-999', email: 'otro@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });

    prisma.booking.findUnique.mockResolvedValue(reservaBase); // clienteId = 'cliente-001'
    prisma.providerProfile.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/bookings/booking-001/status')
      .set('Authorization', `Bearer ${otroToken}`)
      .send({ estado: 'CANCELADO' });

    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('POST /bookings/:id/report — reportar problema', () => {
// ============================================================

  it('cliente reporta problema exitosamente', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaBase);

    const res = await request(app)
      .post('/bookings/booking-001/report')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ mensaje: 'El proveedor no llegó a la cita acordada' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mensaje).toMatch(/24 horas/);
  });

  it('devuelve 400 si el mensaje está vacío', async () => {
    const res = await request(app)
      .post('/bookings/booking-001/report')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ mensaje: '' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/requerido/);
  });

  it('devuelve 400 si el mensaje es muy corto', async () => {
    const res = await request(app)
      .post('/bookings/booking-001/report')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ mensaje: 'Corto' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/10 caracteres/);
  });

  it('proveedor NO puede reportar problemas (403)', async () => {
    const res = await request(app)
      .post('/bookings/booking-001/report')
      .set('Authorization', `Bearer ${tokenProveedor()}`)
      .send({ mensaje: 'Intento de reporte no autorizado' });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/clientes/);
  });

  it('devuelve 404 si la reserva no existe', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/bookings/no-existe/report')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ mensaje: 'Reserva que no existe en la base de datos' });

    expect(res.statusCode).toBe(404);
  });

  it('cliente no puede reportar una reserva ajena (403)', async () => {
    const otroToken = jwt.sign({ id: 'otro-cliente-999', email: 'otro@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
    prisma.booking.findUnique.mockResolvedValue(reservaBase); // clienteId = 'cliente-001'

    const res = await request(app)
      .post('/bookings/booking-001/report')
      .set('Authorization', `Bearer ${otroToken}`)
      .send({ mensaje: 'Intento de reportar reserva ajena sin permiso' });

    expect(res.statusCode).toBe(403);
  });

  it('rechaza sin autenticación (401)', async () => {
    const res = await request(app)
      .post('/bookings/booking-001/report')
      .send({ mensaje: 'Sin token de autenticación presente' });

    expect(res.statusCode).toBe(401);
  });
});
