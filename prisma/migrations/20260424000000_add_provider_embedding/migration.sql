-- Habilitar extensión pgvector (ya ejecutado en Supabase, esta línea es idempotente)
CREATE EXTENSION IF NOT EXISTS vector;

-- Agregar columna embedding al ProviderProfile
ALTER TABLE "ProviderProfile" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Índice IVFFlat para búsqueda aproximada eficiente (se activa cuando hay suficientes filas)
CREATE INDEX IF NOT EXISTS idx_provider_embedding
  ON "ProviderProfile" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);
