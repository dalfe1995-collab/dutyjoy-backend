const cron  = require('node-cron');
const prisma = require('./prisma');
const email  = require('./email');
const { updateProviderEmbedding } = require('./embeddings');
const { enviarReengagement, enviarDigestProveedor } = require('./emailPersonalizado');
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * Cron: recordatorio 24h antes del servicio
 * Se ejecuta cada hora — busca reservas confirmadas que empiecen
 * entre 23h y 25h desde ahora y envía recordatorio si aún no fue enviado.
 *
 * Para marcar un recordatorio como enviado usamos un campo auxiliar
 * `recordatorioEnviado` en Booking (a añadir via migración si se desea),
 * pero como no queremos bloquear el MVP, filtramos por ventana de tiempo
 * y nos apoyamos en que el cron corre cada hora: la ventana 23–25h
 * garantiza que solo la corrida de la hora correcta lo enviará.
 */
async function enviarRecordatorios() {
  if (!process.env.RESEND_API_KEY) return; // no enviar sin API key

  const ahora    = new Date();
  const en23h    = new Date(ahora.getTime() + 23 * 60 * 60 * 1000);
  const en25h    = new Date(ahora.getTime() + 25 * 60 * 60 * 1000);

  try {
    const reservas = await prisma.booking.findMany({
      where: {
        estado:       { in: ['CONFIRMADO', 'EN_PROGRESO'] },
        fechaServicio: { gte: en23h, lte: en25h },
      },
      include: {
        cliente:  { select: { nombre: true, email: true } },
        proveedor: { include: { user: { select: { nombre: true, email: true } } } },
      },
    });

    for (const reserva of reservas) {
      const fecha = new Date(reserva.fechaServicio).toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });

      await email.recordatorio24h({
        clienteEmail:    reserva.cliente.email,
        clienteNombre:   reserva.cliente.nombre,
        proveedorEmail:  reserva.proveedor.user.email,
        proveedorNombre: reserva.proveedor.user.nombre,
        tipoServicio:    reserva.tipoServicio,
        fecha,
      });

      console.log(`[CRON] Recordatorio enviado → booking ${reserva.id}`);
    }

    if (reservas.length > 0) {
      console.log(`[CRON] ${reservas.length} recordatorio(s) enviado(s)`);
    }
  } catch (err) {
    console.error('[CRON] Error en recordatorios24h:', err.message);
  }
}

/**
 * Cron: auto-cancelar reservas PENDIENTE con más de 24h sin respuesta del proveedor
 * Se ejecuta cada hora. Notifica al cliente.
 */
async function cancelarReservasExpiradas() {
  const limite = new Date(Date.now() - 24 * 60 * 60 * 1000);

  try {
    const expiradas = await prisma.booking.findMany({
      where: {
        estado:    'PENDIENTE',
        createdAt: { lt: limite },
      },
      include: {
        cliente:   { select: { nombre: true, email: true } },
        proveedor: { include: { user: { select: { nombre: true } } } },
      },
    });

    for (const reserva of expiradas) {
      await prisma.booking.update({
        where: { id: reserva.id },
        data:  { estado: 'CANCELADO' },
      });

      const fecha = new Date(reserva.fechaServicio).toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });

      email.reservaCancelada({
        destinatarioEmail:  reserva.cliente.email,
        destinatarioNombre: reserva.cliente.nombre,
        canceladoPor:       'DutyJoy (sin respuesta del proveedor en 24h)',
        tipoServicio:       reserva.tipoServicio,
        fecha,
        motivo:             'El proveedor no respondió en 24 horas. Tu dinero no fue cobrado. Puedes buscar otro proveedor.',
      }).catch(() => {});

      console.log(`[CRON] Reserva expirada auto-cancelada → ${reserva.id}`);
    }

    if (expiradas.length > 0) {
      console.log(`[CRON] ${expiradas.length} reserva(s) expirada(s) canceladas`);
    }
  } catch (err) {
    console.error('[CRON] Error en cancelarReservasExpiradas:', err.message);
  }
}

