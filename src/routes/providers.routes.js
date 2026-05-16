const router = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma = require('../lib/prisma');
const email = require('../lib/email');
const OpenAI = require('openai');
const { SERVICIOS_IDS } = require('./services.routes');
const { updateProviderEmbedding, semanticSearch } = require('../lib/embeddings');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// GET /providers — listar proveedores con filtros + búsqueda semántica opcional (?q=)
router.get('/', async (req, res) => {
  try {
    const { ciudad, servicio, minCalificacion, minTarifa, maxTarifa, verificado, search, orden = 'calificacion_desc', page = 1, limit = 12, q, instantBooking } = req.query;

    const tarifaWhere = {};
    if (minTarifa) tarifaWhere.gte = parseFloat(minTarifa);
    if (maxTarifa) tarifaWhere.lte = parseFloat(maxTarifa);

    const where = {
      disponible: true,
      ...(ciudad && { ciudades: { has: ciudad } }),
      ...(servicio && { servicios: { has: servicio } }),
      ...(minCalificacion && { calificacion: { gte: parseFloat(minCalificacion) } }),
      ...(Object.keys(tarifaWhere).length > 0 && { tarifaPorHora: tarifaWhere }),
      ...(verificado !== undefined && verificado !== '' && { verificado: verificado === 'true' }),
      ...(instantBooking === 'true' && { instantBooking: true }),
      ...(search && { user: { nombre: { contains: search, mode: 'insensitive' } } }),
    };

    // Búsqueda semántica con ?q=
    if (q && q.trim().length > 2) {
      const matches = await semanticSearch(q.trim(), 50);
      if (matches.length > 0) {
        const ids = matches.map(m => m.id);
        where.id = { in: ids };
        const providers = await prisma.providerProfile.findMany({
          where,
          include: { user: { select: { nombre: true, ciudad: true } } },
        });
        // Re-ordenar por similitud semántica
        const simMap = Object.fromEntries(matches.map(m => [m.id, m.similarity]));
        providers.sort((a, b) => (simMap[b.id] || 0) - (simMap[a.id] || 0));
        const pageN = parseInt(page), limitN = parseInt(limit);
        const paginated = providers.slice((pageN - 1) * limitN, pageN * limitN);
        return res.json({ providers: paginated, total: providers.length, page: pageN, totalPages: Math.ceil(providers.length / limitN), semantic: true });
      }
    }

    const ordenMap = {
      calificacion_desc: { calificacion: 'desc' },
      calificacion_asc:  { calificacion: 'asc' },
      tarifa_asc:        { tarifaPorHora: 'asc' },
      tarifa_desc:       { tarifaPorHora: 'desc' },
      recientes:         { createdAt: 'desc' },
    };
    const orderBy = ordenMap[orden] || { calificacion: 'desc' };

    const [providers, total] = await Promise.all([
      prisma.providerProfile.findMany({
        where,
        include: { user: { select: { nombre: true, ciudad: true } } },
        orderBy,
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.providerProfile.count({ where }),
    ]);

    res.json({ providers, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al buscar proveedores' });
  }
});

// GET /providers/me — perfil completo del proveedor autenticado
router.get('/me', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden acceder a este recurso' });
    }
    const profile = await prisma.providerProfile.findUnique({
      where: { userId: req.user.id },
      include: {
        _count: { select: { bookings: true, reviews: true } },
      },
    });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });
    res.json(profile);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// POST /providers/me/cedula — enviar URL de documento de identidad
router.post('/me/cedula', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden enviar documentos' });
    }

    const { cedulaUrl } = req.body;
    if (!cedulaUrl?.trim()) {
      return res.status(400).json({ error: 'La URL del documento es requerida' });
    }

    // Validar que sea una URL básica
    try { new URL(cedulaUrl); } catch {
      return res.status(400).json({ error: 'URL inválida. Sube tu documento a Google Drive y comparte el enlace.' });
    }

    const profile = await prisma.providerProfile.update({
      where:  { userId: req.user.id },
      data:   { cedulaUrl: cedulaUrl.trim(), cedulaStatus: 'pendiente', cedulaNota: null },
      include: { user: { select: { nombre: true, email: true } } },
    });

    // Fire-and-forget — confirmar recepción al proveedor
    email.cedulaRecibida({
      proveedorEmail: profile.user.email,
      proveedorNombre: profile.user.nombre,
    }).catch(() => {});

    res.json({ mensaje: 'Documento enviado. Lo revisaremos en 48 horas hábiles.', cedulaStatus: 'pendiente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al enviar el documento' });
  }
});

// PUT /providers/me — proveedor actualiza su perfil
router.put('/me', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden actualizar este perfil' });
    }

    const { bio, servicios, tarifaPorHora, ciudades, disponible, aniosExperiencia,
            horario, portfolioUrls, instantBooking } = req.body;

    // Validar servicios contra catálogo
    if (servicios !== undefined) {
      if (!Array.isArray(servicios)) {
        return res.status(400).json({ error: 'servicios debe ser un array' });
      }
      const invalidos = servicios.filter(s => !SERVICIOS_IDS.includes(s));
      if (invalidos.length > 0) {
        return res.status(400).json({ error: `Servicios no válidos: ${invalidos.join(', ')}. Válidos: ${SERVICIOS_IDS.join(', ')}` });
      }
    }

    // Validar tarifa
    if (tarifaPorHora !== undefined) {
      const tarifa = parseFloat(tarifaPorHora);
      if (isNaN(tarifa) || tarifa < 5000 || tarifa > 5000000) {
        return res.status(400).json({ error: 'La tarifa debe estar entre $5.000 y $5.000.000 COP' });
      }
    }

    // Validar portfolioUrls
    if (portfolioUrls !== undefined) {
      if (!Array.isArray(portfolioUrls) || portfolioUrls.length > 8) {
        return res.status(400).json({ error: 'portfolioUrls debe ser un array de máximo 8 URLs' });
      }
    }

    // Validar horario structure si se envía
    const DIAS = ['lun','mar','mie','jue','vie','sab','dom'];
    if (horario !== undefined && horario !== null) {
      if (typeof horario !== 'object') {
        return res.status(400).json({ error: 'horario debe ser un objeto JSON' });
      }
      for (const dia of Object.keys(horario)) {
        if (!DIAS.includes(dia)) {
          return res.status(400).json({ error: `Día no válido: ${dia}. Válidos: ${DIAS.join(', ')}` });
        }
      }
    }

    const profile = await prisma.providerProfile.update({
      where: { userId: req.user.id },
      data: {
        ...(bio !== undefined && { bio }),
        ...(servicios !== undefined && { servicios }),
        ...(tarifaPorHora !== undefined && { tarifaPorHora: parseFloat(tarifaPorHora) }),
        ...(ciudades !== undefined && { ciudades }),
        ...(disponible !== undefined && { disponible }),
        ...(aniosExperiencia !== undefined && { aniosExperiencia: aniosExperiencia ? parseInt(aniosExperiencia) : null }),
        ...(horario !== undefined && { horario }),
        ...(portfolioUrls !== undefined && { portfolioUrls }),
        ...(instantBooking !== undefined && { instantBooking: Boolean(instantBooking) }),
      },
    });

    // Regenerar embedding en background (no bloquea respuesta)
    updateProviderEmbedding(profile.id).catch(() => {});

    res.json({ mensaje: 'Perfil actualizado', profile });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// GET /providers/:id — perfil público de un proveedor
