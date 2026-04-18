-- AlterTable
ALTER TABLE "ProviderProfile" ADD COLUMN     "cedulaNota" TEXT,
ADD COLUMN     "cedulaStatus" TEXT NOT NULL DEFAULT 'sin_enviar',
ADD COLUMN     "cedulaUrl" TEXT;
