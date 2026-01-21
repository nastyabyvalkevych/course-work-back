-- CreateTable
CREATE TABLE "Tender" (
    "id" SERIAL NOT NULL,
    "prozorroId" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "procuringEntity" TEXT,
    "cpvCodes" TEXT[],
    "valueAmount" DOUBLE PRECISION,
    "valueCurrency" TEXT,
    "status" TEXT,
    "datePublished" TIMESTAMP(3),
    "documentLength" INTEGER NOT NULL DEFAULT 0,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenderIndex" (
    "id" SERIAL NOT NULL,
    "tenderId" INTEGER NOT NULL,
    "term" TEXT NOT NULL,
    "termFrequency" INTEGER NOT NULL,
    "fieldName" TEXT NOT NULL,

    CONSTRAINT "TenderIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermStatistics" (
    "id" SERIAL NOT NULL,
    "term" TEXT NOT NULL,
    "documentFrequency" INTEGER NOT NULL,
    "idf" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TermStatistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionStats" (
    "id" SERIAL NOT NULL,
    "totalDocuments" INTEGER NOT NULL,
    "avgDocumentLength" DOUBLE PRECISION NOT NULL,
    "uniqueTerms" INTEGER NOT NULL,
    "avgTitleLength" DOUBLE PRECISION,
    "avgDescriptionLength" DOUBLE PRECISION,
    "avgCpvCodesLength" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestQuery" (
    "id" SERIAL NOT NULL,
    "queryText" TEXT NOT NULL,
    "category" TEXT,
    "difficulty" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelevanceJudgment" (
    "id" SERIAL NOT NULL,
    "queryId" INTEGER NOT NULL,
    "tenderId" INTEGER NOT NULL,
    "relevanceScore" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelevanceJudgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentResult" (
    "id" SERIAL NOT NULL,
    "experimentName" TEXT NOT NULL,
    "k1" DOUBLE PRECISION NOT NULL,
    "b" DOUBLE PRECISION NOT NULL,
    "fieldWeights" JSONB,
    "usesLemmatization" BOOLEAN NOT NULL,
    "usesMultifield" BOOLEAN NOT NULL,
    "precisionAt10" DOUBLE PRECISION NOT NULL,
    "recallAt10" DOUBLE PRECISION NOT NULL,
    "meanAvgPrecision" DOUBLE PRECISION NOT NULL,
    "numTestQueries" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tender_prozorroId_key" ON "Tender"("prozorroId");

-- CreateIndex
CREATE INDEX "TenderIndex_term_idx" ON "TenderIndex"("term");

-- CreateIndex
CREATE INDEX "TenderIndex_tenderId_idx" ON "TenderIndex"("tenderId");

-- CreateIndex
CREATE INDEX "TenderIndex_term_tenderId_idx" ON "TenderIndex"("term", "tenderId");

-- CreateIndex
CREATE UNIQUE INDEX "TermStatistics_term_key" ON "TermStatistics"("term");

-- CreateIndex
CREATE INDEX "RelevanceJudgment_queryId_idx" ON "RelevanceJudgment"("queryId");

-- CreateIndex
CREATE INDEX "RelevanceJudgment_tenderId_idx" ON "RelevanceJudgment"("tenderId");

-- AddForeignKey
ALTER TABLE "TenderIndex" ADD CONSTRAINT "TenderIndex_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelevanceJudgment" ADD CONSTRAINT "RelevanceJudgment_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "TestQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
