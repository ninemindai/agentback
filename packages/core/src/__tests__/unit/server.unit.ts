// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {Server} from '../../index.js';

describe('Server interface', () => {
  describe('type checking', () => {
    it('accepts object with listening property and lifecycle methods', () => {
      const server: Server = {
        listening: false,
        async start() {},
        async stop() {},
      };

      expect(server.listening).toBe(false);
      expect(server.start).toBeInstanceOf(Function);
      expect(server.stop).toBeInstanceOf(Function);
    });

    it('accepts object with only start method', () => {
      const server: Server = {
        listening: false,
        async start() {},
      };

      expect(server.listening).toBe(false);
      expect(server.start).toBeInstanceOf(Function);
    });

    it('accepts object with only stop method', () => {
      const server: Server = {
        listening: false,
        async stop() {},
      };

      expect(server.listening).toBe(false);
      expect(server.stop).toBeInstanceOf(Function);
    });

    it('accepts object with init method', () => {
      const server: Server = {
        listening: false,
        async init() {},
      };

      expect(server.listening).toBe(false);
      expect(server.init).toBeInstanceOf(Function);
    });

    it('accepts object with all lifecycle methods', () => {
      const server: Server = {
        listening: false,
        async init() {},
        async start() {},
        async stop() {},
      };

      expect(server.listening).toBe(false);
      expect(server.init).toBeInstanceOf(Function);
      expect(server.start).toBeInstanceOf(Function);
      expect(server.stop).toBeInstanceOf(Function);
    });
  });

  describe('listening property', () => {
    it('is readonly', () => {
      const server: Server = {
        listening: false,
      };

      // TypeScript enforces readonly at compile time
      // At runtime, we can verify the property exists
      expect(server).toHaveProperty('listening');
    });

    it('can be true', () => {
      const server: Server = {
        listening: true,
      };

      expect(server.listening).toBe(true);
    });

    it('can be false', () => {
      const server: Server = {
        listening: false,
      };

      expect(server.listening).toBe(false);
    });
  });

  describe('lifecycle methods', () => {
    it('init can be synchronous', () => {
      const server: Server = {
        listening: false,
        init() {},
      };

      expect(server.init).toBeInstanceOf(Function);
    });

    it('init can be asynchronous', () => {
      const server: Server = {
        listening: false,
        async init() {},
      };

      expect(server.init).toBeInstanceOf(Function);
    });

    it('init can return Promise<void>', () => {
      const server: Server = {
        listening: false,
        init(): Promise<void> {
          return Promise.resolve();
        },
      };

      expect(server.init).toBeInstanceOf(Function);
    });

    it('start can be synchronous', () => {
      const server: Server = {
        listening: false,
        start() {},
      };

      expect(server.start).toBeInstanceOf(Function);
    });

    it('start can be asynchronous', () => {
      const server: Server = {
        listening: false,
        async start() {},
      };

      expect(server.start).toBeInstanceOf(Function);
    });

    it('start can return Promise<void>', () => {
      const server: Server = {
        listening: false,
        start(): Promise<void> {
          return Promise.resolve();
        },
      };

      expect(server.start).toBeInstanceOf(Function);
    });

    it('stop can be synchronous', () => {
      const server: Server = {
        listening: false,
        stop() {},
      };

      expect(server.stop).toBeInstanceOf(Function);
    });

    it('stop can be asynchronous', () => {
      const server: Server = {
        listening: false,
        async stop() {},
      };

      expect(server.stop).toBeInstanceOf(Function);
    });

    it('stop can return Promise<void>', () => {
      const server: Server = {
        listening: false,
        stop(): Promise<void> {
          return Promise.resolve();
        },
      };

      expect(server.stop).toBeInstanceOf(Function);
    });

    it('lifecycle methods can accept injected arguments', () => {
      const server: Server = {
        listening: false,
        init(...args: unknown[]) {},
        start(...args: unknown[]) {},
        stop(...args: unknown[]) {},
      };

      expect(server.init).toBeInstanceOf(Function);
      expect(server.start).toBeInstanceOf(Function);
      expect(server.stop).toBeInstanceOf(Function);
    });
  });

  describe('class implementation', () => {
    it('can be implemented by a class', () => {
      class MyServer implements Server {
        listening = false;

        async start() {
          this.listening = true;
        }

        async stop() {
          this.listening = false;
        }
      }

      const server = new MyServer();
      expect(server).toBeInstanceOf(MyServer);
      expect(server.listening).toBe(false);
    });

    it('class can have additional properties', () => {
      class MyServer implements Server {
        listening = false;
        port = 3000;
        host = 'localhost';

        async start() {
          this.listening = true;
        }

        async stop() {
          this.listening = false;
        }
      }

      const server = new MyServer();
      expect(server.port).toBe(3000);
      expect(server.host).toBe('localhost');
    });

    it('class can have additional methods', () => {
      class MyServer implements Server {
        listening = false;

        async start() {
          this.listening = true;
        }

        async stop() {
          this.listening = false;
        }

        getStatus() {
          return this.listening ? 'running' : 'stopped';
        }
      }

      const server = new MyServer();
      expect(server.getStatus()).toBe('stopped');
    });

    it('class can implement all lifecycle methods', () => {
      class MyServer implements Server {
        listening = false;
        initialized = false;

        async init() {
          this.initialized = true;
        }

        async start() {
          this.listening = true;
        }

        async stop() {
          this.listening = false;
        }
      }

      const server = new MyServer();
      expect(server.initialized).toBe(false);
      expect(server.listening).toBe(false);
    });
  });

  describe('functional behavior', () => {
    it('server can track listening state', async () => {
      class MyServer implements Server {
        listening = false;

        async start() {
          this.listening = true;
        }

        async stop() {
          this.listening = false;
        }
      }

      const server = new MyServer();
      expect(server.listening).toBe(false);

      await server.start();
      expect(server.listening).toBe(true);

      await server.stop();
      expect(server.listening).toBe(false);
    });

    it('server can perform initialization', async () => {
      const events: string[] = [];

      class MyServer implements Server {
        listening = false;

        async init() {
          events.push('init');
        }

        async start() {
          events.push('start');
          this.listening = true;
        }

        async stop() {
          events.push('stop');
          this.listening = false;
        }
      }

      const server = new MyServer();
      await server.init?.();
      await server.start();
      await server.stop();

      expect(events).toEqual(['init', 'start', 'stop']);
    });

    it('server can handle errors in lifecycle methods', async () => {
      class MyServer implements Server {
        listening = false;

        async start() {
          throw new Error('Start failed');
        }

        async stop() {
          this.listening = false;
        }
      }

      const server = new MyServer();
      await expect(server.start()).rejects.toThrow('Start failed');
    });

    it('server can manage resources', async () => {
      class MyServer implements Server {
        listening = false;
        private resources: string[] = [];

        async start() {
          this.resources.push('resource1');
          this.resources.push('resource2');
          this.listening = true;
        }

        async stop() {
          this.resources = [];
          this.listening = false;
        }

        getResourceCount() {
          return this.resources.length;
        }
      }

      const server = new MyServer();
      expect(server.getResourceCount()).toBe(0);

      await server.start();
      expect(server.getResourceCount()).toBe(2);

      await server.stop();
      expect(server.getResourceCount()).toBe(0);
    });
  });

  describe('integration scenarios', () => {
    it('multiple servers can coexist', async () => {
      class HttpServer implements Server {
        listening = false;
        async start() {
          this.listening = true;
        }
        async stop() {
          this.listening = false;
        }
      }

      class WebSocketServer implements Server {
        listening = false;
        async start() {
          this.listening = true;
        }
        async stop() {
          this.listening = false;
        }
      }

      const httpServer = new HttpServer();
      const wsServer = new WebSocketServer();

      await httpServer.start();
      await wsServer.start();

      expect(httpServer.listening).toBe(true);
      expect(wsServer.listening).toBe(true);

      await httpServer.stop();
      await wsServer.stop();

      expect(httpServer.listening).toBe(false);
      expect(wsServer.listening).toBe(false);
    });

    it('server can be started and stopped multiple times', async () => {
      class MyServer implements Server {
        listening = false;
        startCount = 0;
        stopCount = 0;

        async start() {
          this.startCount++;
          this.listening = true;
        }

        async stop() {
          this.stopCount++;
          this.listening = false;
        }
      }

      const server = new MyServer();

      await server.start();
      await server.stop();
      await server.start();
      await server.stop();

      expect(server.startCount).toBe(2);
      expect(server.stopCount).toBe(2);
    });
  });
});

// Made with Bob