router.get('/:id', async (req, res) => {
  try {
    const provider = await prisma.providerProfile.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, nombre: true, ciudad: true, createdAt: true, telefono: true } },
        reviews: {
          include: { cliente: { select: { nombre: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!provider) return res.status(404).json({ error: 'Proveedor no encontrado' });

    // Incrementar vistas de forma asíncrona (no bloquea la respuesta)
    prisma.providerProfile.update({
      where: { id: req.params.id },
      data: { totalViews: { increment: 1 } },
    }).catch(() => {});

    res.json(provider);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener proveedor' });
  }
});

// GET /providers/me/analytics — estadísticas del perfil del proveedor autenticado
router.get('/me/analytics', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden acceder a analytics' });
    }

    const profile = await prisma.providerProfile.findUnique({
      where: { userId: req.user.id },
      select: {
        id: true,
        totalViews: true,
        calificacion: true,
        totalReviews: true,
        reservasCompletadas: true,
        tiempoRespuestaH: true,
        tasaAceptacion: true,
      },
    });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

    // Bookings del proveedor (últimos 30 días para tendencias)
    const hace30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [totalBookings, recentBookings] = await Promise.all([
      prisma.booking.groupBy({
        by: ['estado'],
        where: { proveedorId: profile.id },
        _count: { estado: true },
      }),
      prisma.booking.findMany({
        where: { proveedorId: profile.id, createdAt: { gte: hace30Dias } },
        select: { estado: true, createdAt: true, precioTotal: true },
      }),
    ]);

    const estadoCounts = Object.fromEntries(totalBookings.map(g => [g.estado, g._count.estado]));
    const totalRecibidos = Object.values(estadoCounts).reduce((a, b) => a + b, 0);
    const totalConfirmados = (estadoCounts.CONFIRMADO || 0) + (estadoCounts.EN_PROGRESO || 0) + (estadoCounts.COMPLETADO || 0);
    const tasaConfirmacion = totalRecibidos > 0 ? Math.round((totalConfirmados / totalRecibidos) * 100) : null;

    // Ingresos últimos 30 días
    const ingresos30d = recentBookings
      .filter(b => b.estado === 'COMPLETADO')
      .reduce((s, b) => s + (b.precioTotal || 0), 0);

    // Reservas nuevas últimos 7 días
    const hace7Dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const reservas7d = recentBookings.filter(b => new Date(b.createdAt) >= hace7Dias).length;

    res.json({
      totalViews:         profile.totalViews,
      calificacion:       profile.calificacion,
      totalReviews:       profile.totalReviews,
      reservasCompletadas: profile.reservasCompletadas,
      tiempoRespuestaH:   profile.tiempoRespuestaH,
      tasaAceptacion:     profile.tasaAceptacion ?? tasaConfirmacion,
      totalBookings:      totalRecibidos,
      estadoCounts,
      ingresos30d,
      reservas7d,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener analytics' });
  }
});

// POST /providers/me/generate-bio — genera bio profesional con IA
router.post('/me/generate-bio', verifyToken, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'IA no disponible en este momento.' });
  if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });

  const profile = await prisma.providerProfile.findUnique({
    where: { userId: req.user.id },
    include: { user: { select: { nombre: true, ciudad: true } } },
  });
  if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

  const servicios = (profile.servicios || []).join(', ') || 'servicios del hogar';
  const ciudades  = (profile.ciudades  || []).join(', ') || profile.user.ciudad || 'Colombia';
  const tarifa    = profile.tarifaPorHora ? `$${profile.tarifaPorHora.toLocaleString('es-CO')} COP/hora` : null;
  const anios     = profile.aniosExperiencia ? `${profile.aniosExperiencia} años de experiencia` : null;
  const calif     = profile.calificacion > 0 ? `calificación de ${profile.calificacion.toFixed(1)}/5` : null;
  const verif     = profile.verificado ? 'proveedor verificado' : null;

  const contexto = [anios, calif, verif].filter(Boolean).join(', ');

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      temperature: 0.8,
      messages: [{
        role: 'system',
        content: 'Eres un redactor profesional para perfiles de trabajadores independientes colombianos. Escribe bios en primera persona, cálidas, confiables y concisas (máx 150 palabras). Usa lenguaje natural colombiano. NO uses emojis. NO inventes datos que no se te proporcionen.',
      }, {
        role: 'user',
        content: `Nombre: ${profile.user.nombre}
Servicios: ${servicios}
Ciudad(es): ${ciudades}
${tarifa ? `Tarifa: ${tarifa}` : ''}
${contexto ? `Info adicional: ${contexto}` : ''}
${profile.bio ? `Bio actual (opcional, puedes mejorarla): "${profile.bio}"` : ''}

Escribe una bio profesional en primera persona para este proveedor.`,
      }],
    });

    const bio = completion.choices[0].message.content.trim();
    res.json({ bio });
  } catch (e) {
    const detail = e?.response?.error?.message || e?.message || '';
    console.error('[generate-bio]', detail);
    res.status(503).json({ error: 'No se pudo generar la bio. Intenta de nuevo.' });
  }
});

// POST /providers/:id/review-summary — resumen de reseñas con IA (público)
router.post('/:id/review-summary', async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'IA no disponible en este momento.' });

  const profile = await prisma.providerProfile.findUnique({
    where: { id: req.params.id },
    include: {
      reviews: { select: { calificacion: true, comentario: true }, orderBy: { createdAt: 'desc' }, take: 30 },
    },
  });
  if (!profile) return res.status(404).json({ error: 'Proveedor no encontrado' });

  const reseñas = profile.reviews.filter(r => r.comentario?.trim());
  if (reseñas.length < 2) {
    return res.json({ summary: null, razon: 'No hay suficientes reseñas para generar un resumen.' });
  }

  const texto = reseñas.map((r, i) => `${i + 1}. [${r.calificacion}★] "${r.comentario}"`).join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0.5,
      messages: [{
        role: 'system',
        content: 'Eres un analista de reseñas. Resume en 2-3 oraciones en español lo que los clientes destacan (positivo y negativo si aplica) de este proveedor. Sé objetivo, conciso y neutral. No menciones nombres propios. Empieza con "Los clientes destacan..."',
      }, {
        role: 'user',
        content: `Reseñas del proveedor:\n${texto}`,
      }],
    });

    const summary = completion.choices[0].message.content.trim();
    res.json({ summary, total: reseñas.length });
  } catch (e) {
    const detail = e?.response?.error?.message || e?.message || '';
    console.error('[review-summary]', detail);
    res.status(503).json({ error: 'No se pudo generar el resumen.' });
  }
});

