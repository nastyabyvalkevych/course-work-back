-- CreateTable
CREATE TABLE "CompanyRisk" (
    "id" SERIAL NOT NULL,
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,
    "percentile" DOUBLE PRECISION NOT NULL,
    "label" BOOLEAN NOT NULL DEFAULT false,
    "firstDecision" TIMESTAMP(3),
    "group" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "nTenders" INTEGER NOT NULL DEFAULT 0,
    "nWon" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "degree" INTEGER NOT NULL DEFAULT 0,
    "features" JSONB NOT NULL,
    "contributions" JSONB NOT NULL,
    "topNeighbors" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyRisk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyRisk_edrpou_key" ON "CompanyRisk"("edrpou");

-- CreateIndex
CREATE INDEX "CompanyRisk_score_idx" ON "CompanyRisk"("score");

-- CreateIndex
CREATE INDEX "CompanyRisk_rank_idx" ON "CompanyRisk"("rank");

-- CreateIndex
CREATE INDEX "CompanyRisk_group_coverage_idx" ON "CompanyRisk"("group", "coverage");
