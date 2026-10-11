-- Нормалізована модель, етап 1 (адитивний): Organization (+ контакти, довідник областей),
-- рішення АМКУ як Decision / DecisionParty / CourtEvent, PipelineRun для походження похідних
-- даних, номер тендера UA-… у Tender, посилання з Tender і Participation на Organization.
-- Наявні колонки й таблиці не змінюються: код, що їх читає, працює далі. Заповнення —
-- db/migration/02_fill_normalized.sql; перехід коду і вилучення копій — етап 2.
-- Єдина заміна: звичайний індекс TightGroupMember(edrpou) -> унікальний (групи не перетинаються).

-- DropIndex
DROP INDEX "TightGroupMember_edrpou_idx";

-- AlterTable
ALTER TABLE "BuyerStats" ADD COLUMN     "runId" INTEGER;

-- AlterTable
ALTER TABLE "CompanyLink" ADD COLUMN     "runId" INTEGER;

-- AlterTable
ALTER TABLE "CompanyRisk" ADD COLUMN     "runId" INTEGER;

-- AlterTable
ALTER TABLE "Participation" ADD COLUMN     "orgCode" TEXT;

-- AlterTable
ALTER TABLE "RiskBacktest" ADD COLUMN     "runId" INTEGER;

-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "buyerCode" TEXT,
ADD COLUMN     "tenderID" TEXT;

-- AlterTable
ALTER TABLE "TightGroup" ADD COLUMN     "runId" INTEGER;

-- CreateTable
CREATE TABLE "Region" (
    "name" TEXT NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Organization" (
    "code" TEXT NOT NULL,
    "idScheme" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "region" TEXT,
    "firstSeen" TIMESTAMP(3),
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "OrganizationContact" (
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "OrganizationContact_pkey" PRIMARY KEY ("code","kind","value")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "body" TEXT NOT NULL,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionParty" (
    "decisionId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "nameInRegister" TEXT,
    "firstSeenRegister" TEXT NOT NULL,
    "lastSeenRegister" TEXT NOT NULL,

    CONSTRAINT "DecisionParty_pkey" PRIMARY KEY ("decisionId","code")
);

-- CreateTable
CREATE TABLE "CourtEvent" (
    "id" SERIAL NOT NULL,
    "decisionId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "caseNumber" TEXT,
    "court" TEXT,
    "courtDate" TIMESTAMP(3),
    "content" TEXT,
    "reviewNumber" TEXT,
    "reviewDate" TIMESTAMP(3),
    "reviewContent" TEXT,
    "notes" TEXT,

    CONSTRAINT "CourtEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" SERIAL NOT NULL,
    "step" TEXT NOT NULL,
    "graphVersion" TEXT,
    "sampleVersion" TEXT,
    "modelVersion" TEXT,
    "gitCommit" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "notes" TEXT,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Organization_kind_idx" ON "Organization"("kind");

-- CreateIndex
CREATE INDEX "Organization_region_idx" ON "Organization"("region");

-- CreateIndex
CREATE INDEX "OrganizationContact_kind_value_idx" ON "OrganizationContact"("kind", "value");

-- CreateIndex
CREATE INDEX "Decision_date_idx" ON "Decision"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_number_date_body_key" ON "Decision"("number", "date", "body");

-- CreateIndex
CREATE INDEX "DecisionParty_code_idx" ON "DecisionParty"("code");

-- CreateIndex
CREATE INDEX "CourtEvent_decisionId_code_idx" ON "CourtEvent"("decisionId", "code");

-- CreateIndex
CREATE INDEX "Participation_orgCode_idx" ON "Participation"("orgCode");

-- CreateIndex
CREATE UNIQUE INDEX "Tender_tenderID_key" ON "Tender"("tenderID");

-- CreateIndex
CREATE INDEX "Tender_buyerCode_idx" ON "Tender"("buyerCode");

-- CreateIndex
CREATE UNIQUE INDEX "TightGroupMember_edrpou_key" ON "TightGroupMember"("edrpou");

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_buyerCode_fkey" FOREIGN KEY ("buyerCode") REFERENCES "Organization"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participation" ADD CONSTRAINT "Participation_orgCode_fkey" FOREIGN KEY ("orgCode") REFERENCES "Organization"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyRisk" ADD CONSTRAINT "CompanyRisk_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskBacktest" ADD CONSTRAINT "RiskBacktest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyLink" ADD CONSTRAINT "CompanyLink_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TightGroup" ADD CONSTRAINT "TightGroup_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerStats" ADD CONSTRAINT "BuyerStats_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_region_fkey" FOREIGN KEY ("region") REFERENCES "Region"("name") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationContact" ADD CONSTRAINT "OrganizationContact_code_fkey" FOREIGN KEY ("code") REFERENCES "Organization"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionParty" ADD CONSTRAINT "DecisionParty_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionParty" ADD CONSTRAINT "DecisionParty_code_fkey" FOREIGN KEY ("code") REFERENCES "Organization"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtEvent" ADD CONSTRAINT "CourtEvent_decisionId_code_fkey" FOREIGN KEY ("decisionId", "code") REFERENCES "DecisionParty"("decisionId", "code") ON DELETE CASCADE ON UPDATE CASCADE;

