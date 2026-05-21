/**
 * zone.routes.js — Zone Safety & Logistics Analysis
 *
 * Helps DutyJoy providers make an informed decision about whether to accept a booking
 * by analyzing the service address: safety, distance, travel time, access, practical tips.
 *
 * Covers all Colombian cities served: Ibagué, Bogotá, Medellín, Cali, Barranquilla,
 * Bucaramanga, Cartagena, Pereira, Armenia, Manizales.
 */
const router      = require('express').Router();
const OpenAI      = require('openai');
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const ai = (prompt, { max_tokens = 2000, temp = 0.2, json = true } = {}) => {
  if (!openai) return Promise.reject(new Error('OPENAI_API_KEY no configurado'));
  return openai.chat.completions.create({
    model: 'gpt-4o', max_tokens, temperature: temp,
    ...(json && { response_format: { type: 'json_object' } }),
    messages: [{ role: 'user', content: prompt }],
  }).then(r => json ? JSON.parse(r.choices[0].message.content) : r.choices[0].message.content);
};

/* ── Haversine distance (km) ─────────────────────────────────────────────── */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 10) / 10;
}

/* ── Geocode via Nominatim (free, no API key) ────────────────────────────── */
async function geocode(address, city) {
  try {
    const q = encodeURIComponent(`${address}, ${city}, Colombia`);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=co`,
      { headers: { 'User-Agent': 'DutyJoy/1.0 (contact@dutyjoy.com)' }, signal: AbortSignal.timeout(4000) }
    );
    const data = await res.json();
    if (data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
  } catch { /* silent — fallback to AI-only analysis */ }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   POST /zone/analyze
   Full AI zone analysis for a given service address.
   Provider-facing: helps decide whether to accept a booking.
══════════════════════════════════════════════════════════════════════════ */
router.post('/analyze', verifyToken, async (req, res) => {
  const { direccion, ciudad, ciudadProveedor, latProveedor, lngProveedor, bookingId } = req.body;
  if (!direccion || !ciudad) return res.status(400).json({ error: 'direccion y ciudad requeridos' });

  try {
    // Try to geocode the service address
    const coords = await geocode(direccion, ciudad);

    // Calculate real distance if we have both coordinates
    let distanciaReal = null;
    if (coords && latProveedor && lngProveedor) {
      distanciaReal = haversine(latProveedor, lngProveedor, coords.lat, coords.lng);
    }

    const result = await ai(
      `Eres un experto en seguridad urbana y logística de servicios a domicilio en Colombia.
Un proveedor de DutyJoy (servicios del hogar: limpieza, plomería, electricidad, etc.) necesita evaluar si le conviene ir a prestar un servicio a esta dirección.

DIRECCIÓN DEL SERVICIO: "${direccion}"
CIUDAD: ${ciudad}
CIUDAD/SECTOR DEL PROVEEDOR: ${ciudadProveedor || ciudad}
${distanciaReal ? `DISTANCIA GPS CALCULADA: ${distanciaReal} km` : ''}
${coords ? `COORDENADAS APROXIMADAS: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : ''}

Analiza de forma objetiva, concreta y útil para un trabajador independiente colombiano:

1. **Caracterización de la zona**: tipo de sector, estrato aproximado, ambiente general
2. **Seguridad**: historial delictivo conocido, nivel de riesgo real, condiciones de seguridad
3. **Logística**: distancia estimada desde ${ciudadProveedor || ciudad}, tiempo de viaje en diferentes medios
4. **Accesibilidad**: condiciones de las vías, transporte público disponible, parqueadero
5. **Recomendación final**: ¿le conviene ir? ¿bajo qué condiciones?
6. **Consejos prácticos**: específicos para alguien que va a trabajar allí con herramientas

Sé ESPECÍFICO con el contexto colombiano. Menciona comunas/localidades/barrios reconocidos.
Para zonas que no conozcas con certeza, da el mejor análisis posible basado en el nombre.

Devuelve JSON:
{
  "zona": {
    "tipo": "residencial|comercial|industrial|mixta|periférica",
    "estrato_estimado": 1,
    "descripcion": "descripción breve del sector"
  },
  "seguridad": {
    "score": 7,
    "nivel": "alta|buena|moderada|baja|muy_baja",
    "semaforo": "verde|amarillo|rojo",
    "descripcion": "análisis de seguridad",
    "riesgos": ["riesgo específico 1"],
    "horario_recomendado": "ej: 7am–6pm entre semana",
    "precauciones": ["precaución práctica 1"]
  },
  "logistica": {
    "distancia_km_estimada": 5.0,
    "tiempo_moto_min": 15,
    "tiempo_carro_min": 20,
    "tiempo_bus_min": 40,
    "condicion_vias": "buenas|regulares|malas|mixtas",
    "parking": "descripción de opciones de parqueo",
    "transporte_publico": "descripción acceso transporte",
    "observaciones_acceso": "notas relevantes sobre cómo llegar"
  },
  "recomendacion": {
    "decision": "conveniente|con_precaucion|evaluar|no_recomendado",
    "confianza": 0.85,
    "razon_principal": "por qué esta decisión",
    "condiciones": ["condición para que valga la pena ir"],
    "consejos_proveedor": [
      "consejo práctico específico para el proveedor"
    ],
    "mejor_horario": "cuándo ir idealmente"
  },
  "contexto_colombia": "información relevante sobre esta zona en el contexto colombiano",
  "advertencias_criticas": []
}

Scores: seguridad 1-10 (10=máxima seguridad). confianza 0-1 (qué tan seguro estás del análisis).
advertencias_criticas: solo si hay algo verdaderamente importante a destacar (zona de alto riesgo, acceso muy difícil, etc.).
Si el barrio/sector no está bien documentado, indícalo en contexto_colombia y da el mejor análisis posible.`,
      { max_tokens: 2000, temp: 0.2 }
    );

    // Build map URLs
    const mapQ = encodeURIComponent(`${direccion}, ${ciudad}, Colombia`);
    const mapsUrl  = `https://maps.google.com/maps?q=${mapQ}`;
    const wazeUrl  = `https://waze.com/ul?q=${mapQ}&navigate=yes`;
    const osmUrl   = `https://www.openstreetmap.org/search?query=${mapQ}`;
    const embedUrl = coords
      ? `https://www.openstreetmap.org/export/embed.html?bbox=${coords.lng-.015},${coords.lat-.015},${coords.lng+.015},${coords.lat+.015}&layer=mapnik&marker=${coords.lat},${coords.lng}`
      : null;

    res.json({
      ...result,
      meta: {
        direccion, ciudad, ciudadProveedor,
        geocodificado: !!coords,
        distanciaRealKm: distanciaReal,
        coords: coords ? { lat: coords.lat, lng: coords.lng } : null,
      },
      mapas: { google: mapsUrl, waze: wazeUrl, osm: osmUrl, embed: embedUrl },
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /zone/booking/:bookingId
   Analyze a specific booking's service address for the assigned/potential provider.
══════════════════════════════════════════════════════════════════════════ */
router.get('/booking/:bookingId', verifyToken, async (req, res) => {
  try {
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: req.params.bookingId },
      select: {
        id: true,
        direccionServicio: true,
        tipoServicio: true,
        fechaServicio: true,
        precioTotal: true,
        cliente: { select: { ciudad: true } },
        proveedor: {
          select: {
            location: { select: { lat: true, lng: true } },
            user: { select: { ciudad: true } },
          },
        },
      },
    });

    if (!booking.direccionServicio) {
      return res.status(400).json({ error: 'Esta reserva no tiene dirección de servicio registrada.' });
    }

    // Authorization: only the assigned provider or admin
    const isProvider = req.user?.rol === 'PROVEEDOR';
    const isAdmin    = req.user?.rol === 'ADMIN';
    if (!isProvider && !isAdmin) return res.status(403).json({ error: 'Solo proveedores y admins.' });

    const ciudadServicio  = booking.cliente?.ciudad  || 'Colombia';
    const ciudadProveedor = booking.proveedor?.user?.ciudad || ciudadServicio;
    const provLoc         = booking.proveedor?.location;

    // Forward to analyze endpoint logic
    const coords = await geocode(booking.direccionServicio, ciudadServicio);
    let distanciaReal = null;
    if (coords && provLoc?.lat && provLoc?.lng) {
      distanciaReal = haversine(provLoc.lat, provLoc.lng, coords.lat, coords.lng);
    }

    const result = await ai(
      `Eres un experto en logística urbana y seguridad en Colombia para trabajadores de servicios del hogar.

RESERVA A ANALIZAR:
- Servicio: ${booking.tipoServicio}
- Dirección: "${booking.direccionServicio}"
- Ciudad del servicio: ${ciudadServicio}
- Ciudad del proveedor: ${ciudadProveedor}
- Fecha: ${new Date(booking.fechaServicio).toLocaleString('es-CO')}
- Valor: $${booking.precioTotal?.toLocaleString('es-CO')} COP
${distanciaReal ? `- Distancia GPS: ${distanciaReal} km` : ''}

Analiza si le conviene al proveedor aceptar este servicio considerando la zona. Sé específico y práctico para un trabajador independiente en Colombia.

Devuelve JSON con exactamente esta estructura:
{
  "zona": { "tipo": "residencial|comercial|industrial|mixta|periférica", "estrato_estimado": 3, "descripcion": "texto" },
  "seguridad": {
    "score": 8,
    "nivel": "alta|buena|moderada|baja|muy_baja",
    "semaforo": "verde|amarillo|rojo",
    "descripcion": "texto",
    "riesgos": [],
    "horario_recomendado": "texto",
    "precauciones": []
  },
  "logistica": {
    "distancia_km_estimada": 5.0,
    "tiempo_moto_min": 15,
    "tiempo_carro_min": 20,
    "tiempo_bus_min": 40,
    "condicion_vias": "buenas|regulares|malas",
    "parking": "texto",
    "transporte_publico": "texto",
    "observaciones_acceso": "texto"
  },
  "recomendacion": {
    "decision": "conveniente|con_precaucion|evaluar|no_recomendado",
    "confianza": 0.85,
    "razon_principal": "texto",
    "condiciones": [],
    "consejos_proveedor": [],
    "mejor_horario": "texto"
  },
  "contexto_colombia": "texto",
  "advertencias_criticas": []
}`,
      { max_tokens: 2000, temp: 0.2 }
    );

    const mapQ    = encodeURIComponent(`${booking.direccionServicio}, ${ciudadServicio}, Colombia`);
    const embedUrl = coords
      ? `https://www.openstreetmap.org/export/embed.html?bbox=${coords.lng-.015},${coords.lat-.015},${coords.lng+.015},${coords.lat+.015}&layer=mapnik&marker=${coords.lat},${coords.lng}`
      : null;

    res.json({
      ...result,
      meta: { direccion: booking.direccionServicio, ciudad: ciudadServicio, ciudadProveedor, geocodificado: !!coords, distanciaRealKm: distanciaReal, coords: coords ? { lat: coords.lat, lng: coords.lng } : null },
      mapas: {
        google: `https://maps.google.com/maps?q=${mapQ}`,
        waze:   `https://waze.com/ul?q=${mapQ}&navigate=yes`,
        osm:    `https://www.openstreetmap.org/search?query=${mapQ}`,
        embed:  embedUrl,
      },
      booking: { id: booking.id, tipoServicio: booking.tipoServicio, fechaServicio: booking.fechaServicio, precioTotal: booking.precioTotal },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /zone/batch
   Analyze all pending bookings for the current provider.
══════════════════════════════════════════════════════════════════════════ */
router.post('/batch', verifyToken, async (req, res) => {
  if (req.user?.rol !== 'PROVEEDOR') return res.status(403).json({ error: 'Solo proveedores.' });
  try {
    const providerProfile = await prisma.providerProfile.findFirst({
      where: { userId: req.user.id },
      include: { location: true, user: { select: { ciudad: true } } },
    });
    if (!providerProfile) return res.status(404).json({ error: 'Perfil de proveedor no encontrado.' });

    const pendingBookings = await prisma.booking.findMany({
      where: { proveedorId: providerProfile.id, estado: { in: ['PENDIENTE', 'CONFIRMADO'] } },
      select: { id: true, tipoServicio: true, fechaServicio: true, precioTotal: true, direccionServicio: true, cliente: { select: { ciudad: true } } },
      orderBy: { fechaServicio: 'asc' },
      take: 10,
    });

    if (!pendingBookings.length) return res.json({ analyses: [] });

    // Quick scores without full AI (to avoid too many API calls)
    const analyses = pendingBookings
      .filter(b => b.direccionServicio)
      .map(b => ({
        bookingId: b.id,
        tipoServicio: b.tipoServicio,
        fechaServicio: b.fechaServicio,
        precioTotal: b.precioTotal,
        direccion: b.direccionServicio,
        ciudad: b.cliente?.ciudad || providerProfile.user?.ciudad,
        mapas: {
          google: `https://maps.google.com/maps?q=${encodeURIComponent(`${b.direccionServicio}, ${b.cliente?.ciudad || 'Colombia'}`)}`,
          waze:   `https://waze.com/ul?q=${encodeURIComponent(`${b.direccionServicio}, ${b.cliente?.ciudad || 'Colombia'}`)}&navigate=yes`,
        },
      }));

    res.json({ analyses, providerCity: providerProfile.user?.ciudad });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /zone/quick
   Lightweight: AI safety score + emoji only (for compact display)
══════════════════════════════════════════════════════════════════════════ */
router.post('/quick', verifyToken, async (req, res) => {
  const { direccion, ciudad } = req.body;
  if (!direccion || !ciudad) return res.status(400).json({ error: 'direccion y ciudad requeridos' });
  try {
    const result = await ai(
      `Clasifica rápidamente la seguridad y accesibilidad de esta zona en Colombia para un trabajador de servicios del hogar.

Dirección: "${direccion}", ${ciudad}, Colombia.

Devuelve SOLO este JSON minimalista:
{
  "semaforo": "verde|amarillo|rojo",
  "score": 7,
  "nivel": "alta|buena|moderada|baja|muy_baja",
  "distancia_km_estimada": 5,
  "resumen": "frase de máximo 15 palabras"
}`,
      { max_tokens: 200, temp: 0.1 }
    );
    const mapQ = encodeURIComponent(`${direccion}, ${ciudad}, Colombia`);
    res.json({ ...result, mapas: { google: `https://maps.google.com/maps?q=${mapQ}`, waze: `https://waze.com/ul?q=${mapQ}&navigate=yes` } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
