/**
 * coupons.routes.js — Discount coupon management
 * Validate · CRUD (admin) · Auto-seed demo coupons
 */
const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  next();
};

const { seedIfEmpty, validateCoupon, applyCoupon } = require('../lib/coupons');

/* ── Validate (public — any authenticated user) ──────────────────────────── */
router.post('/validate', verifyToken, async (req, res) => {
  const { codigo, monto } = req.body;
  if (!codigo) return res.status(400).json({ error: 'Código requerido' });

  await seedIfEmpty();

  const result = await validateCoupon(codigo, monto);
  if (!result.valid) {
    const status = result.error === 'Cupón no válido' ? 404 : 400;
    return res.status(status).json({ error: result.error });
  }

  res.json({
    valido: true,
    cupon: result.cupon,
    descuento: result.descuento,
    montoFinal: result.montoFinal,
  });
});

/* ── Apply (increment usage) — called when booking is confirmed ─────────── */
router.post('/apply', verifyToken, async (req, res) => {
  const { codigo } = req.body;
  if (!codigo) return res.json({ ok: true });
  await applyCoupon(codigo);
  res.json({ ok: true });
});

/* ── Featured coupons (for dashboard widget — only shows generic ones) ──── */
router.get('/featured', verifyToken, async (req, res) => {
  await seedIfEmpty();
  const featured = await prisma.cupon.findMany({
    where: { activo: true, expira: { gte: new Date() } },
    orderBy: { usos: 'asc' },
    take: 4,
    select: { codigo: true, tipo: true, valor: true, descripcion: true, montoMinimo: true, expira: true },
  });
  // Include ones with null expiry too
  const noExpiry = await prisma.cupon.findMany({
    where: { activo: true, expira: null },
    orderBy: { usos: 'asc' },
    take: 4,
    select: { codigo: true, tipo: true, valor: true, descripcion: true, montoMinimo: true, expira: true },
  });
  const all = [...featured, ...noExpiry].slice(0, 4);
  res.json({ cupones: all });
});

/* ── Admin CRUD ──────────────────────────────────────────────────────────── */
router.get('/', verifyToken, soloAdmin, async (req, res) => {
  await seedIfEmpty();
  const cupones = await prisma.cupon.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ cupones });
});

router.post('/', verifyToken, soloAdmin, async (req, res) => {
  const { codigo, tipo, valor, descripcion, activo, maxUsos, montoMinimo, expira } = req.body;
  if (!codigo || !valor) return res.status(400).json({ error: 'codigo y valor requeridos' });
  try {
    const cupon = await prisma.cupon.create({
      data: {
        codigo: codigo.trim().toUpperCase(), tipo: tipo || 'porcentaje',
        valor: parseFloat(valor), descripcion, activo: activo !== false,
        maxUsos: maxUsos ? parseInt(maxUsos) : null,
        montoMinimo: montoMinimo ? parseFloat(montoMinimo) : null,
        expira: expira ? new Date(expira) : null,
        creadoPor: req.user?.id,
      },
    });
    res.json({ cupon });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ese código ya existe' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const cupon = await prisma.cupon.update({ where: { id: req.params.id }, data: req.body });
    res.json({ cupon });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    await prisma.cupon.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
