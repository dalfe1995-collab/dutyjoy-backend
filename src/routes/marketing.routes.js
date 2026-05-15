const router  = require('express').Router();
const OpenAI  = require('openai');
const prisma  = require('../lib/prisma');
const verifyToken = require('../middleware/verifyToken');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  next();
};

// ── In-memory SEO content cache (24h TTL) ────────────────────────────────
const SEO_CACHE = new Map();
const SEO_TTL   = 24 * 60 * 60 * 1000;

const CIUDADES = ['Bogotá','Medellín','Cali','Ibagué','Barranquilla','Cartagena','Bucaramanga','Pereira'];
const SERVICIOS_META = {
  limpieza:          { label:'Limpieza del hogar',  emoji:'🧹', desc:'aseo, limpieza profunda, lavado de muebles' },
  plomeria:          { label:'Plomería',             emoji:'🔧', desc:'fugas, tuberías, instalaciones sanitarias' },
  electricidad:      { label:'Electricidad',         emoji:'⚡', desc:'instalaciones eléctricas, cortocircuitos, tomas' },
  pintura:           { label:'Pintura',              emoji:'🎨', desc:'pintura interior, exterior, estuco' },
  jardineria:        { label:'Jardinería',           emoji:'🌿', desc:'poda, diseño de jardines, mantenimiento' },
  cerrajeria:        { label:'Cerrajería',           emoji:'🔑', desc:'apertura de puertas, cambio de cerraduras' },
  mudanzas:          { label:'Mudanzas',             emoji:'📦', desc:'transporte de muebles, empaque, carga pesada' },
  aire_acondicionado:{ label:'Aire acondicionado',   emoji:'❄️', desc:'instalación, mantenimiento, limpieza de A/C' },
  carpinteria:       { label:'Carpintería',          emoji:'🪚', desc:'muebles a medida, reparaciones, instalaciones' },
  fumigacion:        { label:'Fumigación',           emoji:'🪲', desc:'control de plagas, cucarachas, roedores' },
};

