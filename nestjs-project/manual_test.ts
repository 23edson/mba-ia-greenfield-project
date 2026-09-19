import * as fs from 'fs';

async function run() {
  const baseUrl = 'http://localhost:3000';
  const email = `manual_${Date.now()}@example.com`;
  
  console.log(`\n1. Registrando usuário ${email}...`);
  const registerRes = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' })
  });
  console.log(await registerRes.text());

  // We need the confirmation token. We can fetch it from the DB.
}
run();
