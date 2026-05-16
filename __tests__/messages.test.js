const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/push', () => ({ sendPush: jest.fn().mockResolvedValue(undefined) }));

jest.mock('../src/lib/prisma', () => ({
  booking: {
    findMany:    jest.fn(),
    findUnique:  jest.fn(),
  },
  mensajeChat: {
    findMany:    jest.fn(),
    create:      jest.fn(),
    count:       jest.fn(),
    updateMany:  jest.fn(),
    delete:      jest.fn(),
  },
  notificacion: {
    create: jest.fn().mockResolvedValue({ id: 'notif-001' }),
  },
}));

const prisma = require('../src/lib/prisma');
const SECRET = process.env.JWT_SECRET || 'test_secret';

function tokenCliente(id = 'cliente-001') {
  return jwt.sign({ id, email: 'cliente@test.com', rol: 'CLIENTE', nombre: 'Juan Cliente' }, SECRET, { expiresIn: '1h' });
}
function tokenProveedor(id = 'prov-001') {
  return jwt.sign({ id, email: 'prov@test.com', rol: 'PROVEEDOR', nombre: 'Carlos Plomero' }, SECRET, { expiresIn: '1h' });
}

const reservaActiva = {
  id: 'booking-001',
  clienteId: 'cliente-001',
  estado: 'CONFIRMADO',
  proveedor: { userId: 'prov-001' },
};

const mensajeBase = {
  id: 'msg-001',
  bookingId: 'booking-001',
  autorId: 'cliente-001',
  contenido: 'Hola, estoy listo',
  tipo: 'texto',
  leido: false,
  createdAt: new Date().toISOString(),
  autor: { id: 'cliente-001', nombre: 'Juan', rol: 'CLIENTE' },
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('GET /messages/:bookingId — cargar mensajes', () => {
// ============================================================

  it('cliente carga mensajes de su reserva', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    prisma.mensajeChat.findMany.mockResolvedValue([mensajeBase]);
    prisma.mensajeChat.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .get('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe('msg-001');
  });

  it('proveedor carga mensajes de su reserva', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    prisma.mensajeChat.findMany.mockResolvedValue([mensajeBase]);
    prisma.mensajeChat.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .get('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenProveedor()}`);

    expect(res.statusCode).toBe(200);
  });

  it('tercero no tiene acceso (403)', async () => {
    const otroToken = jwt.sign({ id: 'otro-999', email: 'otro@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
    prisma.booking.findUnique.mockResolvedValue(reservaActiva); // clienteId='cliente-001', prov='prov-001'

    const res = await request(app)
      .get('/messages/booking-001')
      .set('Authorization', `Bearer ${otroToken}`);

    expect(res.statusCode).toBe(403);
  });

  it('devuelve 404 si booking no existe', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/messages/no-existe')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(404);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/messages/booking-001');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('POST /messages/:bookingId — enviar mensaje', () => {
// ============================================================

  it('cliente envía mensaje de texto exitosamente', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    prisma.mensajeChat.create.mockResolvedValue({ ...mensajeBase, id: 'msg-002', contenido: 'Hola' });

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: 'Hola, estoy listo' });

    expect(res.statusCode).toBe(201);
    expect(res.body.mensaje).toBeDefined();
  });

  it('mensaje vacío devuelve 400', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: '   ' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/vacío/);
  });

  it('mensaje mayor a 2000 chars devuelve 400', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: 'a'.repeat(2001) });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/2000/);
  });

  it('no se pueden enviar mensajes en reservas CANCELADAS (400)', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...reservaActiva, estado: 'CANCELADO' });

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: 'Hola' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/canceladas/);
  });

  it('no se pueden enviar mensajes en reservas COMPLETADAS (400)', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...reservaActiva, estado: 'COMPLETADO' });

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: 'Hola' });

    expect(res.statusCode).toBe(400);
  });

  it('detecta teléfono colombiano e inserta mensaje de sistema', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    const msgConTelefono = { ...mensajeBase, contenido: 'Llámame al 314 555 7890' };
    const msgSistema = { ...mensajeBase, id: 'msg-warn', tipo: 'sistema', contenido: '⚠️ *DutyJoy*' };
    prisma.mensajeChat.create
      .mockResolvedValueOnce(msgConTelefono)
      .mockResolvedValueOnce(msgSistema);

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: 'Llámame al 314 555 7890' });

    expect(res.statusCode).toBe(201);
    expect(res.body.contactDetected).toBe(true);
    expect(prisma.mensajeChat.create).toHaveBeenCalledTimes(2);
  });

  it('detecta email y activa warning de contacto externo', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    const msgConEmail = { ...mensajeBase, contenido: 'Escríbeme a juan@gmail.com' };
    const msgSistema  = { ...mensajeBase, id: 'msg-warn', tipo: 'sistema' };
    prisma.mensajeChat.create
      .mockResolvedValueOnce(msgConEmail)
      .mockResolvedValueOnce(msgSistema);

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: 'Escríbeme a juan@gmail.com' });

    expect(res.statusCode).toBe(201);
    expect(res.body.contactDetected).toBe(true);
  });

  it('mensaje sin teléfono no activa warning', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    prisma.mensajeChat.create.mockResolvedValue(mensajeBase);

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ contenido: 'Perfecto, nos vemos mañana a las 8am' });

    expect(res.statusCode).toBe(201);
    expect(res.body.contactDetected).toBeFalsy();
    expect(prisma.mensajeChat.create).toHaveBeenCalledTimes(1);
  });

  it('tercero no puede enviar mensajes (403)', async () => {
    const otroToken = jwt.sign({ id: 'otro-999', email: 'otro@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);

    const res = await request(app)
      .post('/messages/booking-001')
      .set('Authorization', `Bearer ${otroToken}`)
      .send({ contenido: 'Mensaje no autorizado' });

    expect(res.statusCode).toBe(403);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).post('/messages/booking-001').send({ contenido: 'Hola' });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /messages/:bookingId/unread — mensajes no leídos', () => {
// ============================================================

  it('devuelve conteo de mensajes no leídos', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    prisma.mensajeChat.count.mockResolvedValue(3);

    const res = await request(app)
      .get('/messages/booking-001/unread')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(3);
  });

  it('devuelve 0 si todos leídos', async () => {
    prisma.booking.findUnique.mockResolvedValue(reservaActiva);
    prisma.mensajeChat.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/messages/booking-001/unread')
      .set('Authorization', `Bearer ${tokenCliente()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(0);
  });
});