// GET /providers/me/profile-score — analiza el perfil y da score + tips con IA
router.get('/me/profile-score', verifyToken, async (req, res) => {
  if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });

  const profile = await prisma.providerProfile.findUnique({
    where: { userId: req.user.id },
    include: {
      user: { select: { nombre: true, emailVerificado: true, telefono: true, ciudad: true } },
      _count: { select: { reviews: true, bookings: true } },
    },
  });
  if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

  // Calcular score sin IA (base objetiva)
  const checks = {
    bio:          { ok: (profile.bio?.trim().length || 0) >= 50,   peso: 20, label: 'Biografía completa (min 50 caracteres)' },
    bio_larga:    { ok: (profile.bio?.trim().length || 0) >= 150,  peso: 10, label: 'Biografía detallada (min 150 caracteres)' },
    servicios:    { ok: (profile.servicios?.length || 0) >= 1,     peso: 15, label: 'Al menos 1 servicio configurado' },
    multi_serv:   { ok: (profile.servicios?.length || 0) >= 2,     peso: 5,  label: 'Múltiples servicios (2+)' },
    ciudades:     { ok: (profile.ciudades?.length  || 0) >= 1,     peso: 10, label: 'Ciudad(es) de trabajo configuradas' },
    tarifa:       { ok: (profile.tarifaPorHora || 0) > 0,          peso: 10, label: 'Tarifa por hora configurada' },
    cedula:       { ok: profile.cedulaStatus === 'aprobado',       peso: 15, label: 'Cédula verificada' },
    email:        { ok: profile.user.emailVerificado === true,      peso: 5,  label: 'Email verificado' },
    telefono:     { ok: !!profile.user.telefono,                   peso: 5,  label: 'Teléfono registrado' },
    experiencia:  { ok: (profile.aniosExperiencia || 0) > 0,       peso: 5,  label: 'Años de experiencia registrados' },
  };

  const score = Object.values(checks).reduce((sum, c) => sum + (c.ok ? c.peso : 0), 0);
  const pendientes = Object.values(checks).filter(c => !c.ok).map(c => c.label);

  // Si hay OpenAI, enriquecer con 3 tips personalizados
  let tips = pendientes.slice(0, 3).map(p => `Completa: ${p}`);

  if (openai && pendientes.length > 0) {
    try {
      const ctx = [
        `Score actual: ${score}/100`,
        `Servicios: ${(profile.servicios || []).join(', ') || 'ninguno'}`,
        `Ciudades: ${(profile.ciudades || []).join(', ') || 'ninguna'}`,
        `Bio: ${profile.bio ? `"${profile.bio.substring(0, 100)}..."` : 'vacía'}`,
        `Tarifa: ${profile.tarifaPorHora ? `$${profile.tarifaPorHora.toLocaleString('es-CO')}/hora` : 'no configurada'}`,
        `Cédula: ${profile.cedulaStatus}`,
        `Pendiente mejorar: ${pendientes.slice(0, 5).join('; ')}`,
      ].join('\n');

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0.6,
        messages: [{
          role: 'system',
          content: 'Eres un coach de perfiles para trabajadores independientes colombianos en DutyJoy. Da exactamente 3 tips concretos y accionables (en español, tono amigable) para que este proveedor consiga más clientes. Responde SOLO con JSON válido: {"tips": ["tip1","tip2","tip3"]}',
        }, {
          role: 'user',
          content: ctx,
        }],
      });

      const raw = completion.choices[0].message.content.trim()
        .replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tips) && parsed.tips.length === 3) tips = parsed.tips;
    } catch (e) {
      console.error('[profile-score]', e.message);
      // tips already set as fallback
    }
  }

  res.json({ score, tips, checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok])) });
});

// POST /providers/me/onboarding-agent — conversational AI coach for provider onboarding
router.post('/me/onboarding-agent', verifyToken, async (req, res) => {
  if (req.user.rol !== 'PROVEEDOR') {
    return res.status(403).json({ error: 'Solo proveedores pueden usar el agente de onboarding.' });
  }
  if (!openai) {
    return res.status(503).json({ error: 'Agente no disponible en este momento.' });
  }

  try {
    const { messages = [], generateBio = false } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages requerido.' });
    }
    if (messages.length > 15) {
      return res.status(400).json({ error: 'Conversación demasiado larga. Inicia una nueva.' });
    }

    // Load full provider profile
    const profile = await prisma.providerProfile.findUnique({
      where: { userId: req.user.id },
      include: {
        user: { select: { nombre: true, emailVerificado: true, telefono: true, ciudad: true, createdAt: true } },
        _count: { select: { reviews: true, bookings: true } },
      },
    });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado.' });

    // Compute onboarding checklist status
    const checks = [
      { key: 'bio',          done: (profile.bio?.trim().length || 0) >= 50,    label: 'Biografía (mín 50 caracteres)',    peso: 20 },
      { key: 'servicios',    done: (profile.servicios?.length || 0) >= 1,      label: 'Servicio(s) configurado(s)',       peso: 15 },
      { key: 'tarifa',       done: (profile.tarifaPorHora || 0) > 0,           label: 'Tarifa por hora',                  peso: 10 },
      { key: 'ciudades',     done: (profile.ciudades?.length  || 0) >= 1,      label: 'Ciudad(es) de trabajo',            peso: 10 },
      { key: 'cedula',       done: profile.cedulaStatus === 'aprobado',        label: 'Cédula verificada',                peso: 15 },
      { key: 'telefono',     done: !!profile.user.telefono,                    label: 'Teléfono de contacto',             peso: 5  },
      { key: 'experiencia',  done: (profile.aniosExperiencia || 0) > 0,        label: 'Años de experiencia',              peso: 5  },
      { key: 'horario',      done: !!profile.horario,                          label: 'Horario semanal configurado',      peso: 5  },
      { key: 'portfolio',    done: (profile.portfolioUrls?.length || 0) > 0,   label: 'Foto(s) de trabajos anteriores',  peso: 10 },
      { key: 'disponible',   done: profile.disponible === true,                label: 'Perfil visible (disponible = sí)', peso: 5  },
    ];

    const completados  = checks.filter(c => c.done);
    const pendientes   = checks.filter(c => !c.done);
    const score        = completados.reduce((s, c) => s + c.peso, 0);
    const diasRegistrado = Math.round((Date.now() - new Date(profile.user.createdAt).getTime()) / 86400000);
    const nextStep     = pendientes[0] || null;

    const systemPrompt = `Eres "Joy", el agente de onboarding de DutyJoy — plataforma colombiana de servicios del hogar.
Tu rol: guiar a ${profile.user.nombre} paso a paso para completar su perfil y conseguir su primera reserva.

## Estado actual del perfil
- Score de perfil: ${score}/100
- Días desde registro: ${diasRegistrado}
- Reservas completadas: ${profile._count.bookings}
- Reseñas recibidas: ${profile._count.reviews}
- Servicios: ${(profile.servicios || []).join(', ') || 'ninguno configurado'}
- Ciudades: ${(profile.ciudades || []).join(', ') || 'ninguna'}
- Tarifa: ${profile.tarifaPorHora ? `$${profile.tarifaPorHora.toLocaleString('es-CO')}/hora` : 'no configurada'}
- Bio: ${profile.bio ? `"${profile.bio.substring(0, 80)}…"` : 'vacía'}
- Cédula: ${profile.cedulaStatus}
- Teléfono: ${profile.user.telefono || 'no registrado'}
- Horario: ${profile.horario ? 'configurado' : 'no configurado'}
- Portfolio: ${profile.portfolioUrls?.length || 0} foto(s)

## Pasos completados (${completados.length}/${checks.length})
${completados.map(c => `✅ ${c.label}`).join('\n')}

## Pasos pendientes
${pendientes.map((c, i) => `${i + 1}. ❌ ${c.label}`).join('\n')}

## Instrucciones
- Tono: amigable, motivador, colombiano (tuteo). Usa emojis con moderación.
- Máximo 3-4 oraciones por respuesta. Sé directo y accionable.
- Siempre termina indicando el siguiente paso más importante.
- Si te piden generar una bio, créala basada en los servicios, ciudad y experiencia disponibles.
- Si el perfil está < 50%: enfócate en los pasos de mayor impacto primero.
- No inventes información que no esté en el contexto.
- Responde SIEMPRE en español.`;

    const sanitizedMessages = messages
      .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.substring(0, 600) }))
      .slice(-12);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 350,
      temperature: 0.65,
      messages: [
        { role: 'system', content: systemPrompt },
        ...sanitizedMessages,
      ],
    });

    const reply = completion.choices[0].message.content.trim();

    // If bio was requested or user's message asks for bio, generate one separately
    let suggestedBio = null;
    const lastUserMsg = sanitizedMessages.filter(m => m.role === 'user').pop()?.content?.toLowerCase() || '';
    const wantsBio = generateBio || lastUserMsg.includes('bio') || lastUserMsg.includes('descripción') || lastUserMsg.includes('presentación');

    if (wantsBio && !profile.bio) {
      try {
        const bioComp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 200,
          temperature: 0.7,
          messages: [{
            role: 'user',
            content: `Genera una bio profesional de 2-3 oraciones para un proveedor de servicios del hogar colombiano llamado ${profile.user.nombre}.
Servicios: ${(profile.servicios || []).join(', ') || 'servicios del hogar'}.
Ciudad: ${(profile.ciudades || []).join(', ') || 'Colombia'}.
Experiencia: ${profile.aniosExperiencia ? `${profile.aniosExperiencia} años` : 'experiencia comprobada'}.
Tono: profesional pero cercano. Sin clichés. Máx 150 caracteres. Solo la bio, sin comillas.`,
          }],
        });
        suggestedBio = bioComp.choices[0].message.content.trim();
      } catch { /* bio generation is optional */ }
    }

    res.json({
      reply,
      suggestedBio,
      score,
      pendingSteps:  pendientes.map(c => c.label),
      nextStep:      nextStep?.label || null,
      pct:           Math.round(score),
    });
  } catch (error) {
    console.error('[onboarding-agent]', error);
    res.status(500).json({ error: 'Error en el agente de onboarding.' });
  }
});

