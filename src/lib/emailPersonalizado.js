const OpenAI  = require('openai');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const TIER_LABELS = {
  BRONCE:   { label: 'Bronce',   emoji: '🥉', bookingsMin: 0,  bookingsMax: 4  },
  PLATA:    { label: 'Plata',    emoji: '🥈', bookingsMin: 5,  bookingsMax: 14 },
  ORO:      { label: 'Oro',      emoji: '🥇', bookingsMin: 15, bookingsMax: 29 },
  PLATINO:  { label: 'Platino',  emoji: '💎', bookingsMin: 30, bookingsMax: Infinity },
};

function getTier(completadas) {
  if (completadas >= 30) return TIER_LABELS.PLATINO;
  if (completadas >= 15) return TIER_LABELS.ORO;
  if (completadas >= 5)  return TIER_LABELS.PLATA;
  return TIER_LABELS.BRONCE;
}

/**
 * Generates AI-personalized re-engagement email content
 * @param {object} cliente — { nombre, ciudad, completadas, servicios[], proveedorFavorito, diasInactivo }
 * @returns {object} { subject, headerText, body, ctaText, ps }
 */
async function generarContenidoReengagement(cliente) {
  if (!openai) return null;

  const tier = getTier(cliente.completadas || 0);
  const servicios = (cliente.servicios || []).slice(0, 3).join(', ') || 'servicios del hogar';
  const proveedor = cliente.proveedorFavorito || null;

  const prompt = `Eres el equipo de CRM de DutyJoy, plataforma colombiana de servicios del hogar.
Genera un email de re-engagement personalizado para este cliente que lleva ${cliente.diasInactivo} días sin reservar.

## Perfil del cliente
- Nombre: ${cliente.nombre}
- Ciudad: ${cliente.ciudad || 'Colombia'}
- Nivel de lealtad: ${tier.emoji} ${tier.label}
- Servicios más usados: ${servicios}
- Reservas completadas: ${cliente.completadas || 0}
${proveedor ? `- Proveedor favorito: ${proveedor}` : ''}

## Instrucciones
- Tono: cálido, cercano, colombiano (tuteo). NO corporativo.
- Máximo 3 oraciones en el body.
- Referencia específicamente al servicio más usado o al proveedor favorito.
- El PS debe ser genuinamente personal y sorprender al lector.
- Subject: corto (< 50 chars), con emoji, sin clickbait.

Responde SOLO JSON válido:
{
  "subject": "<línea de asunto>",
  "headerText": "<titular del email, < 40 chars>",
  "body": "<2-3 oraciones personalizadas en español>",
  "ctaText": "<texto del botón CTA, < 25 chars>",
  "ps": "<posdata personal opcional, 1 oración>"
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    temperature: 0.75,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(completion.choices[0].message.content);
}

/**
 * Generates AI-personalized weekly provider digest content
 * @param {object} proveedor — { nombre, ingresos7d, reservas7d, calificacion, vistas7d, topCliente }
 * @returns {object} { subject, headerText, insight, tip, ctaText }
 */
async function generarContenidoDigestProveedor(proveedor) {
  if (!openai) return null;

  const prompt = `Eres el equipo de DutyJoy. Genera el resumen semanal personalizado para este proveedor.

## Métricas de la semana
- Nombre: ${proveedor.nombre}
- Ingresos semana: $${(proveedor.ingresos7d || 0).toLocaleString('es-CO')} COP
- Reservas esta semana: ${proveedor.reservas7d || 0}
- Calificación actual: ${proveedor.calificacion?.toFixed(1) || 'N/A'} ⭐
- Vistas al perfil: ${proveedor.vistas7d || 0}
${proveedor.topCliente ? `- Cliente destacado: ${proveedor.topCliente}` : ''}

Responde SOLO JSON:
{
  "subject": "<asunto corto con emoji, < 50 chars>",
  "headerText": "<titular motivador < 40 chars>",
  "insight": "<observación específica sobre su semana, 1-2 oraciones>",
  "tip": "<consejo accionable para la próxima semana, 1 oración>",
  "ctaText": "<botón CTA < 25 chars>"
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 250,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(completion.choices[0].message.content);
}

/**
 * Builds and sends a personalized re-engagement email
 */
async function enviarReengagement({ to, cliente }) {
  const content = await generarContenidoReengagement(cliente);
  if (!content) return null;

  const tier = getTier(cliente.completadas || 0);
  const BTN_STYLE = `display:inline-block;margin-top:20px;padding:14px 28px;background:#FFC534;color:#0f0f0f;font-weight:700;border-radius:10px;text-decoration:none;font-size:15px;`;
  const LAYOUT_STYLE = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:0;`;
  const CARD_STYLE   = `max-width:560px;margin:32px auto;background:#1a1a1a;border-radius:16px;overflow:hidden;`;
  const HEADER_STYLE = `background:#FFC534;padding:28px 32px;font-size:22px;font-weight:800;color:#0f0f0f;`;
  const BODY_STYLE   = `padding:28px 32px;color:#e5e5e5;font-size:15px;line-height:1.6;`;
  const FOOTER_STYLE = `padding:16px 32px;background:#111;color:#666;font-size:12px;text-align:center;`;
  const APP_URL      = process.env.FRONTEND_URL || 'https://app.dutyjoy.com';

  const html = `
    <div style="${LAYOUT_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="${HEADER_STYLE}">⚡ DutyJoy &nbsp;—&nbsp; ${content.headerText}</div>
        <div style="${BODY_STYLE}">
          <p>Hola <strong>${cliente.nombre}</strong> ${tier.emoji},</p>
          <p>${content.body}</p>
          <a href="${APP_URL}/providers" style="${BTN_STYLE}">${content.ctaText} →</a>
          ${content.ps ? `<p style="color:#888;font-size:13px;margin-top:24px;font-style:italic">P.D. ${content.ps}</p>` : ''}
        </div>
        <div style="${FOOTER_STYLE}">© 2026 DutyJoy · <a href="${APP_URL}" style="color:#FFC534">app.dutyjoy.com</a></div>
      </div>
    </div>`;

  const resend = process.env.RESEND_API_KEY ? require('resend').Resend : null;
  if (!resend || process.env.NODE_ENV === 'test') return { content, sent: false };

  const client = new resend(process.env.RESEND_API_KEY);
  try {
    await client.emails.send({
      from: 'DutyJoy <notificaciones@dutyjoy.com>',
      to,
      subject: content.subject,
      html,
    });
    return { content, sent: true };
  } catch (err) {
    console.error('[emailPersonalizado] send error:', err.message);
    return { content, sent: false, error: err.message };
  }
}

/**
 * Builds and sends a personalized weekly provider digest
 */
async function enviarDigestProveedor({ to, proveedor }) {
  const content = await generarContenidoDigestProveedor(proveedor);
  if (!content) return null;

  const BTN_STYLE = `display:inline-block;margin-top:20px;padding:14px 28px;background:#FFC534;color:#0f0f0f;font-weight:700;border-radius:10px;text-decoration:none;font-size:15px;`;
  const LAYOUT_STYLE = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:0;`;
  const CARD_STYLE   = `max-width:560px;margin:32px auto;background:#1a1a1a;border-radius:16px;overflow:hidden;`;
  const HEADER_STYLE = `background:#FFC534;padding:28px 32px;font-size:22px;font-weight:800;color:#0f0f0f;`;
  const BODY_STYLE   = `padding:28px 32px;color:#e5e5e5;font-size:15px;line-height:1.6;`;
  const FOOTER_STYLE = `padding:16px 32px;background:#111;color:#666;font-size:12px;text-align:center;`;
  const APP_URL      = process.env.FRONTEND_URL || 'https://app.dutyjoy.com';

  const html = `
    <div style="${LAYOUT_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="${HEADER_STYLE}">⚡ DutyJoy &nbsp;—&nbsp; ${content.headerText}</div>
        <div style="${BODY_STYLE}">
          <p>Hola <strong>${proveedor.nombre}</strong>,</p>
          <p>${content.insight}</p>
          <div style="background:#111;border-radius:12px;padding:16px 20px;margin:16px 0;border-left:4px solid #FFC534">
            <p style="margin:0;font-size:14px;color:#ccc">💡 <strong>Consejo de la semana:</strong> ${content.tip}</p>
          </div>
          <a href="${APP_URL}/provider-analytics" style="${BTN_STYLE}">${content.ctaText} →</a>
        </div>
        <div style="${FOOTER_STYLE}">© 2026 DutyJoy · <a href="${APP_URL}" style="color:#FFC534">app.dutyjoy.com</a></div>
      </div>
    </div>`;

  const resend = process.env.RESEND_API_KEY ? require('resend').Resend : null;
  if (!resend || process.env.NODE_ENV === 'test') return { content, sent: false };

  const client = new resend(process.env.RESEND_API_KEY);
  try {
    await client.emails.send({
      from: 'DutyJoy <notificaciones@dutyjoy.com>',
      to,
      subject: content.subject,
      html,
    });
    return { content, sent: true };
  } catch (err) {
    console.error('[emailPersonalizado] digest error:', err.message);
    return { content, sent: false, error: err.message };
  }
}

module.exports = {
  generarContenidoReengagement,
  generarContenidoDigestProveedor,
  enviarReengagement,
  enviarDigestProveedor,
};
