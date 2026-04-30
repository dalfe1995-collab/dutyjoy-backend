const router  = require('express').Router();
const OpenAI  = require('openai');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const SYSTEM_PROMPT = `Eres el asistente virtual de DutyJoy, una plataforma colombiana que conecta clientes con proveedores de servicios del hogar (plomería, electricidad, limpieza, jardinería, pintura, cerrajería, mudanzas, aire acondicionado, carpintería, fumigación y más).

Tu objetivo es ayudar a los usuarios a:
1. Entender cómo funciona DutyJoy
2. Encontrar el tipo de servicio que necesitan
3. Saber cómo reservar y pagar
4. Resolver dudas sobre proveedores, precios y garantías
5. Orientar sobre el proceso de registro (clientes y proveedores)

Información clave:
- Ciudades disponibles: Bogotá, Ibagué, Medellín, Cali
- El pago se hace a través de MercadoPago (tarjetas, PSE)
- DutyJoy cobra una comisión del 15% sobre el precio del servicio
- Los proveedores verificados tienen su cédula revisada por el equipo
- Las reservas se pueden ver en "Mis reservas"
- Para ser proveedor: registrarse como PROVEEDOR, completar el perfil y subir cédula
- Soporte por email: soporte@dutyjoy.com

Responde siempre en español, de forma amable, concisa y útil. Si no sabes algo, indica que pueden escribir a soporte@dutyjoy.com. No inventes información.`;

// Mapea URL del frontend a contexto legible
function urlContext(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split('?')[0];
  if (clean === '/')                  return 'El usuario está en la página de inicio (Landing).';
  if (clean === '/providers')         return 'El usuario está en la lista de proveedores, buscando servicios.';
  if (clean.startsWith('/providers/')) return 'El usuario está viendo el perfil de un proveedor específico.';
  if (clean === '/dashboard')         return 'El usuario está en su panel de control (Dashboard).';
  if (clean === '/my-bookings')       return 'El usuario está revisando sus reservas.';
  if (clean === '/register')          return 'El usuario está en el formulario de registro.';
  if (clean === '/login')             return 'El usuario está en la página de inicio de sesión.';
  if (clean === '/admin')             return 'El usuario está en el panel de administración.';
  return null;
}

// POST /chat — chatbot de soporte conversacional
router.post('/', async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'Asistente no disponible en este momento.' });
  }

  const { messages, context } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Se requiere un array de mensajes.' });
  }

  // Validaciones de seguridad
  if (messages.length > 20) {
    return res.status(400).json({ error: 'Conversación demasiado larga. Inicia una nueva.' });
  }

  const validRoles = ['user', 'assistant'];
  const sanitized = messages
    .filter(m => validRoles.includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.substring(0, 500) }));

  if (sanitized.length === 0 || sanitized[sanitized.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'El último mensaje debe ser del usuario.' });
  }

  // Enrich system prompt with page context if available
  const pageHint = urlContext(context?.url);
  const systemContent = pageHint
    ? `${SYSTEM_PROMPT}\n\nContexto actual: ${pageHint}`
    : SYSTEM_PROMPT;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemContent },
        ...sanitized,
      ],
    });

    const reply = completion.choices[0].message.content.trim();
    res.json({ reply });
  } catch (e) {
    const detail = e?.response?.error?.message || e?.message || 'error desconocido';
    console.error('[chat]', detail);
    res.status(503).json({ error: 'El asistente no está disponible en este momento. Escríbenos a soporte@dutyjoy.com' });
  }
});

module.exports = router;
