const prisma = require('./prisma');

const DEMO_COUPONS = [
  { codigo: 'DUTYJOY10', tipo: 'porcentaje', valor: 10, descripcion: '10% de descuento — bienvenida', maxUsos: null, montoMinimo: 50000 },
  { codigo: 'PRIMERA20', tipo: 'porcentaje', valor: 20, descripcion: '20% de descuento en tu primera reserva', maxUsos: 500, montoMinimo: 80000 },
  { codigo: 'HOGAR15', tipo: 'porcentaje', valor: 15, descripcion: '15% off en servicios del hogar', maxUsos: 200, montoMinimo: 60000 },
  { codigo: 'BIENVENIDO', tipo: 'fijo', valor: 20000, descripcion: '$20.000 de descuento fijo', maxUsos: 100, montoMinimo: 80000 },
  { codigo: 'VIP30', tipo: 'porcentaje', valor: 30, descripcion: '30% clientes VIP', maxUsos: 50, montoMinimo: 150000 },
  { codigo: 'REFERIDO', tipo: 'fijo', valor: 15000, descripcion: '$15.000 por referido', maxUsos: null, montoMinimo: 50000 },
  { codigo: 'QUINCENA', tipo: 'porcentaje', valor: 12, descripcion: '12% de descuento de quincena', maxUsos: 300, montoMinimo: 40000 },
];

async function seedIfEmpty() {
  const count = await prisma.cupon.count();
  if (count === 0) {
    await prisma.cupon.createMany({ data: DEMO_COUPONS });
  }
}

/**
 * @returns {{ valid: boolean, error?: string, cupon?: object, descuento?: number, montoFinal?: number }}
 */
async function validateCoupon(codigo, monto) {
  if (!codigo?.trim()) {
    return { valid: false, error: 'Código requerido' };
  }

  await seedIfEmpty();

  const cupon = await prisma.cupon.findUnique({
    where: { codigo: codigo.trim().toUpperCase() },
  });
  if (!cupon) return { valid: false, error: 'Cupón no válido' };
  if (!cupon.activo) return { valid: false, error: 'Este cupón está inactivo' };
  if (cupon.expira && new Date(cupon.expira) < new Date()) {
    return { valid: false, error: 'Este cupón ha expirado' };
  }
  if (cupon.maxUsos !== null && cupon.usos >= cupon.maxUsos) {
    return { valid: false, error: 'Este cupón ha alcanzado su límite de usos' };
  }
  if (cupon.montoMinimo && monto != null && monto < cupon.montoMinimo) {
    return {
      valid: false,
      error: `Monto mínimo para este cupón: $${cupon.montoMinimo.toLocaleString('es-CO')} COP`,
    };
  }

  const descuento = cupon.tipo === 'porcentaje'
    ? Math.round((monto || 0) * (cupon.valor / 100))
    : cupon.valor;

  return {
    valid: true,
    cupon: {
      id: cupon.id,
      codigo: cupon.codigo,
      tipo: cupon.tipo,
      valor: cupon.valor,
      descripcion: cupon.descripcion,
    },
    descuento,
    montoFinal: Math.max(0, (monto || 0) - descuento),
  };
}

async function applyCoupon(codigo) {
  if (!codigo?.trim()) return;
  try {
    await prisma.cupon.update({
      where: { codigo: codigo.trim().toUpperCase() },
      data: { usos: { increment: 1 } },
    });
  } catch {
    // silent — don't block booking
  }
}

module.exports = { seedIfEmpty, validateCoupon, applyCoupon, DEMO_COUPONS };
