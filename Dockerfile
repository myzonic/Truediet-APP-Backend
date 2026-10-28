FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy source files
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

# Copy compiled code and the SQL migrations. `tsc` does not copy .sql files,
# so the migrations have to come from the source tree. The server resolves
# the folder relative to its own module, so the working directory does not
# matter.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./src/db/migrations

# Run as a non-root user
RUN addgroup -S truediet && adduser -S truediet -G truediet && chown -R truediet:truediet /app
USER truediet

EXPOSE 3000

# The health check verifies that the database connection works AND that the
# expected tables exist, so an incomplete schema is reported as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