/**
 * Cron: auto-completar reservas EN_PROGRESO cuya ventana de servicio terminó
 * Corre cada hora a las :45. Marca como COMPLETADO las reservas cuya
 * fechaServicio + duracionHoras + 2h buffer ya pasaron.
 * Esto desbloquea earnings stats y la posibilidad de dejar reseña.
 */
async function completarReservasFinalizadas() {
  try {
    const ahora = new Date();

    // Obtener candidatas: CONFIRMADO o EN_PROGRESO con fechaServicio ya en el pasado.
    // Incluimos CONFIRMADO porque el webhook de MP deja el booking en CONFIRMADO;
    // el proveedor puede no moverse a EN_PROGRESO manualmente.
    // (el filtro de duración exacto se hace en JS para soportar la duración variable)
    const candidatas = await prisma.booking.findMany({
      where: {
        estado:        { in: ['CONFIRMADO', 'EN_PROGRESO'] },
        fechaServicio: { lt: ahora },
      },
      include: {
        cliente:  { select: { nombre: true, email: true } },
        proveedor: { include: { user: { select: { nombre: true, email: true } } } },
      },
    });

    let completadas = 0;
    for (const reserva of candidatas) {
      // Ventana real de fin = fechaServicio + duracionHoras + 2h buffer
      const finServicio = new Date(
        reserva.fechaServicio.getTime() +
        (reserva.duracionHoras + 2) * 60 * 60 * 1000
      );
      if (ahora < finServicio) continue; // aún no termina

      await prisma.booking.update({
        where: { id: reserva.id },
        data:  { estado: 'COMPLETADO' },
      });

      const fecha = new Date(reserva.fechaServicio).toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });

      email.servicioCompletado({
        proveedorEmail:  reserva.proveedor.user.email,
        proveedorNombre: reserva.proveedor.user.nombre,
        clienteEmail:    reserva.cliente.email,
        clienteNombre:   reserva.cliente.nombre,
        tipoServicio:    reserva.tipoServicio,
        fecha,
        precioTotal:     reserva.precioTotal,
        comision:        reserva.comisionDutyJoy,
        bookingId:       reserva.id,
      }).catch(() => {});

      // Actualizar reservasCompletadas en el perfil del proveedor
      await prisma.providerProfile.update({
        where: { id: reserva.proveedorId },
        data:  { reservasCompletadas: { increment: 1 } },
      }).catch(() => {});

      console.log(`[CRON] Reserva auto-completada → ${reserva.id}`);
      completadas++;
    }

    if (completadas > 0) {
      console.log(`[CRON] ${completadas} reserva(s) auto-completadas`);
    }
  } catch (err) {
    console.error('[CRON] Error en completarReservasFinalizadas:', err.message);
  }
}

/**
 * Cron: actualizar tiempo de respuesta promedio de proveedores
 * Calcula cuántas horas tarda cada proveedor en confirmar/rechazar reservas.
 * Se ejecuta una vez al día a las 3:00 AM Bogotá.
 */
async function actualizarTiemposRespuesta() {
  try {
    // Obtener reservas resueltas en los últimos 30 días
    const hace30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const reservas = await prisma.booking.findMany({
      where: {
        estado:    { in: ['CONFIRMADO', 'CANCELADO', 'EN_PROGRESO', 'COMPLETADO'] },
        updatedAt: { gte: hace30Dias },
      },
      select: { proveedorId: true, createdAt: true, updatedAt: true },
    });

    // Agrupar por proveedor y calcular promedio de horas createdAt→updatedAt
    const porProveedor = {};
    for (const r of reservas) {
      const diffH = (r.updatedAt - r.createdAt) / (1000 * 60 * 60);
      if (diffH > 0 && diffH < 72) { // ignorar outliers >3 días
        if (!porProveedor[r.proveedorId]) porProveedor[r.proveedorId] = [];
        porProveedor[r.proveedorId].push(diffH);
      }
    }

    let actualizados = 0;
    for (const [proveedorId, tiempos] of Object.entries(porProveedor)) {
      const promedio = tiempos.reduce((a, b) => a + b, 0) / tiempos.length;
      await prisma.providerProfile.update({
        where: { id: proveedorId },
        data:  { tiempoRespuestaH: Math.round(promedio * 10) / 10 },
      }).catch(() => {});
      actualizados++;
    }

    if (actualizados > 0) {
      console.log(`[CRON] Tiempo de respuesta actualizado para ${actualizados} proveedor(es)`);
    }
  } catch (err) {
    console.error('[CRON] Error en actualizarTiemposRespuesta:', err.message);
  }
}

