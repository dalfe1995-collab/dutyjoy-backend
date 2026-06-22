#!/usr/bin/env node
/**
 * Pobla ServiceCatalog y CityCatalog desde los datos canónicos.
 * Uso: node scripts/seed-catalog.js
 */
const { PrismaClient } = require('@prisma/client');
const { FALLBACK_SERVICES, FALLBACK_CITIES } = require('../src/lib/catalog');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding catálogo de servicios…');
  for (const s of FALLBACK_SERVICES) {
    await prisma.serviceCatalog.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        nombre: s.nombre,
        icon: s.icon,
        descripcion: s.descripcion,
        color: s.color,
        activo: s.activo,
        orden: s.orden,
      },
      update: {
        nombre: s.nombre,
        icon: s.icon,
        descripcion: s.descripcion,
        color: s.color,
        activo: s.activo,
        orden: s.orden,
      },
    });
  }

  console.log('Seeding catálogo de ciudades…');
  for (const c of FALLBACK_CITIES) {
    await prisma.cityCatalog.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        nombre: c.nombre,
        lat: c.lat,
        lng: c.lng,
        activo: c.activo,
        orden: c.orden,
      },
      update: {
        nombre: c.nombre,
        lat: c.lat,
        lng: c.lng,
        activo: c.activo,
        orden: c.orden,
      },
    });
  }

  const [svcCount, cityCount] = await Promise.all([
    prisma.serviceCatalog.count(),
    prisma.cityCatalog.count(),
  ]);
  console.log(`✅ Catálogo listo: ${svcCount} servicios, ${cityCount} ciudades`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
