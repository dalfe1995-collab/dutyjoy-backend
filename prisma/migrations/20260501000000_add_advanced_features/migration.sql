-- AddColumn: horario (JSON schedule), portfolioUrls, instantBooking, reservasCompletadas, tiempoRespuestaH
ALTER TABLE "ProviderProfile"
  ADD COLUMN IF NOT EXISTS "horario"              JSONB,
  ADD COLUMN IF NOT EXISTS "portfolioUrls"        TEXT[]    NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "instantBooking"       BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reservasCompletadas"  INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tiempoRespuestaH"     DOUBLE PRECISION;

-- AddColumn: respuestaProveedor on Review
ALTER TABLE "Review"
  ADD COLUMN IF NOT EXISTS "respuestaProveedor" TEXT;
