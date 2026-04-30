const OpenAI = require('openai');
const prisma = require('./prisma');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Genera el texto descriptivo de un proveedor para embedding
function buildProviderText(profile) {
  const servicios = (profile.servicios || []).join(', ') || 'servicios del hogar';
  const ciudades  = (profile.ciudades  || []).join(', ') || 'Colombia';
  const bio       = profile.bio ? profile.bio.substring(0, 300) : '';
  const tarifa    = profile.tarifaPorHora ? `Tarifa: ${profile.tarifaPorHora} COP por hora.` : '';
  const calif     = profile.calificacion > 0 ? `Calificación: ${profile.calificacion.toFixed(1)}.` : '';
  const verif     = profile.verificado ? 'Proveedor verificado.' : '';
  const exp       = profile.aniosExperiencia ? `${profile.aniosExperiencia} años de experiencia.` : '';
  return `Proveedor de servicios: ${servicios}. Ciudad: ${ciudades}. ${bio} ${tarifa} ${calif} ${verif} ${exp}`.trim();
}

// Genera embedding de un texto usando OpenAI
async function generateEmbedding(text) {
  if (!openai) return null;
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding; // array de 1536 floats
}

// Genera y guarda el embedding de un proveedor en la DB
async function updateProviderEmbedding(profileId) {
  if (!openai) return;
  try {
    const profile = await prisma.providerProfile.findUnique({ where: { id: profileId } });
    if (!profile) return;
    const text      = buildProviderText(profile);
    const embedding = await generateEmbedding(text);
    if (!embedding) return;
    const vector = `[${embedding.join(',')}]`;
    await prisma.$executeRaw`
      UPDATE "ProviderProfile"
      SET embedding = ${vector}::vector
      WHERE id = ${profileId}
    `;
  } catch (e) {
    console.error('[embeddings] Error actualizando embedding:', e.message);
  }
}

// Búsqueda semántica: devuelve IDs de proveedores ordenados por similitud
async function semanticSearch(query, limit = 20) {
  if (!openai) return [];
  try {
    const embedding = await generateEmbedding(query);
    if (!embedding) return [];
    const vector = `[${embedding.join(',')}]`;
    const rows = await prisma.$queryRaw`
      SELECT id, 1 - (embedding <=> ${vector}::vector) AS similarity
      FROM "ProviderProfile"
      WHERE disponible = true AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${limit}
    `;
    return rows.map(r => ({ id: r.id, similarity: parseFloat(r.similarity) }));
  } catch (e) {
    console.error('[embeddings] Error en búsqueda semántica:', e.message);
    return [];
  }
}

module.exports = { updateProviderEmbedding, semanticSearch, generateEmbedding, buildProviderText };
