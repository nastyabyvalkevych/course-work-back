-- Нормалізована модель, етап 2б (адитивний): позиції предмета закупівлі (TenderItem) з довідником
-- класифікатора ДК 021 (Cpv); складені зовнішні ключі (tenderId, lotId) -> Lot для ставок, перемог
-- і позицій (MATCH SIMPLE: для тендера без лотів lotId = NULL, і ключ не перевіряється).

-- CreateTable
CREATE TABLE "Cpv" (
    "code" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Cpv_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "TenderItem" (
    "tenderId" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "description" TEXT,
    "cpvCode" TEXT,
    "quantity" DECIMAL(18,3),
    "unit" TEXT,

    CONSTRAINT "TenderItem_pkey" PRIMARY KEY ("tenderId","itemId")
);

-- CreateIndex
CREATE INDEX "TenderItem_cpvCode_idx" ON "TenderItem"("cpvCode");

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_tenderId_lotId_fkey" FOREIGN KEY ("tenderId", "lotId") REFERENCES "Lot"("tenderId", "lotId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Award" ADD CONSTRAINT "Award_tenderId_lotId_fkey" FOREIGN KEY ("tenderId", "lotId") REFERENCES "Lot"("tenderId", "lotId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderItem" ADD CONSTRAINT "TenderItem_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderItem" ADD CONSTRAINT "TenderItem_tenderId_lotId_fkey" FOREIGN KEY ("tenderId", "lotId") REFERENCES "Lot"("tenderId", "lotId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderItem" ADD CONSTRAINT "TenderItem_cpvCode_fkey" FOREIGN KEY ("cpvCode") REFERENCES "Cpv"("code") ON DELETE SET NULL ON UPDATE CASCADE;

