const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/prisma', () => ({
  notificacion: {
    findMany:    jest.fn(),
    count:       jest.fn(),
    updateMany:  jest.fn(),
    deleteMany:  jest.fn(),
  },
}));

const prisma = require('../src/lib/prisma');
const SECRET = process.env.JWT_SECRET || 'test_secret';

function token(id = 'user-001') {
  return jwt.sign({ id, email: 'user@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}

const notifBase = {
  id: 'notif-001', userId: 'user-001', tipo: 'booking_status',
  titulo: '✅ Reserva confirmada', mensaje: 'Carlos confirmó tu reserva',
  leida: false, data: null, createdAt: new Date().toISOString(),
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('GET /notifications — listar notificaciones', () => {
// ============================================================

  it('retorna notificaciones con total y badge count', async () => {
    prisma.notificacion.findMany.mockResolvedValue([notifBase]);
    prisma.notificacion.count
      .mockResolvedValueOnce(1)  // total
      .mockResolvedValueOnce(1); // noLeidas

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.noLeidas).toBe(1);
  });

  it('filtra solo no leídas con ?soloNoLeidas=true', async () => {
    prisma.notificacion.findMany.mockResolvedValue([notifBase]);
    prisma.notificacion.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/notifications?soloNoLeidas=true')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(prisma.notificacion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ leida: false }) })
    );
  });

  it('array vacío si no hay notificaciones', async () => {
    prisma.notificacion.findMany.mockResolvedValue([]);
    prisma.notificacion.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.notifications).toHaveLength(0);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/notifications');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /notifications/count — badge counter', () => {
// ============================================================

  it('retorna conteo de no leídas', async () => {
    prisma.notificacion.count.mockResolvedValue(5);

    const res = await request(app)
      .get('/notifications/count')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(5);
  });

  it('retorna 0 si todas leídas', async () => {
    prisma.notificacion.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/notifications/count')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/notifications/count');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('PATCH /notifications/:id/read — marcar como leída', () => {
// ============================================================

  it('marca una notificación como leída', async () => {
    prisma.notificacion.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/notifications/notif-001/read')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.notificacion.updateMany).toHaveBeenCalledWith({
      where: { id: 'notif-001', userId: 'user-001' },
      data:  { leida: true },
    });
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).patch('/notifications/notif-001/read');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('PATCH /notifications/read-all — marcar todas leídas', () => {
// ============================================================

  it('marca todas las notificaciones como leídas', async () => {
    prisma.notificacion.updateMany.mockResolvedValue({ count: 7 });

    const res = await request(app)
      .patch('/notifications/read-all')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.marked).toBe(7);
  });

  it('devuelve marked: 0 si ya todas leídas', async () => {
    prisma.notificacion.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/notifications/read-all')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.marked).toBe(0);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).patch('/notifications/read-all');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('DELETE /notifications/old — limpiar antiguas', () => {
// ============================================================

  it('borra notificaciones leídas de más de 30 días', async () => {
    prisma.notificacion.deleteMany.mockResolvedValue({ count: 12 });

    const res = await request(app)
      .delete('/notifications/old')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(12);
    // Verifica que solo borre leídas y antiguas
    expect(prisma.notificacion.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-001', leida: true }),
      })
    );
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).delete('/notifications/old');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('POST /notifications/device-token — registrar token push', () => {
// ============================================================

  it('registra token de dispositivo exitosamente', async () => {
    const res = await request(app)
      .post('/notifications/device-token')
      .set('Authorization', `Bearer ${token()}`)
      .send({ token: 'fcm-token-xyz', platform: 'android' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('registra token web sin platform explícito', async () => {
    const res = await request(app)
      .post('/notifications/device-token')
      .set('Authorization', `Bearer ${token()}`)
      .send({ token: 'web-push-token-abc' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('falla sin token en body (400)', async () => {
    const res = await request(app)
      .post('/notifications/device-token')
      .set('Authorization', `Bearer ${token()}`)
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/token requerido/);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app)
      .post('/notifications/device-token')
      .send({ token: 'xyz' });
    expect(res.statusCode).toBe(401);
  });
});
