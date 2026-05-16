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
  booking:         { count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  providerProfile: { count: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  disputa:         { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn() },
  review:          { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn() },
  crmTag:          { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  crmTagAsignacion:{ upsert: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
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
describe('GET /admin/users/:id — detalle de un usuario', () => {
// ============================================================

  const fakeUserDetail = {
    id: 'u-1',
    nombre: 'Juan',
    email: 'juan@test.com',
    rol: 'CLIENTE',
    activo: true,
    emailVerificado: true,
    ciudad: 'Bogotá',
    createdAt: new Date().toISOString(),
    providerProfile: null,
    bookingsComoCliente: [],
  };

  it('admin obtiene detalle completo de un usuario', async () => {
    prisma.user.findUnique.mockResolvedValue(fakeUserDetail);

    const res = await request(app)
      .get('/admin/users/u-1')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('u-1');
    expect(res.body.email).toBe('juan@test.com');
    // Nunca devuelve password
    expect(res.body.password).toBeUndefined();
  });

  it('devuelve 404 si el usuario no existe', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/admin/users/no-existe')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/no encontrado/i);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .get('/admin/users/u-1')
      .set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('GET /admin/providers — listar proveedores CRM', () => {
// ============================================================

  const fakeProvider = {
    id: 'prof-001',
    userId: 'u-1',
    verificado: false,
    cedulaStatus: 'pendiente',
    cedulaUrl: 'https://drive.google.com/file/d/abc/view',
    cedulaNota: null,
    calificacion: 4.2,
    tarifaPorHora: 50000,
    createdAt: new Date().toISOString(),
    user: { nombre: 'Carlos', email: 'carlos@test.com', telefono: '3001234567', ciudad: 'Bogotá', createdAt: new Date().toISOString() },
    _count: { bookings: 3, reviews: 2 },
  };

  it('admin lista todos los proveedores', async () => {
    prisma.providerProfile.findMany.mockResolvedValue([fakeProvider]);
    prisma.providerProfile.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/admin/providers')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.providers[0].cedulaStatus).toBe('pendiente');
  });

  it('filtra por cédula pendiente', async () => {
    prisma.providerProfile.findMany.mockResolvedValue([fakeProvider]);
    prisma.providerProfile.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/admin/providers?cedulaStatus=pendiente')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .get('/admin/providers')
      .set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });

  it('sin token recibe 401', async () => {
    const res = await request(app).get('/admin/providers');
    expect(res.statusCode).toBe(401);
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

// ============================================================
describe('GET /admin/leaderboard — top proveedores', () => {
// ============================================================

  it('admin obtiene leaderboard de proveedores', async () => {
    prisma.providerProfile.findMany.mockResolvedValue([
      { id: 'p1', calificacion: 4.9, reservasCompletadas: 50, totalReviews: 12,
        tasaAceptacion: 0.95, verificado: true, tarifaPorHora: 60000,
        user: { nombre: 'Carlos', ciudad: 'Bogotá', email: 'c@t.com' } },
    ]);
    prisma.booking.groupBy.mockResolvedValue([
      { proveedorId: 'p1', _sum: { precioTotal: 3000000 } },
    ]);

    const res = await request(app)
      .get('/admin/leaderboard')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.leaderboard).toHaveLength(1);
    expect(res.body.leaderboard[0].rank).toBe(1);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app).get('/admin/leaderboard').set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('GET /admin/stats/monthly — ingresos mensuales', () => {
// ============================================================

  it('admin obtiene datos mensuales', async () => {
    // 6 months × (aggregate + count) = 12 calls — use persistent mocks
    prisma.booking.aggregate.mockResolvedValue({ _sum: { precioTotal: 500000, comisionDutyJoy: 75000 } });
    prisma.booking.count.mockResolvedValue(5);

    const res = await request(app)
      .get('/admin/stats/monthly')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.months).toBeDefined();
    expect(Array.isArray(res.body.months)).toBe(true);
    expect(res.body.months).toHaveLength(6);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app).get('/admin/stats/monthly').set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('GET /admin/bookings — listar todas las reservas', () => {
// ============================================================

  it('admin lista reservas con paginación', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', estado: 'PENDIENTE', precioTotal: 80000,
        cliente: { nombre: 'Juan', email: 'j@t.com' },
        proveedor: { user: { nombre: 'Carlos' } } },
    ]);
    prisma.booking.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/admin/bookings')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('filtra por estado', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/admin/bookings?estado=CANCELADO')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ estado: 'CANCELADO' }) })
    );
  });

  it('cliente recibe 403', async () => {
    const res = await request(app).get('/admin/bookings').set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('GET /admin/disputes — listar disputas', () => {
// ============================================================

  const disputaBase = {
    id: 'disp-001', estado: 'abierta', mensaje: 'Proveedor no llegó',
    createdAt: new Date(), updatedAt: new Date(),
    cliente: { nombre: 'Juan', email: 'j@t.com' },
    booking: { tipoServicio: 'plomeria', fechaServicio: new Date(), precioTotal: 80000,
               estado: 'CONFIRMADO', proveedor: { user: { nombre: 'Carlos' } } },
  };

  it('admin lista disputas', async () => {
    prisma.disputa.findMany.mockResolvedValue([disputaBase]);
    prisma.disputa.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/admin/disputes')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.disputes).toHaveLength(1);
    expect(res.body.stats).toBeDefined();
  });

  it('filtra por estado', async () => {
    prisma.disputa.findMany.mockResolvedValue([]);
    prisma.disputa.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/admin/disputes?estado=en_revision')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(prisma.disputa.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ estado: 'en_revision' }) })
    );
  });

  it('cliente recibe 403', async () => {
    const res = await request(app).get('/admin/disputes').set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('PATCH /admin/disputes/:id — actualizar disputa', () => {
// ============================================================

  it('admin resuelve disputa con nota', async () => {
    prisma.disputa.update.mockResolvedValue({ id: 'disp-001', estado: 'resuelta', resolucion: 'Reembolso aprobado' });

    const res = await request(app)
      .patch('/admin/disputes/disp-001')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ estado: 'resuelta', resolucion: 'Reembolso aprobado' });

    expect(res.statusCode).toBe(200);
    expect(res.body.disputa.estado).toBe('resuelta');
  });

  it('rechaza estado inválido (400)', async () => {
    const res = await request(app)
      .patch('/admin/disputes/disp-001')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ estado: 'estado_inventado' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Estado inválido/);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .patch('/admin/disputes/disp-001')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ estado: 'resuelta' });
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('POST /admin/disputes/:id/ai-resolve — IA auto-resolución', () => {
// ============================================================

  it('devuelve 503 si OpenAI no está configurado', async () => {
    // openai is null when OPENAI_API_KEY is absent (default in test env)
    const res = await request(app)
      .post('/admin/disputes/disp-001/ai-resolve')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/OPENAI_API_KEY/);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .post('/admin/disputes/disp-001/ai-resolve')
      .set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('GET /admin/reviews/flagged — reseñas con fraude detectado', () => {
// ============================================================

  it('admin ve reseñas marcadas con fraude', async () => {
    prisma.review.findMany.mockResolvedValue([
      { id: 'rev-001', fraudScore: 0.9, calificacion: 5, comentario: 'Excelente!!',
        fraudFlags: ['texto_generico'], fraudOculta: false,
        cliente: { nombre: 'Juan', email: 'j@t.com' },
        proveedor: { user: { nombre: 'Carlos' } },
        booking: { tipoServicio: 'plomeria', fechaServicio: new Date() } },
    ]);
    prisma.review.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/admin/reviews/flagged')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.stats).toBeDefined();
  });

  it('cliente recibe 403', async () => {
    const res = await request(app).get('/admin/reviews/flagged').set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('PATCH /admin/reviews/:id/visibility — ocultar/mostrar reseña', () => {
// ============================================================

  it('admin oculta una reseña fraudulenta', async () => {
    prisma.review.update.mockResolvedValue({ id: 'rev-001', fraudOculta: true });

    const res = await request(app)
      .patch('/admin/reviews/rev-001/visibility')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ oculta: true });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/ocultada/);
  });

  it('admin restaura una reseña', async () => {
    prisma.review.update.mockResolvedValue({ id: 'rev-001', fraudOculta: false });

    const res = await request(app)
      .patch('/admin/reviews/rev-001/visibility')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ oculta: false });

    expect(res.statusCode).toBe(200);
    expect(res.body.mensaje).toMatch(/restaurada/);
  });

  it('falla si oculta no es boolean (400)', async () => {
    const res = await request(app)
      .patch('/admin/reviews/rev-001/visibility')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ oculta: 1 });  // number, not boolean

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/true o false/);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app)
      .patch('/admin/reviews/rev-001/visibility')
      .set('Authorization', `Bearer ${tokenCliente()}`)
      .send({ oculta: true });
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('GET /admin/tags — listar CRM tags', () => {
// ============================================================

  it('admin lista tags', async () => {
    prisma.crmTag.findMany.mockResolvedValue([
      { id: 'tag-001', nombre: 'VIP', color: '#FFD93D', descripcion: 'Cliente premium', _count: { asignaciones: 3 } },
    ]);

    const res = await request(app)
      .get('/admin/tags')
      .set('Authorization', `Bearer ${tokenAdmin()}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.tags)).toBe(true);
    expect(res.body.tags[0].nombre).toBe('VIP');
  });

  it('cliente recibe 403', async () => {
    const res = await request(app).get('/admin/tags').set('Authorization', `Bearer ${tokenCliente()}`);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
describe('POST /admin/tags — crear tag', () => {
// ============================================================

  it('admin crea un tag nuevo', async () => {
    prisma.crmTag.create.mockResolvedValue({ id: 'tag-002', nombre: 'Recurrente', color: '#0ABFBC' });

    const res = await request(app)
      .post('/admin/tags')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ nombre: 'Recurrente', color: '#0ABFBC' });

    expect(res.statusCode).toBe(201);
    expect(res.body.tag.nombre).toBe('Recurrente');
  });

  it('falla sin nombre (400)', async () => {
    const res = await request(app)
      .post('/admin/tags')
      .set('Authorization', `Bearer ${tokenAdmin()}`)
      .send({ color: '#FF0000' });

    expect(res.statusCode).toBe(400);
  });

  it('cliente recibe 403', async () => {
    const res = await request(app).post('/admin/tags').set('Authorization', `Bearer ${tokenCliente()}`).send({ nombre: 'x' });
    expect(res.statusCode).toBe(403);
  });
});
