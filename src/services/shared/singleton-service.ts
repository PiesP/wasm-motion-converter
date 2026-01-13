/**
 * Singleton Service Helper
 *
 * Utility to reduce singleton boilerplate code across services.
 * Implements the Singleton pattern using a simple factory function.
 *
 * Before (boilerplate):
 * ```typescript
 * class MyService {
 *   private static instance: MyService | null = null;
 *
 *   static getInstance(): MyService {
 *     MyService.instance ??= new MyService();
 *     return MyService.instance;
 *   }
 *
 *   private constructor() {}
 * }
 * ```
 *
 * After (using createSingleton):
 * ```typescript
 * class MyService {
 *   // Constructor can be public or private
 *   constructor() {}
 * }
 *
 * export const myService = createSingleton(() => new MyService());
 * ```
 *
 * Benefits:
 * - Eliminates ~20 lines of boilerplate per service
 * - No class hierarchy required
 * - Type-safe
 * - Works with existing patterns
 */

// biome-ignore lint/suspicious/noExplicitAny: Generic singleton requires 'any' for type storage
const instances = new Map<string, any>();

/**
 * Create a singleton instance with automatic memoization
 *
 * @param name - Unique identifier for the singleton
 * @param factory - Function that creates the instance
 * @returns The singleton instance
 */
function createSingleton<T>(name: string, factory: () => T): T {
  if (!instances.has(name)) {
    instances.set(name, factory());
  }
  return instances.get(name) as T;
}

export { createSingleton };
