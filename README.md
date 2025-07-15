# Fullstack Application

A modern fullstack web application built with React, Node.js, TypeScript, and containerized with Docker.

## 🚀 Features

- **Frontend**: React 19 with Vite, TypeScript, and Tailwind CSS
- **Backend**: Node.js with Express, TypeScript, and RESTful API
- **Database**: PostgreSQL with connection pooling
- **Caching**: Redis for session management and caching
- **Authentication**: JWT-based authentication system
- **Testing**: Comprehensive test suites with Jest and Vitest
- **CI/CD**: GitHub Actions for automated testing and deployment
- **Docker**: Full containerization with multi-stage builds
- **Code Quality**: ESLint, Prettier, and Husky pre-commit hooks

## 📋 Prerequisites

- Node.js 20+ and npm
- Docker and Docker Compose
- Git

## 🔧 Quick Start

### Development Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd fullstack-app
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   ```

4. **Start development servers**
   ```bash
   npm run dev
   ```

   This starts both frontend (http://localhost:3000) and backend (http://localhost:5000).

### Docker Development

1. **Start with Docker Compose**
   ```bash
   docker-compose up
   ```

   This starts all services including PostgreSQL and Redis.

## 📁 Project Structure

```
fullstack-app/
├── backend/                 # Node.js/Express API
│   ├── src/
│   │   ├── controllers/     # Route controllers
│   │   ├── middleware/      # Express middleware
│   │   ├── routes/          # API routes
│   │   ├── services/        # Business logic
│   │   ├── utils/           # Utility functions
│   │   └── index.ts         # Application entry point
│   ├── Dockerfile
│   └── package.json
├── frontend/                # React application
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── pages/           # Page components
│   │   ├── hooks/           # Custom hooks
│   │   ├── services/        # API services
│   │   ├── store/           # State management
│   │   └── utils/           # Utility functions
│   ├── Dockerfile
│   └── package.json
├── .github/                 # GitHub Actions workflows
├── docker/                  # Docker configuration
├── scripts/                 # Utility scripts
└── docker-compose.yml
```

## 🛠️ Development Commands

```bash
# Install dependencies for all projects
npm install

# Start development servers
npm run dev

# Run tests
npm test

# Run linting
npm run lint

# Format code
npm run format

# Build for production
npm run build

# Type checking
npm run typecheck
```

## 🔒 Environment Variables

### Backend (.env)
```bash
NODE_ENV=development
PORT=5000
JWT_SECRET=your-super-secret-jwt-key
DATABASE_URL=postgresql://user:password@localhost:5432/fullstack_db
REDIS_URL=redis://localhost:6379
```

### Frontend (.env)
```bash
VITE_API_URL=http://localhost:5000/api
```

## 🚀 Deployment

### Production Build

```bash
# Build both frontend and backend
npm run build

# Build Docker images
docker-compose -f docker-compose.prod.yml build

# Deploy to production
docker-compose -f docker-compose.prod.yml up -d
```

### CI/CD Pipeline

The project includes GitHub Actions workflows for:

- **Continuous Integration**: Automated testing, linting, and building
- **Security Scanning**: CodeQL analysis and dependency vulnerability checks
- **Docker Builds**: Automated Docker image building and pushing
- **Deployment**: Automated deployment to staging and production

Required GitHub Secrets:
- `DOCKER_USERNAME`: Docker Hub username
- `DOCKER_PASSWORD`: Docker Hub password/token
- `DATABASE_URL`: Production database URL
- `JWT_SECRET`: JWT signing secret

## 🧪 Testing

```bash
# Run all tests
npm test

# Run backend tests
npm run test:backend

# Run frontend tests  
npm run test:frontend

# Run tests with coverage
npm run test:coverage
```

## 📊 API Documentation

### Authentication Endpoints

- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login

### User Endpoints

- `GET /api/users/profile` - Get user profile (authenticated)
- `PUT /api/users/profile` - Update user profile (authenticated)

### Health Check

- `GET /health` - Application health status

## 🔧 Database Setup

### PostgreSQL

```sql
CREATE DATABASE fullstack_db;
CREATE USER user WITH PASSWORD 'password';
GRANT ALL PRIVILEGES ON DATABASE fullstack_db TO user;
```

### Redis

Redis is used for session storage and caching. No additional setup required.

## 🛡️ Security

- JWT authentication with secure token handling
- Password hashing with bcrypt
- CORS configuration
- Security headers with Helmet.js
- Input validation with express-validator
- Dependency vulnerability scanning
- Container security scanning

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Style

- Use TypeScript for type safety
- Follow ESLint and Prettier configurations
- Write tests for new features
- Update documentation as needed

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Troubleshooting

### Common Issues

1. **Port conflicts**: Change ports in environment variables
2. **Database connection**: Check PostgreSQL is running and credentials are correct
3. **Docker issues**: Ensure Docker Desktop is running
4. **Dependencies**: Clear node_modules and reinstall

### Support

For issues and questions:
- Create an issue on GitHub
- Check existing documentation
- Review logs for error details

## 🗺️ Roadmap

- [ ] Add database migrations
- [ ] Implement real-time features with WebSocket
- [ ] Add comprehensive logging
- [ ] Implement rate limiting
- [ ] Add API documentation with Swagger
- [ ] Set up monitoring and alerting