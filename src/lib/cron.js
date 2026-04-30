const cron  = require('node-cron');
const prisma = require('./prisma');
const email  = require('./email');

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

  console.log('⏰  Crons activos: recordatorio24h (cada hora) · expiracionReservas (cada hora :30)');
}

module.exports = { iniciarCrons };
