-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifToken" TEXT,
ADD COLUMN     "emailVerificado" BOOLEAN NOT NULL DEFAULT false;
