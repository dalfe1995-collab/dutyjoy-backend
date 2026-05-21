const router      = require('express').Router();
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');
const { sendPush } = require('../lib/push');
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/* ── Contact-info detection ─────────────────────────────────────────────────
   Detects Colombian phone numbers, WhatsApp links, emails, Telegram, etc.
   When found: message is saved normally PLUS a system warning is inserted.
   This protects the platform's commission and both parties' guarantees.
────────────────────────────────────────────────────────────────────────── */
const CONTACT_PATTERNS = [
  /\b3\d{2}[\s\-.]?\d{3}[\s\-.]?\d{4}\b/,            // Colombian mobile 3XX XXX XXXX
  /\+57[\s\-.]?3\d{9}/,                               // +57 3XXXXXXXXX intl
  /\b60\d[\s\-.]?\d{7}\b/,                            // Colombian landline
  /(?:https?:\/\/)?(?:wa\.me|whatsapp\.me)\//i,       // WhatsApp links
  /\bwsp\b|\bwhats\s*app\b/i,                         // "wsp" / "whatsapp" mentions
  /(?:https?:\/\/)?t\.me\//i,                         // Telegram
  /(?:https?:\/\/)?instagram\.com\//i,                // Instagram
  /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/, // Email
];

const WARN_MSG = `⚠️ *DutyJoy:* Detectamos información de contacto externo en tu mensaje.

Toda la comunicación y los pagos deben realizarse dentro de la plataforma. Ventajas de quedarte en DutyJoy:
• ✅ Pagos seguros con MercadoPago
• 🛡️ Sistema de disputas si algo sale mal
• 📋 Historial oficial del servicio
• 💪 Garantía sobre la reserva

Las transacciones fuera de la plataforma no están cubiertas por nuestras garantías ni nuestro mecanismo de resolución de conflictos (Ley 1480/2011).`;

function hasContactInfo(text) {
  return CONTACT_PATTERNS.some(p => p.test(text));
}

/* ── Guard ─────────────────────────────────────────────────────────────── */
async function getBookingOrFail(bookingId, userId, res) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { proveedor: { select: { userId: true } } },
  });
  if (!booking) { res.status(404).json({ error: 'Reserva no encontrada' }); return null; }
  const isCliente   = booking.clienteId === userId;
  const isProveedor = booking.proveedor.userId === userId;
  if (!isCliente && !isProveedor) {
    res.status(403).json({ error: 'No tienes acceso a este chat' }); return null;
  }
  return booking;
}

/* ── GET /messages/:bookingId ────────────────────────────────────────────── */
router.get('/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;

    const mensajes = await prisma.mensajeChat.findMany({
      where: { bookingId: req.params.bookingId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    await prisma.mensajeChat.updateMany({
      where: { bookingId: req.params.bookingId, autorId: { not: req.user.id }, leido: false },
      data: { leido: true },
    });

    res.json(mensajes);
  } catch (e) {
    console.error('[messages GET]', e);
    res.status(500).json({ error: 'Error al cargar mensajes' });
  }
});

/* ── GET /messages/:bookingId/unread ─────────────────────────────────────── */
router.get('/:bookingId/unread', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;
    const count = await prisma.mensajeChat.count({
      where: { bookingId: req.params.bookingId, autorId: { not: req.user.id }, leido: false },
    });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

/* ── GET /messages/unread/all ────────────────────────────────────────────── */
router.get('/unread/all', verifyToken, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        OR: [{ clienteId: req.user.id }, { proveedor: { userId: req.user.id } }],
        estado: { not: 'CANCELADO' },
      },
      select: { id: true },
    });
    const bookingIds = bookings.map(b => b.id);
    if (bookingIds.length === 0) return res.json({ count: 0 });
    const count = await prisma.mensajeChat.count({
      where: { bookingId: { in: bookingIds }, autorId: { not: req.user.id }, leido: false },
    });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

