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

// ═══════════════════════════════════════════════════════════════════════════
//  CHANNEL INTEGRATIONS — Meta · Google Ads · TikTok · WhatsApp
// ═══════════════════════════════════════════════════════════════════════════

// ── Helper: safe JSON fetch with timeout ────────────────────────────────────
async function apiFetch(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch { return { ok: r.ok, status: r.status, data: text }; }
  } finally {
    clearTimeout(timer);
  }
}

// ── GET /marketing/channels/status ──────────────────────────────────────────
// Returns which platforms have credentials configured
router.get('/channels/status', verifyToken, soloAdmin, (req, res) => {
  res.json({
    meta: {
      configured: !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID),
      hasWhatsApp: !!(process.env.META_ACCESS_TOKEN && process.env.META_WHATSAPP_PHONE_ID),
      adAccountId: process.env.META_AD_ACCOUNT_ID || null,
      whatsappPhoneId: process.env.META_WHATSAPP_PHONE_ID || null,
    },
    google: {
      configured: !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CUSTOMER_ID && process.env.GOOGLE_ADS_REFRESH_TOKEN),
      customerId: process.env.GOOGLE_ADS_CUSTOMER_ID || null,
    },
    tiktok: {
      configured: !!(process.env.TIKTOK_ACCESS_TOKEN && process.env.TIKTOK_ADVERTISER_ID),
      advertiserId: process.env.TIKTOK_ADVERTISER_ID || null,
    },
    email: {
      configured: !!(process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY),
      provider: process.env.RESEND_API_KEY ? 'Resend' : process.env.SENDGRID_API_KEY ? 'SendGrid' : null,
    },
    push: {
      configured: !!(process.env.VAPID_PUBLIC_KEY),
    },
  });
});

// ── GET /marketing/channels/meta/insights ────────────────────────────────────
// Fetch Facebook + Instagram Ads metrics via Meta Marketing API v20
router.get('/channels/meta/insights', verifyToken, soloAdmin, async (req, res) => {
  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) return res.json({ configured: false, platform: 'meta' });

  const { days = '30' } = req.query;
  const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString().split('T')[0];
  const until = new Date().toISOString().split('T')[0];

  const fields = [
    'impressions','reach','clicks','spend','cpc','ctr','cpm',
    'actions','action_values','unique_clicks',
  ].join(',');

  const url = `https://graph.facebook.com/v20.0/${accountId}/insights`
    + `?fields=${fields}`
    + `&level=account`
    + `&time_range={"since":"${since}","until":"${until}"}`
    + `&access_token=${token}`;

  try {
    const { ok, data } = await apiFetch(url);
    if (!ok || data.error) {
      return res.json({ configured: true, platform: 'meta', error: data?.error?.message || 'API error' });
    }

    const d = data.data?.[0] || {};
    const actions = d.actions || [];
    const actionVals = d.action_values || [];
    const purchases = actions.find(a => a.action_type === 'purchase')?.value || 0;
    const revenue   = actionVals.find(a => a.action_type === 'purchase')?.value || 0;
    const leads     = actions.find(a => a.action_type === 'lead')?.value || 0;
    const reg       = actions.find(a => a.action_type === 'complete_registration')?.value || 0;

    // Fetch campaigns list
    const campUrl = `https://graph.facebook.com/v20.0/${accountId}/campaigns`
      + `?fields=id,name,status,objective,daily_budget,lifetime_budget`
      + `&access_token=${token}&limit=20`;
    const campRes = await apiFetch(campUrl);

    res.json({
      configured: true, platform: 'meta', days: parseInt(days),
      impressions:   parseInt(d.impressions || 0),
      reach:         parseInt(d.reach || 0),
      clicks:        parseInt(d.clicks || 0),
      uniqueClicks:  parseInt(d.unique_clicks || 0),
      spend:         parseFloat(d.spend || 0),
      cpc:           parseFloat(d.cpc || 0),
      ctr:           parseFloat(d.ctr || 0),
      cpm:           parseFloat(d.cpm || 0),
      purchases:     parseInt(purchases),
      leads:         parseInt(leads),
      registrations: parseInt(reg),
      revenue:       parseFloat(revenue),
      roas:          parseFloat(d.spend) > 0 ? (parseFloat(revenue) / parseFloat(d.spend)).toFixed(2) : 0,
      cpa:           parseInt(purchases) > 0 ? (parseFloat(d.spend) / parseInt(purchases)).toFixed(0) : 0,
      campaigns:     campRes.data?.data || [],
      since, until,
    });
  } catch (e) {
    res.json({ configured: true, platform: 'meta', error: e.message });
  }
});

