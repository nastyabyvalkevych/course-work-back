-- AlterTable
ALTER TABLE "Tender" ADD COLUMN "buyerEdrpou" TEXT, ADD COLUMN "buyerRegion" TEXT, ADD COLUMN "cpvDivision" TEXT;
CREATE INDEX "Tender_buyerEdrpou_idx" ON "Tender"("buyerEdrpou");
CREATE INDEX "Tender_cpvDivision_idx" ON "Tender"("cpvDivision");

-- CreateTable
CREATE TABLE "CompanyLink" (
    "id" SERIAL NOT NULL,
    "edrpouA" TEXT NOT NULL,
    "edrpouB" TEXT NOT NULL,
    "kinds" TEXT[],
    CONSTRAINT "CompanyLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CompanyLink_edrpouA_edrpouB_key" ON "CompanyLink"("edrpouA", "edrpouB");
CREATE INDEX "CompanyLink_edrpouA_idx" ON "CompanyLink"("edrpouA");
CREATE INDEX "CompanyLink_edrpouB_idx" ON "CompanyLink"("edrpouB");

CREATE TABLE "TightGroup" (
    "id" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "sharedTenders" INTEGER NOT NULL,
    "totalTenders" INTEGER NOT NULL,
    "wonAmount" DOUBLE PRECISION NOT NULL,
    "sanctioned" INTEGER NOT NULL,
    "sameDecision" INTEGER NOT NULL,
    "meanScore" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION NOT NULL,
    "regions" TEXT[],
    "topCpv" TEXT[],
    "firstShared" TIMESTAMP(3),
    "lastShared" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TightGroup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TightGroup_maxScore_idx" ON "TightGroup"("maxScore");
CREATE INDEX "TightGroup_wonAmount_idx" ON "TightGroup"("wonAmount");
CREATE INDEX "TightGroup_sanctioned_idx" ON "TightGroup"("sanctioned");

CREATE TABLE "TightGroupMember" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "score" DOUBLE PRECISION,
    "label" BOOLEAN NOT NULL DEFAULT false,
    "nTenders" INTEGER NOT NULL DEFAULT 0,
    "nWon" INTEGER NOT NULL DEFAULT 0,
    "wonAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "TightGroupMember_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TightGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TightGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TightGroupMember_groupId_edrpou_key" ON "TightGroupMember"("groupId", "edrpou");
CREATE INDEX "TightGroupMember_edrpou_idx" ON "TightGroupMember"("edrpou");