/**
 * Cron: generar siguiente ocurrencia de reservas recurrentes
 * Corre diariamente a las 7:00 AM Bogotá.
 * Busca reservas CONFIRMADO/COMPLETADO con recurrencia != UNICA cuya próxima
 * ocurrencia aún no fue creada, y la genera con 3 días de anticipación.
 */
async function generarRecurrencias() {
  const INTERVALOS = { SEMANAL: 7, QUINCENAL: 14, MENSUAL: 30 };
  const ahora = new Date();
  const en3Dias = new Date(ahora.getTime() + 3 * 24 * 60 * 60 * 1000);

  try {
    // Buscar reservas recurrentes originales (sin padre) o últimas hijas
    // Usar estado CONFIRMADO o COMPLETADO para garantizar que el servicio se realizó o va a realizarse
    const recurrentes = await prisma.booking.findMany({
      where: {
        recurrencia: { not: 'UNICA' },
        estado:      { in: ['CONFIRMADO', 'COMPLETADO'] },
        bookingPadreId: null, // solo los originales (las hijas apuntan al padre)
      },
      include: {
        bookingsHijos: {
          orderBy: { fechaServicio: 'desc' },
          take: 1,
          select: { id: true, fechaServicio: true, estado: true },
        },
      },
    });

    let generadas = 0;
    for (const reserva of recurrentes) {
      const ultimaHija = reserva.bookingsHijos[0];
      // La fecha de referencia es la última hija o el original
      const fechaRef = ultimaHija ? new Date(ultimaHija.fechaServicio) : new Date(reserva.fechaServicio);
      const estadoUltima = ultimaHija ? ultimaHija.estado : reserva.estado;

      // Solo generar si la última está en estado CONFIRMADO o COMPLETADO (no PENDIENTE ni CANCELADO)
      if (!['CONFIRMADO', 'COMPLETADO'].includes(estadoUltima)) continue;

      const diasIntervalo = INTERVALOS[reserva.recurrencia];
      if (!diasIntervalo) continue;

      const proximaFecha = new Date(fechaRef.getTime() + diasIntervalo * 24 * 60 * 60 * 1000);

      // Solo crear si la próxima fecha está dentro de los próximos 3 días (o ya pasó el umbral)
      if (proximaFecha > en3Dias) continue;

      // Verificar que no exista ya una hija para esa fecha (ventana de ±1 día)
      const ventana = 24 * 60 * 60 * 1000;
      const yaExiste = await prisma.booking.findFirst({
        where: {
          bookingPadreId: reserva.id,
          fechaServicio: {
            gte: new Date(proximaFecha.getTime() - ventana),
            lte: new Date(proximaFecha.getTime() + ventana),
          },
        },
      });
      if (yaExiste) continue;

      // Crear la nueva ocurrencia
      await prisma.booking.create({
        data: {
          clienteId:      reserva.clienteId,
          proveedorId:    reserva.proveedorId,
          tipoServicio:   reserva.tipoServicio,
          descripcion:    reserva.descripcion,
          fechaServicio:  proximaFecha,
          duracionHoras:  reserva.duracionHoras,
          precioTotal:    reserva.precioTotal,
          comisionDutyJoy: reserva.comisionDutyJoy,
          estado:         'PENDIENTE',
          recurrencia:    reserva.recurrencia,
          bookingPadreId: reserva.id,
        },
      });

      console.log(`[CRON] Reserva recurrente generada → padre ${reserva.id} · fecha ${proximaFecha.toISOString().slice(0, 10)}`);
      generadas++;
    }

    if (generadas > 0) {
      console.log(`[CRON] ${generadas} reserva(s) recurrente(s) generada(s)`);
    }
  } catch (err) {
    console.error('[CRON] Error en generarRecurrencias:', err.message);
  }
}

