/**
 * cs.routes.js — AI-powered Customer Service
 * Reply generation · Sentiment · Triage · Copilot · CSAT prediction · Customer insights
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

const ai = (prompt, { model = 'gpt-4o', max_tokens = 1600, json = true, temp = 0.5 } = {}) => {
  if (!openai) return Promise.reject(new Error('OPENAI_API_KEY no configurado'));
  return openai.chat.completions.create({
    model, max_tokens, temperature: temp,
    ...(json && { response_format: { type: 'json_object' } }),
    messages: [{ role: 'user', content: prompt }],
  }).then(r => json ? JSON.parse(r.choices[0].message.content) : r.choices[0].message.content);
};

const aiChat = (messages, { model = 'gpt-4o', max_tokens = 1200, temp = 0.6 } = {}) => {
  if (!openai) return Promise.reject(new Error('OPENAI_API_KEY no configurado'));
  return openai.chat.completions.create({ model, max_tokens, temperature: temp, messages })
    .then(r => r.choices[0].message.content);
};

// ══════════════════════════════════════════════════════════════
//  AI: GENERATE REPLY
//  POST /cs/ai/reply
//  Drafts a personalized, empathetic response in Spanish for a CS ticket.
// ══════════════════════════════════════════════════════════════
router.post('/ai/reply', verifyToken, soloAdmin, async (req, res) => {
  const { ticketId, subject, type, priority, cliente, bookingId, agentName, context } = req.body;
  try {
    // Try to get booking context from DB
    let bookingContext = '';
    if (bookingId) {
      try {
        const booking = await prisma.booking.findFirst({
          where: { id: bookingId },
          select: {
            estado: true, fechaServicio: true, total: true,
            servicio: { select: { titulo: true } },
            proveedor: { select: { usuario: { select: { nombre: true } } } },
          },
        });
        if (booking) {
          bookingContext = `Reserva: servicio="${booking.servicio?.titulo}", proveedor="${booking.proveedor?.usuario?.nombre}", estado="${booking.estado}", fecha="${booking.fechaServicio?.toLocaleDateString('es-CO')}", valor=$${booking.total?.toLocaleString('es-CO')} COP`;
        }
      } catch {}
    }

    const result = await ai(
      `Eres un agente de soporte de DutyJoy (marketplace de servicios del hogar en Colombia).
Escribe una respuesta profesional, empática y soluciona-problemas en español colombiano para este ticket de soporte.

TICKET:
- Asunto: ${subject}
- Tipo: ${type}
- Prioridad: ${priority}
- Cliente: ${cliente}
- ${bookingContext || 'Sin reserva asociada'}
- Contexto adicional: ${context || 'ninguno'}
- Agente que responde: ${agentName || 'Equipo DutyJoy'}

Responde con JSON:
{
  "draft": "texto completo de la respuesta lista para enviar",
  "tono": "uno de: empático, formal, urgente, amigable",
  "puntos_clave": ["punto 1", "punto 2"],
  "accion_sugerida": "qué debería hacer el agente además de enviar esta respuesta",
  "tiempo_estimado_resolucion": "estimado ej: 24-48 horas",
  "riesgo_escalacion": "bajo|medio|alto"
}`,
      { model: 'gpt-4o', max_tokens: 1200 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: SUMMARIZE TICKET
//  POST /cs/ai/summary
// ══════════════════════════════════════════════════════════════
router.post('/ai/summary', verifyToken, soloAdmin, async (req, res) => {
  const { subject, type, priority, cliente, messages, status, createdAt } = req.body;
  try {
    const age = createdAt ? Math.round((Date.now() - new Date(createdAt)) / 3600000) : 0;
    const result = await ai(
      `Resume este ticket de soporte de DutyJoy para un agente que acaba de tomarlo.

DATOS:
- Asunto: ${subject}
- Tipo: ${type} | Prioridad: ${priority} | Estado: ${status}
- Cliente: ${cliente}
- Antigüedad: ${age}h
- Mensajes/contexto: ${messages || 'sin detalle disponible'}

Devuelve JSON:
{
  "resumen_ejecutivo": "2-3 oraciones del problema central",
  "cronologia": ["evento 1", "evento 2"],
  "problema_raiz": "qué causó el problema",
  "acciones_tomadas": ["acción 1"],
  "siguiente_paso": "qué debe hacer el agente ahora mismo",
  "riesgos": ["riesgo 1"],
  "sentimiento_cliente": "frustrado|neutral|enojado|satisfecho|urgente",
  "probabilidad_escalacion": 0.0
}`,
      { max_tokens: 1000 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: SENTIMENT ANALYSIS
//  POST /cs/ai/sentiment
// ══════════════════════════════════════════════════════════════
router.post('/ai/sentiment', verifyToken, soloAdmin, async (req, res) => {
  const { text, subject, type } = req.body;
  try {
    const result = await ai(
      `Analiza el sentimiento de este mensaje de un cliente de DutyJoy Colombia.

Asunto del ticket: ${subject}
Tipo: ${type}
Mensaje: "${text || subject}"

Devuelve JSON:
{
  "sentimiento": "positivo|neutral|negativo|muy_negativo|urgente",
  "score": -1.0,
  "emocion_dominante": "frustración|enojo|confusión|urgencia|satisfacción|miedo|neutral",
  "urgencia": 0,
  "intencion_abandono": false,
  "intencion_legal": false,
  "palabras_clave_negativas": [],
  "palabras_clave_positivas": [],
  "recomendacion_tono_respuesta": "texto breve sobre cómo responder",
  "prioridad_sugerida": "BAJA|MEDIA|ALTA|URGENTE"
}

score va de -1 (muy negativo) a +1 (positivo).
urgencia va de 0 (ninguna) a 10 (crítica).`,
      { model: 'gpt-4o-mini', max_tokens: 600 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: AUTO-CLASSIFY TICKET
//  POST /cs/ai/classify
// ══════════════════════════════════════════════════════════════
router.post('/ai/classify', verifyToken, soloAdmin, async (req, res) => {
  const { subject, message } = req.body;
  const TIPOS = ['DISPUTA', 'REEMBOLSO', 'QUEJA', 'CONSULTA', 'TECNICO', 'FRAUDE', 'OTRO'];
  const PRIORIDADES = ['BAJA', 'MEDIA', 'ALTA', 'URGENTE'];
  try {
    const result = await ai(
      `Clasifica este ticket de soporte de DutyJoy (marketplace de servicios del hogar, Colombia).

Asunto: "${subject}"
Mensaje: "${message || subject}"

Tipos válidos: ${TIPOS.join(', ')}
Prioridades válidas: ${PRIORIDADES.join(', ')}

Devuelve JSON:
{
  "tipo": "uno de los tipos válidos",
  "prioridad": "una de las prioridades válidas",
  "confianza": 0.0,
  "razon": "por qué esta clasificación",
  "tags": ["etiqueta1"],
  "requiere_escalacion_inmediata": false,
  "departamento_sugerido": "soporte|legal|tecnico|finanzas|compliance",
  "tiempo_respuesta_objetivo_horas": 24
}`,
      { model: 'gpt-4o-mini', max_tokens: 500 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: CSAT PREDICTION
//  POST /cs/ai/csat-predict
// ══════════════════════════════════════════════════════════════
router.post('/ai/csat-predict', verifyToken, soloAdmin, async (req, res) => {
  const { subject, type, priority, status, agentResolutionTime, replyCount, hadEscalation, sentiment } = req.body;
  try {
    const result = await ai(
      `Predice el CSAT que dará el cliente en este ticket de soporte (escala 1-5).

DATOS DEL TICKET:
- Asunto: ${subject}
- Tipo: ${type} | Prioridad: ${priority} | Estado actual: ${status}
- Tiempo de resolución: ${agentResolutionTime || 'N/A'} horas
- Cantidad de respuestas: ${replyCount || 1}
- ¿Hubo escalación? ${hadEscalation ? 'Sí' : 'No'}
- Sentimiento detectado: ${sentiment || 'neutral'}

Devuelve JSON:
{
  "csat_predicho": 3.5,
  "confianza": 0.75,
  "factores_positivos": ["factor 1"],
  "factores_negativos": ["factor 1"],
  "riesgo_resena_negativa": false,
  "acciones_para_mejorar_csat": ["acción 1", "acción 2"],
  "probabilidad_churn": 0.0
}

csat_predicho va de 1 a 5.
probabilidad_churn va de 0 a 1.`,
      { model: 'gpt-4o-mini', max_tokens: 700 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: BULK TRIAGE
//  POST /cs/ai/triage
//  Analyzes multiple open tickets and returns a priority ranked list.
// ══════════════════════════════════════════════════════════════
router.post('/ai/triage', verifyToken, soloAdmin, async (req, res) => {
  const { tickets } = req.body; // array of {id, subject, type, priority, status, createdAt, assignedTo}
  if (!tickets?.length) return res.status(400).json({ error: 'tickets requerido' });
  try {
    const result = await ai(
      `Eres el sistema de triage de DutyJoy CS. Analiza estos ${tickets.length} tickets abiertos y devuelve un ranking priorizado.

TICKETS:
${tickets.map((t, i) => `${i + 1}. [${t.id}] ${t.subject} | tipo=${t.type} | prioridad=${t.priority} | antigüedad=${Math.round((Date.now() - new Date(t.createdAt)) / 3600000)}h | asignado=${t.assignedTo || 'nadie'}`).join('\n')}

Devuelve JSON con esta estructura exacta:
{
  "ranking": [
    {
      "id": "TKT-xxx",
      "urgencia_score": 85,
      "razon_urgencia": "texto breve",
      "accion_inmediata": "qué hacer primero",
      "riesgo": "bajo|medio|alto|critico",
      "asignacion_recomendada": "perfil del agente ideal"
    }
  ],
  "alertas_criticas": ["alerta si algo requiere acción inmediata"],
  "patron_detectado": "qué patrón ve la IA en estos tickets",
  "resumen_situacion": "estado general de la cola",
  "tickets_en_riesgo_sla": ["TKT-xxx"],
  "recomendaciones_equipo": ["recomendación operativa 1"]
}

urgencia_score: 0-100 (100 = acción inmediata requerida).`,
      { model: 'gpt-4o', max_tokens: 2500 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: CUSTOMER INSIGHTS
//  POST /cs/ai/insights
// ══════════════════════════════════════════════════════════════
router.post('/ai/insights', verifyToken, soloAdmin, async (req, res) => {
  const { email, nombre, ticketCount, ticketTypes, avgCsat, totalBookings } = req.body;
  try {
    // Try to get real data from DB
    let dbData = {};
    if (email) {
      try {
        const user = await prisma.user.findFirst({
          where: { email },
          select: {
            nombre: true, createdAt: true, rol: true,
            bookings: {
              select: { estado: true, total: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
              take: 20,
            },
          },
        });
        if (user) {
          dbData = {
            nombre: user.nombre,
            miembroDesde: user.createdAt,
            totalReservas: user.bookings.length,
            valorTotal: user.bookings.reduce((s, b) => s + (b.total || 0), 0),
            reservasCompletadas: user.bookings.filter(b => b.estado === 'COMPLETADO').length,
            ultimaReserva: user.bookings[0]?.createdAt,
          };
        }
      } catch {}
    }

    const result = await ai(
      `Genera un perfil de insights de este cliente de DutyJoy Colombia.

DATOS DISPONIBLES:
- Nombre: ${dbData.nombre || nombre || 'desconocido'}
- Email: ${email || 'N/A'}
- Miembro desde: ${dbData.miembroDesde ? new Date(dbData.miembroDesde).toLocaleDateString('es-CO') : 'desconocido'}
- Total reservas: ${dbData.totalReservas ?? totalBookings ?? 0}
- Reservas completadas: ${dbData.reservasCompletadas ?? 0}
- Valor total gastado: $${(dbData.valorTotal || 0).toLocaleString('es-CO')} COP
- Tickets de soporte: ${ticketCount || 0}
- Tipos de tickets: ${(ticketTypes || []).join(', ') || 'N/A'}
- CSAT promedio dado: ${avgCsat || 'N/A'}

Devuelve JSON:
{
  "segmento": "VIP|regular|en_riesgo|nuevo|inactivo",
  "lifetime_value_estimado": 0,
  "nps_estimado": 0,
  "riesgo_churn": "bajo|medio|alto",
  "probabilidad_churn": 0.0,
  "patron_problemas": "texto sobre qué tipo de problemas tiene",
  "recomendacion_trato": "cómo debe tratarlo el agente",
  "beneficios_sugeridos": ["beneficio que podría retenerlo"],
  "siguiente_mejor_accion": "qué hacer con este cliente ahora",
  "perfil_resumen": "2-3 oraciones del perfil del cliente",
  "alertas": ["alerta si algo preocupa"]
}`,
      { model: 'gpt-4o', max_tokens: 1000 }
    );
    res.json({ ...result, dbData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: CS COPILOT (chat)
//  POST /cs/ai/copilot
// ══════════════════════════════════════════════════════════════
router.post('/ai/copilot', verifyToken, soloAdmin, async (req, res) => {
  const { message, ticketContext, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });

  const systemPrompt = `Eres el CS Copilot de DutyJoy — asistente experto para agentes de soporte al cliente.

DutyJoy es un marketplace de servicios del hogar en Colombia. Operamos con MercadoPago, tenemos proveedores verificados con KYC, política de reembolsos según tiempo transcurrido desde el servicio, SLA de 4h para URGENTE, 24h ALTA, 48h MEDIA, 72h BAJA.

${ticketContext ? `CONTEXTO DEL TICKET ACTIVO:\n${ticketContext}` : ''}

Ayudas a los agentes con:
- Redactar respuestas empáticas y profesionales
- Manejar disputas difíciles
- Navegar políticas de reembolso y cancelación
- Gestionar clientes frustrados o enojados
- Escalar correctamente según el tipo de problema
- Cumplir con HABEAS DATA y normativa colombiana

Responde en español colombiano, de forma concisa y accionable. Eres directo y útil.`;

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];
    const response = await aiChat(messages, { model: 'gpt-4o', max_tokens: 1200, temp: 0.7 });
    res.json({ response });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: ESCALATION CHECK
//  POST /cs/ai/escalation-check
// ══════════════════════════════════════════════════════════════
router.post('/ai/escalation-check', verifyToken, soloAdmin, async (req, res) => {
  const { subject, type, priority, status, age_hours, history_text } = req.body;
  try {
    const result = await ai(
      `Evalúa si este ticket de DutyJoy debe ser escalado inmediatamente.

TICKET:
- Asunto: ${subject}
- Tipo: ${type} | Prioridad actual: ${priority} | Estado: ${status}
- Antigüedad: ${age_hours}h
- Historial: ${history_text || 'no disponible'}

Devuelve JSON:
{
  "debe_escalar": true,
  "urgencia_escalar": "inmediata|pronto|puede_esperar|no_necesario",
  "nivel_escalar": "supervisor|legal|ceo|tecnico|compliance|ninguno",
  "razon": "por qué escalar o no",
  "riesgos_si_no_escala": ["riesgo 1"],
  "acciones_previas_antes_escalar": ["hacer esto antes de escalar"],
  "template_mensaje_escalacion": "texto sugerido para notificar al supervisor"
}`,
      { model: 'gpt-4o-mini', max_tokens: 800 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AI: KNOWLEDGE BASE SEMANTIC SEARCH
//  POST /cs/ai/kb-search
// ══════════════════════════════════════════════════════════════
router.post('/ai/kb-search', verifyToken, soloAdmin, async (req, res) => {
  const { query, ticketType } = req.body;
  if (!query) return res.status(400).json({ error: 'query requerido' });
  try {
    const KB_ARTICLES = [
      { id:'KB-001', titulo:'Cómo procesar un reembolso por servicio no completado', categoria:'Reembolsos' },
      { id:'KB-002', titulo:'Proveedor no se presentó — protocolo de emergencia',    categoria:'No Show' },
      { id:'KB-003', titulo:'Cómo escalar un caso a nivel legal',                    categoria:'Legal' },
      { id:'KB-004', titulo:'Responder solicitudes de HABEAS DATA correctamente',    categoria:'Privacidad' },
      { id:'KB-005', titulo:'Gestión de disputas entre cliente y proveedor',         categoria:'Disputas' },
      { id:'KB-006', titulo:'Proceso de verificación KYC para nuevos proveedores',  categoria:'KYC' },
      { id:'KB-007', titulo:'Política de cancelaciones y penalizaciones',           categoria:'Políticas' },
      { id:'KB-008', titulo:'Cómo manejar quejas sobre calidad del servicio',       categoria:'Calidad' },
    ];

    const result = await ai(
      `Eres el motor de búsqueda semántica de la base de conocimiento de DutyJoy CS.

BÚSQUEDA: "${query}"
TIPO DE TICKET: ${ticketType || 'general'}

ARTÍCULOS DISPONIBLES:
${KB_ARTICLES.map(a => `- ${a.id}: ${a.titulo} [${a.categoria}]`).join('\n')}

Devuelve JSON:
{
  "articulos_relevantes": [
    { "id": "KB-xxx", "relevancia": 0.95, "razon": "por qué es relevante" }
  ],
  "respuesta_directa": "si puedes responder la pregunta directamente hazlo aquí",
  "gaps_conocimiento": "si la respuesta no está en la KB, qué falta",
  "sugerencia_nuevo_articulo": "título de artículo que debería crearse si hay gap"
}

Ordena por relevancia descendente.`,
      { model: 'gpt-4o-mini', max_tokens: 700 }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
