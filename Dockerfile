FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY tests ./tests
COPY .env.example ./
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push && node prisma/seed.js && node src/server.js"]