// ── GET /marketing/channels/meta/campaigns ────────────────────────────────────
// Detailed campaign breakdown with per-campaign insights
router.get('/channels/meta/campaigns', verifyToken, soloAdmin, async (req, res) => {
  const token = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) return res.json({ configured: false });

  const { days = '30' } = req.query;
  const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString().split('T')[0];
  const until = new Date().toISOString().split('T')[0];

  const url = `https://graph.facebook.com/v20.0/${accountId}/campaigns`
    + `?fields=id,name,status,objective,insights.time_range({"since":"${since}","until":"${until}"}){impressions,clicks,spend,reach,ctr,cpc,actions}`
    + `&access_token=${token}&limit=20`;

  try {
    const { ok, data } = await apiFetch(url);
    if (!ok || data.error) return res.json({ configured: true, error: data?.error?.message });
    res.json({ configured: true, campaigns: data.data || [], paging: data.paging });
  } catch (e) {
    res.json({ configured: true, error: e.message });
  }
});

// ── GET /marketing/channels/google/insights ──────────────────────────────────
// Google Ads via REST API (requires OAuth2 refresh token)
router.get('/channels/google/insights', verifyToken, soloAdmin, async (req, res) => {
  const devToken    = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId    = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret= process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken= process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const customerId  = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, '');

  if (!devToken || !refreshToken || !customerId) {
    return res.json({ configured: false, platform: 'google' });
  }

  try {
    // Step 1: refresh access token
    const tokenRes = await apiFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }).toString(),
    });
    if (!tokenRes.ok || tokenRes.data.error) {
      return res.json({ configured: true, platform: 'google', error: tokenRes.data.error_description || 'OAuth failed' });
    }
    const accessToken = tokenRes.data.access_token;

    const { days = '30' } = req.query;
    const endDate   = new Date();
    const startDate = new Date(Date.now() - parseInt(days) * 86400000);
    const fmt = d => d.toISOString().split('T')[0].replace(/-/g, '');

    // Step 2: query Google Ads API v17 with GAQL
    const query = `
      SELECT
        metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.conversions_value,
        metrics.ctr, metrics.average_cpc, metrics.average_cpm,
        metrics.view_through_conversions
      FROM customer
      WHERE segments.date BETWEEN '${fmt(startDate)}' AND '${fmt(endDate)}'
    `.trim();

    const gaqlRes = await apiFetch(
      `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': devToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      }
    );

    if (!gaqlRes.ok) {
      return res.json({ configured: true, platform: 'google', error: gaqlRes.data?.error?.message || 'Query failed' });
    }

    // Aggregate across batches
    let impressions = 0, clicks = 0, costMicros = 0, conversions = 0, convValue = 0;
    const batches = Array.isArray(gaqlRes.data) ? gaqlRes.data : [gaqlRes.data];
    for (const batch of batches) {
      for (const row of (batch.results || [])) {
        const m = row.metrics || {};
        impressions += parseInt(m.impressions || 0);
        clicks      += parseInt(m.clicks || 0);
        costMicros  += parseInt(m.costMicros || m.cost_micros || 0);
        conversions += parseFloat(m.conversions || 0);
        convValue   += parseFloat(m.conversionsValue || m.conversions_value || 0);
      }
    }

    const spend = costMicros / 1_000_000;
    res.json({
      configured: true, platform: 'google', days: parseInt(days),
      impressions, clicks,
      spend: parseFloat(spend.toFixed(2)),
      conversions: Math.round(conversions),
      revenue: parseFloat(convValue.toFixed(2)),
      ctr:  clicks && impressions ? ((clicks / impressions) * 100).toFixed(2) : 0,
      cpc:  clicks ? (spend / clicks).toFixed(4) : 0,
      roas: spend > 0 ? (convValue / spend).toFixed(2) : 0,
      cpa:  conversions > 0 ? (spend / conversions).toFixed(2) : 0,
      since: startDate.toISOString().split('T')[0],
      until: endDate.toISOString().split('T')[0],
    });
  } catch (e) {
    res.json({ configured: true, platform: 'google', error: e.message });
  }
});

// ── GET /marketing/channels/tiktok/insights ──────────────────────────────────
// TikTok For Business Ads API v1.3
router.get('/channels/tiktok/insights', verifyToken, soloAdmin, async (req, res) => {
  const token        = process.env.TIKTOK_ACCESS_TOKEN;
  const advertiserId = process.env.TIKTOK_ADVERTISER_ID;
  if (!token || !advertiserId) return res.json({ configured: false, platform: 'tiktok' });

  const { days = '30' } = req.query;
  const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString().split('T')[0];
  const until = new Date().toISOString().split('T')[0];

  const metrics = ['impressions','clicks','spend','conversions','conversion_rate','ctr','cpc','cpm','reach','video_play_actions','video_watched_2s','video_watched_6s'];

  const url = `https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/`
    + `?advertiser_id=${advertiserId}`
    + `&report_type=BASIC`
    + `&dimensions=["stat_time_day"]`
    + `&metrics=${JSON.stringify(metrics)}`
    + `&start_date=${since}&end_date=${until}&page_size=30`;

  try {
    const { ok, data } = await apiFetch(url, { headers: { 'Access-Token': token } });
    if (!ok || data.code !== 0) {
      return res.json({ configured: true, platform: 'tiktok', error: data?.message || 'API error' });
    }

    const rows = data.data?.list || [];
    const totals = rows.reduce((acc, row) => {
      const m = row.metrics || {};
      return {
        impressions:  acc.impressions  + parseInt(m.impressions || 0),
        clicks:       acc.clicks       + parseInt(m.clicks || 0),
        spend:        acc.spend        + parseFloat(m.spend || 0),
        conversions:  acc.conversions  + parseInt(m.conversions || 0),
        reach:        acc.reach        + parseInt(m.reach || 0),
        videoPlays:   acc.videoPlays   + parseInt(m.video_play_actions || 0),
      };
    }, { impressions:0, clicks:0, spend:0, conversions:0, reach:0, videoPlays:0 });

    res.json({
      configured: true, platform: 'tiktok', days: parseInt(days),
      ...totals,
      spend: parseFloat(totals.spend.toFixed(2)),
      ctr:  totals.impressions ? ((totals.clicks / totals.impressions) * 100).toFixed(2) : 0,
      cpc:  totals.clicks ? (totals.spend / totals.clicks).toFixed(2) : 0,
      cpa:  totals.conversions ? (totals.spend / totals.conversions).toFixed(2) : 0,
      daily: rows.map(r => ({
        date:        r.dimensions?.stat_time_day,
        impressions: r.metrics?.impressions,
        clicks:      r.metrics?.clicks,
        spend:       r.metrics?.spend,
        conversions: r.metrics?.conversions,
      })),
      since, until,
    });
  } catch (e) {
    res.json({ configured: true, platform: 'tiktok', error: e.message });
  }
});

// ── GET /marketing/channels/whatsapp/templates ───────────────────────────────
// List approved WhatsApp message templates
router.get('/channels/whatsapp/templates', verifyToken, soloAdmin, async (req, res) => {
  const token    = process.env.META_ACCESS_TOKEN;
  const bizAccId = process.env.META_WHATSAPP_BIZ_ACCOUNT_ID;
  if (!token || !bizAccId) return res.json({ configured: false, templates: [] });

  const url = `https://graph.facebook.com/v20.0/${bizAccId}/message_templates`
    + `?fields=id,name,status,language,category,components`
    + `&access_token=${token}&limit=50`;

  try {
    const { ok, data } = await apiFetch(url);
    if (!ok || data.error) return res.json({ configured: true, error: data?.error?.message, templates: [] });
    res.json({ configured: true, templates: data.data || [] });
  } catch (e) {
    res.json({ configured: true, error: e.message, templates: [] });
  }
});