// POST /providers/smart-match — AI-powered provider matching (semantic + 8-factor scoring)
router.post('/smart-match', verifyToken, async (req, res) => {
  try {
    const {
      query        = '',
      category     = '',
      budget       = 200000,   // max COP/h
      minRating    = 0,
      urgente      = false,
      soloVerificados  = false,
      soloDisponibles  = false,
      ciudad       = '',
      limit        = 10,
    } = req.body;

    const take = Math.min(parseInt(limit) || 10, 30);

    // 1. Build DB filters
    const where = {
      disponible: soloDisponibles ? true : undefined,
      verificado: soloVerificados ? true : undefined,
      tarifaPorHora: budget > 0 ? { lte: budget } : undefined,
      calificacion: minRating > 0 ? { gte: parseFloat(minRating) } : undefined,
      ...(category && { servicios: { has: category } }),
      ...(ciudad && { ciudades: { has: ciudad } }),
    };
    // Remove undefined keys
    Object.keys(where).forEach(k => where[k] === undefined && delete where[k]);

    // 2. If query text → try semantic search first
    let semanticMap = {};
    if (query && query.trim().length > 2) {
      const matches = await semanticSearch(query.trim(), 50);
      matches.forEach(m => { semanticMap[m.id] = m.similarity; });
      if (matches.length > 0) {
        where.id = { in: matches.map(m => m.id) };
      }
    }

    // 3. Fetch providers from DB
    const providers = await prisma.providerProfile.findMany({
      where,
      take: take * 4, // fetch more to score and sort
      include: {
        user: { select: { nombre: true, ciudad: true } },
      },
    });

    // 4. Load client booking history for history bonus
    let historyIds = new Set();
    try {
      const history = await prisma.booking.findMany({
        where: { clienteId: req.user.id, estado: 'COMPLETADO' },
        select: { proveedorId: true },
        take: 20,
      });
      history.forEach(b => historyIds.add(b.proveedorId));
    } catch { /* no history */ }

    // 5. 8-factor scoring (mirrors frontend computeScore)
    const CATEGORY_MAP = {
      aseo: ['aseo','limpieza','hogar'], plomeria: ['plomeria','tubería','agua','fontaneria'],
      electricidad: ['electricidad','eléctrico','instalación'], jardineria: ['jardineria','jardín','plantas','poda'],
      pintura: ['pintura','decoración'], aires: ['aire_acondicionado','a/c','refrigeración'],
      mudanza: ['mudanzas','transporte','carga'], cerrajeria: ['cerrajeria','llaves','puertas'],
    };

    const scored = providers.map(p => {
      let score = 0;
      const reasons = [], penalties = [];
      const tags = (p.servicios || []).map(s => s.toLowerCase());

      // 1. Rating (0-28)
      const ratingNorm = Math.max(0, (p.calificacion - 3) / 2);
      score += Math.round(ratingNorm * 28);
      if (p.calificacion >= 4.8) reasons.push(`Calificación excepcional: ${p.calificacion} ⭐`);
      else if (p.calificacion >= 4.5) reasons.push(`Muy bien calificado: ${p.calificacion} ⭐`);

      // 2. Category match (0-22)
      if (category) {
        const catTags = CATEGORY_MAP[category] || [category];
        const catMatch = tags.some(t => catTags.some(ct => t.includes(ct)));
        if (catMatch) { score += 22; reasons.push(`Especialista en ${category}`); }
        else { score -= 5; penalties.push('Categoría diferente'); }
      } else { score += 11; }

      // 3. Budget (0-20)
      const maxBudget = budget;
      if (p.tarifaPorHora <= maxBudget) {
        const saving = ((maxBudget - p.tarifaPorHora) / maxBudget) * 100;
        score += Math.round(Math.min(20, 10 + saving * 0.2));
        if (saving >= 30) reasons.push(`Precio ${Math.round(saving)}% bajo tu presupuesto`);
        else reasons.push(`Dentro de tu presupuesto`);
      } else {
        const over = Math.round(((p.tarifaPorHora - maxBudget) / maxBudget) * 100);
        score -= Math.min(15, over * 0.3);
        penalties.push(`${over}% sobre tu presupuesto`);
      }

      // 4. Availability (0-15)
      if (p.disponible) { score += 15; reasons.push('Disponible ahora mismo'); }
      else { score -= 5; penalties.push('No disponible'); }

      // 5. Response time (0-10)
      const respH = p.tiempoRespuestaH || 24;
      if (respH <= 1) { score += 10; reasons.push('Responde en < 1 hora'); }
      else if (respH <= 3) { score += 6; }
      else if (urgente) { score -= 5; penalties.push(`Tiempo de respuesta: ${respH.toFixed(0)}h`); }
      else { score += 2; }

      // 6. Verification (0-5)
      if (p.verificado) { score += 5; reasons.push('Proveedor verificado'); }

      // 7. History bonus (0-5)
      if (historyIds.has(p.id)) { score += 5; reasons.push('Ya contratado con éxito'); }

      // 8. Experience (0-5)
      const exp = p.aniosExperiencia || 0;
      if (exp >= 8) { score += 5; reasons.push(`${exp} años de experiencia`); }
      else if (exp >= 4) { score += 3; }

      // Semantic similarity bonus (0-10 extra)
      const sim = semanticMap[p.id];
      if (sim !== undefined) {
        const bonus = Math.round(sim * 10);
        score += bonus;
        if (sim > 0.85) reasons.push('Alta compatibilidad semántica con tu búsqueda');
      }

      const finalScore = Math.max(5, Math.min(100, Math.round(score)));
      return {
        id:              p.id,
        nombre:          p.user?.nombre || 'Proveedor',
        ciudad:          p.user?.ciudad || p.ciudades?.[0] || '',
        calificacion:    p.calificacion,
        tarifaHora:      p.tarifaPorHora,
        serviciosCount:  p.reservasCompletadas || 0,
        tiempoRespH:     p.tiempoRespuestaH || null,
        verificado:      p.verificado,
        disponible:      p.disponible,
        servicios:       p.servicios || [],
        aniosExperiencia: p.aniosExperiencia || 0,
        bio:             p.bio ? p.bio.substring(0, 120) : null,
        instantBooking:  p.instantBooking || false,
        totalReviews:    p.totalReviews || 0,
        score:           finalScore,
        reasons:         reasons.slice(0, 3),
        penalties:       penalties.slice(0, 2),
        semanticSim:     sim || null,
      };
    });

    // 6. Sort by score desc, take top N
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, take);

    res.json({
      results:     top,
      total:       scored.length,
      semantic:    Object.keys(semanticMap).length > 0,
      query:       query || null,
      filtersApplied: { category, budget, minRating, urgente, soloVerificados, soloDisponibles, ciudad },
    });
  } catch (error) {
    console.error('[smart-match]', error);
    res.status(500).json({ error: 'Error en Smart Match.' });
  }
});