// ── POST /marketing/copilot — AI campaign generator ─────────────────────
router.post('/copilot', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY no configurado.' });

  const { objetivo, audiencia = 'clientes colombianos de servicios del hogar', canal = 'all', tono = 'amigable y profesional', detalles = '' } = req.body;
  if (!objetivo) return res.status(400).json({ error: 'objetivo requerido.' });

  const APP = process.env.FRONTEND_URL || 'https://app.dutyjoy.com';

  try {
    // Pull live platform stats for context
    const [provCount, bookCount] = await Promise.all([
      prisma.providerProfile.count({ where: { verificado: true } }),
      prisma.booking.count({ where: { estado: 'COMPLETADO' } }),
    ]).catch(() => [0, 0]);

    const prompt = `Eres el director de marketing de DutyJoy, una plataforma colombiana de servicios del hogar (limpieza, plomería, electricidad, pintura, jardinería, etc.).
Misión: conectar hogares colombianos con proveedores verificados.
URL: ${APP}
Stats reales: ${provCount} proveedores verificados, ${bookCount} servicios completados.

## Solicitud de campaña
- Objetivo: ${objetivo}
- Audiencia: ${audiencia}
- Tono: ${tono}
${detalles ? `- Detalles extra: ${detalles}` : ''}
- Canales requeridos: ${canal === 'all' ? 'todos' : canal}

## Instrucciones
Genera contenido de marketing de alta conversión en español colombiano (tuteo).
NO uses clichés genéricos. Usa datos reales de la plataforma cuando sea relevante.
Cada pieza debe ser accionable y específica.

Responde SOLO JSON válido:
{
  "email": {
    "subject": "<línea de asunto con emoji, < 50 chars>",
    "preheader": "<texto de preview, < 90 chars>",
    "headline": "<titular principal del email>",
    "body": "<cuerpo del email, 2-3 párrafos en HTML básico (<p>, <strong>), personal y directo>",
    "cta_text": "<texto del botón CTA>",
    "cta_url": "${APP}/providers"
  },
  "instagram": {
    "caption": "<caption completa con emojis, max 300 chars>",
    "hashtags": ["#DutyJoy","#ServiciosDelHogar","#Colombia", "<5 hashtags más relevantes>"],
    "story_text": "<texto corto para Story de 15s, max 80 chars>",
    "cta": "<CTA para bio o swipe-up>"
  },
  "google_ads": {
    "headline1": "<max 30 chars>",
    "headline2": "<max 30 chars>",
    "headline3": "<max 30 chars>",
    "description1": "<max 90 chars>",
    "description2": "<max 90 chars>",
    "keywords": ["<5 palabras clave de alto intento>"]
  },
  "blog": {
    "titulo": "<título SEO-friendly con keyword>",
    "meta_description": "<meta description, 120-155 chars>",
    "slug": "<url-slug-en-minusculas>",
    "intro": "<párrafo introductorio de 2-3 oraciones que engancha al lector>",
    "secciones": [
      {"titulo": "<H2>", "parrafo": "<contenido de 2-3 oraciones>"},
      {"titulo": "<H2>", "parrafo": "<contenido de 2-3 oraciones>"},
      {"titulo": "<H2>", "parrafo": "<contenido de 2-3 oraciones>"}
    ],
    "conclusion": "<párrafo de cierre con CTA>",
    "word_count_estimate": <número>
  },
  "whatsapp": {
    "mensaje": "<mensaje conversacional para WhatsApp Business, max 160 chars, informal>",
    "cta": "<botón de llamada a la acción>"
  }
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1800,
      temperature: 0.75,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    const content = JSON.parse(completion.choices[0].message.content);
    res.json({ content, objetivo, canal, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[marketing/copilot]', e);
    res.status(500).json({ error: 'Error generando contenido de marketing.' });
  }
});

// ── GET /marketing/seo-content — AI content for city+service SEO pages ──
router.get('/seo-content', async (req, res) => {
  const { servicio, ciudad } = req.query;
  if (!servicio || !ciudad) return res.status(400).json({ error: 'servicio y ciudad requeridos.' });

  const svcMeta = SERVICIOS_META[servicio];
  if (!svcMeta || !CIUDADES.includes(ciudad)) {
    return res.status(404).json({ error: 'Servicio o ciudad no soportados.' });
  }

  const cacheKey = `${servicio}:${ciudad}`;
  const cached   = SEO_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEO_TTL) {
    return res.set('Cache-Control', 'public, max-age=3600').json(cached.data);
  }

  // Get real market stats for this service+city
  const [marketStats, topProviders] = await Promise.all([
    prisma.providerProfile.aggregate({
      where: { servicios: { has: servicio }, ciudades: { has: ciudad }, disponible: true },
      _avg: { tarifaPorHora: true, calificacion: true },
      _count: { id: true },
    }),
    prisma.providerProfile.findMany({
      where: { servicios: { has: servicio }, ciudades: { has: ciudad }, disponible: true, verificado: true },
      orderBy: { calificacion: 'desc' },
      take: 3,
      select: { reservasCompletadas: true, calificacion: true, tarifaPorHora: true, user: { select: { nombre: true } } },
    }),
  ]).catch(() => [{}, []]);

  const provCount = marketStats._count?.id || 0;
  const avgTarifa = Math.round(marketStats._avg?.tarifaPorHora || 0);
  const avgCalif  = (marketStats._avg?.calificacion || 4.8).toFixed(1);

  if (!openai) {
    // Fallback: templated content without AI
    const data = buildFallbackSeoContent(svcMeta, ciudad, provCount, avgTarifa);
    SEO_CACHE.set(cacheKey, { data, ts: Date.now() });
    return res.set('Cache-Control', 'public, max-age=3600').json(data);
  }

  try {
    const prompt = `Genera contenido SEO para la página: "${svcMeta.label} en ${ciudad}" de DutyJoy.
Datos reales: ${provCount} proveedores disponibles, tarifa promedio $${avgTarifa.toLocaleString('es-CO')} COP/hora, calificación promedio ${avgCalif}⭐.
Describe: ${svcMeta.desc}

Instrucciones:
- Tono informativo + local + de confianza. Menciona "${ciudad}" y el servicio de forma natural.
- FAQ basada en preguntas reales que hace un cliente en Colombia.
- Sin inventar datos. Usa SOLO los datos reales proporcionados.

Responde SOLO JSON:
{
  "heroTitle": "<H1 principal con keyword ciudad+servicio, max 60 chars>",
  "heroSubtitle": "<subtítulo descriptivo, max 120 chars>",
  "metaDescription": "<meta SEO, 130-155 chars, incluye ciudad y servicio>",
  "whyHire": [
    "<razón 1 para contratar en DutyJoy, específica>",
    "<razón 2>",
    "<razón 3>",
    "<razón 4>"
  ],
  "howItWorks": "<párrafo de 2 oraciones explicando cómo reservar>",
  "localInsight": "<dato o contexto local sobre este servicio en ${ciudad}, 1 oración>",
  "faq": [
    {"pregunta": "<pregunta frecuente real>", "respuesta": "<respuesta clara, 1-2 oraciones>"},
    {"pregunta": "<pregunta>", "respuesta": "<respuesta>"},
    {"pregunta": "<pregunta>", "respuesta": "<respuesta>"},
    {"pregunta": "<pregunta>", "respuesta": "<respuesta>"}
  ],
  "ctaText": "<llamado a la acción principal, max 35 chars>"
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 700,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    const aiContent = JSON.parse(completion.choices[0].message.content);
    const data = {
      ...aiContent,
      servicio,
      ciudad,
      svcLabel: svcMeta.label,
      svcEmoji: svcMeta.emoji,
      provCount,
      avgTarifa,
      avgCalif,
      topProviders: topProviders.map(p => ({
        nombre: p.user.nombre,
        calificacion: p.calificacion,
        tarifaPorHora: p.tarifaPorHora,
        serviciosCompletados: p.reservasCompletadas,
      })),
      generatedAt: new Date().toISOString(),
    };

    SEO_CACHE.set(cacheKey, { data, ts: Date.now() });
    res.set('Cache-Control', 'public, max-age=3600').json(data);
  } catch (e) {
    console.error('[seo-content]', e.message);
    const data = buildFallbackSeoContent(svcMeta, ciudad, provCount, avgTarifa);
    res.set('Cache-Control', 'public, max-age=3600').json(data);
  }
});

