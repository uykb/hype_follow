FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm ci
COPY dashboard/ ./dashboard/
RUN cd dashboard && npm run build

FROM node:20-alpine
WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built frontend from builder stage
COPY --from=frontend-builder /app/dashboard/dist ./dashboard/dist

# Copy backend source code
COPY src/ ./src/
COPY config/ ./config/

# Environment variables
ENV NODE_ENV=production
ENV MONITORING_PORT=49618
ENV REDIS_HOST=redis
ENV REDIS_PORT=6379

EXPOSE 49618

USER node

CMD ["node", "src/index.js"]
