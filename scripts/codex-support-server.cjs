const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const HOST = process.env.CODEX_SUPPORT_HOST || '172.17.0.1';
const PORT = Number(process.env.CODEX_SUPPORT_PORT || 3207);
const TIMEOUT_MS = Number(process.env.CODEX_SUPPORT_TIMEOUT_MS || 35000);
const MAX_MESSAGE_CHARS = 420;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function runCodex(message) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(os.tmpdir(), `tisa-codex-support-${randomUUID()}.txt`);
    const prompt = [
      'Responde como asistente de soporte de TISA, estudio de regulación corporal.',
      'Usa español mexicano, máximo 70 palabras, tono claro y cálido.',
      'Ayuda solo con agenda, clases, lugares, pagos, QR, boletos y dudas del estudio.',
      'No inventes políticas. Si el caso requiere revisión humana, pide nombre, correo de pago y referencia.',
      'No des consejo médico.',
      '',
      `Pregunta del usuario: ${message}`,
    ].join('\n');

    const child = spawn(
      'codex',
      ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', outputFile, prompt],
      {
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      },
    );

    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex timed out'));
    }, TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const reply = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').trim() : '';
        fs.rmSync(outputFile, { force: true });
        if (code !== 0 || !reply) {
          reject(new Error(stderr.trim() || `Codex exited with ${code}`));
          return;
        }
        resolve(reply);
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, service: 'tisa-codex-support' });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/chat') {
    json(res, 404, { error: 'Not found' });
    return;
  }

  try {
    const payload = await readJson(req);
    const message = String(payload.message || '').trim().slice(0, MAX_MESSAGE_CHARS);
    if (!message) {
      json(res, 400, { error: 'Missing message' });
      return;
    }
    const reply = await runCodex(message);
    json(res, 200, { reply, poweredBy: 'codex' });
  } catch (error) {
    console.error('[codex-support]', error.message);
    json(res, 503, { error: 'Codex support unavailable' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`tisa-codex-support listening on http://${HOST}:${PORT}`);
});
