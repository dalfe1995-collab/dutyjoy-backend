-- CreateTable
CREATE TABLE IF NOT EXISTS "Notificacion" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "tipo"      TEXT NOT NULL,
    "titulo"    TEXT NOT NULL,
    "mensaje"   TEXT NOT NULL,
    "leida"     BOOLEAN NOT NULL DEFAULT false,
    "data"      JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notificacion_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Notificacion" ADD CONSTRAINT "Notificacion_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notificacion_userId_leida_idx" ON "Notificacion"("userId", "leida");
CREATE INDEX IF NOT EXISTS "Notificacion_userId_createdAt_idx" ON "Notificacion"("userId", "createdAt" DESC);
