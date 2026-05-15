-- Migration: recurring bookings + provider analytics
-- 2026-05-01

-- Provider analytics fields
ALTER TABLE "ProviderProfile"
  ADD COLUMN IF NOT EXISTS "totalViews"     INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tasaAceptacion" DOUBLE PRECISION;

-- Recurrencia enum
DO $$ BEGIN
  CREATE TYPE "Recurrencia" AS ENUM ('UNICA', 'SEMANAL', 'QUINCENAL', 'MENSUAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Booking: recurring fields
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "recurrencia"      "Recurrencia" NOT NULL DEFAULT 'UNICA',
  ADD COLUMN IF NOT EXISTS "bookingPadreId"   TEXT,
  ADD COLUMN IF NOT EXISTS "motivoCancelacion" TEXT;

-- Self-referencing FK (parent booking)
ALTER TABLE "Booking"
  DROP CONSTRAINT IF EXISTS "Booking_bookingPadreId_fkey";

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_bookingPadreId_fkey"
    FOREIGN KEY ("bookingPadreId") REFERENCES "Booking"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for fast lookup of children
CREATE INDEX IF NOT EXISTS "Booking_bookingPadreId_idx" ON "Booking"("bookingPadreId");
CREATE INDEX IF NOT EXISTS "Booking_recurrencia_estado_idx" ON "Booking"("recurrencia", "estado");
