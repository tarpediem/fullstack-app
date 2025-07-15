#!/bin/bash

# Development environment setup script
set -e

echo "🚀 Setting up fullstack development environment..."

# Check prerequisites
echo "📋 Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 20+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js version $NODE_VERSION is too old. Please install Node.js 20+ first."
    exit 1
fi

echo "✅ Node.js $(node -v) found"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ npm $(npm -v) found"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "⚠️ Docker is not installed. Docker setup will be skipped."
    SKIP_DOCKER=true
else
    echo "✅ Docker $(docker --version | cut -d' ' -f3 | tr -d ',') found"
fi

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    if ! docker compose version &> /dev/null; then
        echo "⚠️ Docker Compose is not installed. Docker setup will be skipped."
        SKIP_DOCKER=true
    else
        echo "✅ Docker Compose (plugin) found"
    fi
else
    echo "✅ Docker Compose $(docker-compose --version | cut -d' ' -f3 | tr -d ',') found"
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

echo "✅ Root dependencies installed"

# Setup environment files
echo ""
echo "🔧 Setting up environment files..."

if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created .env file"
else
    echo "⚠️ .env file already exists"
fi

if [ ! -f backend/.env ]; then
    cp backend/.env.example backend/.env
    echo "✅ Created backend/.env file"
else
    echo "⚠️ backend/.env file already exists"
fi

if [ ! -f frontend/.env ]; then
    cp frontend/.env.example frontend/.env
    echo "✅ Created frontend/.env file"
else
    echo "⚠️ frontend/.env file already exists"
fi

# Setup Git hooks
echo ""
echo "🪝 Setting up Git hooks..."
npm run prepare

echo "✅ Git hooks installed"

# Initialize Docker services
if [ "$SKIP_DOCKER" != true ]; then
    echo ""
    echo "🐳 Setting up Docker services..."
    
    read -p "Do you want to start Docker services now? (y/N): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Starting Docker services..."
        if command -v docker-compose &> /dev/null; then
            docker-compose up -d db redis
        else
            docker compose up -d db redis
        fi
        echo "✅ Database and Redis services started"
        
        # Wait for services to be ready
        echo "⏳ Waiting for services to be ready..."
        sleep 10
        
        echo "✅ Services should be ready"
    else
        echo "⚠️ Skipped Docker services startup"
        echo "💡 You can start them later with: docker-compose up -d"
    fi
fi

# Run initial checks
echo ""
echo "🧪 Running initial checks..."

echo "Checking TypeScript compilation..."
npm run typecheck 2>/dev/null && echo "✅ TypeScript compilation successful" || echo "⚠️ TypeScript compilation issues found"

echo "Checking code style..."
npm run lint 2>/dev/null && echo "✅ Linting passed" || echo "⚠️ Linting issues found"

# Success message
echo ""
echo "🎉 Development environment setup complete!"
echo ""
echo "📖 Next steps:"
echo "1. Review and update environment variables in .env files"
echo "2. Start development servers: npm run dev"
echo "3. Open http://localhost:3000 for frontend"
echo "4. Open http://localhost:5000 for backend API"
echo ""
echo "📚 Useful commands:"
echo "  npm run dev          - Start development servers"
echo "  npm test             - Run tests"
echo "  npm run build        - Build for production"
echo "  npm run lint         - Check code style"
echo "  npm run format       - Format code"
echo ""
echo "🐳 Docker commands:"
echo "  docker-compose up    - Start all services"
echo "  docker-compose down  - Stop all services"
echo ""
echo "Happy coding! 🚀"