// ── POST /marketing/channels/whatsapp/send ────────────────────────────────────
// Send WhatsApp template message to a single number
router.post('/channels/whatsapp/send', verifyToken, soloAdmin, async (req, res) => {
  const token   = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return res.status(503).json({ error: 'WhatsApp no configurado. Configura META_ACCESS_TOKEN y META_WHATSAPP_PHONE_ID.' });

  const { to, templateName, languageCode = 'es', components = [] } = req.body;
  if (!to || !templateName) return res.status(400).json({ error: 'to y templateName requeridos' });

  const phone = to.replace(/\D/g, '');
  if (phone.length < 10) return res.status(400).json({ error: 'Número inválido' });

  try {
    const { ok, data } = await apiFetch(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'template',
          template: { name: templateName, language: { code: languageCode }, components },
        }),
      }
    );
    if (!ok || data.error) return res.status(400).json({ error: data?.error?.message || 'Error al enviar' });
    res.json({ ok: true, messageId: data.messages?.[0]?.id, to: phone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /marketing/channels/whatsapp/broadcast ───────────────────────────────
// Broadcast template to a user segment
router.post('/channels/whatsapp/broadcast', verifyToken, soloAdmin, async (req, res) => {
  const token   = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return res.status(503).json({ error: 'WhatsApp no configurado' });

  const { templateName, languageCode = 'es', components = [],
          segmento = 'todos', limitN = 50 } = req.body;
  if (!templateName) return res.status(400).json({ error: 'templateName requerido' });

  // Build audience from DB
  const where = {};
  if (segmento === 'sin_reserva') {
    where.bookingsComoCliente = { none: {} };
  } else if (segmento === 'inactivos_30d') {
    const d30 = new Date(Date.now() - 30 * 86400000);
    where.bookingsComoCliente = { none: { createdAt: { gte: d30 } } };
  } else if (segmento === 'nuevos_7d') {
    where.createdAt = { gte: new Date(Date.now() - 7 * 86400000) };
  }

  const users = await prisma.user.findMany({
    where: { ...where, rol: 'CLIENTE', activo: true, telefono: { not: null } },
    select: { id: true, nombre: true, telefono: true },
    take: Math.min(parseInt(limitN) || 50, 200),
  });

  const results = { enviados: 0, fallidos: 0, errors: [] };
  for (const u of users) {
    const phone = (u.telefono || '').replace(/\D/g, '');
    if (phone.length < 10) { results.fallidos++; continue; }
    try {
      const { ok, data } = await apiFetch(
        `https://graph.facebook.com/v20.0/${phoneId}/messages`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', recipient_type: 'individual',
            to: phone, type: 'template',
            template: { name: templateName, language: { code: languageCode }, components },
          }),
        }
      );
      if (ok && !data.error) results.enviados++;
      else { results.fallidos++; results.errors.push({ user: u.id, error: data?.error?.message }); }
    } catch (e) {
      results.fallidos++;
      results.errors.push({ user: u.id, error: e.message });
    }
    // Rate limit: 80 msg/s for WhatsApp Business (1 every 12ms min)
    await new Promise(r => setTimeout(r, 15));
  }

  console.log(`[WA Broadcast] Template: ${templateName}, enviados: ${results.enviados}, fallidos: ${results.fallidos}`);
  res.json({ ok: true, total: users.length, ...results });
});

