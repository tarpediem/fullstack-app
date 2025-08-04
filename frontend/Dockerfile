# Multi-stage Dockerfile for Fullstack Frontend
# Base image with specific Node.js version for consistency
FROM node:20.11.1-alpine AS base

# Install security updates and required system dependencies
RUN apk update && apk upgrade && \
    apk add --no-cache \
        dumb-init \
        curl \
        ca-certificates && \
    rm -rf /var/cache/apk/*

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S reactjs -u 1001

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Development stage for local development with hot reload
FROM base AS development

# Install all dependencies including dev dependencies
RUN npm ci && npm cache clean --force

# Copy source code
COPY --chown=reactjs:nodejs . .

# Switch to non-root user
USER reactjs

# Expose port for Vite dev server
EXPOSE 5173

# Health check for development container
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5173 || exit 1

# Start development server with proper host binding
CMD ["dumb-init", "npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Build stage for production assets
FROM base AS builder

# Install all dependencies for building
RUN npm ci && npm cache clean --force

# Copy source code
COPY --chown=reactjs:nodejs . .

# Build the application
RUN npm run build

# Production stage with optimized nginx
FROM nginx:1.25-alpine AS production

# Install security updates
RUN apk update && apk upgrade && \
    apk add --no-cache curl && \
    rm -rf /var/cache/apk/*

# Create nginx user for consistency
RUN addgroup -g 101 -S nginx-app && \
    adduser -S nginx-app -u 101 -G nginx-app

# Copy built assets from builder stage
COPY --from=builder --chown=nginx-app:nginx-app /app/dist /usr/share/nginx/html

# Copy optimized nginx configuration
COPY nginx.prod.conf /etc/nginx/conf.d/default.conf

# Remove default nginx config
RUN rm -f /etc/nginx/conf.d/default.conf.orig

# Set proper permissions
RUN chown -R nginx-app:nginx-app /usr/share/nginx/html && \
    chown -R nginx-app:nginx-app /var/cache/nginx && \
    chown -R nginx-app:nginx-app /var/log/nginx && \
    chown -R nginx-app:nginx-app /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown -R nginx-app:nginx-app /var/run/nginx.pid

# Switch to non-root user
USER nginx-app

# Expose port
EXPOSE 8080

# Health check for production container
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]