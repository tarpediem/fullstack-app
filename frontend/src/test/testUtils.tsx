import React, { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

// Mock data types
export interface MockUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export interface MockArticle {
  id: string;
  title: string;
  content: string;
  author: string;
  publishedAt: string;
  category: string;
}

// Test providers wrapper
interface AllTheProvidersProps {
  children: React.ReactNode;
}

const AllTheProviders: React.FC<AllTheProvidersProps> = ({ children }) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
};

// Custom render function
const customRender = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => {
  return {
    user: userEvent.setup(),
    ...render(ui, { wrapper: AllTheProviders, ...options }),
  };
};

// Re-export everything
export * from '@testing-library/react';
export { customRender as render };

// Custom hooks for testing
export const renderHook = <T extends (...args: any[]) => any>(
  hook: T,
  options?: {
    wrapper?: React.ComponentType<any>;
    initialProps?: Parameters<T>;
  }
) => {
  const { wrapper = AllTheProviders } = options || {};
  
  const TestComponent = (props: Parameters<T>[0]) => {
    const result = hook(props);
    return <div data-testid="hook-result">{JSON.stringify(result)}</div>;
  };

  return render(<TestComponent {...(options?.initialProps?.[0] || {})} />, {
    wrapper,
  });
};

// Mock factories
export const mockFactory = {
  user: (overrides: Partial<MockUser> = {}): MockUser => ({
    id: Math.random().toString(36).substr(2, 9),
    email: `user${Math.random().toString(36).substr(2, 5)}@example.com`,
    name: 'Test User',
    role: 'user',
    ...overrides,
  }),

  users: (count: number, overrides: Partial<MockUser> = {}): MockUser[] =>
    Array.from({ length: count }, (_, i) =>
      mockFactory.user({ name: `User ${i + 1}`, ...overrides })
    ),

  article: (overrides: Partial<MockArticle> = {}): MockArticle => ({
    id: Math.random().toString(36).substr(2, 9),
    title: 'Test Article',
    content: 'This is test article content.',
    author: 'Test Author',
    publishedAt: new Date().toISOString(),
    category: 'Technology',
    ...overrides,
  }),

  articles: (count: number, overrides: Partial<MockArticle> = {}): MockArticle[] =>
    Array.from({ length: count }, (_, i) =>
      mockFactory.article({ title: `Article ${i + 1}`, ...overrides })
    ),

  apiResponse: <T>(data: T, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
    redirected: false,
    type: 'basic' as ResponseType,
    url: 'http://localhost:3000/api/test',
    clone: vi.fn(),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
  }),

  apiError: (message: string, status = 400) => ({
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve({ message, errors: [message] }),
    text: () => Promise.resolve(JSON.stringify({ message, errors: [message] })),
    headers: new Headers(),
    redirected: false,
    type: 'basic' as ResponseType,
    url: 'http://localhost:3000/api/test',
    clone: vi.fn(),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
  }),
};

// Custom matchers and utilities
export const testUtils = {
  // Wait for element with timeout
  waitForElement: async (getElement: () => HTMLElement | null, timeout = 1000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const element = getElement();
      if (element) return element;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Element not found within timeout');
  },

  // Wait for condition
  waitForCondition: async (condition: () => boolean, timeout = 1000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Condition not met within timeout');
  },

  // Simulate network delay
  delay: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),

  // Mock localStorage
  mockLocalStorage: () => {
    const store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        Object.keys(store).forEach(key => delete store[key]);
      }),
      key: vi.fn((index: number) => Object.keys(store)[index] || null),
      length: Object.keys(store).length,
    };
  },

  // Mock sessionStorage
  mockSessionStorage: () => {
    const store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        Object.keys(store).forEach(key => delete store[key]);
      }),
      key: vi.fn((index: number) => Object.keys(store)[index] || null),
      length: Object.keys(store).length,
    };
  },

  // Create mock fetch responses
  mockFetch: (responses: Array<{ url?: string; response: any; status?: number }>) => {
    const mockFetch = vi.fn();
    
    responses.forEach(({ url, response, status = 200 }, index) => {
      const matcher = url ? (call: string) => call.includes(url) : () => index === 0;
      
      mockFetch.mockImplementation((input: string) => {
        if (matcher(input)) {
          return Promise.resolve(mockFactory.apiResponse(response, status));
        }
        return Promise.reject(new Error(`Unexpected fetch call: ${input}`));
      });
    });

    global.fetch = mockFetch;
    return mockFetch;
  },

  // Accessibility testing helpers
  expectToBeAccessible: async (container: HTMLElement) => {
    // Basic accessibility checks
    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    
    focusableElements.forEach(element => {
      // Check for accessible names
      const accessibleName = element.getAttribute('aria-label') || 
                            element.getAttribute('aria-labelledby') ||
                            (element as HTMLElement).innerText;
      
      if (!accessibleName) {
        console.warn('Element without accessible name:', element);
      }
    });
  },

  // Form testing helpers
  fillForm: async (user: ReturnType<typeof userEvent.setup>, formData: Record<string, string>) => {
    for (const [name, value] of Object.entries(formData)) {
      const input = document.querySelector(`[name="${name}"]`) as HTMLInputElement;
      if (input) {
        await user.clear(input);
        await user.type(input, value);
      }
    }
  },

  // Error boundary testing
  expectErrorBoundary: (container: HTMLElement, errorMessage?: string) => {
    const errorBoundary = container.querySelector('[data-testid="error-boundary"]');
    expect(errorBoundary).toBeInTheDocument();
    
    if (errorMessage) {
      expect(errorBoundary).toHaveTextContent(errorMessage);
    }
  },
};

// Test data constants
export const testData = {
  validUser: {
    email: 'test@example.com',
    name: 'Test User',
    password: 'Password123!',
  },
  
  invalidEmails: [
    'invalid-email',
    '@example.com',
    'user@',
    'user..name@example.com',
  ],
  
  validArticle: {
    title: 'Test Article Title',
    content: 'This is the content of the test article.',
    author: 'Test Author',
    category: 'Technology',
  },
  
  apiUrls: {
    login: '/api/auth/login',
    register: '/api/auth/register',
    profile: '/api/user/profile',
    articles: '/api/articles',
  },
};