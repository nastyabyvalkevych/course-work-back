import { PrismaClient } from '@prisma/client'
import fs from 'fs/promises'
import path from 'path'

const prisma = new PrismaClient()

const MAX_QUERIES = 30
const OUTPUT_PATH = path.resolve('generated-test-queries.json')

async function main() {
  const tenders = await prisma.tender.findMany({
    where: { title: { not: null } },
    orderBy: { id: 'desc' },
    take: 80,
  })

  const queries = []

  for (const tender of tenders) {
    if (queries.length >= MAX_QUERIES) {
      break
    }

    const topTerms = await prisma.tenderIndex.findMany({
      where: { tenderId: tender.id, fieldName: 'title' },
      orderBy: { termFrequency: 'desc' },
      take: 3,
    })

    if (topTerms.length < 2) {
      continue
    }

    const queryText = topTerms.map((term) => term.term).join(' ')
    const relevantTenderIds = new Set([tender.id])

    const firstCpv = tender.cpvCodes?.[0]
    if (firstCpv) {
      const related = await prisma.tender.findMany({
        where: { cpvCodes: { has: firstCpv } },
        select: { id: true },
        take: 5,
      })
      for (const item of related) {
        relevantTenderIds.add(item.id)
      }
    }

    queries.push({
      queryText,
      judgments: Array.from(relevantTenderIds).map((tenderId) => ({
        tenderId,
        relevanceScore: 2,
        source: 'auto',
      })),
    })
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    total: queries.length,
    queries,
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2))
  console.log(`Saved ${queries.length} queries to ${OUTPUT_PATH}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
