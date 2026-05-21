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

const DEMO_COUPONS = [
  { codigo:'DUTYJOY10',   tipo:'porcentaje', valor:10,    descripcion:'10% de descuento — bienvenida',         maxUsos:null,  montoMinimo:50000  },
  { codigo:'PRIMERA20',   tipo:'porcentaje', valor:20,    descripcion:'20% de descuento en tu primera reserva', maxUsos:500,   montoMinimo:80000  },
  { codigo:'HOGAR15',     tipo:'porcentaje', valor:15,    descripcion:'15% off en servicios del hogar',         maxUsos:200,   montoMinimo:60000  },
  { codigo:'BIENVENIDO',  tipo:'fijo',       valor:20000, descripcion:'$20.000 de descuento fijo',              maxUsos:100,   montoMinimo:80000  },
  { codigo:'VIP30',       tipo:'porcentaje', valor:30,    descripcion:'30% clientes VIP',                       maxUsos:50,    montoMinimo:150000 },
  { codigo:'REFERIDO',    tipo:'fijo',       valor:15000, descripcion:'$15.000 por referido',                   maxUsos:null,  montoMinimo:50000  },
  { codigo:'QUINCENA',    tipo:'porcentaje', valor:12,    descripcion:'12% de descuento de quincena',           maxUsos:300,   montoMinimo:40000  },
];

async function seedIfEmpty() {
  const count = await prisma.cupon.count();
  if (count === 0) {
    await prisma.cupon.createMany({ data: DEMO_COUPONS });
  }
}

/* ── Validate (public — any authenticated user) ──────────────────────────── */
router.post('/validate', verifyToken, async (req, res) => {
  const { codigo, monto } = req.body;
  if (!codigo) return res.status(400).json({ error: 'Código requerido' });

  await seedIfEmpty();

  const cupon = await prisma.cupon.findUnique({ where: { codigo: codigo.trim().toUpperCase() } });
  if (!cupon) return res.status(404).json({ error: 'Cupón no válido' });
  if (!cupon.activo) return res.status(400).json({ error: 'Este cupón está inactivo' });
  if (cupon.expira && new Date(cupon.expira) < new Date()) return res.status(400).json({ error: 'Este cupón ha expirado' });
  if (cupon.maxUsos !== null && cupon.usos >= cupon.maxUsos) return res.status(400).json({ error: 'Este cupón ha alcanzado su límite de usos' });
  if (cupon.montoMinimo && monto && monto < cupon.montoMinimo) {
    return res.status(400).json({ error: `Monto mínimo para este cupón: $${cupon.montoMinimo.toLocaleString('es-CO')} COP` });
  }

  const descuento = cupon.tipo === 'porcentaje'
    ? Math.round((monto || 0) * (cupon.valor / 100))
    : cupon.valor;

  res.json({
    valido:      true,
    cupon: {
      id:         cupon.id,
      codigo:     cupon.codigo,
      tipo:       cupon.tipo,
      valor:      cupon.valor,
      descripcion: cupon.descripcion,
    },
    descuento,
    montoFinal: Math.max(0, (monto || 0) - descuento),
  });
});

/* ── Apply (increment usage) — called when booking is confirmed ─────────── */
router.post('/apply', verifyToken, async (req, res) => {
  const { codigo } = req.body;
  if (!codigo) return res.status(400).json({ ok: true }); // silent if no coupon
  try {
    await prisma.cupon.update({
      where: { codigo: codigo.trim().toUpperCase() },
      data: { usos: { increment: 1 } },
    });
    res.json({ ok: true });
  } catch { res.json({ ok: true }); } // silent fail — don't block booking
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
