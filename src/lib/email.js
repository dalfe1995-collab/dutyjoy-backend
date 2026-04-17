const { Resend } = require('resend');

// Inicialización diferida: no lanza si la key no está configurada (tests / dev)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM   = 'DutyJoy <notificaciones@dutyjoy.com>';
const APP    = process.env.FRONTEND_URL || 'https://app.dutyjoy.com';

// ── Utilidad interna: enviar y loggear, nunca lanzar ─────────────────────
async function send({ to, subject, html }) {
  if (!resend || process.env.NODE_ENV === 'test') return;
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error(`[EMAIL ERROR] ${subject} → ${to}:`, err.message);
  }
}

// ── Estilos base compartidos ─────────────────────────────────────────────
const BASE_STYLES = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f5f5f5;
  margin: 0; padding: 0;
`;
const CARD = `
  max-width: 560px; margin: 32px auto; background: #1a1a1a;
  border-radius: 16px; overflow: hidden;
`;
const HEADER = `
  background: #FFC534; padding: 28px 32px;
  font-size: 22px; font-weight: 800; color: #0f0f0f;
`;
const BODY = `padding: 28px 32px; color: #e5e5e5; font-size: 15px; line-height: 1.6;`;
const BTN  = `
  display: inline-block; margin-top: 20px; padding: 14px 28px;
  background: #FFC534; color: #0f0f0f; font-weight: 700;
  border-radius: 10px; text-decoration: none; font-size: 15px;
`;
const FOOTER = `
  padding: 16px 32px; background: #111; color: #666;
  font-size: 12px; text-align: center;
`;

