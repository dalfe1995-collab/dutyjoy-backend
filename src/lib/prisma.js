// Singleton de PrismaClient — evita múltiples conexiones en desarrollo
const { PrismaClient } = require('@prisma/client');

const prisma = global.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

module.exports = prisma;
