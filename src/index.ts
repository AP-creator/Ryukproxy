import { createProxyServer } from './server.js';

const port = Number(process.env.RYUKPROXY_PORT ?? 8931);
const server = createProxyServer();
server.listen(port, '127.0.0.1', () => {
  console.log(`Ryukproxy listening on http://127.0.0.1:${port}`);
});
