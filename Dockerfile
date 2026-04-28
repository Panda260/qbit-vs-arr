# Build frontend
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Build backend
FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app/server

# Copy backend source
COPY server/package*.json ./
RUN npm ci --production
COPY server/ ./

# Copy built frontend
COPY --from=client-builder /app/client/dist /app/client/dist

# Expose port
EXPOSE 3000

# Set environment variables for data persistence
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

CMD ["node", "index.js"]
