/**
 * Script para crear el primer usuario ADMIN de DutyJoy
 * Uso: node scripts/seed-admin.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');

async function main() {
  const email    = process.argv[2] || 'admin@dutyjoy.com';
  const password = process.argv[3] || 'DutyJoy2025!';
  const nombre   = process.argv[4] || 'Admin DutyJoy';

  console.log(`\n🔧 Creando admin: ${email}`);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.rol === 'ADMIN') {
      console.log('✅ Ya existe un admin con ese email.');
    } else {
      await prisma.user.update({ where: { email }, data: { rol: 'ADMIN' } });
      console.log(`✅ Usuario existente promovido a ADMIN: ${email}`);
    }
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  const admin  = await prisma.user.create({
    data: { nombre, email, password: hashed, rol: 'ADMIN', ciudad: 'Bogotá' },
  });

  console.log(`✅ Admin creado exitosamente`);
  console.log(`   Email:    ${admin.email}`);
  console.log(`   Password: ${password}`);
  console.log(`   ID:       ${admin.id}`);
  console.log(`\n⚠️  Cambia la contraseña después del primer login.\n`);
}

main()
  .catch(e => { console.error('❌ Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
