# Contributing Guide

Thank you for your interest in contributing to this fullstack application! This guide will help you get started.

## 🚀 Getting Started

### Prerequisites

- Node.js 20+ and npm
- Docker and Docker Compose
- Git
- Basic knowledge of TypeScript, React, and Node.js

### Development Setup

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Copy environment files: `cp .env.example .env`
4. Start development: `npm run dev`

## 📋 Development Workflow

### Branch Strategy

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - New features
- `bugfix/*` - Bug fixes
- `hotfix/*` - Critical production fixes

### Making Changes

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clean, readable code
   - Follow existing code style
   - Add tests for new functionality
   - Update documentation if needed

3. **Test your changes**
   ```bash
   npm test
   npm run lint
   npm run typecheck
   ```

4. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add amazing new feature"
   ```

5. **Push and create PR**
   ```bash
   git push origin feature/your-feature-name
   ```

## 📝 Code Style Guide

### TypeScript

- Use TypeScript for all new code
- Define proper interfaces and types
- Avoid `any` type when possible
- Use strict mode settings

### React

- Use functional components with hooks
- Follow React best practices
- Use proper component naming (PascalCase)
- Implement proper error boundaries

### Node.js

- Use async/await for asynchronous operations
- Implement proper error handling
- Follow RESTful API conventions
- Use middleware for common functionality

### Naming Conventions

- **Files**: kebab-case (`user-service.ts`)
- **Components**: PascalCase (`UserProfile.tsx`)
- **Functions**: camelCase (`getUserData`)
- **Constants**: UPPER_SNAKE_CASE (`API_BASE_URL`)

### Code Organization

```typescript
// Import order:
// 1. Node modules
// 2. Internal modules (absolute paths)
// 3. Relative imports

import express from 'express';
import { Router } from 'express';

import { userService } from '@/services/user.service';
import { authMiddleware } from '@/middleware/auth';

import { validateRequest } from './validation';
```

## 🧪 Testing Guidelines

### Backend Testing

- Unit tests for services and utilities
- Integration tests for API endpoints
- Use Jest and Supertest
- Aim for 80%+ code coverage

```typescript
describe('User Service', () => {
  it('should create a new user', async () => {
    const userData = { email: 'test@example.com', name: 'Test User' };
    const user = await userService.create(userData);
    
    expect(user).toBeDefined();
    expect(user.email).toBe(userData.email);
  });
});
```

### Frontend Testing

- Component tests with React Testing Library
- Hook tests for custom hooks
- Integration tests for user flows
- Use Vitest for testing

```typescript
import { render, screen } from '@testing-library/react';
import { UserProfile } from './UserProfile';

test('renders user profile', () => {
  render(<UserProfile user={{ name: 'John Doe' }} />);
  expect(screen.getByText('John Doe')).toBeInTheDocument();
});
```

## 📚 Documentation

### Code Documentation

- Use JSDoc for function documentation
- Add inline comments for complex logic
- Update README for new features
- Document API endpoints

```typescript
/**
 * Creates a new user account
 * @param userData - User registration data
 * @returns Promise<User> - Created user object
 * @throws {ValidationError} - When user data is invalid
 */
async function createUser(userData: CreateUserInput): Promise<User> {
  // Implementation
}
```

### API Documentation

- Document all endpoints
- Include request/response examples
- Specify authentication requirements
- Note any rate limits or restrictions

## 🚦 Pull Request Guidelines

### Before Submitting

- [ ] All tests pass
- [ ] Code is linted and formatted
- [ ] TypeScript compiles without errors
- [ ] Documentation is updated
- [ ] Branch is up to date with main

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No new warnings introduced
```

### Review Process

1. Automated checks must pass
2. At least one approval required
3. All conversations resolved
4. Branch up to date with main

## 🐛 Bug Reports

### Before Reporting

- Check existing issues
- Reproduce the bug
- Gather relevant information

### Bug Report Template

```markdown
**Describe the bug**
Clear description of the issue

**To Reproduce**
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Expected behavior**
What you expected to happen

**Screenshots**
If applicable, add screenshots

**Environment:**
- OS: [e.g. iOS]
- Browser [e.g. chrome, safari]
- Version [e.g. 22]
```

## ✨ Feature Requests

### Before Requesting

- Check if feature already exists
- Review existing feature requests
- Consider implementation complexity

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
Clear description of the problem

**Describe the solution you'd like**
Clear description of desired feature

**Describe alternatives you've considered**
Other solutions you've considered

**Additional context**
Any other context or screenshots
```

## 🔄 Release Process

### Versioning

We follow [Semantic Versioning](https://semver.org/):
- MAJOR: Breaking changes
- MINOR: New features (backward compatible)
- PATCH: Bug fixes (backward compatible)

### Release Steps

1. Update version numbers
2. Update CHANGELOG.md
3. Create release tag
4. Deploy to staging
5. Deploy to production

## 🤝 Community Guidelines

### Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Help others learn and grow
- Follow GitHub's community guidelines

### Getting Help

- Check documentation first
- Search existing issues
- Ask questions in discussions
- Be specific and provide context

## 🏆 Recognition

Contributors will be recognized in:
- Repository contributors list
- Release notes for significant contributions
- Annual contributor highlights

Thank you for contributing to our project! 🎉