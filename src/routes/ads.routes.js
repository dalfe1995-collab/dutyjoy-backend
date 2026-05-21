/**
 * ads.routes.js — AI-powered cross-platform ad management
 * Meta (FB+IG) · Google Ads · TikTok · AI Agent · Automations
 */
const router      = require('express').Router();
const OpenAI      = require('openai');
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  next();
};

async function apiFetch(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    const r    = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch { return { ok: r.ok, status: r.status, data: text }; }
  } finally { clearTimeout(t); }
}

// ══════════════════════════════════════════════════════════════════════
//  GET /ads/status — platform summary
// ══════════════════════════════════════════════════════════════════════
router.get('/status', verifyToken, soloAdmin, async (req, res) => {
  const [total, activas, pausadas] = await Promise.all([
    prisma.adCampaign.count(),
    prisma.adCampaign.count({ where: { estado: 'activa' } }),
    prisma.adCampaign.count({ where: { estado: 'pausada' } }),
  ]);
  const gastado = await prisma.adCampaign.aggregate({ _sum: { gastado: true } });
  const convs   = await prisma.adCampaign.aggregate({ _sum: { conversiones: true } });

  res.json({
    campaigns: { total, activas, pausadas },
    gastadoTotal: gastado._sum.gastado || 0,
    conversionesTotal: convs._sum.conversiones || 0,
    platforms: {
      meta:   !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID),
      google: !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CUSTOMER_ID),
      tiktok: !!(process.env.TIKTOK_ACCESS_TOKEN && process.env.TIKTOK_ADVERTISER_ID),
    },
    aiEnabled: !!openai,
  });
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/generate — AI generates complete ad package
// ══════════════════════════════════════════════════════════════════════
router.post('/generate', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY no configurado' });

  const {
    servicio = 'servicios del hogar',
    objetivo = 'conversiones',
    audiencia = 'Adultos 25-45 en Colombia que buscan servicios del hogar',
    presupuesto = 100,
    tono = 'confiable y cercano',
    ciudades = ['Ibagué', 'Bogotá', 'Medellín'],
    destacar = '',
  } = req.body;

  // Pull live stats for context
  const [provCount, bookCount, avgRating] = await Promise.all([
    prisma.providerProfile.count({ where: { verificado: true, disponible: true } }),
    prisma.booking.count({ where: { estado: 'COMPLETADO' } }),
    prisma.providerProfile.aggregate({ _avg: { calificacion: true }, where: { calificacion: { gt: 0 } } }),
  ]).catch(() => [0, 0, { _avg: { calificacion: 4.8 } }]);

  const rating = (avgRating._avg?.calificacion || 4.8).toFixed(1);
  const ciudadesStr = ciudades.join(', ');

  const prompt = `Eres director creativo de DutyJoy, marketplace colombiano de servicios del hogar.
Stats reales: ${provCount} proveedores verificados · ${bookCount} servicios completados · ${rating}⭐ promedio.
URL: ${process.env.FRONTEND_URL || 'https://app.dutyjoy.com'}

BRIEFING:
- Servicio: ${servicio}
- Objetivo: ${objetivo}
- Audiencia: ${audiencia}
- Ciudades: ${ciudadesStr}
- Presupuesto diario: $${presupuesto} USD
- Tono: ${tono}
${destacar ? `- Destacar: ${destacar}` : ''}

Genera un paquete de anuncios COMPLETO para TODAS las plataformas. Usa datos reales. Sin clichés. Español colombiano (tuteo).

Responde SOLO JSON válido:
{
  "meta_facebook": {
    "headline": "<máx 40 chars, impactante>",
    "primary_text": "<125-250 chars, engancha con dolor/solución>",
    "description": "<máx 30 chars, refuerza CTA>",
    "cta": "BOOK_NOW|LEARN_MORE|GET_QUOTE|SIGN_UP",
    "variantes": [
      {"headline":"<alt 1>","primary_text":"<alt 1 texto>"},
      {"headline":"<alt 2>","primary_text":"<alt 2 texto>"}
    ]
  },
  "meta_instagram": {
    "caption": "<caption con emojis, max 300 chars>",
    "story_text": "<texto story 15s, max 80 chars, urgente>",
    "hashtags": ["#DutyJoy","#ServiciosHogar","#Colombia","<5 más>"],
    "cta": "<texto botón swipe-up>"
  },
  "tiktok": {
    "video_hook": "<primeros 3 segundos que paran el scroll, max 60 chars>",
    "video_script": "<guión completo 15-30s: hook, problema, solución, CTA>",
    "text_overlay": "<texto superpuesto max 100 chars>",
    "hashtags": ["#DutyJoy","#Colombia","<5 más trending>"],
    "cta": "<CTA botón>"
  },
  "google_search": {
    "headlines": ["<30 chars>","<30 chars>","<30 chars>","<30 chars>","<30 chars>"],
    "descriptions": ["<90 chars>","<90 chars>","<90 chars>"],
    "keywords": {
      "exacto": ["<keyword>","<keyword>","<keyword>"],
      "frase": ["<keyword>","<keyword>","<keyword>"],
      "amplia": ["<keyword>","<keyword>"]
    },
    "sitelinks": [
      {"titulo":"<25 chars>","desc":"<35 chars>","url":"/providers"},
      {"titulo":"<25 chars>","desc":"<35 chars>","url":"/como-funciona"}
    ]
  },
  "google_display": {
    "headline_corto": "<máx 30 chars>",
    "headline_largo": "<máx 90 chars>",
    "description": "<máx 90 chars>",
    "call_to_action": "Reservar|Cotizar|Ver precios"
  },
  "whatsapp": {
    "template_name": "<snake_case, sin espacios>",
    "message": "<mensaje 160 chars max, conversacional, incluye variable {{1}} para nombre>",
    "cta_url": "<URL con utm_source=whatsapp>"
  },
  "targeting": {
    "edad_min": 25,
    "edad_max": 55,
    "genero": "all",
    "ciudades": ${JSON.stringify(ciudades)},
    "intereses_meta": ["<interés 1>","<interés 2>","<interés 3>","<interés 4>"],
    "keywords_tiktok": ["<keyword 1>","<keyword 2>","<keyword 3>"],
    "dispositivos": "mobile_preferred"
  },
  "presupuesto": {
    "distribucion": {"meta": <pct int>, "google": <pct int>, "tiktok": <pct int>},
    "recomendacion": "<1 oración sobre distribución óptima para este objetivo>"
  },
  "ai_notes": "<insight estratégico de 2-3 oraciones: qué esperar, qué medir, cuándo optimizar>"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2400,
      temperature: 0.72,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    const copy = JSON.parse(completion.choices[0].message.content);

    // Persist draft campaign to DB
    const campaign = await prisma.adCampaign.create({
      data: {
        nombre:    `[IA] ${servicio} — ${objetivo}`,
        plataforma:'multi',
        objetivo,
        estado:    'borrador',
        presupuestoTotal: parseFloat(presupuesto),
        creadoPorIA: true,
        copy,
        targeting: copy.targeting,
        aiNotas:   copy.ai_notes,
        aiScore:   85,
      },
    });

    res.json({ campaign, copy, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[ads/generate]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/publish/meta — create real Meta campaign
// ══════════════════════════════════════════════════════════════════════
router.post('/publish/meta', verifyToken, soloAdmin, async (req, res) => {
  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  const pageId    = process.env.META_PAGE_ID;
  if (!token || !accountId) return res.status(503).json({ error: 'META_ACCESS_TOKEN y META_AD_ACCOUNT_ID requeridos' });

  const { campaignId, dailyBudgetUSD = 5, startDate, endDate, imageUrl } = req.body;

  const dbCamp = campaignId
    ? await prisma.adCampaign.findUnique({ where: { id: campaignId } })
    : null;
  const copy = dbCamp?.copy?.meta_facebook || req.body.copy;
  if (!copy) return res.status(400).json({ error: 'copy requerido (campaignId o copy directo)' });

  const BASE = 'https://graph.facebook.com/v20.0';
  const budgetCents = Math.round(dailyBudgetUSD * 100);
  const errors = [];

  try {
    // 1. Create Campaign
    const campRes = await apiFetch(`${BASE}/${accountId}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        name:         copy.headline || dbCamp?.nombre || 'DutyJoy Campaign',
        objective:    'OUTCOME_LEADS',
        status:       'PAUSED',
        special_ad_categories: [],
      }),
    });
    if (!campRes.ok || campRes.data.error) {
      return res.status(400).json({ error: campRes.data?.error?.message || 'Error creando campaña Meta', raw: campRes.data });
    }
    const metaCampaignId = campRes.data.id;

    // 2. Create Ad Set
    const adSetRes = await apiFetch(`${BASE}/${accountId}/adsets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token:    token,
        name:            `AdSet — ${new Date().toISOString().split('T')[0]}`,
        campaign_id:     metaCampaignId,
        billing_event:   'IMPRESSIONS',
        optimization_goal:'LEAD_GENERATION',
        daily_budget:    budgetCents * 100, // Meta uses centavos de cent → value in cents
        targeting: {
          geo_locations: { countries: ['CO'] },
          age_min: dbCamp?.targeting?.edad_min || 25,
          age_max: dbCamp?.targeting?.edad_max || 55,
        },
        status: 'PAUSED',
        ...(startDate && { start_time: new Date(startDate).toISOString() }),
        ...(endDate   && { end_time:   new Date(endDate).toISOString() }),
      }),
    });
    if (!adSetRes.ok || adSetRes.data.error) {
      errors.push({ step: 'adset', error: adSetRes.data?.error?.message });
    }
    const adSetId = adSetRes.data?.id;

    // 3. Create Ad Creative (link ad)
    let creativeId = null;
    if (adSetId) {
      const creativeRes = await apiFetch(`${BASE}/${accountId}/adcreatives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: token,
          name:  `Creative — ${copy.headline}`,
          object_story_spec: {
            page_id: pageId,
            link_data: {
              message:     copy.primary_text,
              link:        process.env.FRONTEND_URL || 'https://app.dutyjoy.com',
              name:        copy.headline,
              description: copy.description,
              call_to_action: { type: copy.cta || 'LEARN_MORE', value: { link: process.env.FRONTEND_URL || 'https://app.dutyjoy.com' } },
              ...(imageUrl && { picture: imageUrl }),
            },
          },
        }),
      });
      if (!creativeRes.ok || creativeRes.data.error) {
        errors.push({ step: 'creative', error: creativeRes.data?.error?.message });
      } else {
        creativeId = creativeRes.data.id;
      }
    }

    // 4. Create Ad
    let adId = null;
    if (adSetId && creativeId) {
      const adRes = await apiFetch(`${BASE}/${accountId}/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: token,
          name:      `Ad — ${copy.headline}`,
          adset_id:  adSetId,
          creative:  { creative_id: creativeId },
          status:    'PAUSED',
        }),
      });
      if (!adRes.ok || adRes.data.error) {
        errors.push({ step: 'ad', error: adRes.data?.error?.message });
      } else {
        adId = adRes.data.id;
      }
    }

    // Update DB
    if (campaignId) {
      await prisma.adCampaign.update({
        where: { id: campaignId },
        data:  {
          externalId: metaCampaignId,
          estado:     errors.length === 0 ? 'activa' : 'error',
          metadata:   { metaCampaignId, adSetId, creativeId, adId, errors },
          presupuestoDiario: dailyBudgetUSD,
        },
      });
    }

    res.json({
      ok: errors.length === 0,
      metaCampaignId, adSetId, creativeId, adId,
      warnings: errors.length > 0 ? errors : undefined,
      message: errors.length === 0
        ? '✅ Campaña Meta creada (estado PAUSED — actívala desde Meta Ads Manager)'
        : '⚠️ Campaña creada con errores parciales. Revisa warnings.',
    });
  } catch (e) {
    console.error('[ads/publish/meta]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/publish/tiktok — create real TikTok campaign
// ══════════════════════════════════════════════════════════════════════
router.post('/publish/tiktok', verifyToken, soloAdmin, async (req, res) => {
  const token        = process.env.TIKTOK_ACCESS_TOKEN;
  const advertiserId = process.env.TIKTOK_ADVERTISER_ID;
  if (!token || !advertiserId) return res.status(503).json({ error: 'TIKTOK_ACCESS_TOKEN y TIKTOK_ADVERTISER_ID requeridos' });

  const { campaignId, dailyBudgetUSD = 20 } = req.body;
  const dbCamp = campaignId ? await prisma.adCampaign.findUnique({ where: { id: campaignId } }) : null;
  const copy   = dbCamp?.copy?.tiktok || req.body.copy;
  if (!copy) return res.status(400).json({ error: 'copy requerido' });

  const BASE    = 'https://business-api.tiktok.com/open_api/v1.3';
  const headers = { 'Access-Token': token, 'Content-Type': 'application/json' };

  try {
    // 1. Campaign
    const campRes = await apiFetch(`${BASE}/campaign/create/`, {
      method: 'POST', headers,
      body: JSON.stringify({
        advertiser_id: advertiserId,
        campaign_name: dbCamp?.nombre || 'DutyJoy Campaign',
        objective_type: 'TRAFFIC',
        budget_mode: 'BUDGET_MODE_DAY',
        budget: dailyBudgetUSD,
        operation_status: 'DISABLE',
      }),
    });
    if (campRes.data?.code !== 0) {
      return res.status(400).json({ error: campRes.data?.message || 'Error creando campaña TikTok', raw: campRes.data });
    }
    const ttCampaignId = campRes.data.data?.campaign_id;

    // 2. Ad Group
    const adGroupRes = await apiFetch(`${BASE}/adgroup/create/`, {
      method: 'POST', headers,
      body: JSON.stringify({
        advertiser_id:   advertiserId,
        campaign_id:     ttCampaignId,
        adgroup_name:    `AdGroup — ${new Date().toISOString().split('T')[0]}`,
        placements:      ['PLACEMENT_TIKTOK'],
        location_ids:    ['CO'],
        age:             ['AGE_25_34','AGE_35_44'],
        budget_mode:     'BUDGET_MODE_DAY',
        budget:          dailyBudgetUSD,
        schedule_type:   'SCHEDULE_START_END',
        operation_status:'DISABLE',
        billing_event:   'CPC',
        pacing:          'PACING_MODE_SMOOTH',
      }),
    });
    const adGroupId = adGroupRes.data?.data?.adgroup_id;

    // 3. Ad (text-only creative — images require upload API)
    let adId = null;
    if (adGroupId) {
      const adRes = await apiFetch(`${BASE}/ad/create/`, {
        method: 'POST', headers,
        body: JSON.stringify({
          advertiser_id: advertiserId,
          adgroup_id:    adGroupId,
          creatives: [{
            ad_name:    copy.video_hook || dbCamp?.nombre || 'DutyJoy Ad',
            ad_text:    copy.text_overlay || copy.video_hook,
            call_to_action: 'DOWNLOAD_NOW',
            landing_page_url: process.env.FRONTEND_URL || 'https://app.dutyjoy.com',
          }],
          operation_status: 'DISABLE',
        }),
      });
      adId = adRes.data?.data?.ad_ids?.[0];
    }

    if (campaignId) {
      await prisma.adCampaign.update({
        where: { id: campaignId },
        data:  { externalId: ttCampaignId, estado: 'activa', metadata: { ttCampaignId, adGroupId, adId }, presupuestoDiario: dailyBudgetUSD },
      });
    }

    res.json({ ok: true, ttCampaignId, adGroupId, adId, message: '✅ Campaña TikTok creada (estado DISABLE — actívala desde TikTok Ads Manager)' });
  } catch (e) {
    console.error('[ads/publish/tiktok]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/publish/google — create Google Search campaign
// ══════════════════════════════════════════════════════════════════════
router.post('/publish/google', verifyToken, soloAdmin, async (req, res) => {
  const devToken    = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId    = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret= process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken= process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const customerId  = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, '');
  if (!devToken || !refreshToken || !customerId) return res.status(503).json({ error: 'Google Ads no configurado' });

  const { campaignId, dailyBudgetUSD = 10 } = req.body;
  const dbCamp = campaignId ? await prisma.adCampaign.findUnique({ where: { id: campaignId } }) : null;
  const copy   = dbCamp?.copy?.google_search || req.body.copy;
  if (!copy) return res.status(400).json({ error: 'copy requerido' });

  try {
    // Get access token
    const tokenRes = await apiFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    });
    if (!tokenRes.ok || tokenRes.data.error) return res.status(401).json({ error: 'Google OAuth failed: ' + tokenRes.data.error_description });
    const accessToken = tokenRes.data.access_token;

    const googleHeaders = {
      'Authorization':   `Bearer ${accessToken}`,
      'developer-token': devToken,
      'Content-Type':    'application/json',
    };
    const BASE = `https://googleads.googleapis.com/v17/customers/${customerId}`;

    // 1. Create Budget
    const budgetMicros = dailyBudgetUSD * 1_000_000;
    const budgetRes = await apiFetch(`${BASE}/campaignBudgets:mutate`, {
      method: 'POST', headers: googleHeaders,
      body: JSON.stringify({
        operations: [{
          create: {
            name:           `DutyJoy Budget ${Date.now()}`,
            amountMicros:   budgetMicros,
            deliveryMethod: 'STANDARD',
          },
        }],
      }),
    });
    if (!budgetRes.ok) return res.status(400).json({ error: 'Error creando presupuesto Google', raw: budgetRes.data });
    const budgetResourceName = budgetRes.data.results?.[0]?.resourceName;

    // 2. Create Campaign
    const gCampRes = await apiFetch(`${BASE}/campaigns:mutate`, {
      method: 'POST', headers: googleHeaders,
      body: JSON.stringify({
        operations: [{
          create: {
            name:            dbCamp?.nombre || 'DutyJoy Campaign',
            status:          'PAUSED',
            advertisingChannelType: 'SEARCH',
            campaignBudget:  budgetResourceName,
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false },
            geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' },
          },
        }],
      }),
    });
    if (!gCampRes.ok) return res.status(400).json({ error: 'Error creando campaña Google', raw: gCampRes.data });
    const gCampaignResourceName = gCampRes.data.results?.[0]?.resourceName;
    const gCampaignId = gCampaignResourceName?.split('/').pop();

    // 3. Create Ad Group
    const adGroupRes = await apiFetch(`${BASE}/adGroups:mutate`, {
      method: 'POST', headers: googleHeaders,
      body: JSON.stringify({
        operations: [{
          create: {
            name:     'DutyJoy AdGroup',
            campaign: gCampaignResourceName,
            status:   'ENABLED',
            type:     'SEARCH_STANDARD',
            cpcBidMicros: 500000,
          },
        }],
      }),
    });
    const adGroupResourceName = adGroupRes.data?.results?.[0]?.resourceName;

    // 4. Create Responsive Search Ad
    let adResourceName = null;
    if (adGroupResourceName && copy.headlines) {
      const headlines    = (copy.headlines || []).slice(0, 15).map(t => ({ text: t.slice(0, 30) }));
      const descriptions = (copy.descriptions || []).slice(0, 4).map(t => ({ text: t.slice(0, 90) }));

      const adRes = await apiFetch(`${BASE}/ads:mutate`, {
        method: 'POST', headers: googleHeaders,
        body: JSON.stringify({
          operations: [{
            create: {
              responsiveSearchAd: {
                headlines,
                descriptions,
                path1: 'servicios',
                path2: 'hogar',
              },
              finalUrls: [process.env.FRONTEND_URL || 'https://app.dutyjoy.com'],
              status: 'PAUSED',
            },
          }],
        }),
      });
      adResourceName = adRes.data?.results?.[0]?.resourceName;
    }

    // 5. Create Keywords
    if (adGroupResourceName && copy.keywords) {
      const kwOps = [
        ...(copy.keywords.exacto || []).map(k => ({ create: { adGroup: adGroupResourceName, text: k, matchType: 'EXACT', status: 'ENABLED', cpcBidMicros: 600000 } })),
        ...(copy.keywords.frase  || []).map(k => ({ create: { adGroup: adGroupResourceName, text: k, matchType: 'PHRASE', status: 'ENABLED', cpcBidMicros: 400000 } })),
      ];
      if (kwOps.length) {
        await apiFetch(`${BASE}/adGroupCriteria:mutate`, { method: 'POST', headers: googleHeaders, body: JSON.stringify({ operations: kwOps }) });
      }
    }

    if (campaignId) {
      await prisma.adCampaign.update({
        where: { id: campaignId },
        data:  { externalId: gCampaignId, estado: 'activa', metadata: { gCampaignResourceName, adGroupResourceName, adResourceName }, presupuestoDiario: dailyBudgetUSD },
      });
    }

    res.json({ ok: true, gCampaignId, gCampaignResourceName, adGroupResourceName, adResourceName, message: '✅ Campaña Google Ads creada (estado PAUSED — actívala desde Google Ads)' });
  } catch (e) {
    console.error('[ads/publish/google]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  GET /ads/campaigns — list all from DB
// ══════════════════════════════════════════════════════════════════════
router.get('/campaigns', verifyToken, soloAdmin, async (req, res) => {
  const { estado, plataforma, page = 1, limit = 20 } = req.query;
  const take = Math.min(parseInt(limit), 100);
  const skip = (Math.max(parseInt(page), 1) - 1) * take;

  const where = {
    ...(estado     && estado !== 'todas'     && { estado }),
    ...(plataforma && plataforma !== 'todas' && { plataforma }),
  };

  const [campaigns, total] = await Promise.all([
    prisma.adCampaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip, take,
      include: { _count: { select: { automations: true } } },
    }),
    prisma.adCampaign.count({ where }),
  ]);

  res.json({ campaigns, total, page: parseInt(page), totalPages: Math.ceil(total / take) });
});