// ── GET /marketing/attribution ────────────────────────────────────────────────
// Cross-channel attribution from real DB UTM data
router.get('/attribution', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { days = '30' } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);

    // Registrations by UTM source
    const users = await prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: {
        utmSource: true, utmMedium: true, utmCampaign: true,
        createdAt: true,
        _count: { select: { bookingsComoCliente: true } },
      },
    });

    // Group by source
    const bySource = {};
    for (const u of users) {
      const src = u.utmSource || 'organico';
      if (!bySource[src]) bySource[src] = { registros: 0, bookings: 0, fuente: src };
      bySource[src].registros++;
      bySource[src].bookings += u._count.bookingsComoCliente;
    }

    // Group by campaign
    const byCampaign = {};
    for (const u of users) {
      if (!u.utmCampaign) continue;
      const key = `${u.utmSource}|${u.utmCampaign}`;
      if (!byCampaign[key]) byCampaign[key] = { fuente: u.utmSource, campana: u.utmCampaign, registros: 0, bookings: 0 };
      byCampaign[key].registros++;
      byCampaign[key].bookings += u._count.bookingsComoCliente;
    }

    // Revenue by source — join with bookings
    const bookings = await prisma.booking.findMany({
      where: {
        estado: 'COMPLETADO',
        createdAt: { gte: since },
        cliente: { utmSource: { not: null } },
      },
      select: {
        precioTotal: true,
        cliente: { select: { utmSource: true, utmCampaign: true } },
      },
    });

    const revenue = {};
    for (const b of bookings) {
      const src = b.cliente?.utmSource || 'organico';
      revenue[src] = (revenue[src] || 0) + b.precioTotal;
    }

    // Merge revenue into bySource
    for (const [src, rev] of Object.entries(revenue)) {
      if (bySource[src]) bySource[src].revenue = rev;
    }

    const sources  = Object.values(bySource).sort((a, b) => b.registros - a.registros);
    const campaigns= Object.values(byCampaign).sort((a, b) => b.registros - a.registros);

    // Daily registration trend by top source
    const topSources = sources.slice(0, 5).map(s => s.fuente);
    const daily = {};
    for (const u of users) {
      const date = u.createdAt.toISOString().split('T')[0];
      const src  = u.utmSource || 'organico';
      if (!topSources.includes(src)) continue;
      if (!daily[date]) daily[date] = {};
      daily[date][src] = (daily[date][src] || 0) + 1;
    }

    res.json({
      days: parseInt(days),
      totalRegistros: users.length,
      sources,
      campaigns,
      daily: Object.entries(daily).sort(([a],[b]) => a.localeCompare(b)).map(([date, sources]) => ({ date, ...sources })),
      topSources,
    });
  } catch (e) {
    console.error('[attribution]', e);
    res.status(500).json({ error: 'Error al calcular atribución' });
  }
});

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
