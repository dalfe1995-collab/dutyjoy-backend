// Script one-time: genera embeddings para proveedores existentes sin embedding
// Costo estimado: ~$0.001 por cada 50 proveedores (text-embedding-3-small)
// Uso: node scripts/backfill-embeddings.js
require('dotenv').config();
const { updateProviderEmbedding } = require('../src/lib/embeddings');
const prisma = require('../src/lib/prisma');

async function main() {
  const providers = await prisma.$queryRaw`
    SELECT id FROM "ProviderProfile" WHERE embedding IS NULL
  `;
  console.log(`Generando embeddings para ${providers.length} proveedores...`);
  for (const p of providers) {
    await updateProviderEmbedding(p.id);
    process.stdout.write('.');
  }
  console.log('\nListo.');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
