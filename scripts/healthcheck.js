#!/usr/bin/env node

const base = process.env.HEALTHCHECK_URL || 'http://localhost:3000';

async function run() {
  try {
    const res = await fetch(`${base}/health`);
    const body = await res.json();

    if (!res.ok || !body.ok) {
      console.error('Healthcheck failed:', { status: res.status, body });
      process.exit(1);
    }

    console.log('✅ Healthcheck OK', body);
    process.exit(0);
  } catch (err) {
    console.error('❌ Healthcheck error:', err.message);
    process.exit(1);
  }
}

run();
