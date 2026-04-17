const request = require('supertest');
const app     = require('../src/app');

describe('GET /health', () => {
  it('devuelve status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.project).toBe('DutyJoy Backend');
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.timestamp).toBeDefined();
  });

  it('devuelve 404 para rutas inexistentes', async () => {
    const res = await request(app).get('/ruta-que-no-existe');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Ruta no encontrada/);
  });
});
