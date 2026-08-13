const http = require('http');
const fs = require('fs');
const path = require('path');
const weather = require('./api/weather');
const flight = require('./api/flight');

const PORT = Number(process.env.PORT || 8001);
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}

function createApiResponse(res) {
  return {
    setHeader: (name, value) => res.setHeader(name, value),
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(body) {
      sendJson(res, res.statusCode || 200, body);
    }
  };
}

function createWarmupResponse(label) {
  return {
    statusCode: 200,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      console.log(`[${label}] warmup status ${this.statusCode}`);
      if(body && body.error) console.log(`[${label}] warmup error`, body.error);
    }
  };
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const filePath = path.resolve(ROOT, '.' + pathname);

  if(!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if(err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type});
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  console.log(`${req.method} ${requestUrl.href}`);

  if(requestUrl.pathname === '/api/weather') {
    await weather(req, createApiResponse(res));
    return;
  }

  if(requestUrl.pathname === '/api/flight') {
    await flight(req, createApiResponse(res));
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Local app running at http://localhost:${PORT}/`);
  flight({url: '/api/flight'}, createWarmupResponse('flight api')).catch(err => {
    console.error('[flight api] warmup failed', err);
  });
});
