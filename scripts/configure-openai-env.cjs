const fs = require('fs');

const key = fs.readFileSync(0, 'utf8').trim();
if (!key) {
  throw new Error('Missing OPENAI_API_KEY on stdin.');
}

const file = '.env';
let env = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

function clean(value) {
  return String(value).replace(/\r?\n/g, '');
}

function upsert(name, value) {
  const line = `${name}=${clean(value)}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(env)) {
    env = env.replace(re, line);
  } else {
    env += `${env.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
}

upsert('OPENAI_API_KEY', key);
upsert('OPENAI_MODEL', 'gpt-5-mini');
fs.writeFileSync(file, env);
console.log('openai env configured');
