const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');

jest.mock('../src/lib/email', () => ({
  bienvenida:          jest.fn(),
  verificarEmail:      jest.fn().mockResolvedValue(undefined),
  reservaCreada:       jest.fn(),
  reservaConfirmada:   jest.fn(),
  recordatorio24h:     jest.fn(),
  servicioCompletado:  jest.fn(),
  nuevaResena:         jest.fn(),
  resetPassword:       jest.fn(),
  cedulaRecibida:      jest.fn().mockResolvedValue(undefined),
  cedulaAprobada:      jest.fn().mockResolvedValue(undefined),
  cedulaRechazada:     jest.fn().mockResolvedValue(undefined),
  disputaAdmin:        jest.fn().mockResolvedValue(undefined),
  disputaCliente:      jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/lib/prisma', () => ({
  user:            { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  booking:         { count: jest.fn(), aggregate: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  providerProfile: { count: jest.fn(), findMany: jest.fn(), update: jest.fn() },
}));

const prisma = require('../src/lib/prisma');
const email  = require('../src/lib/email');
const SECRET = process.env.JWT_SECRET || 'test_secret';

function tokenAdmin(id = 'admin-001') {
  return jwt.sign({ id, email: 'admin@dutyjoy.com', rol: 'ADMIN' }, SECRET, { expiresIn: '1h' });
}
function tokenCliente(id = 'cliente-001') {
  return jwt.sign({ id, email: 'juan@test.com', rol: 'CLIENTE' }, SECRET, { expiresIn: '1h' });
}

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('GET /admin/stats — dashboard metrics', () => {
// ============================================================

  it('admin obtiene estadísticas completas', async () => {
    prisma.user.count
      .mockResolvedValueOnce(100)  // total
      .mockResolvedValueOnce(80)   // clientes
      .mockResolvedValueOnce(20);  // proveedores
    prisma.booking.count
      .mockResolvedValueOnce(50)   // total
      .mockResolvedValueOnce(10)   // pendientes
      .mockResolvedValueOnce(30)   // completados
      .mockResolvedValueOnce(10);  // cancelados
    prisma.providerProfile.count
      .mockResolvedValueOnce(12)   // verificados
      .mockResolvedValueOnce(8)    // pendientes
      .mockResolvedValueOnce(3);   // cedulasPendientes
    prisma.booking.aggregate
      .mockResolvedValueOnce({ _sum: { precioTotal: 5000000 } })
      .mockResolvedValueOnce({ _sum: { comisionDutyJoy: 750000 } });

    const res = await request(app)
      .get('/admin/stats')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.usuarios.total).toBe(100);
    expect(res.body.usuarios.clientes).toBe(80);
    expect(res.body.usuarios.proveedores).toBe(20);
    expect(res.body.bookings.total).toBe(50);
    expect(res.body.bookings.pendientes).toBe(10);
    expect(res.body.proveedores.verificados).toBe(12);
    expect(res.body.proveedores.cedulasPendientes).toBe(3);
    expect(res.body.finanzas.ingresosTotales).toBe(5000000);
    expect(res.body.finanzas.comisionesDutyjoy).toBe(750000);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .get('/admin/stats')
      .set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });

  it('sin token recibe 401', async () => {
    const res = await request(app).get('/admin/stats');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('GET /admin/users — listar usuarios', () => {
// ============================================================

  it('admin lista usuarios', async () => {
    const fakeUser = { id: 'u-1', nombre: 'Juan', email: 'juan@test.com', rol: 'CLIENTE', activo: true, emailVerificado: false, ciudad: 'Bogotá', createdAt: new Date().toISOString(), _count: { bookingsComoCliente: 3 }, providerProfile: null };
    prisma.user.findMany.mockResolvedValue([fakeUser]);
    prisma.user.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.users[0].email).toBe('juan@test.com');
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('PATCH /admin/users/:id — editar usuario', () => {
// ============================================================

  it('admin puede desactivar un usuario', async () => {
    prisma.user.update.mockResolvedValue({ id: 'u-1', nombre: 'Juan', email: 'juan@test.com', rol: 'CLIENTE', activo: false });

    const res = await request(app)
      .patch('/admin/users/u-1')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ activo: false });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.activo).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activo: false }) })
    );
  });

  it('admin puede cambiar rol', async () => {
    prisma.user.update.mockResolvedValue({ id: 'u-1', nombre: 'Juan', email: 'juan@test.com', rol: 'PROVEEDOR', activo: true });

    const res = await request(app)
      .patch('/admin/users/u-1')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ rol: 'PROVEEDOR' });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.rol).toBe('PROVEEDOR');
  });
});

