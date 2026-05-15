-- CreateTable
CREATE TABLE "CrmTag" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#0ABFBC',
    "descripcion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmTagAsignacion" (
    "id" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "asignadoPor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmTagAsignacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmTag_nombre_key" ON "CrmTag"("nombre");

-- CreateIndex
CREATE INDEX "CrmTagAsignacion_userId_idx" ON "CrmTagAsignacion"("userId");

-- CreateIndex
CREATE INDEX "CrmTagAsignacion_tagId_idx" ON "CrmTagAsignacion"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTagAsignacion_tagId_userId_key" ON "CrmTagAsignacion"("tagId", "userId");

-- AddForeignKey
ALTER TABLE "CrmTagAsignacion" ADD CONSTRAINT "CrmTagAsignacion_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "CrmTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmTagAsignacion" ADD CONSTRAINT "CrmTagAsignacion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