// ══════════════════════════════════════════════════════════════════════
//  PATCH /ads/campaigns/:id — update campaign (pause/activate/edit)
// ══════════════════════════════════════════════════════════════════════
router.patch('/campaigns/:id', verifyToken, soloAdmin, async (req, res) => {
  const { estado, nombre, presupuestoDiario, aiScore, aiNotas } = req.body;
  const data = {};
  if (estado)           data.estado           = estado;
  if (nombre)           data.nombre           = nombre;
  if (presupuestoDiario !== undefined) data.presupuestoDiario = presupuestoDiario;
  if (aiScore !== undefined) data.aiScore     = aiScore;
  if (aiNotas)          data.aiNotas          = aiNotas;

  const updated = await prisma.adCampaign.update({ where: { id: req.params.id }, data });
  res.json({ ok: true, campaign: updated });
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/agent/audit — AI audits all active campaigns
// ══════════════════════════════════════════════════════════════════════
router.post('/agent/audit', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY requerido' });

  const campaigns = await prisma.adCampaign.findMany({
    where: { estado: { in: ['activa', 'pausada', 'borrador'] } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });

  const campSummary = campaigns.map(c => ({
    id: c.id,
    nombre: c.nombre,
    plataforma: c.plataforma,
    estado: c.estado,
    presupuesto: c.presupuestoDiario || c.presupuestoTotal,
    gastado: c.gastado,
    impresiones: c.impresiones,
    clicks: c.clicks,
    conversiones: c.conversiones,
    cpa: c.cpa,
    ctr: c.ctr,
    roas: c.roas,
    aiScore: c.aiScore,
    diasActiva: c.startDate ? Math.round((Date.now() - new Date(c.startDate)) / 86400000) : null,
  }));

  // Pull platform-level real data if configured
  let platformContext = '';
  try {
    const metaToken = process.env.META_ACCESS_TOKEN;
    const metaAcc   = process.env.META_AD_ACCOUNT_ID;
    if (metaToken && metaAcc) {
      const r = await apiFetch(`https://graph.facebook.com/v20.0/${metaAcc}/insights?fields=spend,impressions,clicks,ctr,cpc,actions&level=account&date_preset=last_7d&access_token=${metaToken}`);
      if (r.ok && r.data.data?.[0]) {
        const d = r.data.data[0];
        platformContext += `\nMeta real (últimos 7d): spend $${d.spend}, impressions ${d.impressions}, clicks ${d.clicks}, CTR ${d.ctr}%`;
      }
    }
  } catch {}

  const prompt = `Eres el agente IA de marketing de DutyJoy. Audita estas campañas y devuelve recomendaciones concretas y accionables.

CAMPAÑAS ACTUALES:
${JSON.stringify(campSummary, null, 2)}
${platformContext}

Benchmarks DutyJoy:
- CPA target: < $8 USD
- CTR mínimo: > 1.5%
- ROAS mínimo: > 2.5x
- Frecuencia máxima: < 4x antes de refrescar creativos

Analiza cada campaña. Devuelve SOLO JSON:
{
  "score_general": <0-100>,
  "resumen": "<2-3 oraciones ejecutivas>",
  "alertas": [
    { "nivel": "critica|alta|media|baja", "campanaId": "<id o null>", "mensaje": "<qué está mal>", "accion_recomendada": "<qué hacer exactamente>" }
  ],
  "recomendaciones": [
    { "campanaId": "<id>", "tipo": "pausar|aumentar_presupuesto|reducir_presupuesto|refrescar_creativos|cambiar_audiencia|escalar", "razon": "<por qué>", "impacto_estimado": "<qué esperar>" }
  ],
  "oportunidades": [
    { "titulo": "<oportunidad>", "descripcion": "<detalle>", "plataforma": "<meta|google|tiktok|todas>" }
  ],
  "proximas_acciones": ["<acción 1>","<acción 2>","<acción 3>"]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1800,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    const audit = JSON.parse(completion.choices[0].message.content);

    // Apply AI scores to campaigns
    for (const rec of (audit.recomendaciones || [])) {
      if (!rec.campanaId) continue;
      let score = 70;
      if (rec.tipo === 'pausar') score = 25;
      else if (rec.tipo === 'escalar') score = 92;
      else if (rec.tipo === 'aumentar_presupuesto') score = 80;
      await prisma.adCampaign.update({
        where:  { id: rec.campanaId },
        data:   { aiScore: score, aiNotas: rec.razon },
      }).catch(() => {});
    }

    res.json({ audit, campaignsAudited: campaigns.length, auditedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[ads/agent/audit]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/agent/optimize — AI agent takes action on a campaign
// ══════════════════════════════════════════════════════════════════════
router.post('/agent/optimize', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY requerido' });

  const { campaignId, autoApply = false } = req.body;
  if (!campaignId) return res.status(400).json({ error: 'campaignId requerido' });

  const camp = await prisma.adCampaign.findUnique({ where: { id: campaignId } });
  if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });

  // Agent tools
  const tools = [
    {
      type: 'function',
      function: {
        name: 'pausar_campana',
        description: 'Pausa la campaña porque su rendimiento es pobre',
        parameters: { type: 'object', properties: { razon: { type: 'string' } }, required: ['razon'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ajustar_presupuesto',
        description: 'Aumenta o reduce el presupuesto diario',
        parameters: {
          type: 'object',
          properties: {
            cambio_pct: { type: 'number', description: 'Porcentaje de cambio. Positivo = aumentar, Negativo = reducir' },
            razon: { type: 'string' },
          },
          required: ['cambio_pct', 'razon'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generar_nuevos_creativos',
        description: 'Solicita nueva copy creativa para refrescar el anuncio',
        parameters: {
          type: 'object',
          properties: { problema: { type: 'string', description: 'Qué problema tiene el creativo actual' } },
          required: ['problema'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'escalar_campana',
        description: 'Escala la campaña aumentando presupuesto agresivamente porque está performando bien',
        parameters: {
          type: 'object',
          properties: { nueva_meta_diaria: { type: 'number' }, razon: { type: 'string' } },
          required: ['nueva_meta_diaria', 'razon'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'crear_informe',
        description: 'Genera un informe de rendimiento de la campaña sin cambios',
        parameters: {
          type: 'object',
          properties: { conclusion: { type: 'string' }, score: { type: 'number' } },
          required: ['conclusion', 'score'],
        },
      },
    },
  ];

  const systemPrompt = `Eres el agente autónomo de optimización de campañas de DutyJoy.
Analiza los datos de la campaña y usa las herramientas disponibles para optimizarla.
Toma la decisión más impactante y justifica con datos.
Benchmarks: CPA < $8 USD, CTR > 1.5%, ROAS > 2.5x, frecuencia < 4.`;

  const userPrompt = `Campaña a optimizar:
${JSON.stringify({
  id: camp.id, nombre: camp.nombre, plataforma: camp.plataforma, estado: camp.estado,
  presupuestoDiario: camp.presupuestoDiario, gastado: camp.gastado,
  impresiones: camp.impresiones, clicks: camp.clicks, conversiones: camp.conversiones,
  cpa: camp.cpa, ctr: camp.ctr, roas: camp.roas, aiScore: camp.aiScore,
}, null, 2)}

Toma UNA acción concreta y ejecuta la herramienta correspondiente.`;

  const actions = [];

  try {
    let messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    // Agentic loop (max 3 turns)
    for (let turn = 0; turn < 3; turn++) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        tools,
        tool_choice: turn === 0 ? 'required' : 'auto',
        messages,
      });

      const msg = completion.choices[0].message;
      messages.push(msg);

      if (!msg.tool_calls?.length) break;

      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        let result = '';

        if (call.function.name === 'pausar_campana') {
          if (autoApply) await prisma.adCampaign.update({ where: { id: campaignId }, data: { estado: 'pausada', aiNotas: args.razon } });
          actions.push({ tipo: 'pausar', aplicado: autoApply, razon: args.razon });
          result = autoApply ? 'Campaña pausada exitosamente' : 'Recomendación de pausa generada (pendiente aprobación)';
        }
        else if (call.function.name === 'ajustar_presupuesto') {
          const actual  = camp.presupuestoDiario || 10;
          const nuevo   = parseFloat((actual * (1 + args.cambio_pct / 100)).toFixed(2));
          if (autoApply) await prisma.adCampaign.update({ where: { id: campaignId }, data: { presupuestoDiario: nuevo, aiNotas: args.razon } });
          actions.push({ tipo: 'ajustar_presupuesto', aplicado: autoApply, cambio_pct: args.cambio_pct, presupuesto_nuevo: nuevo, razon: args.razon });
          result = `Presupuesto ${args.cambio_pct > 0 ? 'aumentado' : 'reducido'} de $${actual} a $${nuevo}/día`;
        }
        else if (call.function.name === 'generar_nuevos_creativos') {
          actions.push({ tipo: 'nuevos_creativos', aplicado: false, problema: args.problema });
          result = 'Solicitud de nuevos creativos registrada';
        }
        else if (call.function.name === 'escalar_campana') {
          if (autoApply) await prisma.adCampaign.update({ where: { id: campaignId }, data: { presupuestoDiario: args.nueva_meta_diaria, aiNotas: args.razon } });
          actions.push({ tipo: 'escalar', aplicado: autoApply, nueva_meta: args.nueva_meta_diaria, razon: args.razon });
          result = `Campaña escalada a $${args.nueva_meta_diaria}/día`;
        }
        else if (call.function.name === 'crear_informe') {
          if (autoApply) await prisma.adCampaign.update({ where: { id: campaignId }, data: { aiScore: args.score, aiNotas: args.conclusion } });
          actions.push({ tipo: 'informe', score: args.score, conclusion: args.conclusion });
          result = 'Informe generado';
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }

      if (completion.choices[0].finish_reason === 'stop') break;
    }

    // Log automation
    if (actions.length) {
      await prisma.adAutomationLog.create({
        data: {
          automationId: 'ai-agent',
          campaignId,
          accionTomada: actions.map(a => a.tipo).join(', '),
          detalles: JSON.stringify(actions),
        },
      }).catch(() => {});
    }

    res.json({ ok: true, actions, autoApply, campaignId });
  } catch (e) {
    console.error('[ads/agent/optimize]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/agent/refine — refine/iterate ad copy with AI
// ══════════════════════════════════════════════════════════════════════
router.post('/agent/refine', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY requerido' });

  const { campaignId, feedback, plataforma = 'meta_facebook' } = req.body;
  const camp = campaignId ? await prisma.adCampaign.findUnique({ where: { id: campaignId } }) : null;
  const currentCopy = camp?.copy?.[plataforma] || req.body.currentCopy;
  if (!currentCopy || !feedback) return res.status(400).json({ error: 'currentCopy y feedback requeridos' });

  const prompt = `Eres director creativo de DutyJoy. El equipo tiene este feedback sobre el anuncio y quiere una versión mejorada.

COPY ACTUAL (${plataforma}):
${JSON.stringify(currentCopy, null, 2)}

FEEDBACK: ${feedback}

Genera una versión mejorada que incorpore el feedback. Mantén la estructura del JSON original.
Responde SOLO con el JSON del copy mejorado para ${plataforma}, con el mismo formato que el original.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 800,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });

  const refined = JSON.parse(completion.choices[0].message.content);

  if (campaignId && camp) {
    const updatedCopy = { ...(camp.copy || {}), [plataforma]: refined };
    await prisma.adCampaign.update({ where: { id: campaignId }, data: { copy: updatedCopy } });
  }

  res.json({ ok: true, refined, plataforma });
});

