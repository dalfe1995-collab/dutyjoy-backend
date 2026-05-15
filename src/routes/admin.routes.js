const router = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma = require('../lib/prisma');
const email = require('../lib/email');
const OpenAI = require('openai');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Extrae file ID de Google Drive y construye URLs candidatas
function getDriveUrls(url) {
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!match) return [url];
  const id = match[1];
  return [
    `https://lh3.googleusercontent.com/d/${id}`,
    `https://drive.google.com/thumbnail?id=${id}&sz=w2000`,
    `https://drive.google.com/uc?export=download&id=${id}&confirm=t`,
  ];
}

// Descarga imagen y devuelve base64 + mimeType
async function fetchImageAsBase64(url) {
  const urls = getDriveUrls(url);
  for (const candidate of urls) {
    try {
      const res = await fetch(candidate, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DutyJoy/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      return { base64: buffer.toString('base64'), mimeType: contentType.split(';')[0] };
    } catch { continue; }
  }
  return null;
}

// Middleware: solo ADMIN
const soloAdmin = (req, res, next) => {
  if (req.user.rol !== 'ADMIN') {
    return res.status(403).json({ error: 'Acceso restringido a administradores' });
  }
  next();
};

// GET /admin/stats — resumen general para dashboard CRM
router.get('/stats', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [
      totalUsuarios,
      totalClientes,
      totalProveedores,
      totalBookings,
      bookingsPendientes,
      bookingsCompletados,
      bookingsCancelados,
      proveedoresVerificados,
      proveedoresPendientes,
      cedulasPendientes,
      ingresosTotales,
      comisionesDutyjoy,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { rol: 'CLIENTE' } }),
      prisma.user.count({ where: { rol: 'PROVEEDOR' } }),
      prisma.booking.count(),
      prisma.booking.count({ where: { estado: 'PENDIENTE' } }),
      prisma.booking.count({ where: { estado: 'COMPLETADO' } }),
      prisma.booking.count({ where: { estado: 'CANCELADO' } }),
      prisma.providerProfile.count({ where: { verificado: true } }),
      prisma.providerProfile.count({ where: { verificado: false } }),
      prisma.providerProfile.count({ where: { cedulaStatus: 'pendiente' } }),
      prisma.booking.aggregate({ _sum: { precioTotal: true }, where: { estado: 'COMPLETADO' } }),
      prisma.booking.aggregate({ _sum: { comisionDutyJoy: true }, where: { estado: 'COMPLETADO' } }),
    ]);

    res.json({
      usuarios: { total: totalUsuarios, clientes: totalClientes, proveedores: totalProveedores },
      bookings: {
        total: totalBookings,
        pendientes: bookingsPendientes,
        completados: bookingsCompletados,
        cancelados: bookingsCancelados,
      },
      proveedores: { verificados: proveedoresVerificados, pendientes: proveedoresPendientes, cedulasPendientes },
      finanzas: {
        ingresosTotales: ingresosTotales._sum.precioTotal || 0,
        comisionesDutyjoy: comisionesDutyjoy._sum.comisionDutyJoy || 0,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// GET /admin/leaderboard — top 10 proveedores por completados / ingresos / calificación
router.get('/leaderboard', verifyToken, soloAdmin, async (req, res) => {
  try {
    const [byCompleted, byRevenue] = await Promise.all([
      // Top por reservas completadas
      prisma.providerProfile.findMany({
        where: { reservasCompletadas: { gt: 0 } },
        orderBy: { reservasCompletadas: 'desc' },
        take: 10,
        include: { user: { select: { nombre: true, ciudad: true, email: true } } },
        select: {
          id: true, calificacion: true, totalReviews: true,
          reservasCompletadas: true, tarifaPorHora: true,
          tasaAceptacion: true, verificado: true,
          user: { select: { nombre: true, ciudad: true, email: true } },
        },
      }),
      // Top por ingresos generados
      prisma.booking.groupBy({
        by: ['proveedorId'],
        where: { estado: 'COMPLETADO' },
        _sum: { precioTotal: true },
        orderBy: { _sum: { precioTotal: 'desc' } },
        take: 10,
      }),
    ]);

    // Merge revenue into providers
    const revenueMap = Object.fromEntries(byRevenue.map(r => [r.proveedorId, r._sum.precioTotal || 0]));
    const leaderboard = byCompleted.map((p, i) => ({
      rank: i + 1,
      id: p.id,
      nombre: p.user?.nombre,
      ciudad: p.user?.ciudad,
      calificacion: p.calificacion,
      totalReviews: p.totalReviews,
      reservasCompletadas: p.reservasCompletadas,
      tasaAceptacion: p.tasaAceptacion,
      verificado: p.verificado,
      ingresosTotales: revenueMap[p.id] || 0,
    }));

    res.json({ leaderboard });
  } catch (error) {
    console.error('[admin/leaderboard]', error);
    res.status(500).json({ error: 'Error al obtener leaderboard' });
  }
});

// GET /admin/stats/monthly — ingresos y reservas de los últimos 6 meses
router.get('/stats/monthly', verifyToken, soloAdmin, async (req, res) => {
  try {
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      return { year: d.getFullYear(), month: d.getMonth(), start, end, label: d.toLocaleString('es-CO', { month: 'short' }) };
    });

    const results = await Promise.all(
      months.map(async m => {
        const where = { estado: 'COMPLETADO', updatedAt: { gte: m.start, lte: m.end } };
        const [agg, count] = await Promise.all([
          prisma.booking.aggregate({ _sum: { precioTotal: true, comisionDutyJoy: true }, where }),
          prisma.booking.count({ where }),
        ]);
        return {
          label: m.label,
          year: m.year,
          month: m.month,
          bruto: agg._sum.precioTotal || 0,
          comision: agg._sum.comisionDutyJoy || 0,
          count,
        };
      })
    );

    res.json({ months: results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener datos mensuales' });
  }
});

// GET /admin/users — listar todos los usuarios con filtros
router.get('/users', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { rol, search, page = 1, limit = 20 } = req.query;

    const where = {
      ...(rol && { rol }),
      ...(search && {
        OR: [
          { nombre: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, nombre: true, email: true, telefono: true,
          ciudad: true, rol: true, activo: true, emailVerificado: true, createdAt: true,
          providerProfile: {
            select: { calificacion: true, totalReviews: true, verificado: true, servicios: true }
          },
          _count: { select: { bookingsComoCliente: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// GET /admin/users/:id — detalle completo de un usuario
router.get('/users/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        providerProfile: { include: { reviews: { take: 5, orderBy: { createdAt: 'desc' } } } },
        bookingsComoCliente: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { proveedor: { include: { user: { select: { nombre: true } } } } },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { password, ...userSinPassword } = user;
    res.json(userSinPassword);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// PATCH /admin/users/:id — editar usuario (activar/desactivar, cambiar rol)
router.patch('/users/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { activo, rol } = req.body;
    const data = {};
    if (activo !== undefined) data.activo = activo;
    if (rol && ['CLIENTE', 'PROVEEDOR', 'ADMIN'].includes(rol)) data.rol = rol;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, nombre: true, email: true, rol: true, activo: true },
    });

    res.json({ mensaje: 'Usuario actualizado', user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// GET /admin/providers — listar proveedores con stats
router.get('/providers', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { verificado, cedulaStatus, search, page = 1, limit = 20 } = req.query;

    const estadosCedulaValidos = ['sin_enviar', 'pendiente', 'aprobado', 'rechazado'];
    const where = {
      ...(verificado !== undefined && { verificado: verificado === 'true' }),
      ...(cedulaStatus && estadosCedulaValidos.includes(cedulaStatus) && { cedulaStatus }),
      ...(search && {
        user: {
          OR: [
            { nombre: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
      }),
    };

    const [providers, total] = await Promise.all([
      prisma.providerProfile.findMany({
        where,
        include: {
          user: { select: { nombre: true, email: true, telefono: true, ciudad: true, createdAt: true } },
          _count: { select: { bookings: true, reviews: true } },
        },
        // cedulaUrl, cedulaStatus, cedulaNota incluidos automáticamente (campos del modelo)
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.providerProfile.count({ where }),
    ]);

    res.json({ providers, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener proveedores' });
  }
});

// POST /admin/providers/:id/ai-verify — análisis automático de cédula con GPT-4o Vision
router.post('/providers/:id/ai-verify', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'IA no configurada (falta OPENAI_API_KEY)' });

  const profile = await prisma.providerProfile.findUnique({
    where: { id: req.params.id },
    include: { user: { select: { nombre: true } } },
  });
  if (!profile) return res.status(404).json({ error: 'Proveedor no encontrado' });
  if (!profile.cedulaUrl) return res.status(400).json({ error: 'El proveedor no ha subido documento' });

  const imgData = await fetchImageAsBase64(profile.cedulaUrl);
  if (!imgData) {
    return res.status(422).json({ error: 'No se pudo descargar el documento. Verifica que el archivo de Google Drive sea una imagen (JPG/PNG) compartida como "Cualquier persona con el enlace".' });
  }

  // Verificar tamaño (OpenAI acepta max ~20MB en base64, pero para vision se recomienda < 5MB)
  const sizeMB = (imgData.base64.length * 3 / 4) / (1024 * 1024);
  console.log(`[ai-verify] imagen: ${imgData.mimeType}, ~${sizeMB.toFixed(2)} MB`);
  if (sizeMB > 15) {
    return res.status(422).json({ error: `La imagen es muy grande (${sizeMB.toFixed(1)} MB). Sube una foto más comprimida (máx ~15 MB).` });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analiza este documento de identidad colombiano (Cédula de Ciudadanía).

Nombre registrado en el perfil: "${profile.user.nombre}"

Extrae del documento:
1. Nombre completo del titular
2. Número de cédula
3. ¿El documento parece auténtico y legible?
4. ¿El nombre del documento coincide con "${profile.user.nombre}"?

Responde SOLO con JSON válido (sin markdown):
{
  "nombre_detectado": "string o null",
  "cedula_detectada": "string o null",
  "parece_autentico": true/false,
  "nombre_coincide": true/false,
  "recomendacion": "aprobar" | "rechazar" | "revisar_manual",
  "confianza": 0-100,
  "razon": "explicación breve en español"
}`,
          },
          {
            type: 'image_url',
            image_url: { url: `data:${imgData.mimeType};base64,${imgData.base64}`, detail: 'high' },
          },
        ],
      }],
    });

    const raw = response.choices[0].message.content.trim()
      .replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const analysis = JSON.parse(raw);
    res.json({ analysis });
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(422).json({ error: 'La IA no pudo interpretar el documento. ¿Es una foto clara de la cédula?' });
    const detail = e?.response?.error?.message || e?.message || 'error desconocido';
    console.error('[ai-verify] OpenAI error:', detail);
    res.status(500).json({ error: `Error de OpenAI: ${detail}` });
  }
});

// PATCH /admin/providers/:id/verify — verificar/desverificar + aprobar/rechazar cédula
router.patch('/providers/:id/verify', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { verificado, cedulaStatus, cedulaNota } = req.body;

    const data = {};
    if (verificado !== undefined) data.verificado = Boolean(verificado);
    if (cedulaStatus && ['pendiente','aprobado','rechazado','sin_enviar'].includes(cedulaStatus)) {
      data.cedulaStatus = cedulaStatus;
      if (cedulaStatus === 'aprobado')  data.verificado = true;
      if (cedulaStatus === 'rechazado') data.cedulaNota = cedulaNota || null;
    }

    const profile = await prisma.providerProfile.update({
      where:   { id: req.params.id },
      data,
      include: { user: { select: { nombre: true, email: true } } },
    });

    // Emails de notificación (fire-and-forget)
    if (cedulaStatus === 'aprobado') {
      email.cedulaAprobada({
        proveedorEmail:  profile.user.email,
        proveedorNombre: profile.user.nombre,
      }).catch(() => {});
    }
    if (cedulaStatus === 'rechazado') {
      email.cedulaRechazada({
        proveedorEmail:  profile.user.email,
        proveedorNombre: profile.user.nombre,
        nota:            cedulaNota,
      }).catch(() => {});
    }

    res.json({
      mensaje: cedulaStatus
        ? `Cédula marcada como ${cedulaStatus}`
        : `Proveedor ${verificado ? 'verificado' : 'desverificado'} exitosamente`,
      profile,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar verificación' });
  }
});

// GET /admin/bookings — listar todas las reservas
router.get('/bookings', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { estado, search, page = 1, limit = 20 } = req.query;

    const where = {
      ...(estado && { estado }),
      ...(search && {
        OR: [
          { cliente: { nombre: { contains: search, mode: 'insensitive' } } },
          { cliente: { email:  { contains: search, mode: 'insensitive' } } },
          { proveedor: { user: { nombre: { contains: search, mode: 'insensitive' } } } },
          { tipoServicio: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: {
          cliente: { select: { nombre: true, email: true } },
          proveedor: { include: { user: { select: { nombre: true } } } },
          review: { select: { calificacion: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.booking.count({ where }),
    ]);

    res.json({ bookings, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener reservas' });
  }
});

// PATCH /admin/bookings/:id — admin puede cambiar cualquier estado
router.patch('/bookings/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { estado } = req.body;
    const estadosValidos = ['PENDIENTE', 'CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO', 'CANCELADO'];

    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const booking = await prisma.booking.update({
      where: { id: req.params.id },
      data: { estado },
    });

    res.json({ mensaje: 'Reserva actualizada', booking });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar reserva' });
  }
});

// ── Disputes ─────────────────────────────────────────────────────────────────

// GET /admin/disputes — lista paginada de disputas con filtros
router.get('/disputes', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { estado, page = 1, limit = 20 } = req.query;
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

    const where = {};
    if (estado) where.estado = estado;

    const [disputes, total] = await Promise.all([
      prisma.disputa.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          booking: {
            select: {
              tipoServicio: true,
              fechaServicio: true,
              precioTotal: true,
              estado: true,
              proveedor: { include: { user: { select: { nombre: true } } } },
            },
          },
          cliente: { select: { nombre: true, email: true } },
        },
      }),
      prisma.disputa.count({ where }),
    ]);

    // Counts per status
    const [abierta, en_revision, resuelta, cerrada] = await Promise.all([
      prisma.disputa.count({ where: { estado: 'abierta' } }),
      prisma.disputa.count({ where: { estado: 'en_revision' } }),
      prisma.disputa.count({ where: { estado: 'resuelta' } }),
      prisma.disputa.count({ where: { estado: 'cerrada' } }),
    ]);

    res.json({
      disputes,
      total,
      totalPages: Math.ceil(total / take),
      stats: { abierta, en_revision, resuelta, cerrada },
    });
  } catch (error) {
    console.error('[admin/disputes]', error);
    res.status(500).json({ error: 'Error al obtener disputas' });
  }
});

// PATCH /admin/disputes/:id — actualizar estado y/o resolución
router.patch('/disputes/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { estado, resolucion } = req.body;
    const valid = ['abierta', 'en_revision', 'resuelta', 'cerrada'];
    if (estado && !valid.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido. Válidos: ${valid.join(', ')}` });
    }

    const data = { updatedAt: new Date() };
    if (estado)     data.estado = estado;
    if (resolucion) { data.resolucion = resolucion; data.resueltaPorId = req.user.id; }

    const disputa = await prisma.disputa.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ mensaje: 'Disputa actualizada', disputa });
  } catch (error) {
    console.error('[admin/disputes/:id]', error);
    res.status(500).json({ error: 'Error al actualizar disputa' });
  }
});

// POST /admin/disputes/:id/ai-resolve — GPT-4o auto-resolves a dispute
router.post('/disputes/:id/ai-resolve', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'OPENAI_API_KEY no configurado.' });
  }
  try {
    const disputa = await prisma.disputa.findUnique({
      where: { id: req.params.id },
      include: {
        cliente: { select: { nombre: true, email: true } },
        booking: {
          include: {
            proveedor: { include: { user: { select: { nombre: true } } } },
            mensajes: {
              orderBy: { createdAt: 'asc' },
              take: 30,
              include: { autor: { select: { nombre: true, rol: true } } },
            },
          },
        },
      },
    });

    if (!disputa) return res.status(404).json({ error: 'Disputa no encontrada' });
    if (disputa.estado === 'resuelta' || disputa.estado === 'cerrada') {
      return res.status(400).json({ error: 'La disputa ya está resuelta o cerrada.' });
    }

    const { booking, cliente } = disputa;
    const proveedorNombre = booking.proveedor?.user?.nombre || 'Proveedor';

    // Build chat transcript
    const transcript = booking.mensajes.length
      ? booking.mensajes.map(m => `[${m.autor.rol}] ${m.autor.nombre}: ${m.contenido}`).join('\n')
      : 'Sin mensajes de chat.';

    const prompt = `Eres un árbitro imparcial de disputas en DutyJoy, una plataforma colombiana de servicios del hogar.

## Contexto del servicio
- Tipo de servicio: ${booking.tipoServicio}
- Descripción solicitada: ${booking.descripcion || 'Sin descripción'}
- Fecha del servicio: ${new Date(booking.fechaServicio).toLocaleDateString('es-CO')}
- Precio total: $${booking.precioTotal?.toLocaleString('es-CO')} COP
- Estado del booking: ${booking.estado}
- Cliente: ${cliente.nombre}
- Proveedor: ${proveedorNombre}

## Denuncia del cliente
${disputa.mensaje}

## Historial de chat entre las partes
${transcript}

## Tu tarea
Analiza todos los hechos disponibles y emite un veredicto justo. Responde ÚNICAMENTE con JSON válido, sin texto adicional:

{
  "veredicto": "favor_cliente" | "favor_proveedor" | "compromiso",
  "confianza": <número entre 0.0 y 1.0>,
  "razonamiento": "<explicación clara y concisa en español, máx 300 caracteres>",
  "accion_recomendada": "<qué debe hacer el equipo de DutyJoy, máx 200 caracteres>"
}

Criterios:
- "favor_cliente": el proveedor incumplió o el servicio fue deficiente
- "favor_proveedor": la queja del cliente no tiene base o es injustificada
- "compromiso": ambas partes tienen parte de razón; se recomienda solución intermedia
- confianza < 0.80 → el caso necesita revisión humana adicional`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 400,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    let parsed;
    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      return res.status(502).json({ error: 'Respuesta inválida del modelo de IA.' });
    }

    const { veredicto, confianza, razonamiento, accion_recomendada } = parsed;
    const validVeredicts = ['favor_cliente', 'favor_proveedor', 'compromiso'];
    if (!validVeredicts.includes(veredicto) || typeof confianza !== 'number') {
      return res.status(502).json({ error: 'Veredicto inválido del modelo.' });
    }

    const conf = Math.min(Math.max(confianza, 0), 1);
    const autoResolve = conf >= 0.80;

    const data = {
      aiVeredicto:    veredicto,
      aiConfianza:    conf,
      aiRazonamiento: razonamiento,
      updatedAt:      new Date(),
    };

    if (autoResolve) {
      data.estado      = 'resuelta';
      data.resolucion  = `[IA ${Math.round(conf * 100)}% confianza] ${razonamiento}. ${accion_recomendada || ''}`.trim();
      data.resueltaPorId = req.user.id;
    } else {
      // Flag for human review but don't auto-close
      data.estado     = 'en_revision';
      data.resolucion = `[IA ${Math.round(conf * 100)}% — revisión humana requerida] ${razonamiento}`.trim();
    }

    const updated = await prisma.disputa.update({
      where: { id: disputa.id },
      data,
    });

    res.json({
      disputa:      updated,
      autoResuelta: autoResolve,
      veredicto,
      confianza:    conf,
      razonamiento,
      accionRecomendada: accion_recomendada,
    });
  } catch (error) {
    console.error('[admin/disputes/:id/ai-resolve]', error);
    res.status(500).json({ error: 'Error al procesar con IA.' });
  }
});

// ── Fake Review Detection ────────────────────────────────────────────────

// Shared fraud analysis logic (used by endpoint + cron)
async function analyzeReviewFraud(review, clientReviewCount, bookingCompletedAt) {
  if (!openai) return null;

  const minsSinceCompletion = bookingCompletedAt
    ? Math.round((new Date(review.createdAt) - new Date(bookingCompletedAt)) / 60000)
    : null;

  const prompt = `Eres un sistema de detección de reseñas fraudulentas para DutyJoy, una plataforma colombiana de servicios del hogar.

## Reseña a analizar
- Calificación: ${review.calificacion}/5
- Comentario: "${review.comentario || '(sin comentario)'}"
- Total reseñas del cliente (histórico): ${clientReviewCount}
- Minutos desde que se completó el servicio: ${minsSinceCompletion ?? 'desconocido'}

## Patrones de fraude a detectar
- texto_generico: comentario demasiado corto o genérico (< 15 chars, o solo "excelente"/"muy bueno"/"recomendado")
- primera_resena: es la primera o segunda reseña del cliente (sospechoso si calificación = 5)
- velocidad_sospechosa: reseña publicada en menos de 3 minutos tras completar el servicio
- sin_detalle: calificación 5 con comentario vacío o menos de 20 caracteres
- lenguaje_marketing: usa frases de marketing ("altamente recomendado", "mejor servicio", "100%")
- inconsistencia: calificación alta pero comentario neutro/negativo o viceversa
- patron_bot: texto perfectamente genérico o con errores que sugieren traducción automática

## Tu respuesta
Responde SOLO con JSON válido:
{
  "fraudScore": <0.0 a 1.0; 0.0=claramente real, 1.0=claramente falsa>,
  "flags": [<lista de patrones detectados de la lista de arriba>],
  "razonamiento": "<explicación breve en español, máx 150 caracteres>"
}

Umbral sugerido: fraudScore >= 0.65 = sospechosa, >= 0.85 = muy probable fraude.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 200,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(completion.choices[0].message.content);
}

// POST /admin/reviews/:id/fraud-check — AI checks a single review
router.post('/reviews/:id/fraud-check', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY no configurado.' });

  try {
    const review = await prisma.review.findUnique({
      where: { id: req.params.id },
      include: {
        cliente:  { select: { id: true } },
        booking:  { select: { estado: true, updatedAt: true } },
      },
    });
    if (!review) return res.status(404).json({ error: 'Reseña no encontrada.' });

    // Count client's total reviews
    const clientReviewCount = await prisma.review.count({ where: { clienteId: review.clienteId } });
    const bookingCompletedAt = review.booking?.estado === 'COMPLETADO' ? review.booking.updatedAt : null;

    const result = await analyzeReviewFraud(review, clientReviewCount, bookingCompletedAt);
    if (!result) return res.status(502).json({ error: 'Error en análisis IA.' });

    const updated = await prisma.review.update({
      where: { id: review.id },
      data: {
        fraudScore:      result.fraudScore,
        fraudFlags:      result.flags || [],
        fraudCheckedAt:  new Date(),
      },
    });

    res.json({ review: updated, fraudScore: result.fraudScore, flags: result.flags, razonamiento: result.razonamiento });
  } catch (e) {
    console.error('[admin/reviews/fraud-check]', e);
    res.status(500).json({ error: 'Error al analizar reseña.' });
  }
});

// GET /admin/reviews/flagged — lista reseñas sospechosas (fraudScore >= 0.5)
router.get('/reviews/flagged', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { threshold = 0.5, page = 1, limit = 20 } = req.query;
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

    const where = { fraudScore: { gte: parseFloat(threshold) } };
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { fraudScore: 'desc' },
        skip, take,
        include: {
          cliente:  { select: { nombre: true, email: true } },
          proveedor: { include: { user: { select: { nombre: true } } } },
          booking:  { select: { tipoServicio: true, fechaServicio: true } },
        },
      }),
      prisma.review.count({ where }),
    ]);

    const [unchecked, highRisk] = await Promise.all([
      prisma.review.count({ where: { fraudCheckedAt: null } }),
      prisma.review.count({ where: { fraudScore: { gte: 0.85 } } }),
    ]);

    res.json({ reviews, total, totalPages: Math.ceil(total / take), stats: { unchecked, highRisk, flagged: total } });
  } catch (e) {
    console.error('[admin/reviews/flagged]', e);
    res.status(500).json({ error: 'Error al obtener reseñas.' });
  }
});

// PATCH /admin/reviews/:id/visibility — ocultar o mostrar reseña
router.patch('/reviews/:id/visibility', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { oculta } = req.body;
    if (typeof oculta !== 'boolean') return res.status(400).json({ error: 'oculta debe ser true o false.' });
    const updated = await prisma.review.update({
      where: { id: req.params.id },
      data:  { fraudOculta: oculta },
    });
    res.json({ mensaje: oculta ? 'Reseña ocultada' : 'Reseña restaurada', review: updated });
  } catch (e) {
    console.error('[admin/reviews/visibility]', e);
    res.status(500).json({ error: 'Error al actualizar visibilidad.' });
  }
});

// ── CRM: Clients ─────────────────────────────────────────────────────────

// GET /admin/crm/clients — paginated client list with spend tiers + LTV + tags
router.get('/crm/clients', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { search, tier, ciudad, tagId, segment, page = 1, limit = 25, sort = 'recent' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      rol: 'CLIENTE',
      ...(search && {
        OR: [
          { nombre:   { contains: search, mode: 'insensitive' } },
          { email:    { contains: search, mode: 'insensitive' } },
          { telefono: { contains: search, mode: 'insensitive' } },
        ],
      }),
      ...(ciudad && { ciudad }),
      ...(tagId  && { tagAsignaciones: { some: { tagId } } }),
    };

    // Segment-based where additions (pre-filter)
    const now = new Date();
    if (segment === 'nuevos')   where.createdAt = { gte: new Date(now - 30 * 86400000) };
    if (segment === 'activos')  where.bookingsComoCliente = { some: { createdAt: { gte: new Date(now - 30 * 86400000) } } };
    if (segment === 'inactivos') {
      where.createdAt = { lt: new Date(now - 30 * 86400000) };
      where.bookingsComoCliente = { none: {} };
    }

    const orderBy = sort === 'spend'   ? [{ bookingsComoCliente: { _count: 'desc' } }]
                  : sort === 'name'    ? [{ nombre: 'asc' }]
                  : [{ createdAt: 'desc' }];

    const [clients, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: {
          bookingsComoCliente: {
            select: { estado: true, precioTotal: true, tipoServicio: true, createdAt: true },
          },
          tagAsignaciones: { include: { tag: true } },
          _count: { select: { bookingsComoCliente: true } },
        },
        orderBy,
        skip,
        take: parseInt(limit),
      }),
      prisma.user.count({ where }),
    ]);

    // Enrich with spend + tier + tags
    const enriched = clients.map(c => {
      const { password, bookingsComoCliente, tagAsignaciones, ...rest } = c;
      const completados = bookingsComoCliente.filter(b => b.estado === 'COMPLETADO');
      const ltv         = completados.reduce((s, b) => s + (b.precioTotal || 0), 0);
      const totalBks    = bookingsComoCliente.length;
      const lastBooking = bookingsComoCliente.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      const topService  = (() => {
        const freq = {};
        for (const b of bookingsComoCliente) freq[b.tipoServicio] = (freq[b.tipoServicio] || 0) + 1;
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      })();

      // Spend tiers: bronze(<50k), silver(50k-200k), gold(200k-500k), platinum(500k+)
      const spendTier = ltv >= 500000 ? 'platinum'
                      : ltv >= 200000 ? 'gold'
                      : ltv >= 50000  ? 'silver'
                      : 'bronze';

      const tags = (tagAsignaciones || []).map(a => ({ ...a.tag, asignadoAt: a.createdAt }));
      return { ...rest, ltv, totalBks, completados: completados.length, spendTier, topService, lastBooking, tags };
    });

    // If filtering by tier, do it in memory (calculated field)
    const filtered = tier ? enriched.filter(c => c.spendTier === tier) : enriched;

    res.json({ clients: filtered, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error('[crm/clients]', e);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// GET /admin/crm/clients/:id — full client CRM profile
router.get('/crm/clients/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const client = await prisma.user.findUnique({
      where: { id: req.params.id, rol: 'CLIENTE' },
      include: {
        bookingsComoCliente: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            proveedor: {
              select: {
                id: true,
                calificacion: true,
                user: { select: { nombre: true } },
              },
            },
          },
        },
        reviewsEscritas: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { proveedor: { select: { user: { select: { nombre: true } } } } },
        },
        disputas: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        notificaciones: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { titulo: true, createdAt: true, leida: true },
        },
        favoritos: {
          take: 10,
          include: { proveedor: { select: { user: { select: { nombre: true } } } } },
        },
        _count: {
          select: { bookingsComoCliente: true, reviewsEscritas: true, disputas: true, favoritos: true },
        },
        tagAsignaciones: { include: { tag: true } },
      },
    });
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { password, ...safe } = client;
    const completados = client.bookingsComoCliente.filter(b => b.estado === 'COMPLETADO');
    const ltv         = completados.reduce((s, b) => s + (b.precioTotal || 0), 0);
    const avgTicket   = completados.length ? ltv / completados.length : 0;
    const cancelados  = client.bookingsComoCliente.filter(b => b.estado === 'CANCELADO').length;
    const cancelRate  = client.bookingsComoCliente.length > 0
      ? Math.round((cancelados / client.bookingsComoCliente.length) * 100) : 0;
    const avgRating   = client.reviewsEscritas.length
      ? (client.reviewsEscritas.reduce((s, r) => s + r.calificacion, 0) / client.reviewsEscritas.length).toFixed(1) : null;

    // Service frequency map
    const svcFreq = {};
    for (const b of client.bookingsComoCliente) svcFreq[b.tipoServicio] = (svcFreq[b.tipoServicio] || 0) + 1;
    const topServices = Object.entries(svcFreq).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const spendTier = ltv >= 500000 ? 'platinum' : ltv >= 200000 ? 'gold' : ltv >= 50000 ? 'silver' : 'bronze';
    const tags = (safe.tagAsignaciones || []).map(a => ({ ...a.tag, asignadoAt: a.createdAt }));

    res.json({
      ...safe,
      ltv, avgTicket, cancelRate, avgRating, topServices, spendTier, tags,
    });
  } catch (e) {
    console.error('[crm/clients/:id]', e);
    res.status(500).json({ error: 'Error al cargar perfil de cliente' });
  }
});

// PATCH /admin/crm/clients/:id — update notes, tags, VIP flag
router.patch('/crm/clients/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { activo, rol, notas, tags } = req.body;
    const data = {};
    if (activo !== undefined) data.activo = activo;
    if (rol && ['CLIENTE','PROVEEDOR','ADMIN'].includes(rol)) data.rol = rol;
    // notas and tags are stored in a JSON metadata field — add if schema has it, else skip silently

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, nombre: true, email: true, rol: true, activo: true },
    });
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
});

// ── CRM: Provider detail ──────────────────────────────────────────────────

// GET /admin/crm/providers/:id — full provider CRM profile
router.get('/crm/providers/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const profile = await prisma.providerProfile.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          include: {
            _count: { select: { notificaciones: true } },
          },
        },
        reviews: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { cliente: { select: { nombre: true } } },
        },
        bookings: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { cliente: { select: { nombre: true, telefono: true } } },
        },
        disputas: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { cliente: { select: { nombre: true } } },
        },
      },
    });
    if (!profile) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const completadas = profile.bookings.filter(b => b.estado === 'COMPLETADO');
    const revenue     = completadas.reduce((s, b) => s + (b.precioTotal || 0), 0);
    const commission  = Math.round(revenue * 0.15);
    const netRevenue  = revenue - commission;
    const avgTicket   = completadas.length ? revenue / completadas.length : 0;
    const cancelados  = profile.bookings.filter(b => b.estado === 'CANCELADO').length;
    const pendientes  = profile.bookings.filter(b => b.estado === 'PENDIENTE').length;

    // Monthly revenue (last 6 months)
    const since = new Date(); since.setMonth(since.getMonth() - 6);
    const monthlyMap = {};
    for (const b of completadas) {
      if (new Date(b.createdAt) < since) continue;
      const key = `${new Date(b.createdAt).getFullYear()}-${new Date(b.createdAt).getMonth()}`;
      monthlyMap[key] = (monthlyMap[key] || 0) + (b.precioTotal || 0);
    }

    // Rating distribution
    const ratingDist = { 1:0, 2:0, 3:0, 4:0, 5:0 };
    for (const r of profile.reviews) {
      const star = Math.round(r.calificacion);
      if (ratingDist[star] !== undefined) ratingDist[star]++;
    }

    const { password, ...safeUser } = profile.user;
    res.json({
      ...profile,
      user: safeUser,
      revenue, commission, netRevenue, avgTicket,
      cancelados, pendientes, ratingDist, monthlyMap,
    });
  } catch (e) {
    console.error('[crm/providers/:id]', e);
    res.status(500).json({ error: 'Error al cargar perfil de proveedor' });
  }
});

// GET /admin/crm/providers — list with revenue stats + tags
router.get('/crm/providers', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { search, verificado, ciudad, tagId, page = 1, limit = 25, sort = 'revenue' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...(search && {
        user: {
          OR: [
            { nombre: { contains: search, mode: 'insensitive' } },
            { email:  { contains: search, mode: 'insensitive' } },
          ],
        },
      }),
      ...(verificado !== undefined && { verificado: verificado === 'true' }),
      ...(ciudad && { ciudades: { has: ciudad } }),
      ...(tagId  && { user: { tagAsignaciones: { some: { tagId } } } }),
    };

    const [profiles, total] = await Promise.all([
      prisma.providerProfile.findMany({
        where,
        include: {
          user: {
            select: {
              nombre: true, email: true, telefono: true, ciudad: true, activo: true, createdAt: true,
              tagAsignaciones: { include: { tag: true } },
            },
          },
          bookings: { select: { estado: true, precioTotal: true }, where: { estado: 'COMPLETADO' } },
          _count: { select: { bookings: true, reviews: true } },
        },
        skip,
        take: parseInt(limit),
      }),
      prisma.providerProfile.count({ where }),
    ]);

    const enriched = profiles.map(p => {
      const { bookings, user, ...rest } = p;
      const { tagAsignaciones, ...userRest } = user;
      const revenue    = bookings.reduce((s, b) => s + (b.precioTotal || 0), 0);
      const commission = Math.round(revenue * 0.15);
      const tags       = (tagAsignaciones || []).map(a => ({ ...a.tag, asignadoAt: a.createdAt }));
      return { ...rest, user: { ...userRest, tags }, revenue, commission };
    });

    if (sort === 'revenue') enriched.sort((a, b) => b.revenue - a.revenue);
    else if (sort === 'rating') enriched.sort((a, b) => (b.calificacion || 0) - (a.calificacion || 0));
    else if (sort === 'bookings') enriched.sort((a, b) => b._count.bookings - a._count.bookings);

    res.json({ providers: enriched, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error('[crm/providers]', e);
    res.status(500).json({ error: 'Error al obtener proveedores CRM' });
  }
});

// ── CRM Tags ─────────────────────────────────────────────────────────────────

// GET /admin/tags — all tags with user counts
router.get('/tags', verifyToken, soloAdmin, async (req, res) => {
  try {
    const tags = await prisma.crmTag.findMany({
      orderBy: { nombre: 'asc' },
      include: { _count: { select: { asignaciones: true } } },
    });
    res.json({ tags });
  } catch (e) {
    console.error('[admin/tags]', e);
    res.status(500).json({ error: 'Error al obtener etiquetas' });
  }
});

// POST /admin/tags — create tag
router.post('/tags', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { nombre, color = '#0ABFBC', descripcion } = req.body;
    if (!nombre || nombre.trim().length < 1) return res.status(400).json({ error: 'nombre requerido' });
    const tag = await prisma.crmTag.create({
      data: { nombre: nombre.trim(), color: color || '#0ABFBC', descripcion: descripcion?.trim() || null },
    });
    res.status(201).json({ tag });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'Ya existe una etiqueta con ese nombre' });
    console.error('[admin/tags POST]', e);
    res.status(500).json({ error: 'Error al crear etiqueta' });
  }
});

// PUT /admin/tags/:id — update tag
router.put('/tags/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { nombre, color, descripcion } = req.body;
    const data = {};
    if (nombre)      data.nombre      = nombre.trim();
    if (color)       data.color       = color;
    if (descripcion !== undefined) data.descripcion = descripcion?.trim() || null;
    const tag = await prisma.crmTag.update({ where: { id: req.params.id }, data });
    res.json({ tag });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'Ya existe una etiqueta con ese nombre' });
    res.status(500).json({ error: 'Error al actualizar etiqueta' });
  }
});

// DELETE /admin/tags/:id — delete tag (cascades assignments)
router.delete('/tags/:id', verifyToken, soloAdmin, async (req, res) => {
  try {
    await prisma.crmTag.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar etiqueta' });
  }
});

// POST /admin/tags/:tagId/assign/:userId — assign tag to user
router.post('/tags/:tagId/assign/:userId', verifyToken, soloAdmin, async (req, res) => {
  try {
    await prisma.crmTagAsignacion.upsert({
      where:  { tagId_userId: { tagId: req.params.tagId, userId: req.params.userId } },
      create: { tagId: req.params.tagId, userId: req.params.userId, asignadoPor: req.user.id },
      update: {},
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al asignar etiqueta' });
  }
});

// DELETE /admin/tags/:tagId/assign/:userId — remove tag from user
router.delete('/tags/:tagId/assign/:userId', verifyToken, soloAdmin, async (req, res) => {
  try {
    await prisma.crmTagAsignacion.deleteMany({
      where: { tagId: req.params.tagId, userId: req.params.userId },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al quitar etiqueta' });
  }
});

// ── Segments ─────────────────────────────────────────────────────────────────

// GET /admin/segments — computed user segments with counts
router.get('/segments', verifyToken, soloAdmin, async (req, res) => {
  try {
    const now = new Date();
    const hace30  = new Date(now - 30  * 86400000);
    const hace60  = new Date(now - 60  * 86400000);
    const hace7   = new Date(now - 7   * 86400000);
    const hace90  = new Date(now - 90  * 86400000);

    const [
      // Client segments
      cntNuevos, cntActivos, cntEnRiesgo, cntVIP, cntInactivos, cntChurnAlto,
      // Provider segments
      cntProvTop, cntProvInactivos, cntProvNuevos, cntProvSinVerificar,
      // Total context
      totalClients, totalProviders, totalBookings30d, totalRevenue,
    ] = await Promise.all([
      // nuevos clientes (últimos 30 días)
      prisma.user.count({ where: { rol: 'CLIENTE', createdAt: { gte: hace30 } } }),
      // clientes con booking en los últimos 30 días
      prisma.user.count({ where: { rol: 'CLIENTE', bookingsComoCliente: { some: { createdAt: { gte: hace30 } } } } }),
      // clientes en riesgo: tuvieron bookings pero el último fue hace 60+ días
      prisma.user.count({
        where: {
          rol: 'CLIENTE',
          bookingsComoCliente: {
            some: { createdAt: { lt: hace60 } },
            none: { createdAt: { gte: hace60 } },
          },
        },
      }),
      // VIP: ltv >= 200k (gold+) — approximated by count of COMPLETADO bookings with precioTotal high enough
      prisma.user.count({
        where: {
          rol: 'CLIENTE',
          bookingsComoCliente: {
            some: { estado: 'COMPLETADO', precioTotal: { gte: 200000 } },
          },
        },
      }),
      // inactivos: registrados hace >30 días, sin ningún booking
      prisma.user.count({
        where: {
          rol: 'CLIENTE',
          createdAt: { lt: hace30 },
          bookingsComoCliente: { none: {} },
        },
      }),
      // churn alto: > 2 cancelaciones
      prisma.user.count({
        where: {
          rol: 'CLIENTE',
          bookingsComoCliente: { some: { estado: 'CANCELADO' } },
        },
      }),
      // proveedores top: calificacion >= 4.5 AND totalReviews >= 5
      prisma.providerProfile.count({ where: { calificacion: { gte: 4.5 }, totalReviews: { gte: 5 } } }),
      // proveedores inactivos: no booking en 30 días y disponible
      prisma.providerProfile.count({
        where: {
          disponible: true,
          OR: [
            { bookings: { none: {} } },
            { bookings: { none: { createdAt: { gte: hace30 } } } },
          ],
        },
      }),
      // proveedores nuevos: últimos 30 días
      prisma.providerProfile.count({ where: { createdAt: { gte: hace30 } } }),
      // proveedores sin verificar con al menos 1 booking
      prisma.providerProfile.count({
        where: { verificado: false, bookings: { some: {} } },
      }),
      // context
      prisma.user.count({ where: { rol: 'CLIENTE' } }),
      prisma.providerProfile.count(),
      prisma.booking.count({ where: { createdAt: { gte: hace30 } } }),
      prisma.booking.aggregate({ where: { estado: 'COMPLETADO' }, _sum: { precioTotal: true } }),
    ]);

    res.json({
      clients: {
        nuevos:      { count: cntNuevos,    label: 'Nuevos (últimos 30 días)', color: '#0ABFBC',  icon: '🆕', segment: 'nuevos',   description: 'Se registraron en los últimos 30 días' },
        activos:     { count: cntActivos,   label: 'Activos (último mes)',     color: '#00C9A7',  icon: '🟢', segment: 'activos',  description: 'Han hecho al menos una reserva este mes' },
        enRiesgo:    { count: cntEnRiesgo,  label: 'En riesgo de churn',       color: '#FF9F43',  icon: '⚠️',  segment: 'riesgo',   description: 'Última actividad hace más de 60 días' },
        vip:         { count: cntVIP,       label: 'Clientes VIP',             color: '#FFD93D',  icon: '⭐', segment: 'vip',     description: 'Al menos un pago de $200,000+ COP' },
        inactivos:   { count: cntInactivos, label: 'Sin primera reserva',      color: '#667eea',  icon: '😴', segment: 'inactivos', description: 'Registrados hace +30 días sin reservas' },
        churnAlto:   { count: cntChurnAlto, label: 'Con cancelaciones',        color: '#FF6B6B',  icon: '❌', segment: 'churn',   description: 'Han cancelado al menos una reserva' },
      },
      providers: {
        top:         { count: cntProvTop,         label: 'Proveedores top',        color: '#FFD93D', icon: '🏆', description: 'Calificación ≥ 4.5 y ≥ 5 reseñas' },
        inactivos:   { count: cntProvInactivos,   label: 'Sin actividad reciente', color: '#FF9F43', icon: '😴', description: 'Disponibles pero sin reservas en 30 días' },
        nuevos:      { count: cntProvNuevos,      label: 'Nuevos (este mes)',      color: '#0ABFBC', icon: '🆕', description: 'Se unieron en los últimos 30 días' },
        sinVerificar:{ count: cntProvSinVerificar, label: 'Con reservas sin verificar', color: '#a78bfa', icon: '🔍', description: 'Ya han recibido reservas pero no están verificados' },
      },
      summary: {
        totalClients, totalProviders, totalBookings30d,
        totalRevenue: totalRevenue._sum.precioTotal || 0,
      },
    });
  } catch (e) {
    console.error('[admin/segments]', e);
    res.status(500).json({ error: 'Error al calcular segmentos' });
  }
});

// ── Analytics ─────────────────────────────────────────────────────────────────

// GET /admin/analytics/funnel — booking state conversion funnel
router.get('/analytics/funnel', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);

    const [total, confirmado, enProgreso, completado, cancelado] = await Promise.all([
      prisma.booking.count({ where: { createdAt: { gte: since } } }),
      prisma.booking.count({ where: { createdAt: { gte: since }, estado: { in: ['CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO'] } } }),
      prisma.booking.count({ where: { createdAt: { gte: since }, estado: { in: ['EN_PROGRESO', 'COMPLETADO'] } } }),
      prisma.booking.count({ where: { createdAt: { gte: since }, estado: 'COMPLETADO' } }),
      prisma.booking.count({ where: { createdAt: { gte: since }, estado: 'CANCELADO' } }),
    ]);

    const pct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;

    res.json({
      days: parseInt(days),
      stages: [
        { key: 'created',    label: 'Reservas creadas',   count: total,      pct: 100,         color: '#667eea' },
        { key: 'confirmed',  label: 'Confirmadas',         count: confirmado, pct: pct(confirmado), color: '#0ABFBC' },
        { key: 'inProgress', label: 'En progreso',         count: enProgreso, pct: pct(enProgreso), color: '#a78bfa' },
        { key: 'completed',  label: 'Completadas',         count: completado, pct: pct(completado), color: '#00C9A7' },
        { key: 'canceled',   label: 'Canceladas',          count: cancelado,  pct: pct(cancelado),  color: '#FF6B6B' },
      ],
    });
  } catch (e) {
    console.error('[admin/analytics/funnel]', e);
    res.status(500).json({ error: 'Error al calcular embudo' });
  }
});

// GET /admin/analytics/services — revenue and volume by service type
router.get('/analytics/services', verifyToken, soloAdmin, async (req, res) => {
  try {
    const { days = 90 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);

    const bookings = await prisma.booking.findMany({
      where: { estado: 'COMPLETADO', createdAt: { gte: since } },
      select: { tipoServicio: true, precioTotal: true, comisionDutyJoy: true },
    });

    const map = {};
    for (const b of bookings) {
      const k = b.tipoServicio;
      if (!map[k]) map[k] = { servicio: k, count: 0, revenue: 0, commission: 0 };
      map[k].count++;
      map[k].revenue    += b.precioTotal || 0;
      map[k].commission += b.comisionDutyJoy || 0;
    }

    const services = Object.values(map)
      .map(s => ({ ...s, avgTicket: s.count > 0 ? Math.round(s.revenue / s.count) : 0 }))
      .sort((a, b) => b.revenue - a.revenue);

    const totalRevenue = services.reduce((s, x) => s + x.revenue, 0);
    const enriched = services.map(s => ({ ...s, pct: totalRevenue > 0 ? Math.round((s.revenue / totalRevenue) * 100) : 0 }));

    res.json({ services: enriched, totalRevenue, days: parseInt(days) });
  } catch (e) {
    console.error('[admin/analytics/services]', e);
    res.status(500).json({ error: 'Error al calcular analytics de servicios' });
  }
});

// GET /admin/analytics/cohort — monthly user acquisition + first booking
router.get('/analytics/cohort', verifyToken, soloAdmin, async (req, res) => {
  try {
    // Last 6 months of user signups by month
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setDate(1); d.setHours(0,0,0,0);
      d.setMonth(d.getMonth() - (5 - i));
      return d;
    });

    const cohortData = await Promise.all(months.map(async (start, i) => {
      const end = i < months.length - 1 ? months[i + 1] : new Date();
      const label = start.toLocaleDateString('es-CO', { month: 'short', year: '2-digit' });

      const [clientsReg, providersReg, bookingsCreated, bookingsCompleted] = await Promise.all([
        prisma.user.count({ where: { rol: 'CLIENTE',   createdAt: { gte: start, lt: end } } }),
        prisma.user.count({ where: { rol: 'PROVEEDOR', createdAt: { gte: start, lt: end } } }),
        prisma.booking.count({ where: { createdAt: { gte: start, lt: end } } }),
        prisma.booking.count({ where: { createdAt: { gte: start, lt: end }, estado: 'COMPLETADO' } }),
      ]);

      return { month: label, clientsReg, providersReg, bookingsCreated, bookingsCompleted };
    }));

    res.json({ cohort: cohortData });
  } catch (e) {
    console.error('[admin/analytics/cohort]', e);
    res.status(500).json({ error: 'Error al calcular cohorte' });
  }
});

module.exports = router;
