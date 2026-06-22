CREATE TYPE "TipoPago" AS ENUM ('CLIENTE_RECIBIDO', 'PROVEEDOR_PENDIENTE', 'PROVEEDOR_PAGADO', 'REEMBOLSO_CLIENTE');

-- CreateEnum
CREATE TYPE "EstadoPago" AS ENUM ('PENDIENTE', 'EN_PROCESO', 'COMPLETADO', 'FALLIDO');

-- DropForeignKey
ALTER TABLE "Favorito" DROP CONSTRAINT "Favorito_clienteId_fkey";

-- DropForeignKey
ALTER TABLE "Favorito" DROP CONSTRAINT "Favorito_proveedorId_fkey";

-- DropIndex
DROP INDEX "Booking_bookingPadreId_idx";

-- DropIndex
DROP INDEX "Booking_recurrencia_estado_idx";

-- DropIndex
DROP INDEX "idx_provider_embedding";

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "fotos" TEXT[],
ADD COLUMN     "startCode" TEXT,
ADD COLUMN     "startCodeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startCodeExpiry" TIMESTAMP(3),
ADD COLUMN     "startCodeUsedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Disputa" ADD COLUMN     "aiConfianza" DOUBLE PRECISION,
ADD COLUMN     "aiRazonamiento" TEXT,
ADD COLUMN     "aiVeredicto" TEXT;

-- AlterTable
ALTER TABLE "ProviderProfile" ADD COLUMN     "backgroundData" JSONB,
ADD COLUMN     "backgroundScore" INTEGER,
ADD COLUMN     "backgroundStatus" TEXT NOT NULL DEFAULT 'pendiente',
ADD COLUMN     "bancoCobro" TEXT,
ADD COLUMN     "metodoCobro" TEXT,
ADD COLUMN     "numeroCobro" TEXT,
ADD COLUMN     "paquetes" JSONB,
ADD COLUMN     "tipoCuentaCobro" TEXT,
ADD COLUMN     "titularCobro" TEXT,
ADD COLUMN     "voiceOnboardingAt" TIMESTAMP(3),
ALTER COLUMN "portfolioUrls" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "fraudCheckedAt" TIMESTAMP(3),
ADD COLUMN     "fraudFlags" TEXT[],
ADD COLUMN     "fraudOculta" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fraudScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "referredById" TEXT,
ADD COLUMN     "utmCampaign" TEXT,
ADD COLUMN     "utmContent" TEXT,
ADD COLUMN     "utmMedium" TEXT,
ADD COLUMN     "utmSource" TEXT,
ADD COLUMN     "utmTerm" TEXT;