// ══════════════════════════════════════════════════════════════════════
//  GET /ads/automations — list rules
// ══════════════════════════════════════════════════════════════════════
router.get('/automations', verifyToken, soloAdmin, async (req, res) => {
  const automations = await prisma.adAutomation.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { logs: true } } },
  });
  res.json({ automations });
});

// ── POST /ads/automations — create rule ─────────────────────────────
router.post('/automations', verifyToken, soloAdmin, async (req, res) => {
  const { nombre, condicion, valor, accion, parametro, plataforma } = req.body;
  const CONDICIONES = ['cpa_mayor','ctr_menor','roas_menor','roas_mayor','gasto_diario_mayor','impresiones_bajas','sin_conversiones_24h'];
  const ACCIONES    = ['pausar','activar','aumentar_presupuesto','reducir_presupuesto','alertar','duplicar'];
  if (!nombre || !condicion || valor === undefined || !accion) return res.status(400).json({ error: 'nombre, condicion, valor y accion requeridos' });
  if (!CONDICIONES.includes(condicion)) return res.status(400).json({ error: 'condicion inválida' });
  if (!ACCIONES.includes(accion))       return res.status(400).json({ error: 'accion inválida' });

  const automation = await prisma.adAutomation.create({
    data: { nombre, condicion, valor: parseFloat(valor), accion, parametro: parametro ? parseFloat(parametro) : null, plataforma: plataforma || 'todas' },
  });
  res.json({ ok: true, automation });
});

