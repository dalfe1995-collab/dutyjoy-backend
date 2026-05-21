const prisma = require('./prisma');

/**
 * Write a security audit record. Fire-and-forget — never throws.
 * @param {object} opts
 * @param {string} opts.accion   - "user_role_change" | "pago_procesado" | "booking_cancelado" ...
 * @param {string} [opts.userId] - who acted (null for system/webhooks)
 * @param {string} [opts.entidad]
 * @param {string} [opts.entidadId]
 * @param {*}      [opts.antes]  - old value (will be JSON-serialized)
 * @param {*}      [opts.despues] - new value
 * @param {object} [opts.req]    - Express request (extracts IP + UA)
 */
async function audit({ accion, userId, entidad, entidadId, antes, despues, req }) {
  try {
    const ip        = req ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress) : null;
    const userAgent = req ? (req.headers['user-agent']?.slice(0, 500)) : null;
    await prisma.auditLog.create({
      data: {
        userId:      userId || null,
        accion,
        entidad:     entidad   || null,
        entidadId:   entidadId || null,
        valorAntes:  antes   !== undefined ? antes   : undefined,
        valorDespues: despues !== undefined ? despues : undefined,
        ip,
        userAgent,
      },
    });
  } catch { /* never break the request */ }
}

module.exports = { audit };
