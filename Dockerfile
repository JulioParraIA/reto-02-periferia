FROM oven/bun:1.4.2-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/server.ts"]
