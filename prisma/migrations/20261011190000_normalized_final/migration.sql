-- Нормалізована модель, етап 3 (кінцевий): перехід на нові таблиці завершено, копії й застарілі
-- таблиці вилучено. Застосовано до робочої бази 11.10.2026 однією транзакцією разом із
-- db/deploy.sql (psql -1), після резервної копії (evaluation/data/backup_20261011) і репетиції на
-- копії даних; позначено в Prisma як застосовану (migrate resolve --applied).
-- Написано вручну: генератор Prisma на перейменуваннях видаляє колонку й створює нову (втрата
-- даних), тут — RENAME. Дати переводяться в timestamptz при часовому поясі UTC: без переписування.
SET timezone = 'UTC';

-- 0. Подання й тригер, що залежать від змінюваних таблиць (deploy.sql створює нові версії)
DROP VIEW IF EXISTS public.v_cobidding_edges, public.v_amcu_same_decision_pairs, public.v_region_risk;
DROP TRIGGER IF EXISTS amcu_sync_company_risk ON public."AmcuDecision";
DROP FUNCTION IF EXISTS public.trg_amcu_sync_company_risk();

-- 1. Рядки похідних таблиць з кодами, що не є організаціями (заглушки): не пройшли б FK
DELETE FROM "CompanyRisk"      WHERE edrpou NOT IN (SELECT code FROM "Organization");
DELETE FROM "RiskBacktest"     WHERE edrpou NOT IN (SELECT code FROM "Organization");
DELETE FROM "TightGroupMember" WHERE edrpou NOT IN (SELECT code FROM "Organization");
DELETE FROM "BuyerStats"       WHERE edrpou NOT IN (SELECT code FROM "Organization");

-- 2. Рядки реєстру АМКУ: AmcuDecision -> AmcuRegisterRow
ALTER TABLE "AmcuDecision" RENAME TO "AmcuRegisterRow";
ALTER SEQUENCE "AmcuDecision_id_seq" RENAME TO "AmcuRegisterRow_id_seq";
ALTER TABLE "AmcuRegisterRow" RENAME CONSTRAINT "AmcuDecision_pkey" TO "AmcuRegisterRow_pkey";
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT indexname FROM pg_indexes WHERE tablename = 'AmcuRegisterRow' AND indexname <> 'AmcuRegisterRow_pkey' LOOP
    EXECUTE format('DROP INDEX %I', r.indexname);
  END LOOP;
END $$;
ALTER TABLE "AmcuRegisterRow"
  ALTER COLUMN "decisionDate" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "courtDate"    TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "reviewDate"   TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "createdAt"    TYPE TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "amcu_register_row_key" ON "AmcuRegisterRow"
  ("registerVersion", "decisionNumber", "decisionDate", body, edrpou, "courtName", "courtDate") NULLS NOT DISTINCT;
CREATE INDEX "AmcuRegisterRow_edrpou_idx" ON "AmcuRegisterRow"(edrpou);
CREATE INDEX "AmcuRegisterRow_registerVersion_idx" ON "AmcuRegisterRow"("registerVersion");

-- 3. Участь розділено на Bid / Award: стара таблиця більше не потрібна
DROP TABLE "Participation";
ALTER TABLE "Bid"   ADD COLUMN "schemeInCard" TEXT;
ALTER TABLE "Award" ADD COLUMN "schemeInCard" TEXT;
CREATE UNIQUE INDEX "bid_natural_key"   ON "Bid"("tenderId", "lotId", "codeInCard") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "award_natural_key" ON "Award"("tenderId", "lotId", "codeInCard") NULLS NOT DISTINCT;

-- 4. Tender: розділ CPV тепер з TenderItem. Дати Tender лишаються timestamp (UTC): зміна типу
--    на timestamptz переписує всю таблицю разом із 33 ГБ документів (перевірено 11.10.2026).
ALTER TABLE "Tender" DROP COLUMN "cpvDivision";

