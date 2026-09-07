-- CreateTable
CREATE TABLE "AmcuDecision" (
    "id" SERIAL NOT NULL,
    "decisionNumber" TEXT NOT NULL,
    "decisionDate" TIMESTAMP(3) NOT NULL,
    "body" TEXT,
    "edrpou" TEXT NOT NULL,
    "companyName" TEXT,
    "courtCaseNumber" TEXT,
    "courtName" TEXT,
    "courtDate" TIMESTAMP(3),
    "courtContent" TEXT,
    "reviewNumber" TEXT,
    "reviewDate" TIMESTAMP(3),
    "reviewContent" TEXT,
    "notes" TEXT,
    "registerVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmcuDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participation" (
    "id" SERIAL NOT NULL,
    "tenderId" INTEGER NOT NULL,
    "prozorroTenderId" TEXT NOT NULL,
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL,
    "lotId" TEXT,
    "bidAmount" DOUBLE PRECISION,
    "bidDate" TIMESTAMP(3),
    "bidStatus" TEXT,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "datePublished" TIMESTAMP(3),

    CONSTRAINT "Participation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenderSample" (
    "id" SERIAL NOT NULL,
    "tenderId" INTEGER NOT NULL,
    "sampleGroup" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "procurementMethodType" TEXT,
    "cpvDivision" TEXT,
    "bidsCount" INTEGER NOT NULL DEFAULT 0,
    "hasSanctioned" BOOLEAN NOT NULL DEFAULT false,
    "sanctionedEdrpous" TEXT[],
    "sampleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenderSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmcuDecision_edrpou_idx" ON "AmcuDecision"("edrpou");

-- CreateIndex
CREATE INDEX "AmcuDecision_decisionDate_idx" ON "AmcuDecision"("decisionDate");

-- CreateIndex
CREATE UNIQUE INDEX "AmcuDecision_registerVersion_decisionNumber_decisionDate_ed_key" ON "AmcuDecision"("registerVersion", "decisionNumber", "decisionDate", "edrpou", "courtName", "courtDate");

-- CreateIndex
CREATE INDEX "Participation_edrpou_idx" ON "Participation"("edrpou");

-- CreateIndex
CREATE INDEX "Participation_tenderId_idx" ON "Participation"("tenderId");

-- CreateIndex
CREATE INDEX "Participation_prozorroTenderId_idx" ON "Participation"("prozorroTenderId");

-- CreateIndex
CREATE INDEX "Participation_edrpou_datePublished_idx" ON "Participation"("edrpou", "datePublished");

-- CreateIndex
CREATE UNIQUE INDEX "TenderSample_tenderId_key" ON "TenderSample"("tenderId");

-- CreateIndex
CREATE INDEX "TenderSample_sampleGroup_idx" ON "TenderSample"("sampleGroup");

-- CreateIndex
CREATE INDEX "TenderSample_year_procurementMethodType_idx" ON "TenderSample"("year", "procurementMethodType");

-- AddForeignKey
ALTER TABLE "Participation" ADD CONSTRAINT "Participation_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderSample" ADD CONSTRAINT "TenderSample_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
