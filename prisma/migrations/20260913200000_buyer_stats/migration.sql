CREATE TABLE "BuyerStats" (
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "region" TEXT,
    "tenders" INTEGER NOT NULL,
    "singleBidder" INTEGER NOT NULL,
    "twoBidder" INTEGER NOT NULL,
    "highRiskWins" INTEGER NOT NULL,
    "sanctionedWins" INTEGER NOT NULL,
    "wonTotal" DOUBLE PRECISION NOT NULL,
    "wonHighRisk" DOUBLE PRECISION NOT NULL,
    "repeatedPairs" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyerStats_pkey" PRIMARY KEY ("edrpou")
);
CREATE INDEX "BuyerStats_region_idx" ON "BuyerStats"("region");
CREATE INDEX "BuyerStats_tenders_idx" ON "BuyerStats"("tenders");
CREATE INDEX "BuyerStats_twoBidder_idx" ON "BuyerStats"("twoBidder");
