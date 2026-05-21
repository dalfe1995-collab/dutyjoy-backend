/**
 * automations.routes.js — Automation Engine
 * Rule-based + AI-driven automations that run against real DB data.
 * Each executor queries Prisma, checks conditions, takes actions, logs results.
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
const ai = (prompt, { model = 'gpt-4o', max_tokens = 1800, json = true, temp = 0.3 } = {}) => {
  if (!openai) return Promise.reject(new Error('OPENAI_API_KEY no configurado'));
  return openai.chat.completions.create({
    model, max_tokens, temperature: temp,
    ...(json && { response_format: { type: 'json_object' } }),
    messages: [{ role: 'user', content: prompt }],
  }).then(r => json ? JSON.parse(r.choices[0].message.content) : r.choices[0].message.content);
};

const now      = () => new Date();
const daysAgo  = d => new Date(Date.now() - d * 86_400_000);
const daysAhead = d => new Date(Date.now() + d * 86_400_000);

/* ══════════════════════════════════════════════════════════════════════════
   AUTOMATION EXECUTORS
   Each executor: queries DB → checks conditions → takes action → returns log
══════════════════════════════════════════════════════════════════════════ */
const EXECUTORS = {

  // 1. Churn prevention: clients inactive > 25 days → internal notification
  churn_prevention: async (rule) => {
    const inactiveClients = await prisma.user.findMany({
      where: {
        rol: 'CLIENTE', activo: true,
        bookingsComoCliente: {
          none: { createdAt: { gte: daysAgo(25) } },
          some: { createdAt: { lte: daysAgo(25) } }, // had at least one booking before
        },
      },
      select: { id: true, nombre: true, email: true },
      take: 50,
    });
    const threshold = rule.trigger?.umbral || 25;
    const actions = [];
    for (const user of inactiveClients) {
      await prisma.notificacion.create({
        data: {
          userId: user.id,
          tipo: 'marketing',
          titulo: '¡Te echamos de menos! 👋',
          mensaje: `${user.nombre}, han pasado más de ${threshold} días sin reservar. ¡Vuelve y encuentra el mejor proveedor para ti!`,
          data: { tipo: 'churn_prevention', oferta: '10% descuento', automatizacion: rule.id },
        },
      });
      actions.push({ usuario: user.nombre, accion: 'notificación enviada', canal: 'in-app' });
    }
    return { afectados: inactiveClients.length, acciones: actions };
  },

  // 2. Quality coaching: providers with declining rating < 4.0 → coaching notification
  quality_coaching: async (rule) => {
    const threshold = rule.trigger?.umbral || 4.0;
    const providers = await prisma.providerProfile.findMany({
      where: {
        disponible: true, totalReviews: { gte: 3 },
        calificacion: { gt: 0, lt: threshold },
      },
      include: { user: { select: { id: true, nombre: true } } },
      take: 30,
    });
    const actions = [];
    const tips = [
      'Confirma tus reservas en menos de 2 horas para mejorar tu ranking.',
      'Sube fotos de tus trabajos terminados — los clientes confían más en proveedores con portfolio.',
      'Responde los mensajes del chat antes de llegar al servicio.',
      'Un saludo inicial al cliente puede mejorar significativamente tu calificación.',
    ];
    for (const p of providers) {
      const tip = tips[Math.floor(Math.random() * tips.length)];
      await prisma.notificacion.create({
        data: {
          userId: p.user.id,
          tipo: 'performance',
          titulo: '💡 Consejo para mejorar tu perfil',
          mensaje: `Hola ${p.user.nombre}, tu calificación actual es ${p.calificacion.toFixed(1)}. ${tip}`,
          data: { tipo: 'quality_coaching', calificacion: p.calificacion, automatizacion: rule.id },
        },
      });
      actions.push({ proveedor: p.user.nombre, calificacion: p.calificacion.toFixed(1), tip });
    }
    return { afectados: providers.length, acciones: actions };
  },

  // 3. Review request: completed bookings 24-72h ago with no review
  review_request: async (rule) => {
    const bookings = await prisma.booking.findMany({
      where: {
        estado: 'COMPLETADO',
        updatedAt: { gte: daysAgo(3), lte: daysAgo(1) },
        review: null,
      },
      include: {
        cliente: { select: { id: true, nombre: true } },
        proveedor: { include: { user: { select: { nombre: true } } } },
      },
      take: 60,
    });
    const actions = [];
    for (const b of bookings) {
      await prisma.notificacion.create({
        data: {
          userId: b.cliente.id,
          tipo: 'review_request',
          titulo: '⭐ ¿Cómo fue tu servicio?',
          mensaje: `${b.cliente.nombre}, cuéntanos cómo estuvo el servicio de ${b.proveedor.user.nombre}. ¡Tu reseña ayuda a otros clientes!`,
          data: { tipo: 'review_request', bookingId: b.id, automatizacion: rule.id },
        },
      });
      actions.push({ cliente: b.cliente.nombre, proveedor: b.proveedor.user.nombre, bookingId: b.id });
    }
    return { afectados: bookings.length, acciones: actions };
  },

  // 4. No-show prevention: CONFIRMADO in next 24h with risky provider → reminder
  no_show_prevention: async (rule) => {
    const risky = await prisma.booking.findMany({
      where: {
        estado: 'CONFIRMADO',
        fechaServicio: { gte: now(), lte: daysAhead(1) },
        proveedor: { reservasCompletadas: { lt: 5 } },
      },
      include: {
        proveedor: { include: { user: { select: { id: true, nombre: true } } } },
        cliente: { select: { nombre: true } },
      },
      take: 30,
    });
    const actions = [];
    for (const b of risky) {
      await prisma.notificacion.create({
        data: {
          userId: b.proveedor.user.id,
          tipo: 'reminder',
          titulo: '⏰ Recordatorio de servicio próximo',
          mensaje: `Hola ${b.proveedor.user.nombre}, tienes un servicio con ${b.cliente.nombre} el ${new Date(b.fechaServicio).toLocaleString('es-CO')}. Confirma tu asistencia.`,
          data: { tipo: 'no_show_prevention', bookingId: b.id, automatizacion: rule.id },
        },
      });
      actions.push({ proveedor: b.proveedor.user.nombre, cliente: b.cliente.nombre, fecha: b.fechaServicio });
    }
    return { afectados: risky.length, acciones: actions };
  },

  // 5. Client reactivation: inactive > 45 days with history of bookings → win-back
  client_reactivation: async (rule) => {
    const threshold = rule.trigger?.umbral || 45;
    const users = await prisma.user.findMany({
      where: {
        rol: 'CLIENTE', activo: true,
        bookingsComoCliente: {
          none: { createdAt: { gte: daysAgo(threshold) } },
          some: { createdAt: { lte: daysAgo(threshold) } },
        },
      },
      select: { id: true, nombre: true },
      take: 40,
    });
    const actions = [];
    for (const u of users) {
      await prisma.notificacion.create({
        data: {
          userId: u.id,
          tipo: 'winback',
          titulo: '🎁 ¡Vuelve y ahorra!',
          mensaje: `${u.nombre}, te tenemos una oferta especial. ¡Reserva cualquier servicio esta semana y obtén prioridad en la asignación de proveedores top!`,
          data: { tipo: 'client_reactivation', diasInactivo: threshold, automatizacion: rule.id },
        },
      });
      actions.push({ usuario: u.nombre, accion: 'win-back notificación enviada' });
    }
    return { afectados: users.length, acciones: actions };
  },

  // 6. Provider welcome: new providers (last 48h) with no bookings yet
  provider_welcome: async (rule) => {
    const newProviders = await prisma.providerProfile.findMany({
      where: {
        createdAt: { gte: daysAgo(2) },
        bookings: { none: {} },
      },
      include: { user: { select: { id: true, nombre: true } } },
      take: 20,
    });
    const welcomeSteps = [
      'Completa tu perfil con foto profesional y descripción detallada.',
      'Activa el "Booking instantáneo" para recibir más reservas.',
      'Sube fotos de trabajos anteriores a tu portfolio.',
      'Configura tu horario de disponibilidad correctamente.',
    ];
    const actions = [];
    for (const p of newProviders) {
      await prisma.notificacion.create({
        data: {
          userId: p.user.id,
          tipo: 'onboarding',
          titulo: '🚀 ¡Bienvenido a DutyJoy!',
          mensaje: `${p.user.nombre}, para empezar a recibir clientes: ${welcomeSteps.join(' · ')}`,
          data: { tipo: 'provider_welcome', pasos: welcomeSteps, automatizacion: rule.id },
        },
      });
      actions.push({ proveedor: p.user.nombre, accion: 'onboarding iniciado' });
    }
    return { afectados: newProviders.length, acciones: actions };
  },

  // 7. Fraud quarantine: reviews with fraudScore > 0.6 not yet hidden → auto-hide
  fraud_quarantine: async (rule) => {
    const threshold = rule.trigger?.umbral || 0.6;
    const suspicious = await prisma.review.findMany({
      where: { fraudScore: { gte: threshold }, fraudOculta: false },
      include: {
        proveedor: { include: { user: { select: { nombre: true } } } },
        cliente: { select: { nombre: true } },
      },
      take: 20,
    });
    const actions = [];
    for (const r of suspicious) {
      await prisma.review.update({
        where: { id: r.id },
        data: { fraudOculta: true },
      });
      actions.push({
        proveedor: r.proveedor.user.nombre,
        cliente: r.cliente.nombre,
        fraudScore: r.fraudScore,
        calificacion: r.calificacion,
        accion: 'reseña ocultada automáticamente',
      });
    }
    return { afectados: suspicious.length, acciones: actions };
  },

  // 8. Dispute prevention: completed bookings last 12h where provider has prior disputes → proactive check-in
  dispute_prevention: async (rule) => {
    // Find providers that have had disputes before
    const disputedProviders = await prisma.disputa.findMany({
      select: { booking: { select: { proveedorId: true } } },
      distinct: ['bookingId'],
      take: 100,
    });
    const providerIds = [...new Set(disputedProviders.map(d => d.booking.proveedorId).filter(Boolean))];

    const recentBookings = await prisma.booking.findMany({
      where: {
        estado: 'COMPLETADO',
        updatedAt: { gte: daysAgo(1) },
        proveedorId: { in: providerIds },
        disputas: { none: {} },
      },
      include: {
        cliente: { select: { id: true, nombre: true } },
        proveedor: { include: { user: { select: { nombre: true } } } },
      },
      take: 30,
    });
    const actions = [];
    for (const b of recentBookings) {
      await prisma.notificacion.create({
        data: {
          userId: b.cliente.id,
          tipo: 'quality_check',
          titulo: '✅ ¿Todo salió bien con tu servicio?',
          mensaje: `${b.cliente.nombre}, queremos asegurarnos de que tu experiencia con ${b.proveedor.user.nombre} fue excelente. Si algo no estuvo bien, cuéntanos.`,
          data: { tipo: 'dispute_prevention', bookingId: b.id, automatizacion: rule.id },
        },
      });
      actions.push({ cliente: b.cliente.nombre, proveedor: b.proveedor.user.nombre });
    }
    return { afectados: recentBookings.length, acciones: actions };
  },

  // 9. SLA escalation: open disputes > 48h without resolution → internal alert
  sla_escalation: async (rule) => {
    const threshold = rule.trigger?.umbral || 48;
    const stalledDisputes = await prisma.disputa.findMany({
      where: {
        estado: { in: ['abierta', 'en_revision'] },
        createdAt: { lte: daysAgo(threshold / 24) },
      },
      include: {
        cliente: { select: { id: true, nombre: true } },
        booking: { select: { tipoServicio: true, precioTotal: true } },
      },
      take: 20,
    });
    const actions = [];
    // Notify admin users
    const admins = await prisma.user.findMany({ where: { rol: 'ADMIN', activo: true }, select: { id: true, nombre: true }, take: 5 });
    for (const d of stalledDisputes) {
      const horasAbiertas = Math.round((now() - new Date(d.createdAt)) / 3_600_000);
      for (const admin of admins) {
        await prisma.notificacion.create({
          data: {
            userId: admin.id,
            tipo: 'sla_breach',
            titulo: `🚨 Disputa sin resolver — ${horasAbiertas}h abierta`,
            mensaje: `Disputa de ${d.cliente.nombre} lleva ${horasAbiertas} horas sin resolver. Servicio: ${d.booking?.tipoServicio}, Valor: $${d.booking?.precioTotal?.toLocaleString('es-CO')} COP`,
            data: { tipo: 'sla_escalation', disputaId: d.id, horasAbiertas, automatizacion: rule.id },
          },
        });
      }
      actions.push({ cliente: d.cliente.nombre, horasAbiertas, disputaId: d.id });
    }
    return { afectados: stalledDisputes.length, acciones: actions };
  },

  // 10. Revenue anomaly: today's bookings significantly below rolling average → alert
  revenue_anomaly: async (rule) => {
    const [todayStats, weekAvg] = await Promise.all([
      prisma.booking.aggregate({
        where: { createdAt: { gte: daysAgo(1) }, estado: { not: 'CANCELADO' } },
        _count: { id: true }, _sum: { precioTotal: true },
      }),
      prisma.booking.aggregate({
        where: { createdAt: { gte: daysAgo(8), lte: daysAgo(1) }, estado: { not: 'CANCELADO' } },
        _count: { id: true }, _sum: { precioTotal: true },
      }),
    ]);
    const todayGMV   = todayStats._sum.precioTotal || 0;
    const dailyAvgGMV = (weekAvg._sum.precioTotal || 0) / 7;
    const deviation   = dailyAvgGMV > 0 ? (todayGMV - dailyAvgGMV) / dailyAvgGMV : 0;
    const threshold   = rule.trigger?.umbral || -0.3; // -30% below average = anomaly

    if (deviation > threshold) {
      return { afectados: 0, acciones: [{ mensaje: `Revenue hoy: $${Math.round(todayGMV).toLocaleString()} COP. Promedio diario: $${Math.round(dailyAvgGMV).toLocaleString()} COP. Desviación: ${(deviation * 100).toFixed(1)}%. Sin anomalía.` }] };
    }

    const admins = await prisma.user.findMany({ where: { rol: 'ADMIN', activo: true }, select: { id: true }, take: 5 });
    for (const admin of admins) {
      await prisma.notificacion.create({
        data: {
          userId: admin.id,
          tipo: 'revenue_alert',
          titulo: `📉 Anomalía de ingresos detectada`,
          mensaje: `El GMV de hoy ($${Math.round(todayGMV).toLocaleString()} COP) está ${Math.abs(deviation * 100).toFixed(0)}% por debajo del promedio diario ($${Math.round(dailyAvgGMV).toLocaleString()} COP). Requiere atención.`,
          data: { tipo: 'revenue_anomaly', todayGMV, dailyAvgGMV, deviation, automatizacion: rule.id },
        },
      });
    }
    return { afectados: admins.length, acciones: [{ desviacion: `${(deviation * 100).toFixed(1)}%`, todayGMV: Math.round(todayGMV), dailyAvgGMV: Math.round(dailyAvgGMV) }] };
  },
};

