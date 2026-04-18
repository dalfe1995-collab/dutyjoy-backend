const request = require('supertest');
const app     = require('../src/app');

// No mocks needed — services route has no DB calls

// ============================================================
describe('GET /services — catálogo de servicios', () => {
// ============================================================

  it('devuelve todos los servicios con estructura correcta', async () => {
    const res = await request(app).get('/services');

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.services)).toBe(true);
    expect(res.body.total).toBe(res.body.services.length);
    expect(res.body.total).toBeGreaterThanOrEqual(8);

    // Cada servicio debe tener los campos requeridos
    res.body.services.forEach(s => {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('nombre');
      expect(s).toHaveProperty('icon');
      expect(s).toHaveProperty('descripcion');
    });
  });

  it('incluye los servicios core del catálogo', async () => {
    const res = await request(app).get('/services');

    const ids = res.body.services.map(s => s.id);
    expect(ids).toContain('aseo');
    expect(ids).toContain('plomeria');
    expect(ids).toContain('electricidad');
    expect(ids).toContain('pintura');
    expect(ids).toContain('jardineria');
    expect(ids).toContain('mudanzas');
  });

  it('los IDs no tienen espacios ni mayúsculas', async () => {
    const res = await request(app).get('/services');

    res.body.services.forEach(s => {
      expect(s.id).toBe(s.id.toLowerCase());
      expect(s.id).not.toContain(' ');
    });
  });

  it('no requiere autenticación (ruta pública)', async () => {
    const res = await request(app).get('/services');
    expect(res.statusCode).toBe(200);
  });
});

// ============================================================
describe('GET /services/:id — detalle de un servicio', () => {
// ============================================================

  it('devuelve detalle de un servicio existente', async () => {
    const res = await request(app).get('/services/plomeria');

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('plomeria');
    expect(res.body.nombre).toBeTruthy();
    expect(res.body.icon).toBeTruthy();
    expect(res.body.descripcion).toBeTruthy();
  });

  it('devuelve 404 para un servicio inexistente', async () => {
    const res = await request(app).get('/services/servicio-que-no-existe');

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Servicio no encontrado/);
  });

  it('devuelve el servicio aseo correctamente', async () => {
    const res = await request(app).get('/services/aseo');

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('aseo');
    expect(res.body.icon).toBe('🧹');
  });

  it('es case-sensitive: PLOMERIA retorna 404', async () => {
    const res = await request(app).get('/services/PLOMERIA');
    expect(res.statusCode).toBe(404);
  });
});