/**
 * Cron: actualizar tasa de aceptación de proveedores
 * Calcula qué % de reservas recibidas confirman (vs cancela o deja expirar).
 * Se ejecuta una vez al día a las 3:30 AM Bogotá.
 */
async function actualizarTasasAceptacion() {
  try {
    const hace30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const reservas = await prisma.booking.findMany({
      where: {
        estado:    { in: ['CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO', 'CANCELADO'] },
        createdAt: { gte: hace30Dias },
      },
      select: { proveedorId: true, estado: true },
    });

    const porProveedor = {};
    for (const r of reservas) {
      if (!porProveedor[r.proveedorId]) porProveedor[r.proveedorId] = { total: 0, confirmados: 0 };
      porProveedor[r.proveedorId].total++;
      if (['CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO'].includes(r.estado)) {
        porProveedor[r.proveedorId].confirmados++;
      }
    }

    let actualizados = 0;
    for (const [proveedorId, stats] of Object.entries(porProveedor)) {
      if (stats.total < 2) continue; // necesita al menos 2 datos
      const tasa = Math.round((stats.confirmados / stats.total) * 100) / 100;
      await prisma.providerProfile.update({
        where: { id: proveedorId },
        data:  { tasaAceptacion: tasa },
      }).catch(() => {});
      actualizados++;
    }

    if (actualizados > 0) {
      console.log(`[CRON] Tasa de aceptación actualizada para ${actualizados} proveedor(es)`);
    }
  } catch (err) {
    console.error('[CRON] Error en actualizarTasasAceptacion:', err.message);
  }
}

/**
 * Registra todos los crons. Llamar desde index.js una sola vez.
 */
function iniciarCrons() {
  // Recordatorio 24h antes — cada hora en punto
  cron.schedule('0 * * * *', enviarRecordatorios, {
    timezone: 'America/Bogota',
  });

  // Auto-cancelar reservas expiradas — cada hora a los 30 min
  cron.schedule('30 * * * *', cancelarReservasExpiradas, {
    timezone: 'America/Bogota',
  });

  // Auto-completar reservas CONFIRMADO/EN_PROGRESO finalizadas — cada hora a los 45 min
  cron.schedule('45 * * * *', completarReservasFinalizadas, {
    timezone: 'America/Bogota',
  });

  // Actualizar tiempo de respuesta promedio — diariamente a las 3:00 AM
  cron.schedule('0 3 * * *', actualizarTiemposRespuesta, {
    timezone: 'America/Bogota',
  });

  // Actualizar tasa de aceptación — diariamente a las 3:30 AM
  cron.schedule('30 3 * * *', actualizarTasasAceptacion, {
    timezone: 'America/Bogota',
  });

  // Generar recurrencias — diariamente a las 7:00 AM
  cron.schedule('0 7 * * *', generarRecurrencias, {
    timezone: 'America/Bogota',
  });

  // Generar embeddings para proveedores sin vector — diariamente a las 02:00 AM
  cron.schedule('0 2 * * *', generarEmbeddingsPendientes, {
    timezone: 'America/Bogota',
  });

  // Escanear reseñas no revisadas por fraude — diariamente a las 04:00 AM
  cron.schedule('0 4 * * *', escanearResenasFraude, {
    timezone: 'America/Bogota',
  });

  // Onboarding nudges para proveedores nuevos — diariamente a las 09:00 AM
  cron.schedule('0 9 * * *', enviarNudgesOnboarding, {
    timezone: 'America/Bogota',
  });

  // Re-engagement emails — lunes a las 10:00 AM
  cron.schedule('0 10 * * 1', enviarReengagementSemanal, {
    timezone: 'America/Bogota',
  });

  // Digest semanal proveedores — lunes a las 10:30 AM
  cron.schedule('30 10 * * 1', enviarDigestProveedoresSemanal, {
    timezone: 'America/Bogota',
  });

  console.log('⏰  Crons activos: recordatorio24h (:00) · expiracionReservas (:30) · autoCompletar (:45) · tiempoRespuesta (03:00) · tasaAceptacion (03:30) · recurrencias (07:00) · embeddings (02:00) · fraude (04:00) · onboarding (09:00) · reengagement (lun 10:00) · digest (lun 10:30)');
}