/* ── Execute a single rule ───────────────────────────────────────────────── */
async function executeRule(rule) {
  const t0      = Date.now();
  const executor = EXECUTORS[rule.tipo];
  if (!executor) throw new Error(`No executor for tipo: ${rule.tipo}`);
  try {
    const result = await executor(rule);
    const duracionMs = Date.now() - t0;
    const log = await prisma.automationLog.create({
      data: {
        ruleId:   rule.id,
        estado:   'exitoso',
        afectados: result.afectados,
        detalles: result,
        duracionMs,
      },
    });
    await prisma.automationRule.update({
      where: { id: rule.id },
      data: {
        ejecuciones:    { increment: 1 },
        exitos:         { increment: 1 },
        afectados:      { increment: result.afectados },
        ultimaEjecucion: now(),
        proximaEjecucion: new Date(Date.now() + 86_400_000),
      },
    });
    return { ...log, resultado: result };
  } catch (e) {
    const duracionMs = Date.now() - t0;
    await prisma.automationLog.create({
      data: { ruleId: rule.id, estado: 'fallido', afectados: 0, error: e.message, duracionMs },
    });
    await prisma.automationRule.update({
      where: { id: rule.id },
      data: { ejecuciones: { increment: 1 }, errores: { increment: 1 }, ultimaEjecucion: now() },
    });
    throw e;
  }
}

