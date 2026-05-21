/**
 * predictions.routes.js — AI Predictive Intelligence
 * No-show risk · Churn · Dispute forecast · Revenue · Demand · Quality · Fraud · Early Warning
 *
 * Strategy: pull real DB stats → GPT-4o reasons → returns scored, actionable predictions.
 * Temperature 0.2 for factual/deterministic output on all models.
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

const ai = (prompt, { model = 'gpt-4o', max_tokens = 2500, json = true, temp = 0.2 } = {}) => {
  if (!openai) return Promise.reject(new Error('OPENAI_API_KEY no configurado'));
  return openai.chat.completions.create({
    model, max_tokens, temperature: temp,
    ...(json && { response_format: { type: 'json_object' } }),
    messages: [{ role: 'user', content: prompt }],
  }).then(r => json ? JSON.parse(r.choices[0].message.content) : r.choices[0].message.content);
};

const now     = () => new Date();
const daysAgo = d => new Date(Date.now() - d * 86_400_000);
const daysAhead = d => new Date(Date.now() + d * 86_400_000);

/* ══════════════════════════════════════════════════════════════════════════
   1. NO-SHOW RISK PREDICTION
   GET /predictions/no-show-risk
   Scores each upcoming CONFIRMADO booking for provider no-show probability.
══════════════════════════════════════════════════════════════════════════ */
router.get('/no-show-risk', verifyToken, soloAdmin, async (req, res) => {
  try {
    const upcoming = await prisma.booking.findMany({
      where: { estado: 'CONFIRMADO', fechaServicio: { gte: now(), lte: daysAhead(7) } },
      include: {
        proveedor: { include: { user: { select: { nombre: true, ciudad: true } } } },
        cliente:   { select: { nombre: true, ciudad: true } },
      },
      orderBy: { fechaServicio: 'asc' },
      take: 60,
    });

    if (!upcoming.length) return res.json({ predictions: [], resumen: 'Sin reservas confirmadas en los próximos 7 días.' });

    const records = upcoming.map(b => {
      const horasHastaServicio = (new Date(b.fechaServicio) - now()) / 3_600_000;
      const tasaCompletacion   = b.proveedor.tasaAceptacion ?? (b.proveedor.reservasCompletadas > 0 ? 0.85 : null);
      return {
        id:              b.id,
        bookingRef:      `BK-${b.id.slice(-6).toUpperCase()}`,
        proveedor:       b.proveedor.user.nombre,
        cliente:         b.cliente.nombre,
        servicio:        b.tipoServicio,
        precioTotal:     b.precioTotal,
        fechaServicio:   b.fechaServicio.toISOString(),
        horasHastaServicio: Math.round(horasHastaServicio),
        calificacion:    b.proveedor.calificacion,
        verificado:      b.proveedor.verificado,
        reservasCompletadas: b.proveedor.reservasCompletadas,
        tasaAceptacion:  tasaCompletacion,
        tiempoRespuestaH: b.proveedor.tiempoRespuestaH,
        ciudad:          b.cliente.ciudad,
      };
    });

    const result = await ai(
      `Eres el modelo predictivo de DutyJoy Colombia (marketplace de servicios del hogar).
Analiza estos ${records.length} bookings CONFIRMADOS próximos y predice cuáles tienen mayor riesgo de que el proveedor NO se presente (no-show).

DATOS DE RESERVAS:
${JSON.stringify(records, null, 1)}

FACTORES DE RIESGO CONOCIDOS EN NUESTRO NEGOCIO:
- Calificación < 4.0 → riesgo elevado
- Sin verificar (verificado=false) → riesgo elevado
- reservasCompletadas < 5 → proveedor nuevo, mayor riesgo
- tasaAceptacion < 0.75 → patrón de cancelaciones
- Servicio en < 12 horas → poco tiempo para reaccionar
- Valores altos (> $150,000 COP) con proveedores sin reseñas → riesgo

Devuelve JSON:
{
  "predicciones": [
    {
      "bookingRef": "BK-xxx",
      "proveedor": "nombre",
      "cliente": "nombre",
      "servicio": "tipo",
      "fechaServicio": "ISO string",
      "horasHastaServicio": 0,
      "riesgo_noshow": "critico|alto|medio|bajo",
      "probabilidad": 0.0,
      "score": 0,
      "factores_riesgo": ["factor 1", "factor 2"],
      "accion_recomendada": "qué hacer ahora mismo",
      "urgencia_accion_horas": 0,
      "alternativa_disponible": true
    }
  ],
  "resumen": "texto general de la situación",
  "total_en_riesgo": 0,
  "valor_en_riesgo_cop": 0,
  "patron_detectado": "si hay un patrón recurrente"
}

Score 0-100 (100 = certeza de no-show). Solo incluye los de riesgo medio/alto/crítico (prob > 0.20).
Ordena por score descendente.`,
      { max_tokens: 3000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   2. CHURN RISK PREDICTION
   GET /predictions/churn-risk
   Clients + Providers at risk of leaving the platform.
══════════════════════════════════════════════════════════════════════════ */
router.get('/churn-risk', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [clientStats, providerStats] = await Promise.all([
      // Clients: last booking + dispute history
      prisma.user.findMany({
        where: { rol: 'CLIENTE', activo: true },
        select: {
          id: true, nombre: true, email: true, ciudad: true, createdAt: true,
          bookingsComoCliente: {
            orderBy: { createdAt: 'desc' }, take: 5,
            select: { estado: true, precioTotal: true, createdAt: true, tipoServicio: true },
          },
          disputas: { select: { id: true, estado: true, createdAt: true }, take: 3 },
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      // Providers: rating trend + activity
      prisma.providerProfile.findMany({
        where: { disponible: true },
        select: {
          id: true, calificacion: true, totalReviews: true, verificado: true,
          reservasCompletadas: true, tasaAceptacion: true,
          user: { select: { nombre: true, email: true, ciudad: true, createdAt: true } },
          bookings: {
            orderBy: { createdAt: 'desc' }, take: 10,
            select: { estado: true, createdAt: true, precioTotal: true },
          },
          reviews: {
            orderBy: { createdAt: 'desc' }, take: 5,
            select: { calificacion: true, createdAt: true },
          },
        },
        take: 100,
      }),
    ]);

    // Compute client churn signals
    const thirtyDaysAgo = daysAgo(30);
    const clientSignals = clientStats.map(u => {
      const lastBooking = u.bookingsComoCliente[0];
      const daysSinceLast = lastBooking ? Math.round((now() - new Date(lastBooking.createdAt)) / 86_400_000) : 999;
      const totalGastado  = u.bookingsComoCliente.reduce((s, b) => s + (b.precioTotal || 0), 0);
      const disputeCount  = u.disputas.length;
      const lastCancelled = u.bookingsComoCliente.filter(b => b.estado === 'CANCELADO').length;
      return {
        nombre: u.nombre, ciudad: u.ciudad,
        diasSinReserva: daysSinceLast,
        totalReservas: u.bookingsComoCliente.length,
        totalGastadoCOP: Math.round(totalGastado),
        disputas: disputeCount,
        cancelaciones: lastCancelled,
        miembroDesde: u.createdAt.toISOString().split('T')[0],
      };
    }).filter(u => u.diasSinReserva > 20 || u.disputas > 0 || u.cancelaciones > 1);

    // Provider churn signals
    const providerSignals = providerStats.map(p => {
      const lastBooking  = p.bookings[0];
      const daysSinceLast = lastBooking ? Math.round((now() - new Date(lastBooking.createdAt)) / 86_400_000) : 999;
      const recentRatings = p.reviews.map(r => r.calificacion);
      const recentAvg     = recentRatings.length ? recentRatings.reduce((a,b) => a+b,0) / recentRatings.length : null;
      const ratingTrend   = (recentAvg && p.calificacion) ? recentAvg - p.calificacion : 0;
      return {
        nombre: p.user.nombre, ciudad: p.user.ciudad,
        calificacion: p.calificacion, totalReviews: p.totalReviews,
        reservasCompletadas: p.reservasCompletadas,
        tasaAceptacion: p.tasaAceptacion,
        diasSinActividad: daysSinceLast,
        tendenciaCalificacion: Math.round(ratingTrend * 10) / 10,
        verificado: p.verificado,
      };
    }).filter(p => p.diasSinActividad > 14 || p.calificacion < 3.8 || (p.tendenciaCalificacion < -0.5));

    const result = await ai(
      `Eres el modelo de predicción de churn de DutyJoy Colombia.

CLIENTES CON SEÑALES DE RIESGO (${clientSignals.length}):
${JSON.stringify(clientSignals.slice(0, 30), null, 1)}

PROVEEDORES CON SEÑALES DE RIESGO (${providerSignals.length}):
${JSON.stringify(providerSignals.slice(0, 20), null, 1)}

CONTEXTO DUTYJOY:
- Ciclo normal de reserva: cada 2-4 semanas
- Cliente inactivo > 30 días = señal de churn
- Proveedor sin actividad > 14 días = señal de abandono
- Rating < 3.8 = proveedor en riesgo de ser removido

Devuelve JSON:
{
  "clientes_en_riesgo": [
    {
      "nombre": "string",
      "ciudad": "string",
      "nivel_riesgo": "critico|alto|medio",
      "probabilidad_churn": 0.0,
      "valor_perdido_estimado_cop": 0,
      "razon_principal": "por qué se va a ir",
      "accion_retencion": "qué hacer para retenerlo",
      "ventana_accion_dias": 0
    }
  ],
  "proveedores_en_riesgo": [
    {
      "nombre": "string",
      "ciudad": "string",
      "nivel_riesgo": "critico|alto|medio",
      "probabilidad_abandono": 0.0,
      "impacto_oferta": "alto|medio|bajo",
      "razon_principal": "string",
      "accion_retencion": "string",
      "ventana_accion_dias": 0
    }
  ],
  "resumen_ejecutivo": "texto breve del estado general de churn",
  "valor_total_en_riesgo_cop": 0,
  "tasa_churn_estimada_mensual": 0.0,
  "recomendacion_prioridad": "qué hacer primero esta semana"
}`,
      { max_tokens: 3000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   3. DISPUTE PROBABILITY FORECAST
   GET /predictions/dispute-forecast
   Scores recent/active bookings for dispute likelihood.
══════════════════════════════════════════════════════════════════════════ */
router.get('/dispute-forecast', verifyToken, soloAdmin, async (req, res) => {
  try {
    const recentCompleted = await prisma.booking.findMany({
      where: {
        estado: { in: ['COMPLETADO', 'EN_PROGRESO', 'CONFIRMADO'] },
        createdAt: { gte: daysAgo(14) },
      },
      include: {
        proveedor: {
          include: {
            user: { select: { nombre: true } },
            reviews: { orderBy: { createdAt: 'desc' }, take: 3, select: { calificacion: true } },
          },
        },
        cliente:  { select: { nombre: true } },
        disputas: { select: { id: true, estado: true } },
        review:   { select: { calificacion: true } },
      },
      take: 80,
    });

    // Aggregate existing dispute rates per provider
    const providerDisputeCount = await prisma.disputa.groupBy({
      by: ['bookingId'],
      _count: { id: true },
    });

    const records = recentCompleted.map(b => {
      const providerRecentRatings = b.proveedor.reviews.map(r => r.calificacion);
      const providerRecentAvg     = providerRecentRatings.length ? providerRecentRatings.reduce((a,c) => a+c,0) / providerRecentRatings.length : null;
      return {
        bookingRef:   `BK-${b.id.slice(-6).toUpperCase()}`,
        estado:       b.estado,
        proveedor:    b.proveedor.user.nombre,
        cliente:      b.cliente.nombre,
        servicio:     b.tipoServicio,
        precioTotal:  b.precioTotal,
        calificacionProveedor: b.proveedor.calificacion,
        recentAvgProveedor:    providerRecentAvg ? Math.round(providerRecentAvg * 10) / 10 : null,
        verificado:   b.proveedor.verificado,
        yaHayDisputa: b.disputas.length > 0,
        tieneReview:  !!b.review,
        reviewCalif:  b.review?.calificacion ?? null,
        diasDesdeCreacion: Math.round((now() - new Date(b.createdAt)) / 86_400_000),
      };
    }).filter(b => !b.yaHayDisputa); // exclude already-disputed

    const result = await ai(
      `Eres el modelo predictivo de disputas de DutyJoy Colombia.
Analiza estos ${records.length} bookings recientes y predice cuáles tienen alta probabilidad de generar una disputa.

BOOKINGS (sin disputa activa):
${JSON.stringify(records.slice(0, 40), null, 1)}

FACTORES QUE AUMENTAN PROBABILIDAD DE DISPUTA EN DUTYJOY:
- Calificación proveedor < 3.8 → muy alta
- Sin verificar → alta
- Precio > $200,000 COP → mayor motivación para disputar
- Servicio completado sin review después de 48h → señal
- Review con calificación 1-2 → disputa probable
- RecentAvg < calificación general → tendencia bajando

Devuelve JSON:
{
  "bookings_en_riesgo": [
    {
      "bookingRef": "BK-xxx",
      "proveedor": "string",
      "cliente": "string",
      "servicio": "string",
      "precioTotal": 0,
      "probabilidad_disputa": 0.0,
      "score": 0,
      "nivel": "critico|alto|medio|bajo",
      "factores": ["factor 1"],
      "ventana_probable_dias": 0,
      "accion_preventiva": "qué hacer ahora para evitar la disputa",
      "tipo_disputa_probable": "calidad|no_completado|reembolso|comportamiento|otro"
    }
  ],
  "resumen": "estado general",
  "valor_total_en_riesgo_cop": 0,
  "patron_detectado": "string",
  "recomendacion_sistemica": "cambio de proceso que reduciría disputas"
}

Score 0-100. Solo incluye prob > 0.15. Ordena por score desc.`,
      { max_tokens: 3000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   4. REVENUE FORECAST
   GET /predictions/revenue-forecast
   Projects revenue for next 30/60/90 days based on pipeline + trends.
══════════════════════════════════════════════════════════════════════════ */
router.get('/revenue-forecast', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [weeklyRevenue, pipelineBookings, providerCount, clientCount, disputeRate] = await Promise.all([
      // Revenue by week (last 12 weeks)
      prisma.booking.groupBy({
        by: ['estado'],
        where: { createdAt: { gte: daysAgo(84) }, estado: 'COMPLETADO' },
        _sum: { precioTotal: true, comisionDutyJoy: true },
        _count: { id: true },
      }),
      // Confirmed pipeline
      prisma.booking.findMany({
        where: { estado: { in: ['CONFIRMADO', 'PENDIENTE'] } },
        select: { precioTotal: true, comisionDutyJoy: true, fechaServicio: true, tipoServicio: true },
      }),
      prisma.providerProfile.count({ where: { disponible: true, verificado: true } }),
      prisma.user.count({ where: { rol: 'CLIENTE', activo: true } }),
      prisma.disputa.count({ where: { createdAt: { gte: daysAgo(30) } } }),
    ]);

    // Monthly stats
    const [m1, m2, m3] = await Promise.all([
      prisma.booking.aggregate({ where: { estado: 'COMPLETADO', createdAt: { gte: daysAgo(30),  lte: now() } }, _sum: { precioTotal: true, comisionDutyJoy: true }, _count: { id: true } }),
      prisma.booking.aggregate({ where: { estado: 'COMPLETADO', createdAt: { gte: daysAgo(60),  lte: daysAgo(30) } }, _sum: { precioTotal: true, comisionDutyJoy: true }, _count: { id: true } }),
      prisma.booking.aggregate({ where: { estado: 'COMPLETADO', createdAt: { gte: daysAgo(90),  lte: daysAgo(60) } }, _sum: { precioTotal: true, comisionDutyJoy: true }, _count: { id: true } }),
    ]);

    const pipelineValue   = pipelineBookings.reduce((s, b) => s + (b.precioTotal || 0), 0);
    const pipelineComision = pipelineBookings.reduce((s, b) => s + (b.comisionDutyJoy || 0), 0);

    const result = await ai(
      `Eres el modelo de pronóstico de ingresos de DutyJoy Colombia (marketplace de servicios del hogar, comisión 15%).

DATOS HISTÓRICOS:
- Hace 61-90 días: ${m3._count.id} reservas completadas, GMV=$${Math.round(m3._sum.precioTotal||0).toLocaleString()} COP, comisión=$${Math.round(m3._sum.comisionDutyJoy||0).toLocaleString()} COP
- Hace 31-60 días: ${m2._count.id} reservas completadas, GMV=$${Math.round(m2._sum.precioTotal||0).toLocaleString()} COP, comisión=$${Math.round(m2._sum.comisionDutyJoy||0).toLocaleString()} COP
- Últimos 30 días: ${m1._count.id} reservas completadas, GMV=$${Math.round(m1._sum.precioTotal||0).toLocaleString()} COP, comisión=$${Math.round(m1._sum.comisionDutyJoy||0).toLocaleString()} COP

PIPELINE ACTUAL:
- ${pipelineBookings.length} reservas confirmadas/pendientes
- Valor pipeline: $${Math.round(pipelineValue).toLocaleString()} COP
- Comisión pipeline: $${Math.round(pipelineComision).toLocaleString()} COP

MÉTRICAS PLATAFORMA:
- Proveedores activos verificados: ${providerCount}
- Clientes activos: ${clientCount}
- Disputas último mes: ${disputeRate}

Contexto Colombia: pico de demanda servicios del hogar: lunes-viernes 8am-6pm, festivos y quincenas (1-15 de cada mes). Temporada alta: diciembre, enero, junio-julio.

Devuelve JSON con pronóstico realista basado en los datos:
{
  "forecast": {
    "proximos_30_dias": {
      "gmv_min": 0, "gmv_esperado": 0, "gmv_max": 0,
      "comision_min": 0, "comision_esperada": 0, "comision_max": 0,
      "reservas_estimadas": 0,
      "crecimiento_vs_mes_anterior": 0.0
    },
    "proximos_60_dias": { "gmv_esperado": 0, "comision_esperada": 0, "crecimiento": 0.0 },
    "proximos_90_dias": { "gmv_esperado": 0, "comision_esperada": 0, "crecimiento": 0.0 }
  },
  "tendencia": "creciendo|estable|decreciendo",
  "tasa_crecimiento_mensual": 0.0,
  "factores_positivos": ["factor 1"],
  "factores_riesgo": ["riesgo 1"],
  "acciones_para_acelerar": ["acción 1"],
  "kpis_a_vigilar": ["KPI 1"],
  "alertas": ["alerta si algo preocupa en los datos"],
  "narrativa": "análisis ejecutivo de 3-4 oraciones"
}

Todos los valores monetarios en COP enteros. crecimiento_vs_mes_anterior en decimal (0.15 = +15%).`,
      { max_tokens: 2000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   5. DEMAND GAP FORECAST
   GET /predictions/demand-gap
   Detects where supply doesn't meet demand by city and service type.
══════════════════════════════════════════════════════════════════════════ */
router.get('/demand-gap', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [bookingsByService, providersByService, cancelledByReason] = await Promise.all([
      // Demand: bookings by service type (last 30 days)
      prisma.booking.groupBy({
        by: ['tipoServicio'],
        where: { createdAt: { gte: daysAgo(30) } },
        _count: { id: true },
        _sum: { precioTotal: true },
        orderBy: { _count: { id: 'desc' } },
        take: 20,
      }),
      // Supply: providers by service
      prisma.providerProfile.findMany({
        where: { disponible: true },
        select: { servicios: true, ciudades: true, calificacion: true, verificado: true },
        take: 500,
      }),
      // Cancelled bookings by reason (demand unfulfilled)
      prisma.booking.findMany({
        where: { estado: 'CANCELADO', createdAt: { gte: daysAgo(30) } },
        select: { tipoServicio: true, motivoCancelacion: true },
        take: 200,
      }),
    ]);

    // Compute supply per service type
    const supplyMap = {};
    for (const p of providersByService) {
      for (const s of p.servicios) {
        if (!supplyMap[s]) supplyMap[s] = { count: 0, verified: 0, avgRating: [] };
        supplyMap[s].count++;
        if (p.verificado) supplyMap[s].verified++;
        if (p.calificacion > 0) supplyMap[s].avgRating.push(p.calificacion);
      }
    }
    const supplyStats = Object.entries(supplyMap).map(([service, data]) => ({
      servicio: service,
      proveedores: data.count,
      verificados: data.verified,
      calificacionPromedio: data.avgRating.length ? Math.round(data.avgRating.reduce((a,b) => a+b,0) / data.avgRating.length * 10)/10 : null,
    }));

    const demandStats = bookingsByService.map(b => ({
      servicio: b.tipoServicio,
      reservas30d: b._count.id,
      gmv30d: Math.round(b._sum.precioTotal || 0),
    }));

    const result = await ai(
      `Eres el modelo de análisis de oferta/demanda de DutyJoy Colombia.

DEMANDA (últimos 30 días, bookings):
${JSON.stringify(demandStats, null, 1)}

OFERTA (proveedores disponibles):
${JSON.stringify(supplyStats, null, 1)}

CANCELACIONES RECIENTES: ${cancelledByReason.length} en 30 días

Analiza los gaps entre oferta y demanda. Un "gap" existe cuando:
- Hay alta demanda (muchas reservas) pero pocos proveedores
- Hay pocos proveedores verificados en servicios muy demandados
- La calificación promedio en un servicio es baja (mala calidad cubre alta demanda)

Devuelve JSON:
{
  "gaps": [
    {
      "servicio": "string",
      "severidad": "critico|alto|medio",
      "demanda_reservas_mes": 0,
      "proveedores_disponibles": 0,
      "ratio_reservas_por_proveedor": 0.0,
      "problema": "descripción del gap",
      "impacto_revenue_perdido_estimado_cop": 0,
      "accion_recomendada": "qué hacer",
      "plazo_accion": "inmediato|1 semana|1 mes"
    }
  ],
  "servicios_saturados": ["servicios donde sobran proveedores"],
  "oportunidades_expansion": ["ciudad o servicio donde expandir"],
  "resumen": "análisis ejecutivo",
  "indice_salud_oferta_demanda": 0
}

indice_salud_oferta_demanda: 0-100 (100 = perfectamente balanceado).`,
      { max_tokens: 2000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   6. PROVIDER QUALITY DECLINE
   GET /predictions/quality-decline
   Identifies providers whose ratings are dropping before they get removed.
══════════════════════════════════════════════════════════════════════════ */
router.get('/quality-decline', verifyToken, soloAdmin, async (req, res) => {
  try {
    const providers = await prisma.providerProfile.findMany({
      where: { disponible: true, totalReviews: { gte: 3 } },
      include: {
        user: { select: { nombre: true, email: true, ciudad: true } },
        reviews: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { calificacion: true, comentario: true, createdAt: true, fraudScore: true },
        },
        bookings: {
          where: { createdAt: { gte: daysAgo(30) } },
          select: { estado: true },
        },
      },
      take: 150,
    });

    const signals = providers.map(p => {
      const allRatings    = p.reviews.map(r => r.calificacion);
      const recentRatings = allRatings.slice(0, 4);
      const olderRatings  = allRatings.slice(4);
      const recentAvg     = recentRatings.length ? recentRatings.reduce((a,b) => a+b,0) / recentRatings.length : p.calificacion;
      const olderAvg      = olderRatings.length  ? olderRatings.reduce((a,b) => a+b,0) / olderRatings.length  : p.calificacion;
      const trend         = recentAvg - olderAvg;
      const cancelados    = p.bookings.filter(b => b.estado === 'CANCELADO').length;
      const completados   = p.bookings.filter(b => b.estado === 'COMPLETADO').length;
      const lowFraudReviews = p.reviews.filter(r => (r.fraudScore || 0) > 0.5).length;
      return {
        nombre: p.user.nombre, ciudad: p.user.ciudad,
        calificacionGlobal: p.calificacion,
        recentAvg: Math.round(recentAvg * 10) / 10,
        trend: Math.round(trend * 10) / 10,
        cancelados30d: cancelados,
        completados30d: completados,
        reviewsSospechosas: lowFraudReviews,
        totalReviews: p.totalReviews,
      };
    }).filter(p => p.trend < -0.3 || p.calificacion < 3.9 || p.cancelados30d > 2);

    const result = await ai(
      `Eres el modelo de calidad de proveedores de DutyJoy Colombia.
Analiza estos ${signals.length} proveedores con señales de deterioro en calidad.

PROVEEDORES CON SEÑALES:
${JSON.stringify(signals.slice(0, 30), null, 1)}

UMBRALES DUTYJOY:
- Calificación < 3.5 → candidato a suspensión
- trend < -0.5 (caída reciente significativa) → intervención urgente
- > 3 cancelaciones en 30 días → patrón de incumplimiento
- Reviews sospechosas → posible manipulación

Devuelve JSON:
{
  "proveedores_en_riesgo": [
    {
      "nombre": "string",
      "ciudad": "string",
      "calificacion": 0.0,
      "tendencia": 0.0,
      "nivel_riesgo": "critico|alto|medio",
      "problema_principal": "string",
      "tiempo_estimado_antes_suspension_dias": 0,
      "accion_recomendada": "string",
      "tipo_intervencion": "coaching|advertencia|suspension_preventiva|monitoreo_intensivo"
    }
  ],
  "resumen": "estado de calidad de la red de proveedores",
  "tasa_proveedores_en_riesgo": 0.0,
  "impacto_oferta_si_se_van": "bajo|medio|alto|critico",
  "recomendacion_sistemica": "cambio de proceso o política recomendado"
}`,
      { max_tokens: 2500 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   7. ANOMALY & FRAUD DETECTION
   GET /predictions/fraud-scan
   Detects suspicious patterns: fake reviews, booking abuse, payment anomalies.
══════════════════════════════════════════════════════════════════════════ */
router.get('/fraud-scan', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [suspiciousReviews, highValueBookings, newUsersHighValue] = await Promise.all([
      // Reviews with high fraud score
      prisma.review.findMany({
        where: { fraudScore: { gte: 0.4 } },
        include: {
          proveedor: { include: { user: { select: { nombre: true } } } },
          cliente: { select: { nombre: true, createdAt: true } },
        },
        orderBy: { fraudScore: 'desc' },
        take: 30,
      }),
      // Unusually high-value bookings (potential fraud)
      prisma.booking.findMany({
        where: { precioTotal: { gte: 500_000 }, createdAt: { gte: daysAgo(14) } },
        include: {
          cliente: { select: { nombre: true, createdAt: true, email: true } },
          proveedor: { include: { user: { select: { nombre: true } } } },
        },
        take: 20,
      }),
      // New users (< 7 days) with high-value bookings
      prisma.booking.findMany({
        where: {
          createdAt: { gte: daysAgo(14) },
          precioTotal: { gte: 200_000 },
          cliente: { createdAt: { gte: daysAgo(7) } },
        },
        include: {
          cliente: { select: { nombre: true, email: true, createdAt: true } },
        },
        take: 20,
      }),
    ]);

    const reviewFlags = suspiciousReviews.map(r => ({
      proveedor: r.proveedor?.user?.nombre,
      cliente: r.cliente.nombre,
      clienteDias: Math.round((now() - new Date(r.cliente.createdAt)) / 86_400_000),
      calificacion: r.calificacion,
      fraudScore: r.fraudScore,
      flags: r.fraudFlags,
    }));

    const bookingFlags = highValueBookings.map(b => ({
      cliente: b.cliente.nombre,
      clienteDias: Math.round((now() - new Date(b.cliente.createdAt)) / 86_400_000),
      proveedor: b.proveedor?.user?.nombre,
      precioTotal: b.precioTotal,
      estado: b.estado,
    }));

    const result = await ai(
      `Eres el modelo de detección de fraude y anomalías de DutyJoy Colombia.

RESEÑAS CON FRAUD SCORE ELEVADO (${reviewFlags.length}):
${JSON.stringify(reviewFlags.slice(0, 20), null, 1)}

BOOKINGS DE ALTO VALOR RECIENTES (${bookingFlags.length}):
${JSON.stringify(bookingFlags.slice(0, 15), null, 1)}

NUEVOS USUARIOS CON BOOKINGS DE ALTO VALOR: ${newUsersHighValue.length}

PATRONES DE FRAUDE CONOCIDOS EN MARKETPLACES COLOMBIA:
- Reseñas falsas de cuentas nuevas (< 7 días) → inflación artificial de rating
- Bookings de alto valor con usuarios recién creados → posible fraude de pago
- Múltiples reseñas 5 estrellas en período corto con texto genérico
- Cancelaciones tras confirmar para extraer información

Devuelve JSON:
{
  "alertas": [
    {
      "tipo": "resena_falsa|fraude_pago|abuso_plataforma|patron_sospechoso|anomalia_precio",
      "severidad": "critico|alto|medio",
      "descripcion": "qué está pasando",
      "entidades_involucradas": ["nombre 1"],
      "evidencia": ["evidencia 1"],
      "accion_inmediata": "qué hacer ahora",
      "riesgo_financiero_cop": 0
    }
  ],
  "score_salud_plataforma": 0,
  "resumen_fraude": "estado general",
  "tendencias_preocupantes": ["tendencia 1"],
  "recomendaciones_prevencion": ["recomendación 1"]
}

score_salud_plataforma: 0-100 (100 = sin fraude).`,
      { max_tokens: 2000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   8. COMPREHENSIVE EARLY WARNING DASHBOARD
   GET /predictions/early-warning
   Runs a lightweight scan of all risk signals and returns top 10 alerts.
══════════════════════════════════════════════════════════════════════════ */
router.get('/early-warning', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [
      openDisputes, urgentTickets, pendingBookings, lowRatedProviders,
      recentCancellations, inactiveProviders, upcomingToday,
      newUsersWeek, completedThisWeek, avgRating,
    ] = await Promise.all([
      prisma.disputa.count({ where: { estado: 'abierta' } }),
      prisma.disputa.count({ where: { estado: 'abierta', createdAt: { gte: daysAgo(1) } } }),
      prisma.booking.count({ where: { estado: 'PENDIENTE' } }),
      prisma.providerProfile.count({ where: { disponible: true, calificacion: { gt: 0, lt: 3.5 } } }),
      prisma.booking.count({ where: { estado: 'CANCELADO', createdAt: { gte: daysAgo(7) } } }),
      prisma.providerProfile.count({ where: { disponible: true, bookings: { none: { createdAt: { gte: daysAgo(14) } } } } }),
      prisma.booking.count({ where: { estado: 'CONFIRMADO', fechaServicio: { gte: now(), lte: daysAhead(1) } } }),
      prisma.user.count({ where: { createdAt: { gte: daysAgo(7) } } }),
      prisma.booking.count({ where: { estado: 'COMPLETADO', updatedAt: { gte: daysAgo(7) } } }),
      prisma.providerProfile.aggregate({ where: { totalReviews: { gt: 0 } }, _avg: { calificacion: true } }),
    ]);

    const result = await ai(
      `Eres el sistema de alerta temprana de DutyJoy Colombia.
Analiza estas métricas en tiempo real y genera las top alertas que el equipo debe atender HOY.

MÉTRICAS ACTUALES (${new Date().toLocaleDateString('es-CO')}):
- Disputas abiertas: ${openDisputes}
- Disputas nuevas (24h): ${urgentTickets}
- Reservas PENDIENTES sin confirmar: ${pendingBookings}
- Proveedores con calificación < 3.5: ${lowRatedProviders}
- Cancelaciones esta semana: ${recentCancellations}
- Proveedores sin actividad >14 días: ${inactiveProviders}
- Reservas confirmadas para HOY: ${upcomingToday}
- Nuevos usuarios esta semana: ${newUsersWeek}
- Reservas completadas esta semana: ${completedThisWeek}
- Calificación promedio plataforma: ${avgRating._avg.calificacion?.toFixed(2) ?? 'N/A'}

UMBRALES DE ALERTA DUTYJOY:
- Disputas abiertas > 10 → riesgo reputacional
- Pendientes > 20 → cuello de botella en confirmaciones
- Calificación plataforma < 4.0 → alerta de calidad
- Cancelaciones semanales > 15 → problema operacional
- Proveedores inactivos > 20% del total → riesgo de oferta

Devuelve JSON:
{
  "alertas": [
    {
      "id": "ALT-001",
      "titulo": "título corto de la alerta",
      "descripcion": "qué está pasando y por qué importa",
      "tipo": "operacional|financiero|calidad|churn|fraude|capacidad|sla",
      "severidad": "critico|alto|medio|bajo",
      "score_urgencia": 0,
      "metricas_actuales": { "clave": "valor" },
      "impacto_estimado": "qué pasa si no se actúa",
      "accion_recomendada": "qué hacer hoy",
      "responsable": "soporte|ops|finanzas|marketing|tech|ceo",
      "ventana_accion_horas": 0
    }
  ],
  "score_salud_general": 0,
  "tendencia_general": "mejorando|estable|deteriorando",
  "resumen_ejecutivo": "2-3 oraciones para el CEO",
  "prioridad_del_dia": "la única cosa más importante que hacer hoy"
}

score_salud_general: 0-100 (100 = todo perfecto). score_urgencia: 0-100.
Ordena alertas por score_urgencia desc. Máximo 8 alertas.`,
      { max_tokens: 2500 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   9. PREDICTION COPILOT
   POST /predictions/copilot
   Natural language interface to ask any prediction question.
══════════════════════════════════════════════════════════════════════════ */
router.post('/copilot', verifyToken, soloAdmin, async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });

  // Pull quick stats for context
  let statsContext = '';
  try {
    const [bookingsHoy, disputasAbiertas, provCount, clientCount] = await Promise.all([
      prisma.booking.count({ where: { fechaServicio: { gte: now(), lte: daysAhead(1) } } }),
      prisma.disputa.count({ where: { estado: 'abierta' } }),
      prisma.providerProfile.count({ where: { disponible: true } }),
      prisma.user.count({ where: { rol: 'CLIENTE', activo: true } }),
    ]);
    statsContext = `Datos en tiempo real: ${bookingsHoy} reservas hoy, ${disputasAbiertas} disputas abiertas, ${provCount} proveedores activos, ${clientCount} clientes activos.`;
  } catch {}

  const systemPrompt = `Eres el Prediction Copilot de DutyJoy Colombia — un experto en análisis predictivo y business intelligence para un marketplace de servicios del hogar.

Puedes responder preguntas sobre:
- Predicciones de churn de clientes o proveedores
- Riesgos de no-show en reservas específicas
- Probabilidades de disputas
- Pronósticos de ingresos y demanda
- Detección de patrones anómalos
- Estrategias preventivas basadas en datos

${statsContext}

Plataforma: DutyJoy Colombia. Ciudades: Ibagué, Bogotá, Medellín, Cali. Comisión: 15%. Pagos: MercadoPago.
Responde en español colombiano, de forma concisa y basada en datos. Sé específico con números cuando sea posible.`;

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];
    const r = await openai.chat.completions.create({ model: 'gpt-4o', max_tokens: 1000, temperature: 0.4, messages });
    res.json({ response: r.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
