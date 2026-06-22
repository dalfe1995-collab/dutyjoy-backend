-- Catálogos parametrizables: servicios y ciudades
CREATE TABLE "ServiceCatalog" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "icon" TEXT,
    "descripcion" TEXT,
    "color" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCatalog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CityCatalog" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CityCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CityCatalog_nombre_key" ON "CityCatalog"("nombre");
CREATE INDEX "ServiceCatalog_activo_orden_idx" ON "ServiceCatalog"("activo", "orden");
CREATE INDEX "CityCatalog_activo_orden_idx" ON "CityCatalog"("activo", "orden");