// ============================================================
describe('PATCH /admin/providers/:id/verify — verificar / aprobar / rechazar cédula', () => {
// ============================================================

  const fakeProfile = {
    id: 'prof-001',
    userId: 'proveedor-001',
    verificado: true,
    cedulaStatus: 'aprobado',
    cedulaNota: null,
    user: { nombre: 'Carlos Plomero', email: 'carlos@test.com' },
  };

  it('admin verifica manualmente un proveedor', async () => {
    prisma.providerProfile.update.mockResolvedValue({ ...fakeProfile, verificado: true, cedulaStatus: 'sin_enviar' });

    const res = await request(app)
      .patch('/admin/providers/prof-001/verify')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ verificado: true });

    expect(res.statusCode).toBe(200);
    expect(res.body.profile.verificado).toBe(true);
  });

  it('aprobar cédula establece verificado=true y envía email', async () => {
    prisma.providerProfile.update.mockResolvedValue(fakeProfile);

    const res = await request(app)
      .patch('/admin/providers/prof-001/verify')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ cedulaStatus: 'aprobado' });

    expect(res.statusCode).toBe(200);
    expect(res.body.profile.cedulaStatus).toBe('aprobado');
    expect(res.body.mensaje).toMatch(/aprobado/);
    // email fire-and-forget — verificar que se llamó
    await new Promise(r => setTimeout(r, 50));
    expect(email.cedulaAprobada).toHaveBeenCalledWith(
      expect.objectContaining({ proveedorEmail: 'carlos@test.com' })
    );
  });

  it('rechazar cédula guarda cedulaNota y envía email', async () => {
    prisma.providerProfile.update.mockResolvedValue({
      ...fakeProfile,
      cedulaStatus: 'rechazado',
      verificado: false,
      cedulaNota: 'Foto borrosa',
    });

    const res = await request(app)
      .patch('/admin/providers/prof-001/verify')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ cedulaStatus: 'rechazado', cedulaNota: 'Foto borrosa' });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/rechazado/);
    await new Promise(r => setTimeout(r, 50));
    expect(email.cedulaRechazada).toHaveBeenCalledWith(
      expect.objectContaining({ proveedorEmail: 'carlos@test.com', nota: 'Foto borrosa' })
    );
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .patch('/admin/providers/prof-001/verify')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ verificado: true });
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('PATCH /admin/bookings/:id — cambiar estado de reserva', () => {
// ============================================================

  it('admin cambia estado a COMPLETADO', async () => {
    prisma.booking.update.mockResolvedValue({ id: 'book-001', estado: 'COMPLETADO' });

    const res = await request(app)
      .patch('/admin/bookings/book-001')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ estado: 'COMPLETADO' });

    expect(res.statusCode).toBe(200);
    expect(res.body.booking.estado).toBe('COMPLETADO');
  });

  it('rechaza estado inválido', async () => {
    const res = await request(app)
      .patch('/admin/bookings/book-001')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ estado: 'INEXISTENTE' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Estado inválido/);
  });

  it('sin token recibe 401', async () => {
    const res = await request(app)
      .patch('/admin/bookings/book-001')
      .send({ estado: 'COMPLETADO' });
    expect(res.statusCode).toBe(401);
  });
});