/* ── POST /messages/:bookingId ───────────────────────────────────────────── */
router.post('/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;

    if (['CANCELADO', 'COMPLETADO'].includes(booking.estado)) {
      return res.status(400).json({ error: 'No se pueden enviar mensajes en reservas canceladas o completadas' });
    }

    const { contenido, tipo = 'texto' } = req.body;
    if (!contenido || typeof contenido !== 'string' || !contenido.trim()) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }

    if (tipo === 'imagen') {
      if (contenido.length > 800_000) {
        return res.status(400).json({ error: 'La imagen es demasiado grande. Máximo 600KB.' });
      }
    } else if (contenido.trim().length > 2000) {
      return res.status(400).json({ error: 'El mensaje no puede superar 2000 caracteres' });
    }

    const allowedTypes = ['texto', 'imagen', 'pago_solicitado'];
    const msgTipo = allowedTypes.includes(tipo) ? tipo : 'texto';

    const mensaje = await prisma.mensajeChat.create({
      data: {
        bookingId: req.params.bookingId,
        autorId:   req.user.id,
        contenido: tipo === 'imagen' ? contenido : contenido.trim(),
        tipo:      msgTipo,
      },
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    // ── Contact-info guard ──
    const contactDetected = msgTipo === 'texto' && hasContactInfo(contenido);
    let warnMsg = null;
    if (contactDetected) {
      warnMsg = await prisma.mensajeChat.create({
        data: {
          bookingId: req.params.bookingId,
          autorId:   req.user.id,
          contenido: WARN_MSG,
          tipo:      'sistema',
        },
        include: { autor: { select: { id: true, nombre: true, rol: true } } },
      });
    }

    // Notify recipient
    const recipientId = booking.clienteId === req.user.id
      ? booking.proveedor.userId
      : booking.clienteId;

    const previewText = msgTipo === 'imagen' ? '📷 Imagen' : contenido.trim().substring(0, 80);
    const notifMsg = `${req.user.nombre}: "${previewText}${contenido.trim().length > 80 ? '…' : ''}"`;
    await Promise.allSettled([
      prisma.notificacion.create({
        data: {
          userId:  recipientId,
          tipo:    'mensaje_nuevo',
          titulo:  '💬 Nuevo mensaje',
          mensaje: notifMsg,
          data:    { bookingId: booking.id, autorId: req.user.id },
        },
      }),
      sendPush(recipientId, {
        title: '💬 Nuevo mensaje',
        body:  notifMsg,
        url:   `/booking-chat/${booking.id}`,
        tag:   `chat-${booking.id}`,
      }),
    ]);

    res.status(201).json({ mensaje, warnMsg, contactDetected });
  } catch (e) {
    console.error('[messages POST]', e);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

/* ── POST /messages/:bookingId/request-payment ───────────────────────────── */
router.post('/:bookingId/request-payment', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden solicitar pagos' });
    }
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;
    if (!['CONFIRMADO', 'EN_PROGRESO', 'COMPLETADO'].includes(booking.estado)) {
      return res.status(400).json({ error: 'Estado de reserva no permite solicitar pago' });
    }

    const mensaje = await prisma.mensajeChat.create({
      data: {
        bookingId: req.params.bookingId,
        autorId:   req.user.id,
        contenido: JSON.stringify({
          monto:     booking.precioTotal,
          bookingId: booking.id,
          servicio:  booking.tipoServicio,
        }),
        tipo: 'pago_solicitado',
      },
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    await prisma.notificacion.create({
      data: {
        userId:  booking.clienteId,
        tipo:    'pago_recibido',
        titulo:  '💳 Solicitud de pago',
        mensaje: `${req.user.nombre} solicita el pago de $${(booking.precioTotal || 0).toLocaleString('es-CO')}`,
        data:    { bookingId: booking.id },
      },
    }).catch(() => {});

    res.status(201).json(mensaje);
  } catch (e) {
    console.error('[messages payment-request]', e);
    res.status(500).json({ error: 'Error al enviar solicitud de pago' });
  }
});

/* ── Typing indicators (in-memory, ephemeral) ────────────────────────────── */
const typingStore = new Map();

router.get('/:bookingId/typing', verifyToken, async (req, res) => {
  try {
    await getBookingOrFail(req.params.bookingId, req.user.id, res);
    const entry  = typingStore.get(req.params.bookingId);
    const typing = entry && entry.userId !== req.user.id && Date.now() - entry.ts < 4000;
    res.json({ typing: !!typing });
  } catch { res.json({ typing: false }); }
});

router.post('/:bookingId/typing', verifyToken, async (req, res) => {
  try {
    if (req.body.typing) {
      typingStore.set(req.params.bookingId, { userId: req.user.id, ts: Date.now() });
    } else {
      const entry = typingStore.get(req.params.bookingId);
      if (entry?.userId === req.user.id) typingStore.delete(req.params.bookingId);
    }
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

/* ── DELETE /messages/:bookingId/:msgId ──────────────────────────────────── */
router.delete('/:bookingId/:msgId', verifyToken, async (req, res) => {
  try {
    const booking = await getBookingOrFail(req.params.bookingId, req.user.id, res);
    if (!booking) return;
    const msg = await prisma.mensajeChat.findUnique({ where: { id: req.params.msgId } });
    if (!msg || msg.bookingId !== req.params.bookingId) {
      return res.status(404).json({ error: 'Mensaje no encontrado' });
    }
    if (msg.autorId !== req.user.id) {
      return res.status(403).json({ error: 'Solo puedes eliminar tus propios mensajes' });
    }
    if (Date.now() - new Date(msg.createdAt).getTime() > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Solo puedes eliminar mensajes dentro de los primeros 5 minutos' });
    }
    await prisma.mensajeChat.delete({ where: { id: req.params.msgId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar mensaje' }); }
});

/* ── POST /messages/:bookingId/ai-suggestions ───────────────────────────────
   Returns 3 context-aware smart reply suggestions for the current user's role.
   Analyzes recent conversation + booking details.
────────────────────────────────────────────────────────────────────────── */
router.post('/:bookingId/ai-suggestions', verifyToken, async (req, res) => {
  if (!openai) return res.json({ suggestions: [] });
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      select: {
        tipoServicio: true, estado: true, fechaServicio: true,
        precioTotal: true, descripcion: true,
        cliente:   { select: { nombre: true, id: true } },
        proveedor: { include: { user: { select: { nombre: true, id: true } } } },
      },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });

    // Last 6 messages for context
    const msgs = await prisma.mensajeChat.findMany({
      where: { bookingId: req.params.bookingId },
      include: { autor: { select: { nombre: true, rol: true } } },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });

    const isProveedor  = req.user?.rol === 'PROVEEDOR';
    const rol          = isProveedor ? 'PROVEEDOR' : 'CLIENTE';
    const horasHastaServicio = (new Date(booking.fechaServicio) - Date.now()) / 3_600_000;
    const conversation = msgs.reverse().map(m => `${m.autor.nombre} (${m.autor.rol}): ${m.contenido}`).join('\n');

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: `Eres el asistente de chat de DutyJoy Colombia (marketplace servicios del hogar).
Sugiere 3 respuestas cortas y naturales para el ${rol} en esta conversación de servicio.

SERVICIO: ${booking.tipoServicio} | Estado: ${booking.estado} | En: ${horasHastaServicio > 0 ? Math.round(horasHastaServicio) + 'h' : 'ya pasó'}
Descripción: ${booking.descripcion || 'sin descripción'}
${conversation ? `\nCONVERSACIÓN RECIENTE:\n${conversation}` : '\n(Sin mensajes aún)'}

ROL DEL USUARIO: ${rol}

Devuelve JSON: { "suggestions": ["sugerencia 1", "sugerencia 2", "sugerencia 3"] }
Máximo 60 caracteres por sugerencia. En español colombiano natural. Apropiadas para el contexto actual.`,
      }],
    });
    const data = JSON.parse(r.choices[0].message.content);
    res.json({ suggestions: data.suggestions || [] });
  } catch { res.json({ suggestions: [] }); }
});

/* ── GET /messages/:bookingId/checklist ─────────────────────────────────────
   Returns a service preparation checklist for provider/client based on service type.
────────────────────────────────────────────────────────────────────────── */
const CHECKLISTS = {
  proveedor: {
    limpieza:     ['🧹 Escoba y trapero','🪣 Balde y trapero húmedo','🧴 Jabón multiusos y desengrasante','🧽 Esponjas y estropajos','🧻 Papel absorbente','💧 Agua para mezclas','🪟 Limpiador de vidrios','🗑️ Bolsas de basura','🧤 Guantes de protección','👕 Ropa de trabajo'],
    plomeria:     ['🔧 Llave de tubo y ajustable','🔩 Juego de destornilladores','⚙️ Teflón y sellante de tuberías','🪣 Balde para derrames','💡 Linterna','📐 Cinta métrica','🔴 Tornillos y tuercas variados','🧰 Caja de herramientas completa'],
    electricidad: ['⚡ Probador de voltaje / multímetro','🔌 Cinta aislante','🔦 Linterna','🔩 Destornilladores aislados','🔧 Pelacables','⚡ Breakers de repuesto (varios amperajes)','📐 Nivel','🧤 Guantes aislantes','⚠️ Conos de señalización'],
    pintura:      ['🖌️ Rodillos y brochas variados','🪣 Bandejas para pintura','🎨 Pintura (según acordado)','📦 Plástico protector','🪜 Escalera','🧹 Espátula para masilla','📦 Masilla y lija','🧤 Guantes','😷 Mascarilla','👓 Gafas protectoras'],
    jardineria:   ['✂️ Tijeras de poda y podadora','🪚 Sierra para ramas gruesas','🌱 Abono (si acordado)','🧤 Guantes de jardín','🪣 Regadera','🍂 Bolsas para desechos vegetales','🔨 Pala y rastrillo','💧 Manguera (verificar disponibilidad cliente)'],
    carpinteria:  ['🔨 Martillo y clavos variados','🪚 Sierra manual/eléctrica','📐 Escuadra y nivel','✏️ Lápiz para trazos','🔩 Tornillos y tarugos','🔧 Taladro con brocas','🪜 Escalera','🧤 Guantes','😷 Mascarilla para polvo'],
    cerrajeria:   ['🔑 Juego de llaves maestras','🔧 Destornilladores','🏠 Cerraduras de repuesto variadas','📐 Cinta métrica','💡 Linterna','🔩 Tornillos','🪛 Llave hexagonal'],
    mudanzas:     ['📦 Cajas de cartón variadas','🎁 Plástico burbuja y papel periódico','🔧 Cinta de embalaje','🪛 Herramientas básicas para desmontar muebles','🧤 Guantes','🦺 Faja lumbar','📋 Lista de inventario'],
    aires:        ['🔧 Llave de tubo y destornilladores','🧹 Cepillo para limpieza de filtros','💧 Agua y trapos limpios','📊 Manómetro de presión','🔌 Multímetro','🧤 Guantes','📦 Repuestos comunes (filtros, capacitores)'],
    fumigacion:   ['🧪 Productos de fumigación certificados','💦 Bomba fumigadora','😷 Mascarilla certificada','👓 Gafas protectoras','🦺 Traje de protección','🧤 Guantes gruesos','⚠️ Señales de área fumigada'],
    default:      ['🔧 Herramientas básicas','🧤 Guantes de protección','📋 Anota los detalles del trabajo','💡 Linterna','📱 Teléfono con carga completa'],
  },
  cliente: {
    limpieza:     ['🚗 Asegúrate de estar en casa o dejar acceso','🗑️ Retira objetos valiosos de superficies','🐾 Aísla mascotas durante la limpieza','💧 Deja acceso a agua y electricidad','🗝️ Ten las llaves listas'],
    plomeria:     ['🚰 Cierra la llave general del agua','🗑️ Despeja el área de trabajo','💧 Ten toallas y baldes disponibles','🗝️ Muéstrale el registro de agua','📍 Señala exactamente el problema'],
    electricidad: ['⚡ Ubica el tablero eléctrico','🔌 Muéstrale qué circuitos están fallando','💡 Ten linternas por si cortan la luz','🗑️ Despeja el área de trabajo','⚠️ Avisa a la familia que puede haber cortes'],
    pintura:      ['🛋️ Mueve muebles del área a pintar','🎨 Ten decidido el color','🖼️ Retira cuadros y decoraciones','💧 Ventila bien el espacio','🗑️ Protege el piso con plástico si el proveedor no trae'],
    default:      ['🗝️ Ten las llaves listas','📍 Comparte la dirección exacta','💧 Deja acceso a agua y luz','📱 Mantén el teléfono activo','🐾 Aísla mascotas si tienes'],
  },
};

router.get('/:bookingId/checklist', verifyToken, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      select: { tipoServicio: true, estado: true },
    });
    if (!booking) return res.status(404).json({ error: 'No encontrado' });

    const svc       = (booking.tipoServicio || '').toLowerCase().replace(/[^a-záéíóúñ]/gi, '');
    const isProveedor = req.user?.rol === 'PROVEEDOR';

    const items = isProveedor
      ? {
          proveedor: CHECKLISTS.proveedor[svc] || CHECKLISTS.proveedor.default,
          cliente:   CHECKLISTS.cliente[svc]   || CHECKLISTS.cliente.default,
        }
      : { cliente: CHECKLISTS.cliente[svc] || CHECKLISTS.cliente.default };

    const SVC_ICONS = { limpieza:'🧹', plomeria:'🔧', electricidad:'⚡', pintura:'🖌️', jardineria:'🌱', carpinteria:'🔨', cerrajeria:'🔑', mudanzas:'📦', aires:'❄️', fumigacion:'🪲' };
    const icon = SVC_ICONS[svc] || '🛠️';

    res.json({ items, tipoServicio: booking.tipoServicio, rol: req.user?.rol, icon, titulo: `Checklist: ${booking.tipoServicio}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
