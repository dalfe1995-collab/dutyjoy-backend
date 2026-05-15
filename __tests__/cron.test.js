/**
 * Tests for cron job helper functions (non-schedule logic only)
 */

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../src/lib/prisma', () => ({
  booking: {
    findMany: jest.fn(),
    update:   jest.fn(),
  },
}));

jest.mock('../src/lib/email', () => ({
  recordatorio24h:    jest.fn().mockResolvedValue(undefined),
  reservaCancelada:   jest.fn().mockResolvedValue(undefined),
  servicioCompletado: jest.fn().mockResolvedValue(undefined),
}));

// node-cron: mock schedule so iniciarCrons() doesn't actually register timers
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const prisma = require('../src/lib/prisma');
const email  = require('../src/lib/email');
const { completarReservasFinalizadas, cancelarReservasExpiradas } = require('../src/lib/cron');

// ── Helpers ────────────────────────────────────────────────────────────────
function makeBooking(overrides = {}) {
  return {
    id:              'booking-1',
    tipoServicio:    'aseo',
    fechaServicio:   new Date('2027-01-01T10:00:00Z'),
    duracionHoras:   2,
    precioTotal:     80000,
    comisionDutyJoy: 12000,
    cliente:         { nombre: 'Ana', email: 'ana@test.com' },
    proveedor:       { user: { nombre: 'Juan', email: 'juan@test.com' } },
    ...overrides,
  };
}

// ── completarReservasFinalizadas ───────────────────────────────────────────
describe('completarReservasFinalizadas', () => {
  beforeEach(() => jest.clearAllMocks());

  test('completes an EN_PROGRESO booking whose service + buffer has elapsed', async () => {
    // Service was 2h, started 5h ago → well past the 2h buffer
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const booking = makeBooking({ estado: 'EN_PROGRESO', fechaServicio: fiveHoursAgo, duracionHoras: 2 });

    prisma.booking.findMany.mockResolvedValue([booking]);
    prisma.booking.update.mockResolvedValue({ ...booking, estado: 'COMPLETADO' });

    await completarReservasFinalizadas();

    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data:  { estado: 'COMPLETADO' },
    });
    expect(email.servicioCompletado).toHaveBeenCalledTimes(1);
  });

  test('completes a CONFIRMADO (paid) booking whose service + buffer has elapsed', async () => {
    // Payment confirmed, provider never manually moved to EN_PROGRESO
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const booking = makeBooking({ estado: 'CONFIRMADO', fechaServicio: sixHoursAgo, duracionHoras: 2 });

    prisma.booking.findMany.mockResolvedValue([booking]);
    prisma.booking.update.mockResolvedValue({ ...booking, estado: 'COMPLETADO' });

    await completarReservasFinalizadas();

    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data:  { estado: 'COMPLETADO' },
    });
    expect(email.servicioCompletado).toHaveBeenCalledTimes(1);
  });

  test('does NOT complete a booking whose buffer has not elapsed yet', async () => {
    // Service started 3h ago, duration=2h → end=1h ago, but buffer=2h → finalises in 1h
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const booking = makeBooking({ fechaServicio: threeHoursAgo, duracionHoras: 2 });

    prisma.booking.findMany.mockResolvedValue([booking]);

    await completarReservasFinalizadas();

    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(email.servicioCompletado).not.toHaveBeenCalled();
  });

  test('handles empty result set gracefully', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await completarReservasFinalizadas();

    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('handles prisma error without throwing', async () => {
    prisma.booking.findMany.mockRejectedValue(new Error('DB error'));

    await expect(completarReservasFinalizadas()).resolves.not.toThrow();
  });
});

// ── cancelarReservasExpiradas ──────────────────────────────────────────────
describe('cancelarReservasExpiradas', () => {
  beforeEach(() => jest.clearAllMocks());

  test('cancels expired PENDIENTE bookings and sends email', async () => {
    const booking = makeBooking({ estado: 'PENDIENTE' });
    prisma.booking.findMany.mockResolvedValue([booking]);
    prisma.booking.update.mockResolvedValue({ ...booking, estado: 'CANCELADO' });

    await cancelarReservasExpiradas();

    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data:  { estado: 'CANCELADO' },
    });
    expect(email.reservaCancelada).toHaveBeenCalledTimes(1);
  });

  test('handles empty result set gracefully', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await cancelarReservasExpiradas();

    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('handles prisma error without throwing', async () => {
    prisma.booking.findMany.mockRejectedValue(new Error('DB down'));

    await expect(cancelarReservasExpiradas()).resolves.not.toThrow();
  });
});
