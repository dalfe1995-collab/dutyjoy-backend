-- Restore default for portfolioUrls (dropped in sync_missing_schema migration)
ALTER TABLE "ProviderProfile" ALTER COLUMN "portfolioUrls" SET DEFAULT '{}';
