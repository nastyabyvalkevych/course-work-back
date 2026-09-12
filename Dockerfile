# Бекенд NestJS + Prisma. Збірка у два етапи: залежності й компіляція, потім легкий образ виконання.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist
EXPOSE 3012
# міграції застосовуються окремо: docker compose exec backend npx prisma migrate deploy
CMD ["node", "--enable-source-maps", "dist/main"]
