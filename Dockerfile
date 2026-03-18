FROM node:20-slim

WORKDIR /app

COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source
COPY src/ ./src/
COPY config/ ./config/
COPY dashboard/dist/ ./dashboard/dist/

# Copy and setup entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Environment variables
ENV NODE_ENV=production
ENV MONITORING_PORT=49618
ENV BINANCE_TESTNET=false

EXPOSE 49618

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]