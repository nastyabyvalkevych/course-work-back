-- CreateTable
CREATE TABLE "RiskBacktest" (
    "id" SERIAL NOT NULL,
    "cutoffYear" INTEGER NOT NULL,
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,
    "rankFull" INTEGER,
    "group" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "nTenders" INTEGER NOT NULL DEFAULT 0,
    "degree" INTEGER NOT NULL DEFAULT 0,
    "knownAtCutoff" BOOLEAN NOT NULL DEFAULT false,
    "firstDecision" TIMESTAMP(3),
    "outcome" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskBacktest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RiskBacktest_cutoffYear_edrpou_key" ON "RiskBacktest"("cutoffYear", "edrpou");
CREATE INDEX "RiskBacktest_cutoffYear_rank_idx" ON "RiskBacktest"("cutoffYear", "rank");
CREATE INDEX "RiskBacktest_cutoffYear_coverage_rankFull_idx" ON "RiskBacktest"("cutoffYear", "coverage", "rankFull");
CREATE INDEX "RiskBacktest_cutoffYear_outcome_idx" ON "RiskBacktest"("cutoffYear", "outcome");