// ── PATCH /ads/automations/:id — toggle active ──────────────────────
router.patch('/automations/:id', verifyToken, soloAdmin, async (req, res) => {
  const { activa } = req.body;
  const updated = await prisma.adAutomation.update({ where: { id: req.params.id }, data: { activa } });
  res.json({ ok: true, automation: updated });
});

// ── DELETE /ads/automations/:id ─────────────────────────────────────
router.delete('/automations/:id', verifyToken, soloAdmin, async (req, res) => {
  await prisma.adAutomation.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
//  POST /ads/automations/run — execute all active rules against campaigns
// ══════════════════════════════════════════════════════════════════════
router.post('/automations/run', verifyToken, soloAdmin, async (req, res) => {
  const [automations, campaigns] = await Promise.all([
    prisma.adAutomation.findMany({ where: { activa: true } }),
    prisma.adCampaign.findMany({ where: { estado: { in: ['activa','pausada'] } } }),
  ]);

  const results = [];

  for (const auto of automations) {
    for (const camp of campaigns) {
      if (auto.plataforma !== 'todas' && auto.plataforma !== camp.plataforma) continue;

      let triggered = false;
      const cpa  = camp.cpa  || (camp.gastado && camp.conversiones ? camp.gastado / camp.conversiones : null);
      const ctr  = camp.ctr  || (camp.clicks && camp.impresiones   ? (camp.clicks / camp.impresiones) * 100 : null);
      const roas = camp.roas;
      const gastoDiario = camp.presupuestoDiario || 0;

      switch (auto.condicion) {
        case 'cpa_mayor':              triggered = cpa  !== null && cpa  >  auto.valor; break;
        case 'ctr_menor':              triggered = ctr  !== null && ctr  <  auto.valor; break;
        case 'roas_menor':             triggered = roas !== null && roas <  auto.valor; break;
        case 'roas_mayor':             triggered = roas !== null && roas >  auto.valor; break;
        case 'gasto_diario_mayor':     triggered = gastoDiario  > auto.valor; break;
        case 'impresiones_bajas':      triggered = camp.impresiones < auto.valor; break;
        case 'sin_conversiones_24h':   triggered = camp.conversiones === 0 && camp.impresiones > auto.valor; break;
      }

      if (!triggered) continue;

      // Execute action
      let detalles = '';
      const updateData = {};

      switch (auto.accion) {
        case 'pausar':
          updateData.estado = 'pausada';
          detalles = `Pausada: ${auto.condicion} = ${auto.valor}`;
          break;
        case 'activar':
          updateData.estado = 'activa';
          detalles = `Activada por regla`;
          break;
        case 'aumentar_presupuesto': {
          const pct   = auto.parametro || 20;
          const nuevo = parseFloat(((camp.presupuestoDiario || 10) * (1 + pct / 100)).toFixed(2));
          updateData.presupuestoDiario = nuevo;
          detalles = `Presupuesto aumentado ${pct}% → $${nuevo}/día`;
          break;
        }
        case 'reducir_presupuesto': {
          const pct   = auto.parametro || 20;
          const nuevo = parseFloat(((camp.presupuestoDiario || 10) * (1 - pct / 100)).toFixed(2));
          updateData.presupuestoDiario = Math.max(1, nuevo);
          detalles = `Presupuesto reducido ${pct}% → $${nuevo}/día`;
          break;
        }
        case 'alertar':
          detalles = `Alerta: ${auto.condicion} = ${auto.valor} en ${camp.nombre}`;
          break;
      }

      if (Object.keys(updateData).length) {
        await prisma.adCampaign.update({ where: { id: camp.id }, data: updateData });
      }

      await prisma.adAutomation.update({ where: { id: auto.id }, data: { disparos: { increment: 1 }, ultimoDisparo: new Date() } });
      await prisma.adAutomationLog.create({ data: { automationId: auto.id, campaignId: camp.id, accionTomada: auto.accion, detalles } });

      results.push({ automationId: auto.id, campaignId: camp.id, accion: auto.accion, detalles });
    }
  }

  res.json({ ok: true, actionsExecuted: results.length, results });
});

// ══════════════════════════════════════════════════════════════════════
//  GET /ads/automations/:id/logs — automation logs
// ══════════════════════════════════════════════════════════════════════
router.get('/automations/:id/logs', verifyToken, soloAdmin, async (req, res) => {
  const logs = await prisma.adAutomationLog.findMany({
    where: { automationId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { campaign: { select: { nombre: true, plataforma: true } } },
  });
  res.json({ logs });
});

module.exports = router;
