-- Нормалізована модель, етап 2 (адитивний): Участь розділено на Ставку (Bid) і Перемогу (Award),
-- обидві посилаються на Лот (Lot, з власною очікуваною вартістю) і Organization; склад дослідження
-- (StudyCompany) перенесено з SQLite збирача; тип процедури — атрибут Tender. Суми — numeric,
-- дати — timestamptz. Participation лишається до переходу коду (етап 3).

-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "procurementMethodType" TEXT;

-- CreateTable
CREATE TABLE "Lot" (
    "tenderId" INTEGER NOT NULL,
    "lotId" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT,
    "valueAmount" DECIMAL(18,2),
    "valueCurrency" TEXT,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("tenderId","lotId")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" SERIAL NOT NULL,
    "tenderId" INTEGER NOT NULL,
    "lotId" TEXT,
    "codeInCard" TEXT NOT NULL,
    "orgCode" TEXT,
    "nameInCard" TEXT,
    "regionInCard" TEXT,
    "amount" DECIMAL(18,2),
    "bidDate" TIMESTAMPTZ(3),
    "status" TEXT,
    "datePublished" TIMESTAMPTZ(3),

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Award" (
    "id" SERIAL NOT NULL,
    "tenderId" INTEGER NOT NULL,
    "lotId" TEXT,
    "codeInCard" TEXT NOT NULL,
    "orgCode" TEXT,
    "nameInCard" TEXT,
    "regionInCard" TEXT,
    "amount" DECIMAL(18,2),
    "awardDate" TIMESTAMPTZ(3),
    "datePublished" TIMESTAMPTZ(3),

    CONSTRAINT "Award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyCompany" (
    "code" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tendersFound" INTEGER NOT NULL DEFAULT 0,
    "collectedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StudyCompany_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "Bid_tenderId_orgCode_idx" ON "Bid"("tenderId", "orgCode");

-- CreateIndex
CREATE INDEX "Bid_orgCode_datePublished_idx" ON "Bid"("orgCode", "datePublished");

-- CreateIndex
CREATE INDEX "Award_tenderId_orgCode_idx" ON "Award"("tenderId", "orgCode");

-- CreateIndex
CREATE INDEX "Award_orgCode_datePublished_idx" ON "Award"("orgCode", "datePublished");

-- CreateIndex
CREATE INDEX "StudyCompany_cohort_coverage_idx" ON "StudyCompany"("cohort", "coverage");

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_orgCode_fkey" FOREIGN KEY ("orgCode") REFERENCES "Organization"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Award" ADD CONSTRAINT "Award_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Award" ADD CONSTRAINT "Award_orgCode_fkey" FOREIGN KEY ("orgCode") REFERENCES "Organization"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyCompany" ADD CONSTRAINT "StudyCompany_code_fkey" FOREIGN KEY ("code") REFERENCES "Organization"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