/**
 * Cron: generar embeddings para proveedores sin vector
 * Corre diariamente a las 02:00. Procesa hasta 30 proveedores por ejecución
 * para no exceder el rate limit de OpenAI.
 */
async function generarEmbeddingsPendientes() {
  if (!process.env.OPENAI_API_KEY) return;
  try {
    const sinEmbedding = await prisma.$queryRaw`
      SELECT id FROM "ProviderProfile"
      WHERE embedding IS NULL AND disponible = true
      LIMIT 30
    `;
    if (!sinEmbedding.length) return;
    let ok = 0;
    for (const { id } of sinEmbedding) {
      await updateProviderEmbedding(id);
      ok++;
      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 200));
    }
    if (ok > 0) console.log(`[CRON] Embeddings generados: ${ok} proveedores`);
  } catch (err) {
    console.error('[CRON] Error generando embeddings:', err.message);
  }
}

/**
 * Cron: escanear reseñas sin análisis de fraude
 * Corre diariamente a las 04:00. Procesa hasta 40 reseñas por run.
 */
async function escanearResenasFraude() {
  if (!openai) return;
  try {
    const sinChequear = await prisma.review.findMany({
      where: { fraudCheckedAt: null },
      include: {
        booking: { select: { estado: true, updatedAt: true } },
      },
      take: 40,
      orderBy: { createdAt: 'desc' },
    });
    if (!sinChequear.length) return;

    let flagged = 0;
    for (const review of sinChequear) {
      try {
        const clientCount = await prisma.review.count({ where: { clienteId: review.clienteId } });
        const completedAt = review.booking?.estado === 'COMPLETADO' ? review.booking.updatedAt : null;
        const minsSince   = completedAt
          ? Math.round((new Date(review.createdAt) - new Date(completedAt)) / 60000)
          : null;

        const prompt = `Detecta fraude en esta reseña de servicios del hogar.
Calificación: ${review.calificacion}/5
Comentario: "${review.comentario || '(sin comentario)'}"
Total reseñas del cliente: ${clientCount}
Minutos desde servicio completado: ${minsSince ?? 'desconocido'}

Responde SOLO JSON: {"fraudScore":<0.0-1.0>,"flags":[<texto_generico|primera_resena|velocidad_sospechosa|sin_detalle|lenguaje_marketing|inconsistencia|patron_bot>],"razonamiento":"<max 100 chars>"}`;

        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 150,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        });

        const result = JSON.parse(completion.choices[0].message.content);
        await prisma.review.update({
          where: { id: review.id },
          data: {
            fraudScore:     result.fraudScore,
            fraudFlags:     result.flags || [],
            fraudCheckedAt: new Date(),
          },
        });
        if (result.fraudScore >= 0.65) flagged++;
        await new Promise(r => setTimeout(r, 300)); // rate limit
      } catch { /* skip this review, try next */ }
    }
    console.log(`[CRON] Fraude: ${sinChequear.length} reseñas analizadas, ${flagged} sospechosas`);
  } catch (err) {
    console.error('[CRON] Error escaneo fraude:', err.message);
  }
}

/**
 * Cron: onboarding nudges for new providers with incomplete profiles
 * Runs daily at 09:00 AM. Targets providers registered < 14 days with profile < 70%.
 * Max 15 emails per run.
 */