-- CreateTable
CREATE TABLE "ProviderUnavailability" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL,
    "fechaFin" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderUnavailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'planificacion',
    "prioridad" TEXT NOT NULL DEFAULT 'media',
    "tipo" TEXT NOT NULL DEFAULT 'interno',
    "fechaInicio" TIMESTAMP(3),
    "fechaFin" TIMESTAMP(3),
    "presupuesto" DOUBLE PRECISION,
    "progreso" INTEGER NOT NULL DEFAULT 0,
    "owner" TEXT,
    "equipo" TEXT[],
    "tags" TEXT[],
    "color" TEXT NOT NULL DEFAULT '#0ABFBC',
    "aiPlan" JSONB,
    "aiRisks" JSONB,
    "aiSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descripcion" TEXT,
    "columna" TEXT NOT NULL DEFAULT 'backlog',
    "prioridad" TEXT NOT NULL DEFAULT 'media',
    "asignado" TEXT,
    "puntos" INTEGER,
    "etiquetas" TEXT[],
    "fechaVence" TIMESTAMP(3),
    "estimacion" TEXT,
    "subtareas" JSONB,
    "dependencias" TEXT[],
    "aiNotas" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "bloqueadoPor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMilestone" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "descripcion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectComment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "autor" TEXT NOT NULL,
    "contenido" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'comentario',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "cargo" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'TIEMPO_COMPLETO',
    "salario" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estado" TEXT NOT NULL DEFAULT 'ACTIVO',
    "inicio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performance" TEXT,
    "skills" TEXT[],
    "vacaciones" INTEGER NOT NULL DEFAULT 15,
    "telefono" TEXT,
    "foto" TEXT,
    "nivelSalarial" TEXT,
    "reportaA" TEXT,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobPosition" (
    "id" TEXT NOT NULL,
    "cargo" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "prioridad" TEXT NOT NULL DEFAULT 'MEDIA',
    "estado" TEXT NOT NULL DEFAULT 'ABIERTA',
    "descripcion" TEXT,
    "requisitos" TEXT[],
    "salarioMin" DOUBLE PRECISION,
    "salarioMax" DOUBLE PRECISION,
    "ubicacion" TEXT NOT NULL DEFAULT 'Remoto/Ibagué',
    "aiBrief" JSONB,
    "aiQuestions" JSONB,
    "candidatos" INTEGER NOT NULL DEFAULT 0,
    "publicadaEn" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReview" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'trimestral',
    "score" TEXT,
    "metasAlcanzadas" DOUBLE PRECISION,
    "fortalezas" TEXT,
    "areasMejora" TEXT,
    "comentario" TEXT,
    "aiBorrador" TEXT,
    "revisorNombre" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PtoRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "desde" TIMESTAMP(3) NOT NULL,
    "hasta" TIMESTAMP(3) NOT NULL,
    "dias" INTEGER NOT NULL,
    "motivo" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "aprobadoPor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PtoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrPulse" (
    "id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "preguntas" JSONB NOT NULL,
    "respuestas" JSONB,
    "analisis" TEXT,
    "score" DOUBLE PRECISION,
    "temas" JSONB,
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrPulse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "plataforma" TEXT NOT NULL,
    "objetivo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "externalId" TEXT,
    "presupuestoTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "presupuestoDiario" DOUBLE PRECISION,
    "gastado" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impresiones" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversiones" INTEGER NOT NULL DEFAULT 0,
    "cpa" DOUBLE PRECISION,
    "ctr" DOUBLE PRECISION,
    "roas" DOUBLE PRECISION,
    "aiScore" INTEGER,
    "aiNotas" TEXT,
    "copy" JSONB,
    "targeting" JSONB,
    "creativos" JSONB,
    "metadata" JSONB,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "creadoPorIA" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdAutomation" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "plataforma" TEXT NOT NULL DEFAULT 'todas',
    "condicion" TEXT NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "accion" TEXT NOT NULL,
    "parametro" DOUBLE PRECISION,
    "disparos" INTEGER NOT NULL DEFAULT 0,
    "ultimoDisparo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdAutomationLog" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "campaignId" TEXT,
    "accionTomada" TEXT NOT NULL,
    "detalles" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdAutomationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pago" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "proveedorId" TEXT,
    "tipo" "TipoPago" NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "estado" "EstadoPago" NOT NULL DEFAULT 'PENDIENTE',
    "referencia" TEXT,
    "metodo" TEXT,
    "notas" TEXT,
    "procesadoPor" TEXT,
    "fechaPago" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderLocation" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "puntos" INTEGER NOT NULL DEFAULT 0,
    "nivel" TEXT NOT NULL DEFAULT 'bronce',
    "totalGanados" INTEGER NOT NULL DEFAULT 0,
    "totalCanjeados" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "puntos" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "descripcion" TEXT,
    "bookingId" TEXT,
    "cuponId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cupon" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'porcentaje',
    "valor" DOUBLE PRECISION NOT NULL,
    "descripcion" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "usos" INTEGER NOT NULL DEFAULT 0,
    "maxUsos" INTEGER,
    "montoMinimo" DOUBLE PRECISION,
    "expira" TIMESTAMP(3),
    "creadoPor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "tipo" TEXT NOT NULL,
    "categoria" TEXT NOT NULL DEFAULT 'operacional',
    "trigger" JSONB NOT NULL,
    "accion" JSONB NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'diario',
    "ejecuciones" INTEGER NOT NULL DEFAULT 0,
    "exitos" INTEGER NOT NULL DEFAULT 0,
    "errores" INTEGER NOT NULL DEFAULT 0,
    "afectados" INTEGER NOT NULL DEFAULT 0,
    "ultimaEjecucion" TIMESTAMP(3),
    "proximaEjecucion" TIMESTAMP(3),
    "creadoPorIA" BOOLEAN NOT NULL DEFAULT false,
    "aiRationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationLog" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'exitoso',
    "afectados" INTEGER NOT NULL DEFAULT 0,
    "detalles" JSONB,
    "error" TEXT,
    "duracionMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "accion" TEXT NOT NULL,
    "entidad" TEXT,
    "entidadId" TEXT,
    "valorAntes" JSONB,
    "valorDespues" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "exitoso" BOOLEAN NOT NULL DEFAULT false,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderUnavailability_providerId_fechaInicio_idx" ON "ProviderUnavailability"("providerId", "fechaInicio");

-- CreateIndex
CREATE INDEX "ProviderUnavailability_fechaInicio_fechaFin_idx" ON "ProviderUnavailability"("fechaInicio", "fechaFin");

-- CreateIndex
CREATE INDEX "Project_estado_prioridad_idx" ON "Project"("estado", "prioridad");

-- CreateIndex
CREATE INDEX "ProjectTask_projectId_columna_idx" ON "ProjectTask"("projectId", "columna");

-- CreateIndex
CREATE INDEX "ProjectTask_asignado_idx" ON "ProjectTask"("asignado");

-- CreateIndex
CREATE INDEX "ProjectMilestone_projectId_idx" ON "ProjectMilestone"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_email_key" ON "Employee"("email");

-- CreateIndex
CREATE INDEX "Employee_dept_estado_idx" ON "Employee"("dept", "estado");

-- CreateIndex
CREATE INDEX "PtoRequest_employeeId_estado_idx" ON "PtoRequest"("employeeId", "estado");

-- CreateIndex
CREATE INDEX "AdCampaign_plataforma_estado_idx" ON "AdCampaign"("plataforma", "estado");

-- CreateIndex
CREATE INDEX "AdCampaign_createdAt_idx" ON "AdCampaign"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Pago_bookingId_idx" ON "Pago"("bookingId");

-- CreateIndex
CREATE INDEX "Pago_tipo_estado_idx" ON "Pago"("tipo", "estado");

-- CreateIndex
CREATE INDEX "Pago_proveedorId_estado_idx" ON "Pago"("proveedorId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderLocation_providerId_key" ON "ProviderLocation"("providerId");

-- CreateIndex
CREATE INDEX "ProviderLocation_providerId_idx" ON "ProviderLocation"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_userId_key" ON "LoyaltyAccount"("userId");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_userId_idx" ON "LoyaltyAccount"("userId");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_nivel_idx" ON "LoyaltyAccount"("nivel");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_accountId_createdAt_idx" ON "LoyaltyTransaction"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Cupon_codigo_key" ON "Cupon"("codigo");

-- CreateIndex
CREATE INDEX "Cupon_codigo_idx" ON "Cupon"("codigo");

-- CreateIndex
CREATE INDEX "Cupon_activo_idx" ON "Cupon"("activo");

-- CreateIndex
CREATE INDEX "AutomationRule_activa_tipo_idx" ON "AutomationRule"("activa", "tipo");

-- CreateIndex
CREATE INDEX "AutomationRule_categoria_idx" ON "AutomationRule"("categoria");

-- CreateIndex
CREATE INDEX "AutomationLog_ruleId_createdAt_idx" ON "AutomationLog"("ruleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationLog_createdAt_idx" ON "AutomationLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_accion_createdAt_idx" ON "AuditLog"("accion", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_entidad_entidadId_idx" ON "AuditLog"("entidad", "entidadId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderUnavailability" ADD CONSTRAINT "ProviderUnavailability_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTask" ADD CONSTRAINT "ProjectTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMilestone" ADD CONSTRAINT "ProjectMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectComment" ADD CONSTRAINT "ProjectComment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtoRequest" ADD CONSTRAINT "PtoRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAutomationLog" ADD CONSTRAINT "AdAutomationLog_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "AdAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAutomationLog" ADD CONSTRAINT "AdAutomationLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "ProviderProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLocation" ADD CONSTRAINT "ProviderLocation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorito" ADD CONSTRAINT "Favorito_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorito" ADD CONSTRAINT "Favorito_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLog" ADD CONSTRAINT "AutomationLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Restaurar índice pgvector (no gestionado por Prisma schema)
CREATE INDEX IF NOT EXISTS idx_provider_embedding
  ON "ProviderProfile" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);
