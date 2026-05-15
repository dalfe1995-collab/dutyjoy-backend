-- CreateTable
CREATE TABLE "MensajeChat" (
    "id"        TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "autorId"   TEXT NOT NULL,
    "contenido" TEXT NOT NULL,
    "leido"     BOOLEAN NOT NULL DEFAULT false,
    "tipo"      TEXT NOT NULL DEFAULT 'texto',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MensajeChat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MensajeChat_bookingId_createdAt_idx" ON "MensajeChat"("bookingId", "createdAt" ASC);
CREATE INDEX "MensajeChat_autorId_idx" ON "MensajeChat"("autorId");

-- AddForeignKey
ALTER TABLE "MensajeChat" ADD CONSTRAINT "MensajeChat_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MensajeChat" ADD CONSTRAINT "MensajeChat_autorId_fkey"
  FOREIGN KEY ("autorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
