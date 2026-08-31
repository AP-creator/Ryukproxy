import { createProxyServer, resolvePort } from './server.js';

let port: number;
try {
  port = resolvePort(process.env.RYUKPROXY_PORT);
} catch (err) {
  console.error(`ryukproxy: ${(err as Error).message}`);
  process.exit(1);
}

const server = createProxyServer();

// Without this, a port conflict surfaces as an unhandled 'error' event and a
// stack trace. The launcher already falls back to an unproxied session when the
// proxy doesn't come up, so the job here is to say why, legibly, for anyone
// running the server directly.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `ryukproxy: port ${port} is already in use. ` +
        'Another Ryukproxy may already be running (check ~/.ryukproxy/ryukproxy.pid), ' +
        'or set RYUKPROXY_PORT to a free port.'
    );
  } else {
    console.error(`ryukproxy: failed to start: ${err.message}`);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Ryukproxy listening on http://127.0.0.1:${port}`);
});