function buildFallbackSeoContent(svcMeta, ciudad, provCount, avgTarifa) {
  return {
    heroTitle: `${svcMeta.label} en ${ciudad} — Verificados`,
    heroSubtitle: `Encuentra proveedores de ${svcMeta.label.toLowerCase()} en ${ciudad} con pagos seguros y garantía de calidad.`,
    metaDescription: `Contrata ${svcMeta.label.toLowerCase()} en ${ciudad} con DutyJoy. ${provCount} proveedores verificados${avgTarifa ? `, desde $${Math.round(avgTarifa/1000)}K/hora` : ''}. Reserva fácil, pago seguro.`,
    whyHire: [
      'Proveedores verificados con cédula y antecedentes revisados',
      'Precios transparentes sin costos ocultos',
      'Pago seguro a través de MercadoPago',
      'Garantía: si no quedas satisfecho, lo resolvemos',
    ],
    howItWorks: 'Busca un proveedor, elige el horario y paga de forma segura. El proveedor llega a tu puerta en el tiempo acordado.',
    localInsight: `En ${ciudad} tenemos ${provCount} proveedores de ${svcMeta.label.toLowerCase()} listos para atenderte.`,
    faq: [
      { pregunta: `¿Cuánto cuesta un servicio de ${svcMeta.label.toLowerCase()} en ${ciudad}?`, respuesta: avgTarifa > 0 ? `La tarifa promedio es $${avgTarifa.toLocaleString('es-CO')} COP por hora. El precio exacto varía según el proveedor y el tamaño del trabajo.` : 'El precio varía según el tipo de servicio. Puedes ver la tarifa de cada proveedor en su perfil.' },
      { pregunta: '¿Están verificados los proveedores?', respuesta: 'Sí. Todos los proveedores pasan por un proceso de verificación de cédula y revisión de antecedentes.' },
      { pregunta: '¿Cómo pago el servicio?', respuesta: 'El pago se realiza de forma segura a través de MercadoPago con tarjeta débito, crédito o PSE.' },
      { pregunta: '¿Qué pasa si no quedo satisfecho?', respuesta: 'DutyJoy garantiza tu satisfacción. Puedes abrir una disputa y el equipo la resolverá.' },
    ],
    ctaText: `Ver proveedores en ${ciudad}`,
    servicio: svcMeta.label,
    ciudad,
    svcEmoji: svcMeta.emoji,
    provCount,
    avgTarifa,
    avgCalif: 4.8,
    topProviders: [],
    generatedAt: new Date().toISOString(),
  };
}

// ── GET /marketing/seo-index — list all available SEO pages ─────────────
router.get('/seo-index', (req, res) => {
  const pages = [];
  for (const ciudad of CIUDADES) {
    for (const [servicio, meta] of Object.entries(SERVICIOS_META)) {
      pages.push({ servicio, ciudad, label: meta.label, emoji: meta.emoji, url: `/servicios/${servicio}/${ciudad.toLowerCase().replace(/é/g,'e').replace(/á/g,'a').replace(/ó/g,'o')}` });
    }
  }
  res.json({ pages, total: pages.length, ciudades: CIUDADES, servicios: Object.keys(SERVICIOS_META) });
});

module.exports = router;