/* ── Default seeding ─────────────────────────────────────────────────────── */
const DEFAULT_RULES = [
  { nombre:'Prevención de churn de clientes', tipo:'churn_prevention', categoria:'retencion', descripcion:'Detecta clientes inactivos más de 25 días y les envía una notificación de reactivación.', trigger:{ evento:'daily_check', condicion:'dias_sin_reserva > 25', umbral:25 }, accion:{ tipo:'notificacion_interna', canal:'push+in-app', mensaje:'Te echamos de menos' }, schedule:'diario' },
  { nombre:'Coaching de calidad a proveedores', tipo:'quality_coaching', categoria:'calidad', descripcion:'Envía consejos automáticos a proveedores con calificación inferior a 4.0.', trigger:{ evento:'daily_check', condicion:'calificacion < 4.0', umbral:4.0 }, accion:{ tipo:'notificacion_interna', canal:'in-app', mensaje:'Consejos de mejora' }, schedule:'diario' },
  { nombre:'Solicitud de reseña post-servicio', tipo:'review_request', categoria:'operacional', descripcion:'Recuerda a clientes dejar reseña 24-72h después de un servicio completado sin review.', trigger:{ evento:'booking_completado', condicion:'sin_review && horas_transcurridas between 24 and 72' }, accion:{ tipo:'notificacion_interna', canal:'push+in-app', mensaje:'Deja tu reseña' }, schedule:'cada_hora' },
  { nombre:'Prevención de no-show', tipo:'no_show_prevention', categoria:'operacional', descripcion:'Envía recordatorio a proveedores con pocas reservas completadas que tienen servicio en las próximas 24h.', trigger:{ evento:'hourly_check', condicion:'estado=CONFIRMADO && horas_hasta_servicio < 24 && reservasCompletadas < 5' }, accion:{ tipo:'notificacion_interna', canal:'push', mensaje:'Recordatorio de servicio' }, schedule:'cada_hora' },
  { nombre:'Reactivación de clientes perdidos', tipo:'client_reactivation', categoria:'retencion', descripcion:'Win-back para clientes con más de 45 días de inactividad pero con historial de reservas.', trigger:{ evento:'weekly_check', condicion:'dias_sin_reserva > 45', umbral:45 }, accion:{ tipo:'notificacion_interna', canal:'push+in-app', mensaje:'Oferta de reactivación' }, schedule:'semanal' },
  { nombre:'Bienvenida a nuevos proveedores', tipo:'provider_welcome', categoria:'operacional', descripcion:'Envía guía de onboarding a proveedores registrados en las últimas 48h sin reservas aún.', trigger:{ evento:'provider_registered', condicion:'createdAt < 48h && bookings == 0' }, accion:{ tipo:'notificacion_interna', canal:'in-app', mensaje:'Pasos de onboarding' }, schedule:'diario' },
  { nombre:'Cuarentena automática de reseñas falsas', tipo:'fraud_quarantine', categoria:'fraude', descripcion:'Oculta automáticamente reseñas con fraud score ≥ 0.6 para proteger la integridad de la plataforma.', trigger:{ evento:'review_created', condicion:'fraudScore >= 0.6', umbral:0.6 }, accion:{ tipo:'db_update', campo:'fraudOculta', valor:true }, schedule:'cada_hora' },
  { nombre:'Prevención proactiva de disputas', tipo:'dispute_prevention', categoria:'operacional', descripcion:'Check-in automático a clientes cuyo proveedor tiene historial de disputas, tras cada servicio completado.', trigger:{ evento:'booking_completado', condicion:'proveedor_con_disputas_previas' }, accion:{ tipo:'notificacion_interna', canal:'in-app', mensaje:'¿Todo salió bien?' }, schedule:'cada_hora' },
  { nombre:'Escalación de disputas por SLA', tipo:'sla_escalation', categoria:'operacional', descripcion:'Alerta al equipo admin cuando una disputa lleva más de 48h sin resolución.', trigger:{ evento:'hourly_check', condicion:'estado in [abierta, en_revision] && horas_abiertas > 48', umbral:48 }, accion:{ tipo:'notificacion_admin', canal:'in-app', mensaje:'SLA breach alert' }, schedule:'cada_hora' },
  { nombre:'Detección de anomalías de ingresos', tipo:'revenue_anomaly', categoria:'financiero', descripcion:'Alerta si el GMV diario cae más de 30% por debajo del promedio de los últimos 7 días.', trigger:{ evento:'daily_check', condicion:'gmv_hoy < promedio_7d * 0.7', umbral:-0.3 }, accion:{ tipo:'notificacion_admin', canal:'in-app', mensaje:'Revenue anomaly alert' }, schedule:'diario' },
];

