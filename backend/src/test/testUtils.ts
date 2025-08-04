import request from 'supertest';
import { Application } from 'express';

export interface TestUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export class TestHelper {
  private app: Application;

  constructor(app: Application) {
    this.app = app;
  }

  // Auth helpers
  async createTestUser(userData: Partial<TestUser> = {}): Promise<TestUser> {
    const defaultUser = {
      email: 'test@example.com',
      name: 'Test User',
      password: 'password123',
      role: 'user',
      ...userData,
    };

    const response = await request(this.app)
      .post('/api/auth/register')
      .send(defaultUser)
      .expect(201);

    return response.body.user;
  }

  async loginUser(email: string, password: string): Promise<AuthTokens> {
    const response = await request(this.app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);

    return {
      accessToken: response.body.accessToken,
      refreshToken: response.body.refreshToken,
    };
  }

  async createUserAndLogin(userData: Partial<TestUser> = {}): Promise<{
    user: TestUser;
    tokens: AuthTokens;
  }> {
    const user = await this.createTestUser(userData);
    const tokens = await this.loginUser(user.email, 'password123');
    return { user, tokens };
  }

  // API helpers
  get(url: string, token?: string) {
    const req = request(this.app).get(url);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  }

  post(url: string, data: any, token?: string) {
    const req = request(this.app).post(url).send(data);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  }

  put(url: string, data: any, token?: string) {
    const req = request(this.app).put(url).send(data);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  }

  patch(url: string, data: any, token?: string) {
    const req = request(this.app).patch(url).send(data);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  }

  delete(url: string, token?: string) {
    const req = request(this.app).delete(url);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  }

  // Database helpers
  async cleanDatabase(): Promise<void> {
    // Implementation depends on your database setup
    // This is a placeholder - implement based on your DB
    console.log('Cleaning test database...');
  }

  async seedDatabase(): Promise<void> {
    // Implementation depends on your database setup
    // This is a placeholder - implement based on your DB
    console.log('Seeding test database...');
  }

  // Utility methods
  generateMockUser(overrides: Partial<TestUser> = {}): TestUser {
    return {
      id: Math.random().toString(36).substr(2, 9),
      email: `test${Math.random().toString(36).substr(2, 5)}@example.com`,
      name: 'Test User',
      role: 'user',
      ...overrides,
    };
  }

  generateMockUsers(count: number): TestUser[] {
    return Array.from({ length: count }, (_, i) =>
      this.generateMockUser({ name: `Test User ${i + 1}` })
    );
  }

  // Assertion helpers
  expectValidationError(response: any, expectedErrors: string[]): void {
    expect(response.status).toBe(400);
    expect(response.body.errors).toBeDefined();
    expectedErrors.forEach(error => {
      expect(response.body.errors).toContain(error);
    });
  }

  expectUnauthorized(response: any): void {
    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/unauthorized|authentication/i);
  }

  expectForbidden(response: any): void {
    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/forbidden|permission/i);
  }

  expectNotFound(response: any): void {
    expect(response.status).toBe(404);
    expect(response.body.message).toMatch(/not found/i);
  }

  expectInternalServerError(response: any): void {
    expect(response.status).toBe(500);
    expect(response.body.message).toMatch(/internal server error/i);
  }

  // Time helpers
  wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Mock helpers
  mockConsole(): {
    log: jest.SpyInstance;
    warn: jest.SpyInstance;
    error: jest.SpyInstance;
  } {
    return {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
    };
  }

  restoreConsole(): void {
    jest.restoreAllMocks();
  }
}

// Export singleton instance
export const createTestHelper = (app: Application): TestHelper => {
  return new TestHelper(app);
};

// Common test data
export const testData = {
  validUser: {
    email: 'valid@example.com',
    name: 'Valid User',
    password: 'ValidPassword123!',
  },
  invalidEmails: [
    'invalid-email',
    '@example.com',
    'user@',
    'user..name@example.com',
  ],
  invalidPasswords: [
    'short',
    'nouppercaseorspecial',
    'NOLOWERCASEORSPECIAL',
    'NoSpecialChars123',
    '12345678',
  ],
};