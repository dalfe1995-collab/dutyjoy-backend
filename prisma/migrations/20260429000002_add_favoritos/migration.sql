-- CreateTable: Favorito (client bookmarks providers)
CREATE TABLE IF NOT EXISTS "Favorito" (
    "id"          TEXT NOT NULL,
    "clienteId"   TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorito_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one bookmark per client-provider pair
CREATE UNIQUE INDEX IF NOT EXISTS "Favorito_clienteId_proveedorId_key"
    ON "Favorito"("clienteId", "proveedorId");

-- Foreign keys
ALTER TABLE "Favorito"
    ADD CONSTRAINT "Favorito_clienteId_fkey"
    FOREIGN KEY ("clienteId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Favorito"
    ADD CONSTRAINT "Favorito_proveedorId_fkey"
    FOREIGN KEY ("proveedorId") REFERENCES "ProviderProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