// GET /providers/me/pricing-suggestion — AI-powered dynamic pricing recommendation
router.get('/me/pricing-suggestion', verifyToken, async (req, res) => {
  if (req.user.rol !== 'PROVEEDOR') {
    return res.status(403).json({ error: 'Solo proveedores pueden acceder a sugerencias de precio.' });
  }
  if (!openai) {
    return res.status(503).json({ error: 'OPENAI_API_KEY no configurado.' });
  }

  try {
    const profile = await prisma.providerProfile.findUnique({
      where: { userId: req.user.id },
      select: {
        tarifaPorHora: true,
        servicios: true,
        ciudades: true,
        calificacion: true,
        totalReviews: true,
        aniosExperiencia: true,
        reservasCompletadas: true,
        tasaAceptacion: true,
        verificado: true,
      },
    });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado.' });

    const servicioPrincipal = profile.servicios?.[0] || 'servicios';
    const ciudadPrincipal   = profile.ciudades?.[0]  || 'Colombia';

    // Get market stats for primary service + city
    const marketWhere = {
      disponible: true,
      tarifaPorHora: { gt: 0 },
      servicios: { has: servicioPrincipal },
      ciudades: { has: ciudadPrincipal },
    };
    const [marketStats, percentileData] = await Promise.all([
      prisma.providerProfile.aggregate({
        where: marketWhere,
        _avg: { tarifaPorHora: true },
        _min: { tarifaPorHora: true },
        _max: { tarifaPorHora: true },
        _count: { tarifaPorHora: true },
      }),
      prisma.providerProfile.findMany({
        where: marketWhere,
        select: { tarifaPorHora: true },
        orderBy: { tarifaPorHora: 'asc' },
      }),
    ]);

    // Fallback market data if not enough providers
    const fallbacks = {
      plomeria: { min: 35000, avg: 55000, max: 90000 },
      electricidad: { min: 40000, avg: 65000, max: 120000 },
      limpieza: { min: 20000, avg: 35000, max: 60000 },
      jardineria: { min: 25000, avg: 40000, max: 70000 },
      pintura: { min: 30000, avg: 50000, max: 90000 },
      cerrajeria: { min: 35000, avg: 55000, max: 100000 },
      mudanzas: { min: 50000, avg: 80000, max: 150000 },
      aire_acondicionado: { min: 60000, avg: 90000, max: 150000 },
      carpinteria: { min: 35000, avg: 55000, max: 100000 },
      fumigacion: { min: 40000, avg: 65000, max: 120000 },
    };

    const hasSufficientData = (marketStats._count.tarifaPorHora || 0) >= 3;
    const fb = fallbacks[servicioPrincipal] || { min: 30000, avg: 50000, max: 100000 };

    const marketAvg  = hasSufficientData ? Math.round(marketStats._avg.tarifaPorHora || fb.avg) : fb.avg;
    const marketMin  = hasSufficientData ? Math.round(marketStats._min.tarifaPorHora || fb.min) : fb.min;
    const marketMax  = hasSufficientData ? Math.round(marketStats._max.tarifaPorHora || fb.max) : fb.max;

    // Compute percentile of provider's rate
    const rates = percentileData.map(p => p.tarifaPorHora).filter(Boolean);
    const myRate = profile.tarifaPorHora || 0;
    const belowMe = rates.filter(r => r <= myRate).length;
    const percentil = rates.length > 0 ? Math.round((belowMe / rates.length) * 100) : 50;

    // Build AI prompt
    const prompt = `Eres un consultor de precios experto en el mercado colombiano de servicios del hogar.

## Datos del proveedor
- Servicio principal: ${servicioPrincipal}
- Ciudad: ${ciudadPrincipal}
- Tarifa actual: $${myRate.toLocaleString('es-CO')} COP/hora
- Calificación: ${profile.calificacion?.toFixed(1) || 'N/A'} (${profile.totalReviews || 0} reseñas)
- Años de experiencia: ${profile.aniosExperiencia || 'no especificado'}
- Reservas completadas: ${profile.reservasCompletadas || 0}
- Tasa de aceptación: ${profile.tasaAceptacion ? `${Math.round(profile.tasaAceptacion)}%` : 'N/A'}
- Verificado: ${profile.verificado ? 'Sí' : 'No'}

## Datos del mercado (${servicioPrincipal} en ${ciudadPrincipal})
- Tarifa mínima: $${marketMin.toLocaleString('es-CO')} COP/hora
- Tarifa promedio: $${marketAvg.toLocaleString('es-CO')} COP/hora
- Tarifa máxima: $${marketMax.toLocaleString('es-CO')} COP/hora
- Total proveedores en mercado: ${marketStats._count.tarifaPorHora || 0}
- Percentil del proveedor: ${percentil}° (su tarifa es mayor que el ${percentil}% del mercado)

## Tu tarea
Analiza si el proveedor está cobrando óptimamente y recomienda una estrategia de precio. Responde ÚNICAMENTE con JSON válido:

{
  "tarifaSugerida": <número en COP, múltiplo de 1000>,
  "deltaPercent": <número con signo: +10 significa subir 10%, -5 bajar 5%>,
  "confianza": <0.0 a 1.0>,
  "resumen": "<1-2 oraciones sobre la situación del proveedor en el mercado, máx 150 chars>",
  "razonamiento": "<explicación detallada de por qué este precio, máx 300 chars>",
  "escenarios": [
    { "label": "Conservador", "tarifa": <COP>, "impactoReservas": <+/-%, texto>, "ingresoMensualEstimado": <COP> },
    { "label": "Óptimo", "tarifa": <COP>, "impactoReservas": <+/-%, texto>, "ingresoMensualEstimado": <COP> },
    { "label": "Agresivo", "tarifa": <COP>, "impactoReservas": <+/-%, texto>, "ingresoMensualEstimado": <COP> }
  ],
  "accionPrincipal": "subir" | "bajar" | "mantener"
}

Asume que el proveedor trabaja ~40 horas/mes y que cambios de ±10% en precio afectan demanda en ~±8% (elasticidad precio típica).`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    let parsed;
    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      return res.status(502).json({ error: 'Respuesta inválida del modelo.' });
    }

    res.json({
      currentRate:  myRate,
      marketAvg,
      marketMin,
      marketMax,
      percentil,
      totalProveedores: marketStats._count.tarifaPorHora || 0,
      servicio: servicioPrincipal,
      ciudad:   ciudadPrincipal,
      fuente:   hasSufficientData ? 'mercado' : 'referencia',
      ...parsed,
    });
  } catch (error) {
    console.error('[pricing-suggestion]', error);
    res.status(500).json({ error: 'Error al generar sugerencia de precio.' });
  }
});

