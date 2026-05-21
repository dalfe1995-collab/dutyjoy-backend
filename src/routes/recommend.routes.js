/**
 * recommend.routes.js — AI-powered personalized recommendations
 * Provider recommendations based on booking history + preferences
 */
const router      = require('express').Router();
const OpenAI      = require('openai');
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const ai = (prompt, { max_tokens = 1200, temp = 0.4 } = {}) => {
  if (!openai) return Promise.reject(new Error('OPENAI_API_KEY no configurado'));
  return openai.chat.completions.create({
    model: 'gpt-4o', max_tokens, temperature: temp,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  }).then(r => JSON.parse(r.choices[0].message.content));
};

/* ── GET /recommend/providers ────────────────────────────────────────────── */
router.get('/providers', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'CLIENTE') return res.json({ recommendations: [] });

  try {
    const [userBookings, topProviders] = await Promise.all([
      // Client's booking history
      prisma.booking.findMany({
        where: { clienteId: req.user.id },
        include: {
          proveedor: { include: { user: { select: { nombre: true, ciudad: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      // Top-rated available providers
      prisma.providerProfile.findMany({
        where: { disponible: true, calificacion: { gt: 3.5 } },
        include: { user: { select: { nombre: true, ciudad: true } } },
        orderBy: [{ calificacion: 'desc' }, { reservasCompletadas: 'desc' }],
        take: 20,
      }),
    ]);

    if (!topProviders.length) return res.json({ recommendations: [] });

    // Compute quick scores without AI if no bookings
    if (!userBookings.length) {
      const recs = topProviders.slice(0, 4).map(p => ({
        providerId: p.id,
        nombre: p.user.nombre,
        ciudad: p.user.ciudad,
        calificacion: p.calificacion,
        tarifaPorHora: p.tarifaPorHora,
        verificado: p.verificado,
        reservasCompletadas: p.reservasCompletadas,
        servicios: p.servicios.slice(0, 3),
        razon: 'Proveedor con alta calificación y experiencia en tu ciudad.',
        match_score: Math.round((p.calificacion / 5) * 85 + (p.verificado ? 15 : 0)),
        tag: p.verificado ? '✓ Verificado' : '⭐ Top rated',
      }));
      return res.json({ recommendations: recs, personalized: false });
    }

    // Build history context
    const services   = [...new Set(userBookings.map(b => b.tipoServicio))];
    const cities     = [...new Set(userBookings.map(b => b.proveedor?.user?.ciudad).filter(Boolean))];
    const avgSpend   = userBookings.reduce((s, b) => s + (b.precioTotal || 0), 0) / userBookings.length;
    const completed  = userBookings.filter(b => b.estado === 'COMPLETADO').length;

    const providerContext = topProviders.slice(0, 12).map(p => ({
      id:      p.id,
      nombre:  p.user.nombre,
      ciudad:  p.user.ciudad,
      servicios: p.servicios.slice(0, 4),
      calificacion: p.calificacion,
      tarifa: p.tarifaPorHora,
      verificado: p.verificado,
      completados: p.reservasCompletadas,
    }));

    const result = await ai(
      `Eres el motor de recomendaciones personalizadas de DutyJoy Colombia.

HISTORIAL DEL CLIENTE:
- Servicios usados: ${services.join(', ')}
- Ciudades: ${cities.join(', ')}
- Promedio de gasto: $${Math.round(avgSpend).toLocaleString('es-CO')} COP
- Servicios completados: ${completed}
- Total reservas: ${userBookings.length}

PROVEEDORES DISPONIBLES:
${JSON.stringify(providerContext, null, 1)}

Selecciona los 3-4 proveedores más relevantes para este cliente basándote en:
- Coincidencia con servicios usados
- Ciudad similar
- Tarifa cerca del promedio del cliente
- Alta calificación

Devuelve JSON:
{
  "recommendations": [
    {
      "providerId": "string",
      "nombre": "string",
      "ciudad": "string",
      "calificacion": 0.0,
      "tarifaPorHora": 0,
      "verificado": true,
      "reservasCompletadas": 0,
      "servicios": [],
      "razon": "por qué este proveedor es ideal para este cliente (1 frase)",
      "match_score": 0,
      "tag": "etiqueta corta: '✓ Tu favorito', '🆕 Nuevo', '⭐ Altamente recomendado', etc."
    }
  ],
  "insight": "frase motivacional sobre los resultados"
}

match_score: 0-100. Ordena por match_score desc.`,
      { max_tokens: 1500, temp: 0.3 }
    );

    res.json({ ...result, personalized: true });
  } catch (e) {
    // Fallback: return top providers without AI
    const fallback = await prisma.providerProfile.findMany({
      where: { disponible: true, calificacion: { gt: 4.0 }, verificado: true },
      include: { user: { select: { nombre: true, ciudad: true } } },
      orderBy: { calificacion: 'desc' },
      take: 4,
    });
    res.json({
      recommendations: fallback.map(p => ({
        providerId: p.id, nombre: p.user.nombre, ciudad: p.user.ciudad,
        calificacion: p.calificacion, tarifaPorHora: p.tarifaPorHora,
        verificado: p.verificado, reservasCompletadas: p.reservasCompletadas,
        servicios: p.servicios.slice(0, 3),
        razon: 'Proveedor verificado con excelentes reseñas.',
        match_score: Math.round(p.calificacion * 18),
        tag: '✓ Verificado',
      })),
      personalized: false,
    });
  }
});

module.exports = router;
