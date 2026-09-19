FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
# --ignore-scripts skips the playwright chromium postinstall (not needed for the bot)
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

ENV NODE_ENV=production

CMD ["bun", "run", "src/telegram/index.ts"]
