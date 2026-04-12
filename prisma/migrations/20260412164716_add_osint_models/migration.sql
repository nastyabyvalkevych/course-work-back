-- CreateTable
CREATE TABLE "OsintReport" (
    "id" SERIAL NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "numTenders" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "singleBidderCount" INTEGER NOT NULL,
    "singleBidderRatio" DOUBLE PRECISION NOT NULL,
    "multiBidderCount" INTEGER NOT NULL,
    "topSingleBidderEntities" JSONB NOT NULL,
    "coParticipationPairs" JSONB NOT NULL,
    "winRateAnomalies" JSONB NOT NULL,
    "regionalDominance" JSONB NOT NULL,
    "hhiPerCpv" JSONB NOT NULL,
    "bidRotationCohorts" JSONB NOT NULL,

    CONSTRAINT "OsintReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOsintStats" (
    "id" SERIAL NOT NULL,
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "totalBids" INTEGER NOT NULL DEFAULT 0,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "topPartners" JSONB,
    "regionsActive" TEXT[],
    "dominantRegion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierOsintStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcuringEntityOsintStats" (
    "id" SERIAL NOT NULL,
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "region" TEXT,
    "totalTenders" INTEGER NOT NULL DEFAULT 0,
    "singleBidderTenders" INTEGER NOT NULL DEFAULT 0,
    "singleBidderRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcuringEntityOsintStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OsintReport_generatedAt_idx" ON "OsintReport"("generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOsintStats_edrpou_key" ON "SupplierOsintStats"("edrpou");

-- CreateIndex
CREATE INDEX "SupplierOsintStats_winRate_idx" ON "SupplierOsintStats"("winRate");

-- CreateIndex
CREATE INDEX "SupplierOsintStats_totalWins_idx" ON "SupplierOsintStats"("totalWins");

-- CreateIndex
CREATE UNIQUE INDEX "ProcuringEntityOsintStats_edrpou_key" ON "ProcuringEntityOsintStats"("edrpou");

-- CreateIndex
CREATE INDEX "ProcuringEntityOsintStats_singleBidderRatio_idx" ON "ProcuringEntityOsintStats"("singleBidderRatio");

-- CreateIndex
CREATE INDEX "ProcuringEntityOsintStats_singleBidderTenders_idx" ON "ProcuringEntityOsintStats"("singleBidderTenders");
