-- CreateTable
CREATE TABLE "Disputa" (
    "id"            TEXT NOT NULL,
    "bookingId"     TEXT NOT NULL,
    "clienteId"     TEXT NOT NULL,
    "mensaje"       TEXT NOT NULL,
    "estado"        TEXT NOT NULL DEFAULT 'abierta',
    "resolucion"    TEXT,
    "resueltaPorId" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Disputa_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Disputa" ADD CONSTRAINT "Disputa_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disputa" ADD CONSTRAINT "Disputa_clienteId_fkey"
    FOREIGN KEY ("clienteId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Disputa_estado_idx"     ON "Disputa"("estado");
CREATE INDEX "Disputa_bookingId_idx"  ON "Disputa"("bookingId");
CREATE INDEX "Disputa_clienteId_idx"  ON "Disputa"("clienteId");
