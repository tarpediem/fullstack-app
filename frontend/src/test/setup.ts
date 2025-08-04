import '@testing-library/jest-dom';
import { expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Global test setup
beforeAll(() => {
  // Global setup before all tests
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Mock IntersectionObserver
  global.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));

  // Mock ResizeObserver  
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));

  // Mock fetch
  global.fetch = vi.fn();

  // Mock console methods in tests
  const consoleMethods = ['log', 'warn', 'error', 'info', 'debug'] as const;
  consoleMethods.forEach(method => {
    vi.spyOn(console, method).mockImplementation(() => {});
  });
});

afterAll(() => {
  // Global cleanup after all tests
  vi.restoreAllMocks();
});

// Clean up after each test case (e.g. clearing jsdom)
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Extended custom matchers
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () =>
          `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected ${received} to be within range ${floor} - ${ceiling}`,  
        pass: false,
      };
    }
  },
  toHaveBeenCalledWithMatch(received: any, expected: any) {
    const pass = received.mock.calls.some((call: any[]) =>
      call.some(arg => JSON.stringify(arg).includes(JSON.stringify(expected)))
    );
    if (pass) {
      return {
        message: () => `expected ${received} not to have been called with match ${expected}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to have been called with match ${expected}`,
        pass: false,
      };
    }
  },
});

// Global test utilities
global.testUtils = {
  // Mock React Router
  createMockRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    go: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    listen: vi.fn(),
    createPath: vi.fn(),
    createHref: vi.fn(),
  }),
  
  // Mock user object
  createMockUser: () => ({
    id: '1',
    email: 'test@example.com',
    name: 'Test User',
    role: 'user',
  }),

  // Wait for async operations
  waitFor: (callback: () => void, timeout = 1000) => {
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        try {
          callback();
          clearInterval(interval);
          resolve(true);
        } catch (error) {
          // Continue waiting
        }
      }, 10);

      setTimeout(() => {
        clearInterval(interval);
        reject(new Error('Timeout waiting for condition'));
      }, timeout);
    });
  },

  // Create mock API response
  createMockApiResponse: (data: any, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }),
};