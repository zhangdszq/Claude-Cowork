import { Hono } from 'hono';

const health = new Hono();

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

health.get('/ready', (c) => {
  return c.json({
    ready: true,
    timestamp: new Date().toISOString(),
  });
});

export { health as healthRoutes };