// GET /providers/market-pricing — rango de precios del mercado por servicio/ciudad
router.get('/market-pricing', async (req, res) => {
  const { servicio, ciudad } = req.query;
  if (!servicio) return res.status(400).json({ error: 'servicio es requerido' });

  try {
    const where = {
      disponible: true,
      tarifaPorHora: { gt: 0 },
      ...(servicio && { servicios: { has: servicio } }),
      ...(ciudad && { ciudades: { has: ciudad } }),
    };

    const stats = await prisma.providerProfile.aggregate({
      where,
      _avg: { tarifaPorHora: true },
      _min: { tarifaPorHora: true },
      _max: { tarifaPorHora: true },
      _count: { tarifaPorHora: true },
    });

    const avg = Math.round(stats._avg.tarifaPorHora || 0);
    const min = stats._min.tarifaPorHora || 0;
    const max = stats._max.tarifaPorHora || 0;
    const total = stats._count.tarifaPorHora;

    // Si no hay datos suficientes, devolver rangos de referencia por servicio
    const fallbacks = {
      plomeria: { min: 35000, avg: 55000, max: 90000 },
      electricidad: { min: 40000, avg: 65000, max: 120000 },
      limpieza: { min: 20000, avg: 35000, max: 60000 },
      jardineria: { min: 25000, avg: 40000, max: 70000 },
      pintura: { min: 30000, avg: 50000, max: 90000 },
      cerrajeria: { min: 35000, avg: 55000, max: 100000 },
      mudanzas: { min: 50000, avg: 80000, max: 150000 },
      aire_acondicionado: { min: 60000, avg: 90000, max: 150000 },
      carpinteria: { min: 35000, avg: 55000, max: 100000 },
      fumigacion: { min: 40000, avg: 65000, max: 120000 },
    };

    if (total < 3) {
      const fb = fallbacks[servicio] || { min: 30000, avg: 50000, max: 100000 };
      return res.json({ ...fb, total: 0, fuente: 'referencia' });
    }

    const sugerido = Math.round(avg * 1.0 / 1000) * 1000; // redondear a miles
    res.json({ min, avg, max, sugerido, total, fuente: 'mercado' });
  } catch (e) {
    console.error('[market-pricing]', e.message);
    res.status(500).json({ error: 'Error al obtener precios del mercado' });
  }
});

// GET /providers/:id/similar — proveedores similares (por servicios + ciudad + calificación)
router.get('/:id/similar', async (req, res) => {
  try {
    const provider = await prisma.providerProfile.findUnique({
      where: { id: req.params.id },
      select: { id: true, servicios: true, ciudades: true, calificacion: true },
    });
    if (!provider) return res.status(404).json({ error: 'Proveedor no encontrado' });

    // Búsqueda por servicios y ciudades en común, excluyendo al proveedor actual
    const similares = await prisma.providerProfile.findMany({
      where: {
        id:        { not: provider.id },
        disponible: true,
        verificado: true,
        servicios:  provider.servicios?.length > 0 ? { hasSome: provider.servicios } : undefined,
      },
      include: { user: { select: { nombre: true, ciudad: true } } },
      orderBy: { calificacion: 'desc' },
      take: 20,
    });

    // Score: #servicios en común (peso 2) + misma ciudad (peso 3) + calificación
    const scored = similares.map(p => {
      const serviciosComun = (p.servicios || []).filter(s => (provider.servicios || []).includes(s)).length;
      const ciudadComun    = (p.ciudades || []).some(c => (provider.ciudades || []).includes(c)) ? 1 : 0;
      const score = serviciosComun * 2 + ciudadComun * 3 + (p.calificacion || 0) * 0.5;
      return { ...p, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);
    const top = scored.slice(0, 4).map(({ _score, ...p }) => p);

    res.json(top);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener proveedores similares' });
  }
});

// GET /providers/:id/available-slots?fecha=YYYY-MM-DD&duracion=2
// Devuelve los slots disponibles de un proveedor para una fecha dada (14 días máx)
router.get('/:id/available-slots', async (req, res) => {
  try {
    const { fecha, duracion = 2 } = req.query;
    const durH = parseFloat(duracion) || 2;

    const profile = await prisma.providerProfile.findUnique({
      where: { id: req.params.id },
      select: { horario: true, disponible: true, instantBooking: true },
    });
    if (!profile) return res.status(404).json({ error: 'Proveedor no encontrado' });
    if (!profile.disponible) return res.json({ slots: [], motivo: 'Proveedor no disponible' });

    // Determinar la fecha a consultar (hoy si no se pasa)
    const targetDate = fecha ? new Date(fecha) : new Date();
    if (isNaN(targetDate.getTime())) return res.status(400).json({ error: 'Fecha inválida' });

    const DIAS_ES = ['dom','lun','mar','mie','jue','vie','sab'];
    const slots = [];

    // Generar slots para los próximos 14 días (o solo la fecha pedida)
    const days = fecha ? 1 : 14;
    for (let d = 0; d < days; d++) {
      const day = new Date(targetDate);
      day.setDate(day.getDate() + d);
      day.setHours(0, 0, 0, 0);

      const diaKey = DIAS_ES[day.getDay()];
      const schedule = profile.horario?.[diaKey];

      // Si no hay horario configurado, usar slot por defecto 8:00-18:00 Mon-Sat
      let inicio = '08:00';
      let fin    = '18:00';
      let activo = diaKey !== 'dom'; // domingo inactivo por defecto

      if (schedule) {
        activo = Boolean(schedule.activo);
        inicio = schedule.inicio || '08:00';
        fin    = schedule.fin    || '18:00';
      }
      if (!activo) continue;

      // Obtener reservas activas del día para detectar conflictos
      const startOfDay = new Date(day);
      const endOfDay   = new Date(day);
      endOfDay.setHours(23, 59, 59, 999);

      const existentes = await prisma.booking.findMany({
        where: {
          proveedorId: req.params.id,
          estado:      { in: ['PENDIENTE', 'CONFIRMADO', 'EN_PROGRESO'] },
          fechaServicio: { gte: startOfDay, lte: endOfDay },
        },
        select: { fechaServicio: true, duracionHoras: true },
      });

      // Generar slots de 1h entre inicio y fin
      const [hIni] = inicio.split(':').map(Number);
      const [hFin] = fin.split(':').map(Number);
      const now    = new Date();

      for (let h = hIni; h + durH <= hFin; h++) {
        const slotStart = new Date(day);
        slotStart.setHours(h, 0, 0, 0);
        const slotEnd = new Date(slotStart.getTime() + durH * 60 * 60 * 1000);

        // Descartar slots en el pasado o a menos de 1h de ahora
        if (slotStart <= new Date(now.getTime() + 60 * 60 * 1000)) continue;

        // Verificar conflictos
        const ocupado = existentes.some(b => {
          const bStart = new Date(b.fechaServicio);
          const bEnd   = new Date(bStart.getTime() + b.duracionHoras * 60 * 60 * 1000);
          return slotStart < bEnd && slotEnd > bStart;
        });

        slots.push({
          inicio:    slotStart.toISOString(),
          fin:       slotEnd.toISOString(),
          disponible: !ocupado,
          diaLabel:  day.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }),
        });
      }
    }

    res.json({ slots, instantBooking: profile.instantBooking });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener disponibilidad' });
  }
});