-- 5. Вибірка: ключ (тендер, версія), без копій атрибутів тендера
ALTER TABLE "TenderSample" DROP CONSTRAINT "TenderSample_pkey";
DROP INDEX IF EXISTS "TenderSample_tenderId_key";
DROP INDEX IF EXISTS "TenderSample_sampleGroup_idx";
ALTER TABLE "TenderSample" DROP COLUMN id, DROP COLUMN year, DROP COLUMN "procurementMethodType",
  DROP COLUMN "cpvDivision", DROP COLUMN "bidsCount", DROP COLUMN "hasSanctioned", DROP COLUMN "sanctionedEdrpous";
ALTER TABLE "TenderSample" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3);
ALTER TABLE "TenderSample" ADD CONSTRAINT "TenderSample_pkey" PRIMARY KEY ("tenderId", "sampleVersion");
CREATE INDEX "TenderSample_sampleVersion_sampleGroup_idx" ON "TenderSample"("sampleVersion", "sampleGroup");

-- 6. Оцінка ризику: ключ — код організації; лише результат моделі; winRate генерується
ALTER TABLE "CompanyRisk" DROP CONSTRAINT "CompanyRisk_pkey";
DROP INDEX IF EXISTS "CompanyRisk_edrpou_key";
ALTER TABLE "CompanyRisk" DROP COLUMN id, DROP COLUMN name, DROP COLUMN label, DROP COLUMN "firstDecision",
  DROP COLUMN "group", DROP COLUMN coverage, DROP COLUMN region, DROP COLUMN "winRate";
ALTER TABLE "CompanyRisk" RENAME COLUMN edrpou TO "orgCode";
ALTER TABLE "CompanyRisk" ADD CONSTRAINT "CompanyRisk_pkey" PRIMARY KEY ("orgCode");
ALTER TABLE "CompanyRisk" ADD COLUMN "winRate" DOUBLE PRECISION
  GENERATED ALWAYS AS (CASE WHEN "nTenders" > 0 THEN "nWon"::double precision / "nTenders" ELSE 0 END) STORED;
ALTER TABLE "CompanyRisk" ALTER COLUMN "computedAt" TYPE TIMESTAMPTZ(3);
ALTER TABLE "CompanyRisk" ADD CONSTRAINT "CompanyRisk_orgCode_fkey" FOREIGN KEY ("orgCode")
  REFERENCES "Organization"(code) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Ретроспективна оцінка: ключ (дата зрізу, код); рік — генерований з дати
UPDATE "RiskBacktest" SET "cutoffDate" = make_date("cutoffYear", 12, 31) WHERE "cutoffDate" IS NULL;
ALTER TABLE "RiskBacktest" DROP CONSTRAINT "RiskBacktest_pkey";
ALTER TABLE "RiskBacktest" DROP COLUMN id, DROP COLUMN name, DROP COLUMN "group", DROP COLUMN coverage,
  DROP COLUMN "firstDecision", DROP COLUMN "cutoffYear";
ALTER TABLE "RiskBacktest" RENAME COLUMN edrpou TO "orgCode";
ALTER TABLE "RiskBacktest" ALTER COLUMN "cutoffDate" TYPE DATE USING "cutoffDate"::date,
  ALTER COLUMN "cutoffDate" SET NOT NULL, ALTER COLUMN "computedAt" TYPE TIMESTAMPTZ(3);
ALTER TABLE "RiskBacktest" ADD COLUMN "cutoffYear" INTEGER
  GENERATED ALWAYS AS (extract(year FROM "cutoffDate")::int) STORED;
