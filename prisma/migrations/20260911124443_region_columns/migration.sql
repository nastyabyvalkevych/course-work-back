-- AlterTable
ALTER TABLE "CompanyRisk" ADD COLUMN     "region" TEXT;

-- AlterTable
ALTER TABLE "Participation" ADD COLUMN     "region" TEXT;

-- CreateIndex
CREATE INDEX "CompanyRisk_region_idx" ON "CompanyRisk"("region");