// GET /providers/recommended — personalized recs for authenticated client
router.get('/recommended', verifyToken, async (req, res) => {
  try {
    // Fetch user's past bookings to learn preferred services + cities
    const pastBookings = await prisma.booking.findMany({
      where: { clienteId: req.user.id },
      select: { tipoServicio: true, proveedor: { select: { ciudades: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Count service frequency
    const svcFreq = {};
    const cityFreq = {};
    for (const b of pastBookings) {
      svcFreq[b.tipoServicio] = (svcFreq[b.tipoServicio] || 0) + 1;
      for (const c of b.proveedor?.ciudades || []) {
        cityFreq[c] = (cityFreq[c] || 0) + 1;
      }
    }

    // Get favorites to exclude
    const favs = await prisma.favorito.findMany({ where: { userId: req.user.id }, select: { proveedorId: true } });
    const favIds = favs.map(f => f.proveedorId);

    // Already-booked provider IDs
    const bookedIds = [...new Set(pastBookings.map(b => b.proveedorId).filter(Boolean))];

    const topServices = Object.entries(svcFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
    const topCities   = Object.entries(cityFreq).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);

    const where = {
      disponible: true,
      verificado: true,
      ...(topServices.length > 0 && { servicios: { hasSome: topServices } }),
    };

    const candidates = await prisma.providerProfile.findMany({
      where,
      include: {
        user:    { select: { nombre: true, ciudad: true } },
        reviews: { select: { calificacion: true }, take: 100 },
      },
      orderBy: { calificacion: 'desc' },
      take: 40,
    });

    const scored = candidates.map(p => {
      const svcMatch  = (p.servicios || []).filter(s => topServices.includes(s)).length;
      const cityMatch = (p.ciudades   || []).some(c => topCities.includes(c)) ? 2 : 0;
      const favBonus  = favIds.includes(p.id) ? 1 : 0;
      const newBonus  = !bookedIds.includes(p.id) ? 1.5 : 0; // prefer undiscovered
      const score = svcMatch * 2 + cityMatch + favBonus + newBonus + (p.calificacion || 0) * 0.4;
      return { ...p, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);

    const top = scored.slice(0, 6).map(({ _score, reviews, ...p }) => ({
      ...p,
      _reason: _score > 5 ? 'top_match' : _score > 3 ? 'good_match' : 'popular',
    }));

    // Fallback: if no history, return top-rated verified providers
    if (top.length < 4) {
      const fallback = await prisma.providerProfile.findMany({
        where: { disponible: true, verificado: true },
        include: { user: { select: { nombre: true, ciudad: true } } },
        orderBy: [{ calificacion: 'desc' }, { reservasCompletadas: 'desc' }],
        take: 6,
      });
      return res.json(fallback.map(p => ({ ...p, _reason: 'popular' })));
    }

    res.json(top);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener recomendaciones' });
  }
});

// GET /providers/me/earnings — monthly revenue chart (last 6 months)
router.get('/me/earnings', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

    const since = new Date();
    since.setMonth(since.getMonth() - 6);
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const completadas = await prisma.booking.findMany({
      where: { proveedorId: profile.id, estado: 'COMPLETADO', createdAt: { gte: since } },
      select: { precioTotal: true, createdAt: true },
    });

    // Build 6-month buckets
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      months.push({
        label: d.toLocaleDateString('es-CO', { month:'short', year:'2-digit' }),
        year: d.getFullYear(),
        month: d.getMonth(),
        total: 0,
        count: 0,
      });
    }

    for (const b of completadas) {
      const d = new Date(b.createdAt);
      const bucket = months.find(m => m.year === d.getFullYear() && m.month === d.getMonth());
      if (bucket) { bucket.total += (b.precioTotal || 0); bucket.count++; }
    }

    const totalGeneral = months.reduce((s, m) => s + m.total, 0);
    const mejorMes = months.reduce((best, m) => m.total > best.total ? m : best, months[0]);
    const promedioMes = totalGeneral / 6;

    res.json({ months, totalGeneral, mejorMes, promedioMes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener ingresos' });
  }
});

// GET /providers/me/upcoming — next 5 upcoming bookings
router.get('/me/upcoming', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

    const bookings = await prisma.booking.findMany({
      where: {
        proveedorId: profile.id,
        estado: { in: ['PENDIENTE','CONFIRMADO','EN_PROGRESO'] },
        fechaServicio: { gte: new Date() },
      },
      orderBy: { fechaServicio: 'asc' },
      take: 5,
      include: { cliente: { select: { nombre: true, telefono: true } } },
    });

    res.json(bookings);
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

// ── Voice Onboarding ──────────────────────────────────────────────────────

// Interview questions the voice agent asks
const INTERVIEW_QUESTIONS = [
  { id: 'experiencia',     text: '¿Cuántos años de experiencia tienes en los servicios que ofreces?' },
  { id: 'servicios',       text: '¿Qué servicios ofreces exactamente? Por ejemplo: limpieza de hogares, plomería, electricidad…' },
  { id: 'ciudades',        text: '¿En qué ciudades o barrios puedes ofrecer tus servicios?' },
  { id: 'tarifa',          text: '¿Cuánto cobras por hora por tus servicios?' },
  { id: 'historia',        text: '¿Puedes contarme brevemente sobre tus trabajos anteriores? ¿Para quién has trabajado o qué proyectos has hecho?' },
  { id: 'fortaleza',       text: '¿Cuál es tu mayor fortaleza como proveedor de servicios?' },
  { id: 'disponibilidad',  text: '¿En qué horarios estás disponible? ¿Trabajas fines de semana?' },
  { id: 'referencia1',     text: '¿Puedes darnos el nombre y teléfono de una persona que pueda dar referencias tuyas? Puede ser un cliente anterior o un empleador.' },
  { id: 'antecedentes',    text: '¿Tienes algún antecedente judicial, penal o disciplinario que debamos conocer? Responde con sinceridad — esto es confidencial y parte de nuestro proceso de verificación.' },
  { id: 'compromiso',      text: 'Por último: ¿Te comprometes a tratar a todos los clientes con respeto, a cumplir los horarios acordados y a mantener la calidad del servicio?' },
];

// GET /providers/me/interview-questions — returns the interview script
router.get('/me/interview-questions', verifyToken, async (req, res) => {
  if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores.' });
  res.json({ questions: INTERVIEW_QUESTIONS });
});

// POST /providers/me/voice-onboarding — processes full interview transcript, updates profile
router.post('/me/voice-onboarding', verifyToken, async (req, res) => {
  if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores.' });

  const { answers } = req.body; // { experiencia: "5 años", servicios: "limpieza y plomería", ... }
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers (object) requerido.' });
  }

  try {
    const profile = await prisma.providerProfile.findUnique({
      where: { userId: req.user.id },
      include: { user: { select: { nombre: true } } },
    });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado.' });

    // AI processing: extract structured data + background score
    let extractedData = null;
    let backgroundScore = 50; // default if no OpenAI
    let suggestedBio    = null;
    let flags           = [];

    if (openai) {
      const answersText = INTERVIEW_QUESTIONS
        .filter(q => answers[q.id])
        .map(q => `P: ${q.text}\nR: ${answers[q.id]}`)
        .join('\n\n');

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 800,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `Analiza esta entrevista de onboarding de un proveedor de servicios del hogar colombiano. Extrae datos estructurados y evalúa el perfil.

${answersText}

Responde SOLO JSON:
{
  "servicios": [<lista de servicios mencionados, IDs: limpieza|plomeria|electricidad|pintura|jardineria|cerrajeria|mudanzas|aire_acondicionado|carpinteria|fumigacion>],
  "ciudades": [<lista de ciudades colombianas mencionadas>],
  "aniosExperiencia": <número entero o null>,
  "tarifaPorHora": <número COP o null — interpreta "80 mil" como 80000>,
  "bioGenerada": "<bio profesional de 2-3 oraciones basada en las respuestas>",
  "referencia": { "nombre": "<nombre>", "telefono": "<teléfono>" } o null,
  "backgroundScore": <0-100: evalúa coherencia, honestidad, experiencia, disponibilidad. Resta si admite antecedentes o responde evasivamente.>,
  "flags": [<lista de señales de alerta si hay: "admite_antecedentes", "respuestas_evasivas", "sin_referencias", "experiencia_inconsistente">],
  "resumenAdmin": "<resumen de 2 oraciones para el equipo de revisión>",
  "aprobacionSugerida": "aprobado" | "en_revision" | "rechazado"
}`,
        }],
      });

      extractedData = JSON.parse(completion.choices[0].message.content);
      backgroundScore = extractedData.backgroundScore ?? 50;
      suggestedBio    = extractedData.bioGenerada;
      flags           = extractedData.flags || [];
    } else {
      // Simple extraction without AI
      extractedData = { resumenAdmin: 'Entrevista completada sin análisis IA.', aprobacionSugerida: 'en_revision' };
    }

    // Update profile with extracted data
    const updateData = {
      backgroundScore,
      backgroundStatus: extractedData.aprobacionSugerida === 'aprobado' && backgroundScore >= 70 ? 'aprobado'
        : flags.includes('admite_antecedentes') || backgroundScore < 30 ? 'rechazado'
        : 'en_revision',
      backgroundData: {
        answers,
        extractedData,
        flags,
        interviewedAt: new Date().toISOString(),
      },
      voiceOnboardingAt: new Date(),
    };

    // Only update profile fields if we got AI extraction
    if (extractedData.servicios?.length)      updateData.servicios = extractedData.servicios;
    if (extractedData.ciudades?.length)       updateData.ciudades  = extractedData.ciudades;
    if (extractedData.aniosExperiencia != null) updateData.aniosExperiencia = extractedData.aniosExperiencia;
    if (extractedData.tarifaPorHora && extractedData.tarifaPorHora > 0) updateData.tarifaPorHora = extractedData.tarifaPorHora;
    if (suggestedBio && !profile.bio) updateData.bio = suggestedBio;

    const updated = await prisma.providerProfile.update({
      where: { id: profile.id },
      data: updateData,
    });

    res.json({
      mensaje: 'Entrevista procesada exitosamente',
      backgroundScore,
      backgroundStatus: updated.backgroundStatus,
      flags,
      suggestedBio,
      resumenAdmin: extractedData.resumenAdmin,
      profileUpdated: { servicios: updateData.servicios, ciudades: updateData.ciudades, aniosExperiencia: updateData.aniosExperiencia, tarifaPorHora: updateData.tarifaPorHora },
    });
  } catch (e) {
    console.error('[voice-onboarding]', e);
    res.status(500).json({ error: 'Error procesando la entrevista.' });
  }
});

// GET /providers/me/background-status — returns current background check status
router.get('/me/background-status', verifyToken, async (req, res) => {
  if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores.' });
  try {
    const profile = await prisma.providerProfile.findUnique({
      where: { userId: req.user.id },
      select: { backgroundScore: true, backgroundStatus: true, backgroundData: true, voiceOnboardingAt: true, cedulaStatus: true },
    });
    if (!profile) return res.status(404).json({ error: 'Perfil no encontrado.' });
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: 'Error.' });
  }
});