/* ══════════════════════════════════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════════════════════════════════ */

// GET /automations — list all rules
router.get('/', verifyToken, soloAdmin, async (req, res) => {
  try {
    const rules = await prisma.automationRule.findMany({
      include: { _count: { select: { logs: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // Seed defaults if empty
    if (rules.length === 0) {
      await prisma.automationRule.createMany({ data: DEFAULT_RULES });
      const seeded = await prisma.automationRule.findMany({
        include: { _count: { select: { logs: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return res.json({ rules: seeded, seeded: true });
    }
    res.json({ rules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /automations — create
router.post('/', verifyToken, soloAdmin, async (req, res) => {
  const { nombre, descripcion, tipo, categoria, trigger, accion, schedule, creadoPorIA, aiRationale } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'nombre y tipo requeridos' });
  try {
    const rule = await prisma.automationRule.create({
      data: { nombre, descripcion, tipo, categoria: categoria || 'operacional', trigger: trigger || {}, accion: accion || {}, schedule: schedule || 'diario', creadoPorIA: creadoPorIA || false, aiRationale },
    });
    res.json({ rule });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /automations/:id — update
router.patch('/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const rule = await prisma.automationRule.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ rule });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /automations/:id
router.delete('/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    await prisma.automationRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /automations/:id/execute — run a specific rule manually
router.post('/:id/execute', verifyToken, soloAdmin, async (req, res) => {
  try {
    const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id: req.params.id } });
    const result = await executeRule(rule);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /automations/run-all — execute all active rules (call from scheduler/cron)
router.post('/run-all', verifyToken, soloAdmin, async (req, res) => {
  const { schedule } = req.query; // filter by schedule if provided
  try {
    const where = { activa: true, ...(schedule ? { schedule } : {}) };
    const rules = await prisma.automationRule.findMany({ where });
    const results = await Promise.allSettled(rules.map(r => executeRule(r)));
    const summary = results.map((r, i) => ({
      rule:    rules[i].nombre,
      estado:  r.status === 'fulfilled' ? 'exitoso' : 'fallido',
      afectados: r.status === 'fulfilled' ? r.value?.resultado?.afectados ?? 0 : 0,
      error:   r.status === 'rejected' ? r.reason?.message : null,
    }));
    res.json({ ejecutadas: rules.length, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /automations/logs — recent execution logs
router.get('/logs', verifyToken, soloAdmin, async (req, res) => {
  const { ruleId, limit = 50 } = req.query;
  try {
    const logs = await prisma.automationLog.findMany({
      where: ruleId ? { ruleId } : {},
      include: { rule: { select: { nombre: true, tipo: true, categoria: true } } },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
    });
    res.json({ logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /automations/stats — aggregated stats
router.get('/stats', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [rules, recentLogs, notifsSent] = await Promise.all([
      prisma.automationRule.groupBy({
        by: ['activa'],
        _count: { id: true },
        _sum: { ejecuciones: true, exitos: true, errores: true, afectados: true },
      }),
      prisma.automationLog.count({ where: { createdAt: { gte: daysAgo(1) } } }),
      prisma.notificacion.count({ where: { tipo: { in: ['marketing','performance','review_request','reminder','winback','onboarding','quality_check','sla_breach','revenue_alert'] }, createdAt: { gte: daysAgo(7) } } }),
    ]);
    const total = rules.reduce((s, r) => ({ ejecuciones: s.ejecuciones + (r._sum.ejecuciones || 0), exitos: s.exitos + (r._sum.exitos || 0), errores: s.errores + (r._sum.errores || 0), afectados: s.afectados + (r._sum.afectados || 0) }), { ejecuciones: 0, exitos: 0, errores: 0, afectados: 0 });
    res.json({ rules, total, recentLogs, notifsSent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /automations/ai/suggest — GPT-4o suggests new automations based on current data
router.post('/ai/suggest', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [disputes, cancelRate, avgRating, inactiveCount, recentRevenue] = await Promise.all([
      prisma.disputa.count({ where: { estado: 'abierta' } }),
      prisma.booking.count({ where: { estado: 'CANCELADO', createdAt: { gte: daysAgo(30) } } }),
      prisma.providerProfile.aggregate({ where: { totalReviews: { gt: 0 } }, _avg: { calificacion: true } }),
      prisma.user.count({ where: { rol: 'CLIENTE', bookingsComoCliente: { none: { createdAt: { gte: daysAgo(30) } } } } }),
      prisma.booking.aggregate({ where: { estado: 'COMPLETADO', createdAt: { gte: daysAgo(7) } }, _count: { id: true }, _sum: { precioTotal: true } }),
    ]);

    const result = await ai(
      `Eres el motor de sugerencias de automatizaciones de DutyJoy Colombia (marketplace de servicios del hogar).

ESTADO ACTUAL DE LA PLATAFORMA:
- Disputas abiertas: ${disputes}
- Cancelaciones últimos 30 días: ${cancelRate}
- Calificación promedio proveedores: ${avgRating._avg.calificacion?.toFixed(2) ?? 'N/A'}
- Clientes inactivos (sin reserva en 30d): ${inactiveCount}
- Reservas completadas esta semana: ${recentRevenue._count.id}
- GMV esta semana: $${Math.round(recentRevenue._sum.precioTotal || 0).toLocaleString()} COP

AUTOMATIZACIONES YA EXISTENTES: churn_prevention, quality_coaching, review_request, no_show_prevention, client_reactivation, provider_welcome, fraud_quarantine, dispute_prevention, sla_escalation, revenue_anomaly

Basándote en el estado actual, sugiere 3-5 NUEVAS automatizaciones que tendrían alto impacto.
Para cada una, sé específico con los parámetros y el ROI esperado.

Devuelve JSON:
{
  "sugerencias": [
    {
      "nombre": "string",
      "descripcion": "qué hace y por qué es útil ahora",
      "tipo": "string (nuevo tipo único)",
      "categoria": "operacional|retencion|calidad|fraude|financiero",
      "trigger": { "evento": "string", "condicion": "string", "umbral": 0 },
      "accion": { "tipo": "string", "canal": "string", "mensaje": "string" },
      "schedule": "diario|cada_hora|semanal",
      "impacto_estimado": "descripción del impacto en métricas",
      "roi_estimado": "por qué vale la pena implementarla",
      "urgencia": "inmediata|esta_semana|este_mes"
    }
  ],
  "resumen": "por qué estas automatizaciones son prioritarias ahora"
}`,
      { max_tokens: 2000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /automations/ai/build — natural language → automation rule
router.post('/ai/build', verifyToken, soloAdmin, async (req, res) => {
  const { descripcion } = req.body;
  if (!descripcion) return res.status(400).json({ error: 'descripcion requerida' });
  try {
    const result = await ai(
      `Eres el constructor de automatizaciones de DutyJoy Colombia.
El usuario describió esta automatización en lenguaje natural:

"${descripcion}"

Conviértela en una regla de automatización estructurada para DutyJoy.

TIPOS DISPONIBLES: churn_prevention, quality_coaching, review_request, no_show_prevention, client_reactivation, provider_welcome, fraud_quarantine, dispute_prevention, sla_escalation, revenue_anomaly, custom

CATEGORÍAS: operacional, retencion, calidad, fraude, financiero

SCHEDULES: diario, cada_hora, semanal, evento

CANALES DE ACCIÓN: in-app, push, email, sms, internal_ticket, db_update

Devuelve JSON con la regla completa:
{
  "nombre": "string corto y descriptivo",
  "descripcion": "qué hace esta automatización",
  "tipo": "uno de los tipos disponibles",
  "categoria": "una de las categorías",
  "trigger": {
    "evento": "qué evento o check dispara la automatización",
    "condicion": "la condición en lenguaje legible",
    "umbral": 0
  },
  "accion": {
    "tipo": "notificacion_interna|db_update|create_ticket|send_push",
    "canal": "canal o canales",
    "mensaje": "texto del mensaje/notificación"
  },
  "schedule": "frecuencia",
  "creadoPorIA": true,
  "aiRationale": "explicación de cómo interpretaste la descripción"
}`,
      { max_tokens: 800 }
    );
    res.json({ rule: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /automations/ai/analyze — analyze execution history for insights
router.post('/ai/analyze', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [rules, recentLogs] = await Promise.all([
      prisma.automationRule.findMany({ orderBy: { afectados: 'desc' }, take: 20 }),
      prisma.automationLog.findMany({
        include: { rule: { select: { nombre: true, tipo: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const result = await ai(
      `Analiza el rendimiento de las automatizaciones de DutyJoy y genera recomendaciones.

REGLAS (ordenadas por afectados):
${rules.map(r => `- ${r.nombre}: ${r.ejecuciones} ejecuciones, ${r.exitos} éxitos, ${r.errores} errores, ${r.afectados} usuarios afectados, activa=${r.activa}`).join('\n')}

LOGS RECIENTES (${recentLogs.length}):
${recentLogs.slice(0, 20).map(l => `- ${l.rule.nombre}: ${l.estado} (${l.afectados} afectados, ${l.duracionMs}ms)`).join('\n')}

Devuelve JSON:
{
  "automatizacion_mas_efectiva": "nombre + por qué",
  "automatizaciones_ineficientes": ["automatización que debería desactivarse o ajustarse"],
  "patrones_detectados": ["patrón observado en los logs"],
  "recomendaciones": [
    { "accion": "string", "impacto": "string", "urgencia": "inmediata|pronto|puede_esperar" }
  ],
  "score_salud_automatizaciones": 0,
  "resumen": "estado general del motor de automatizaciones"
}`,
      { max_tokens: 1200 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