ALTER TABLE "RiskBacktest" ADD CONSTRAINT "RiskBacktest_pkey" PRIMARY KEY ("cutoffDate", "orgCode");
CREATE INDEX "RiskBacktest_cutoffYear_rank_idx"     ON "RiskBacktest"("cutoffYear", rank);
CREATE INDEX "RiskBacktest_cutoffYear_rankFull_idx" ON "RiskBacktest"("cutoffYear", "rankFull");
CREATE INDEX "RiskBacktest_cutoffYear_outcome_idx"  ON "RiskBacktest"("cutoffYear", outcome);
ALTER TABLE "RiskBacktest" ADD CONSTRAINT "RiskBacktest_orgCode_fkey" FOREIGN KEY ("orgCode")
  REFERENCES "Organization"(code) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 8. Спільні контакти: замість збереженої таблиці — матеріалізоване подання (views.sql)
DROP TABLE "CompanyLink";

-- 9. Тісні групи: член групи — за кодом (щонайбільше одна група); гроші — numeric
ALTER TABLE "TightGroup" ALTER COLUMN "wonAmount" TYPE DECIMAL(18,2) USING round("wonAmount"::numeric, 2),
  ALTER COLUMN "firstShared" TYPE TIMESTAMPTZ(3), ALTER COLUMN "lastShared" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "computedAt" TYPE TIMESTAMPTZ(3);
ALTER TABLE "TightGroupMember" DROP CONSTRAINT "TightGroupMember_pkey";
DROP INDEX IF EXISTS "TightGroupMember_groupId_edrpou_key";
DROP INDEX IF EXISTS "TightGroupMember_edrpou_key";
ALTER TABLE "TightGroupMember" DROP COLUMN id, DROP COLUMN name, DROP COLUMN score, DROP COLUMN label;
ALTER TABLE "TightGroupMember" RENAME COLUMN edrpou TO "orgCode";
ALTER TABLE "TightGroupMember" ALTER COLUMN "wonAmount" DROP DEFAULT,
  ALTER COLUMN "wonAmount" TYPE DECIMAL(18,2) USING round("wonAmount"::numeric, 2),
  ALTER COLUMN "wonAmount" SET DEFAULT 0;
ALTER TABLE "TightGroupMember" ADD CONSTRAINT "TightGroupMember_pkey" PRIMARY KEY ("orgCode");
CREATE INDEX "TightGroupMember_groupId_idx" ON "TightGroupMember"("groupId");
ALTER TABLE "TightGroupMember" ADD CONSTRAINT "TightGroupMember_orgCode_fkey" FOREIGN KEY ("orgCode")
  REFERENCES "Organization"(code) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10. Зведення замовника: ключ — код організації, без копій назви й області
DROP INDEX IF EXISTS "BuyerStats_region_idx";
ALTER TABLE "BuyerStats" DROP COLUMN name, DROP COLUMN region;
ALTER TABLE "BuyerStats" RENAME COLUMN edrpou TO "orgCode";
ALTER TABLE "BuyerStats" ALTER COLUMN "wonTotal" TYPE DECIMAL(18,2) USING round("wonTotal"::numeric, 2),
  ALTER COLUMN "wonHighRisk" TYPE DECIMAL(18,2) USING round("wonHighRisk"::numeric, 2),
  ALTER COLUMN "computedAt" TYPE TIMESTAMPTZ(3);
ALTER TABLE "BuyerStats" ADD CONSTRAINT "BuyerStats_orgCode_fkey" FOREIGN KEY ("orgCode")
  REFERENCES "Organization"(code) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 11. Дати з часовим поясом у таблицях, створених на етапах 1–2
ALTER TABLE "Organization" ALTER COLUMN "firstSeen" TYPE TIMESTAMPTZ(3), ALTER COLUMN "lastSeen" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3), ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3);
ALTER TABLE "Decision" ALTER COLUMN date TYPE TIMESTAMPTZ(3);
ALTER TABLE "CourtEvent" ALTER COLUMN "courtDate" TYPE TIMESTAMPTZ(3), ALTER COLUMN "reviewDate" TYPE TIMESTAMPTZ(3);
ALTER TABLE "PipelineRun" ALTER COLUMN "startedAt" TYPE TIMESTAMPTZ(3), ALTER COLUMN "finishedAt" TYPE TIMESTAMPTZ(3);
