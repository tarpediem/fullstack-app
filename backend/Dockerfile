# Multi-stage Dockerfile for Fullstack Backend API
# Base image with specific Node.js version for consistency
FROM node:20.11.1-alpine AS base

# Install security updates and required system dependencies
RUN apk update && apk upgrade && \
    apk add --no-cache \
        dumb-init \
        curl \
        ca-certificates \
        python3 \
        make \
        g++ && \
    rm -rf /var/cache/apk/*

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S backend -u 1001

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Development stage for local development
FROM base AS development

# Install all dependencies including dev dependencies
RUN npm ci && npm cache clean --force

# Copy source code
COPY --chown=backend:nodejs . .

# Create logs directory with proper permissions
RUN mkdir -p /app/logs && \
    chown -R backend:nodejs /app/logs

# Switch to non-root user
USER backend

# Expose port
EXPOSE 5000

# Health check for development container
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

# Start development server with proper process handling
CMD ["dumb-init", "npm", "run", "dev"]

# Build stage for production assets
FROM base AS builder

# Install all dependencies for building
RUN npm ci && npm cache clean --force

# Copy source code
COPY --chown=backend:nodejs . .

# Build the application
RUN npm run build

# Remove dev dependencies after build
RUN npm ci --only=production && npm cache clean --force

# Production stage
FROM node:20.11.1-alpine AS production

# Install security updates and runtime dependencies
RUN apk update && apk upgrade && \
    apk add --no-cache \
        dumb-init \
        curl \
        ca-certificates && \
    rm -rf /var/cache/apk/*

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S backend -u 1001

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder --chown=backend:nodejs /app/dist ./dist

# Create logs directory with proper permissions
RUN mkdir -p /app/logs && \
    chown -R backend:nodejs /app/logs

# Switch to non-root user
USER backend

# Expose port
EXPOSE 5000

# Health check for production container
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

# Start the application with proper process handling
CMD ["dumb-init", "node", "dist/index.js"]