-- Allow logout and emergency sign-out to invalidate issued owner JWTs.
-- Existing rows receive the safe default zero; existing tokens without this
-- claim become invalid once the migration and updated API are deployed.
ALTER TABLE "Admin" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