async function enviarNudgesOnboarding() {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const hace14d = new Date(Date.now() - 14 * 86400000);
    const proveedores = await prisma.providerProfile.findMany({
      where: {
        user: { createdAt: { gte: hace14d }, rol: 'PROVEEDOR', activo: true },
      },
      include: {
        user: { select: { email: true, nombre: true, telefono: true, emailVerificado: true } },
      },
      take: 15,
    });

    const SCORE_FIELDS = (p) => {
      let s = 0;
      if ((p.bio?.trim().length || 0) >= 50)     s += 20;
      if ((p.servicios?.length || 0) >= 1)        s += 15;
      if ((p.tarifaPorHora || 0) > 0)             s += 10;
      if ((p.ciudades?.length  || 0) >= 1)        s += 10;
      if (p.cedulaStatus === 'aprobado')           s += 15;
      if (p.user.telefono)                         s += 5;
      if ((p.aniosExperiencia || 0) > 0)           s += 5;
      if (p.horario)                               s += 5;
      if ((p.portfolioUrls?.length || 0) > 0)     s += 10;
      if (p.disponible)                            s += 5;
      return s;
    };

    const APP_URL = process.env.FRONTEND_URL || 'https://app.dutyjoy.com';
    const resend = process.env.RESEND_API_KEY ? require('resend').Resend : null;
    if (!resend) return;
    const resendClient = new resend(process.env.RESEND_API_KEY);

    let sent = 0;
    for (const p of proveedores) {
      try {
        const score = SCORE_FIELDS(p);
        if (score >= 70) continue; // already well-configured

        const pendientes = [];
        if ((p.bio?.trim().length || 0) < 50)    pendientes.push('tu biografía');
        if (!(p.servicios?.length >= 1))          pendientes.push('tus servicios');
        if (!(p.tarifaPorHora > 0))              pendientes.push('tu tarifa por hora');
        if (p.cedulaStatus === 'sin_enviar')      pendientes.push('tu cédula de identidad');
        if (!(p.portfolioUrls?.length > 0))      pendientes.push('fotos de trabajos anteriores');

        if (!pendientes.length) continue;

        const nextItem = pendientes[0];
        const html = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:0">
            <div style="max-width:560px;margin:32px auto;background:#1a1a1a;border-radius:16px;overflow:hidden">
              <div style="background:#FFC534;padding:28px 32px;font-size:22px;font-weight:800;color:#0f0f0f">
                ⚡ DutyJoy — Tu perfil necesita atención
              </div>
              <div style="padding:28px 32px;color:#e5e5e5;font-size:15px;line-height:1.6">
                <p>Hola <strong>${p.user.nombre}</strong>,</p>
                <p>Tu perfil está al <strong style="color:#FFC534">${score}%</strong> de completitud. Los perfiles completos reciben <strong>3x más reservas</strong>.</p>
                <p>Tu próximo paso: <strong style="color:#0ABFBC">agrega ${nextItem}</strong>.</p>
                <p style="font-size:13px;color:#888">También puedes hablar con nuestro <strong>Agente IA</strong> en el dashboard — te guía paso a paso y puede generar tu bio automáticamente.</p>
                <a href="${APP_URL}/dashboard" style="display:inline-block;margin-top:20px;padding:14px 28px;background:#FFC534;color:#0f0f0f;font-weight:700;border-radius:10px;text-decoration:none;font-size:15px">
                  Completar mi perfil →
                </a>
              </div>
              <div style="padding:16px 32px;background:#111;color:#666;font-size:12px;text-align:center">
                © 2026 DutyJoy · <a href="${APP_URL}" style="color:#FFC534">app.dutyjoy.com</a>
              </div>
            </div>
          </div>`;

        await resendClient.emails.send({
          from: 'DutyJoy <notificaciones@dutyjoy.com>',
          to: p.user.email,
          subject: `Tu perfil está al ${score}% — falta ${nextItem}`,
          html,
        });
        sent++;
        await new Promise(r => setTimeout(r, 400));
      } catch { /* skip */ }
    }
    if (sent > 0) console.log(`[CRON] Onboarding nudges: ${sent} enviados`);
  } catch (err) {
    console.error('[CRON] Error onboarding nudges:', err.message);
  }
}

/**
 * Cron: re-engagement emails for clients inactive 30-60 days
 * Runs every Monday at 10:00 AM. Max 20 emails per run to stay within Resend limits.
 */
async function enviarReengagementSemanal() {
  if (!process.env.OPENAI_API_KEY || !process.env.RESEND_API_KEY) return;
  try {
    const desde = new Date(Date.now() - 60 * 86400000);
    const hasta = new Date(Date.now() - 30 * 86400000);

    const clientes = await prisma.user.findMany({
      where: {
        rol: 'CLIENTE',
        activo: true,
        bookingsComoCliente: { some: { createdAt: { gte: desde, lte: hasta } } },
      },
      include: {
        bookingsComoCliente: {
          where: { estado: 'COMPLETADO' },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { tipoServicio: true, createdAt: true, proveedor: { select: { user: { select: { nombre: true } } } } },
        },
      },
      take: 20,
    });

    let sent = 0;
    for (const u of clientes) {
      try {
        const lastBooking = u.bookingsComoCliente[0];
        const diasInactivo = lastBooking
          ? Math.round((Date.now() - new Date(lastBooking.createdAt).getTime()) / 86400000)
          : 45;
        const svcCount = {};
        u.bookingsComoCliente.forEach(b => { svcCount[b.tipoServicio] = (svcCount[b.tipoServicio] || 0) + 1; });
        const servicios = Object.entries(svcCount).sort((a, b) => b[1] - a[1]).map(([s]) => s);
        const provNombres = {};
        u.bookingsComoCliente.forEach(b => { const n = b.proveedor?.user?.nombre; if (n) provNombres[n] = (provNombres[n]||0)+1; });
        const proveedorFavorito = Object.entries(provNombres).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;

        await enviarReengagement({
          to: u.email,
          cliente: { nombre: u.nombre, ciudad: u.ciudad, completadas: u.bookingsComoCliente.length, servicios, proveedorFavorito, diasInactivo },
        });
        sent++;
        await new Promise(r => setTimeout(r, 500)); // 500ms between emails
      } catch { /* skip this user */ }
    }
    if (sent > 0) console.log(`[CRON] Re-engagement: ${sent} emails enviados`);
  } catch (err) {
    console.error('[CRON] Error re-engagement:', err.message);
  }
}

/**
 * Cron: weekly digest emails for providers
 * Runs every Monday at 10:30 AM. Max 30 providers per run.
 */
async function enviarDigestProveedoresSemanal() {
  if (!process.env.OPENAI_API_KEY || !process.env.RESEND_API_KEY) return;
  try {
    const hace7d = new Date(Date.now() - 7 * 86400000);
    const proveedores = await prisma.providerProfile.findMany({
      where: { disponible: true, verificado: true },
      include: { user: { select: { email: true, nombre: true } } },
      take: 30,
    });

    let sent = 0;
    for (const p of proveedores) {
      try {
        const bookings7d = await prisma.booking.findMany({
          where: { proveedorId: p.id, createdAt: { gte: hace7d }, estado: 'COMPLETADO' },
          select: { precioTotal: true, cliente: { select: { nombre: true } } },
        });
        const ingresos7d  = bookings7d.reduce((s, b) => s + (b.precioTotal || 0), 0);
        const topCliente  = bookings7d[0]?.cliente?.nombre || null;

        await enviarDigestProveedor({
          to: p.user.email,
          proveedor: {
            nombre:      p.user.nombre,
            ingresos7d,
            reservas7d:  bookings7d.length,
            calificacion: p.calificacion,
            vistas7d:    Math.round((p.totalViews || 0) * 0.15),
            topCliente,
          },
        });
        sent++;
        await new Promise(r => setTimeout(r, 400));
      } catch { /* skip */ }
    }
    if (sent > 0) console.log(`[CRON] Digest proveedores: ${sent} emails enviados`);
  } catch (err) {
    console.error('[CRON] Error digest:', err.message);
  }
}

module.exports = {
  iniciarCrons,
  completarReservasFinalizadas,
  cancelarReservasExpiradas,
  enviarRecordatorios,
  actualizarTiemposRespuesta,
  actualizarTasasAceptacion,
  generarRecurrencias,
  generarEmbeddingsPendientes,
  escanearResenasFraude,
  enviarReengagementSemanal,
  enviarDigestProveedoresSemanal,
  enviarNudgesOnboarding,
};