// GET /admin/providers/background-queue — providers pending background review
router.get('/background-queue', verifyToken, async (req, res) => {
  if (req.user.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo admin.' });
  try {
    const providers = await prisma.providerProfile.findMany({
      where: { backgroundStatus: { in: ['en_revision', 'pendiente'] }, voiceOnboardingAt: { not: null } },
      orderBy: { voiceOnboardingAt: 'desc' },
      include: { user: { select: { nombre: true, email: true } } },
      take: 50,
    });
    res.json({ providers, total: providers.length });
  } catch (e) {
    res.status(500).json({ error: 'Error.' });
  }
});

/* ══════════════════════════════════════════════════════════════════════
   Service Packages CRUD
   paquetes: [{id,nombre,descripcion,precio,duracionHoras,incluye:[]}]
   ══════════════════════════════════════════════════════════════════════ */
const { randomUUID } = require('crypto');

// GET /providers/me/packages
router.get('/me/packages', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const p = await prisma.providerProfile.findUnique({ where: { userId: req.user.id }, select: { paquetes: true } });
    res.json(p?.paquetes || []);
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// POST /providers/me/packages
router.post('/me/packages', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const { nombre, descripcion, precio, duracionHoras, incluye = [] } = req.body;
    if (!nombre?.trim() || !precio || !duracionHoras) {
      return res.status(400).json({ error: 'nombre, precio y duracionHoras son requeridos' });
    }
    const p = await prisma.providerProfile.findUnique({ where: { userId: req.user.id }, select: { paquetes: true } });
    const existing = Array.isArray(p?.paquetes) ? p.paquetes : [];
    if (existing.length >= 6) return res.status(400).json({ error: 'Máximo 6 paquetes' });
    const newPkg = { id: randomUUID(), nombre: nombre.trim(), descripcion: descripcion?.trim() || '', precio: parseFloat(precio), duracionHoras: parseFloat(duracionHoras), incluye };
    const updated = await prisma.providerProfile.update({
      where: { userId: req.user.id },
      data: { paquetes: [...existing, newPkg] },
    });
    res.status(201).json(newPkg);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error' }); }
});

// PUT /providers/me/packages/:pkgId
router.put('/me/packages/:pkgId', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const p = await prisma.providerProfile.findUnique({ where: { userId: req.user.id }, select: { paquetes: true } });
    const list = Array.isArray(p?.paquetes) ? p.paquetes : [];
    const idx = list.findIndex(pkg => pkg.id === req.params.pkgId);
    if (idx === -1) return res.status(404).json({ error: 'Paquete no encontrado' });
    const { nombre, descripcion, precio, duracionHoras, incluye } = req.body;
    list[idx] = { ...list[idx], ...(nombre && { nombre: nombre.trim() }), ...(descripcion !== undefined && { descripcion: descripcion.trim() }), ...(precio && { precio: parseFloat(precio) }), ...(duracionHoras && { duracionHoras: parseFloat(duracionHoras) }), ...(incluye && { incluye }) };
    await prisma.providerProfile.update({ where: { userId: req.user.id }, data: { paquetes: list } });
    res.json(list[idx]);
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// DELETE /providers/me/packages/:pkgId
router.delete('/me/packages/:pkgId', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores' });
    const p = await prisma.providerProfile.findUnique({ where: { userId: req.user.id }, select: { paquetes: true } });
    const list = Array.isArray(p?.paquetes) ? p.paquetes : [];
    const filtered = list.filter(pkg => pkg.id !== req.params.pkgId);
    await prisma.providerProfile.update({ where: { userId: req.user.id }, data: { paquetes: filtered } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

module.exports = router;