function layout(headerText, bodyHtml) {
  return `
    <div style="${BASE_STYLES}">
      <div style="${CARD}">
        <div style="${HEADER}">⚡ DutyJoy &nbsp;—&nbsp; ${headerText}</div>
        <div style="${BODY}">${bodyHtml}</div>
        <div style="${FOOTER}">© 2026 DutyJoy · <a href="${APP}" style="color:#FFC534">app.dutyjoy.com</a></div>
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════
// EMAILS DE RESERVAS
// ════════════════════════════════════════════════════════════════════════

/**
 * Al proveedor cuando un cliente crea una reserva
 */
async function reservaCreada({ proveedorEmail, proveedorNombre, clienteNombre, tipoServicio, fecha, duracion, precioTotal, bookingId }) {
  const html = layout('Nueva reserva recibida 🎉', `
    <p>Hola <strong>${proveedorNombre}</strong>,</p>
    <p><strong>${clienteNombre}</strong> quiere contratar tu servicio:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px 0;color:#999">Servicio</td><td style="padding:8px 0;font-weight:600">${tipoServicio}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Fecha</td><td style="padding:8px 0;font-weight:600">${fecha}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Duración</td><td style="padding:8px 0;font-weight:600">${duracion} hora(s)</td></tr>
      <tr><td style="padding:8px 0;color:#999">Total</td><td style="padding:8px 0;font-weight:600;color:#FFC534">$${precioTotal.toLocaleString('es-CO')} COP</td></tr>
    </table>
    <p>Tienes 24 horas para confirmar o el cliente podrá cancelar.</p>
    <a href="${APP}/my-bookings" style="${BTN}">Ver reserva →</a>
  `);

  await send({ to: proveedorEmail, subject: `Nueva reserva de ${clienteNombre} — DutyJoy`, html });
}

/**
 * Al cliente cuando el proveedor confirma
 */
async function reservaConfirmada({ clienteEmail, clienteNombre, proveedorNombre, tipoServicio, fecha, precioTotal }) {
  const html = layout('¡Reserva confirmada! ✅', `
    <p>Hola <strong>${clienteNombre}</strong>,</p>
    <p><strong>${proveedorNombre}</strong> ha confirmado tu reserva:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px 0;color:#999">Servicio</td><td style="padding:8px 0;font-weight:600">${tipoServicio}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Fecha</td><td style="padding:8px 0;font-weight:600">${fecha}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Total</td><td style="padding:8px 0;font-weight:600;color:#FFC534">$${precioTotal.toLocaleString('es-CO')} COP</td></tr>
    </table>
    <p>Recuerda tener el pago listo para el día del servicio.</p>
    <a href="${APP}/my-bookings" style="${BTN}">Ver mis reservas →</a>
  `);

  await send({ to: clienteEmail, subject: `Tu reserva fue confirmada — DutyJoy`, html });
}

/**
 * Recordatorio 24h antes del servicio — se envía a ambos
 */
async function recordatorio24h({ clienteEmail, clienteNombre, proveedorEmail, proveedorNombre, tipoServicio, fecha }) {
  const clienteHtml = layout('Recordatorio: mañana es tu servicio 📅', `
    <p>Hola <strong>${clienteNombre}</strong>,</p>
    <p>Mañana tienes programado:</p>
    <p style="font-size:18px;font-weight:700;color:#FFC534">${tipoServicio} · ${fecha}</p>
    <p>El proveedor <strong>${proveedorNombre}</strong> estará contigo. Asegúrate de estar disponible.</p>
    <a href="${APP}/my-bookings" style="${BTN}">Ver detalle →</a>
  `);

  const proveedorHtml = layout('Recordatorio: mañana tienes un servicio 📅', `
    <p>Hola <strong>${proveedorNombre}</strong>,</p>
    <p>Mañana tienes programado:</p>
    <p style="font-size:18px;font-weight:700;color:#FFC534">${tipoServicio} · ${fecha}</p>
    <p>Cliente: <strong>${clienteNombre}</strong></p>
    <a href="${APP}/my-bookings" style="${BTN}">Ver detalle →</a>
  `);

  await Promise.all([
    send({ to: clienteEmail,   subject: `Recordatorio: mañana es tu servicio — DutyJoy`, html: clienteHtml }),
    send({ to: proveedorEmail, subject: `Recordatorio: mañana tienes un servicio — DutyJoy`, html: proveedorHtml }),
  ]);
}

/**
 * Al proveedor cuando el servicio se marca como completado
 */
async function servicioCompletado({ proveedorEmail, proveedorNombre, clienteNombre, tipoServicio, precioTotal, comision }) {
  const ganancia = precioTotal - comision;
  const html = layout('Servicio completado 🎉', `
    <p>Hola <strong>${proveedorNombre}</strong>,</p>
    <p>El servicio con <strong>${clienteNombre}</strong> fue marcado como completado.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px 0;color:#999">Servicio</td><td style="padding:8px 0;font-weight:600">${tipoServicio}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Total cobrado</td><td style="padding:8px 0;font-weight:600">$${precioTotal.toLocaleString('es-CO')} COP</td></tr>
      <tr><td style="padding:8px 0;color:#999">Comisión DutyJoy (15%)</td><td style="padding:8px 0;color:#ff6b6b">−$${comision.toLocaleString('es-CO')} COP</td></tr>
      <tr style="border-top:1px solid #333"><td style="padding:12px 0;color:#999;font-weight:700">Tu ganancia</td><td style="padding:12px 0;font-weight:700;color:#FFC534;font-size:18px">$${ganancia.toLocaleString('es-CO')} COP</td></tr>
    </table>
    <p style="color:#999;font-size:13px">El pago será transferido en el próximo ciclo de pagos (cada viernes).</p>
    <a href="${APP}/my-bookings" style="${BTN}">Ver historial →</a>
  `);

  await send({ to: proveedorEmail, subject: `Servicio completado — DutyJoy`, html });
}

// ════════════════════════════════════════════════════════════════════════
// EMAILS DE RESEÑAS
// ════════════════════════════════════════════════════════════════════════

/**
 * Al proveedor cuando recibe una nueva reseña
 */
async function nuevaResena({ proveedorEmail, proveedorNombre, clienteNombre, calificacion, comentario }) {
  const estrellas = '⭐'.repeat(calificacion) + '☆'.repeat(5 - calificacion);
  const html = layout('Tienes una nueva reseña ⭐', `
    <p>Hola <strong>${proveedorNombre}</strong>,</p>
    <p><strong>${clienteNombre}</strong> te dejó una reseña:</p>
    <div style="background:#111;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #FFC534">
      <div style="font-size:24px;margin-bottom:8px">${estrellas}</div>
      <p style="color:#e5e5e5;font-style:italic;margin:0">"${comentario || 'Sin comentario'}"</p>
    </div>
    <a href="${APP}/providers" style="${BTN}">Ver mi perfil →</a>
  `);

  await send({ to: proveedorEmail, subject: `Nueva reseña de ${calificacion} estrellas — DutyJoy`, html });
}

// ════════════════════════════════════════════════════════════════════════
// EMAILS DE AUTENTICACIÓN
// ════════════════════════════════════════════════════════════════════════

/**
 * Bienvenida al registrarse
 */
async function bienvenida({ email, nombre, rol }) {
  const esProveedor = rol === 'PROVEEDOR';
  const html = layout('¡Bienvenido a DutyJoy! 👋', `
    <p>Hola <strong>${nombre}</strong>,</p>
    <p>Tu cuenta fue creada exitosamente como <strong>${esProveedor ? 'Proveedor de servicios' : 'Cliente'}</strong>.</p>
    ${esProveedor
      ? `<p>Completa tu perfil para que los clientes puedan encontrarte:</p>
         <a href="${APP}/dashboard" style="${BTN}">Completar mi perfil →</a>`
      : `<p>Ya puedes buscar proveedores y hacer tu primera reserva:</p>
         <a href="${APP}/providers" style="${BTN}">Explorar servicios →</a>`
    }
    <p style="color:#666;font-size:13px;margin-top:24px">Si tienes preguntas escríbenos a <a href="mailto:info@dutyjoy.com" style="color:#FFC534">info@dutyjoy.com</a></p>
  `);

  await send({ to: email, subject: `¡Bienvenido a DutyJoy, ${nombre}!`, html });
}

/**
 * Verificación de email al registrarse
 */
async function verificarEmail({ email, nombre, token }) {
  const link = `${APP}/verify-email?token=${token}`;
  const html = layout('Verifica tu email ✉️', `
    <p>Hola <strong>${nombre}</strong>,</p>
    <p>Gracias por registrarte en DutyJoy. Solo falta un paso: confirma tu dirección de correo haciendo clic en el botón de abajo.</p>
    <a href="${link}" style="${BTN}">Verificar mi email →</a>
    <p style="color:#666;font-size:13px;margin-top:24px">Este enlace expira en <strong>24 horas</strong>. Si no creaste una cuenta en DutyJoy, ignora este mensaje.</p>
    <p style="color:#444;font-size:12px;word-break:break-all">O copia este enlace: ${link}</p>
  `);

  await send({ to: email, subject: `Verifica tu email — DutyJoy`, html });
}

/**
 * Recuperación de contraseña
 */
async function resetPassword({ email, nombre, resetToken }) {
  const link = `${APP}/reset-password?token=${resetToken}`;
  const html = layout('Recuperar contraseña 🔑', `
    <p>Hola <strong>${nombre}</strong>,</p>
    <p>Recibimos una solicitud para restablecer tu contraseña.</p>
    <p>Haz clic en el botón — el enlace expira en <strong>1 hora</strong>:</p>
    <a href="${link}" style="${BTN}">Restablecer contraseña →</a>
    <p style="color:#666;font-size:13px;margin-top:24px">Si no solicitaste esto, ignora este email. Tu contraseña no cambiará.</p>
    <p style="color:#444;font-size:12px;word-break:break-all">O copia este enlace: ${link}</p>
  `);

  await send({ to: email, subject: `Restablece tu contraseña — DutyJoy`, html });
}

// ════════════════════════════════════════════════════════════════════════
// EMAILS DE DISPUTAS
// ════════════════════════════════════════════════════════════════════════

/**
 * Al admin cuando un cliente reporta un problema con una reserva
 */
async function disputaAdmin({ bookingId, clienteNombre, clienteEmail, proveedorNombre, tipoServicio, fechaServicio, mensaje }) {
  const fecha = new Date(fechaServicio).toLocaleDateString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const html = layout('⚠️ Problema reportado por un cliente', `
    <p>El cliente <strong>${clienteNombre}</strong> ha reportado un problema en una reserva:</p>
    <div style="background:#2a1a1a;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #FF6B6B">
      <p style="color:#e5e5e5;font-style:italic;margin:0">"${mensaje}"</p>
    </div>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px 0;color:#999">Booking ID</td><td style="padding:8px 0;font-size:12px;color:#aaa">${bookingId}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Cliente</td><td style="padding:8px 0;font-weight:600">${clienteNombre} &lt;${clienteEmail}&gt;</td></tr>
      <tr><td style="padding:8px 0;color:#999">Proveedor</td><td style="padding:8px 0;font-weight:600">${proveedorNombre}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Servicio</td><td style="padding:8px 0;font-weight:600">${tipoServicio}</td></tr>
      <tr><td style="padding:8px 0;color:#999">Fecha</td><td style="padding:8px 0">${fecha}</td></tr>
    </table>
    <p style="color:#999;font-size:13px">Responde al cliente directamente a <a href="mailto:${clienteEmail}" style="color:#FFC534">${clienteEmail}</a></p>
  `);

  await send({ to: 'admin@dutyjoy.com', subject: `⚠️ Disputa: ${clienteNombre} — reserva #${bookingId.slice(-6).toUpperCase()}`, html });
}

/**
 * Confirmación al cliente de que su reporte fue recibido
 */
async function disputaCliente({ clienteEmail, clienteNombre, bookingId }) {
  const html = layout('Reporte recibido ✅', `
    <p>Hola <strong>${clienteNombre}</strong>,</p>
    <p>Recibimos tu reporte sobre la reserva <strong>#${bookingId.slice(-6).toUpperCase()}</strong>.</p>
    <p>Nuestro equipo lo revisará y te contactará en un plazo máximo de <strong>24 horas hábiles</strong>.</p>
    <p style="color:#666;font-size:13px;margin-top:24px">
      Si tienes más detalles que compartir, responde a este email o escríbenos a
      <a href="mailto:info@dutyjoy.com" style="color:#FFC534">info@dutyjoy.com</a>
    </p>
  `);

  await send({ to: clienteEmail, subject: `Reporte recibido — DutyJoy`, html });
}

// ════════════════════════════════════════════════════════════════════════
module.exports = {
  reservaCreada,
  reservaConfirmada,
  recordatorio24h,
  servicioCompletado,
  nuevaResena,
  bienvenida,
  verificarEmail,
  resetPassword,
  disputaAdmin,
  disputaCliente,
};
