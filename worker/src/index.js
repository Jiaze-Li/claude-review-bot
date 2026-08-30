const encoder = new TextEncoder();
const decoder = new TextDecoder();
const API_VERSION = '2022-11-28';
const MAX_WEBHOOK_BYTES = 1024 * 1024;

export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return json({ ok: true, service: 'claude-review-bot webhook' });
    }

    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const signature = request.headers.get('x-hub-signature-256');
    if (!signature || !env.GITHUB_WEBHOOK_SECRET) return new Response('Missing webhook signature', { status: 401 });

    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        return new Response('Invalid Content-Length', { status: 400 });
      }
      if (contentLength > MAX_WEBHOOK_BYTES) {
        return new Response('Webhook payload too large', { status: 413 });
      }
    }

    let bodyBytes;
    try {
      bodyBytes = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return new Response('Webhook payload too large', { status: 413 });
      }
      throw error;
    }

    const validSignature = await verifyWebhook(bodyBytes, signature, env.GITHUB_WEBHOOK_SECRET);
    if (!validSignature) return new Response('Invalid webhook signature', { status: 401 });

    const event = request.headers.get('x-github-event');
    if (event !== 'issue_comment') return json({ ignored: true, reason: 'not issue_comment' });

    let payload;
    try {
      payload = JSON.parse(decoder.decode(bodyBytes));
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (payload.action !== 'created') return json({ ignored: true, reason: 'not a created comment' });
    if (!payload.issue?.pull_request) return json({ ignored: true, reason: 'comment is not on a pull request' });
    if (String(payload.comment?.body ?? '') !== '@claude review') {
      return json({ ignored: true, reason: 'not exact @claude review' });
    }

    const installationId = payload.installation?.id;
    const targetRepo = payload.repository?.full_name;
    const prNumber = payload.issue?.number;
    const triggerUser = payload.comment?.user?.login;
    const commentId = payload.comment?.id;

    if (!installationId || !targetRepo || !prNumber || !triggerUser || !commentId) {
      return new Response('Webhook payload missing required GitHub App fields', { status: 400 });
    }

    const appId = requireEnv(env, 'GITHUB_APP_ID');
    const privateKey = requireEnv(env, 'GITHUB_PRIVATE_KEY');
    const appJwt = await createAppJwt(appId, privateKey);

    const targetToken = await createInstallationToken(installationId, appJwt);

    const permission = await githubApi(`/repos/${targetRepo}/collaborators/${encodeURIComponent(triggerUser)}/permission`, {
      token: targetToken,
    });

    if (!['admin', 'write'].includes(permission.permission)) {
      return json({ ignored: true, reason: `trigger user has ${permission.permission ?? 'no'} write permission` });
    }

    const pr = await githubApi(`/repos/${targetRepo}/pulls/${prNumber}`, { token: targetToken });
    if (pr.state !== 'open') return json({ ignored: true, reason: 'pull request is not open' });

    // Fast path for normal GitHub redeliveries: if this source comment already
    // produced a review, acknowledge the webhook without dispatching another run.
    // The central workflow repeats this check under concurrency to close the race
    // between two near-simultaneous redeliveries.
    if (await hasPublishedReviewForComment(targetRepo, prNumber, commentId, targetToken)) {
      return json({ ignored: true, reason: 'source comment already reviewed' });
    }

    const controlRepo = env.CONTROL_REPO || 'Jiaze-Li/claude-review-bot';
    const controlWorkflow = env.CONTROL_WORKFLOW || 'review.yml';
    const controlRef = env.CONTROL_REF || 'main';

    const controlInstallation = await githubApi(`/repos/${controlRepo}/installation`, { token: appJwt });
    if (!controlInstallation?.id) {
      throw new Error(`GitHub App is not installed on control repository ${controlRepo}`);
    }

    const controlToken = Number(controlInstallation.id) === Number(installationId)
      ? targetToken
      : await createInstallationToken(controlInstallation.id, appJwt);

    await githubApi(`/repos/${controlRepo}/actions/workflows/${encodeURIComponent(controlWorkflow)}/dispatches`, {
      method: 'POST',
      token: controlToken,
      body: {
        ref: controlRef,
        inputs: {
          target_repo: targetRepo,
          pr_number: String(prNumber),
          base_sha: pr.base.sha,
          head_sha: pr.head.sha,
          trigger_user: triggerUser,
          source_comment_id: String(commentId),
        },
      },
      expectNoContent: true,
    });

    return json({
      accepted: true,
      target: `${targetRepo}#${prNumber}`,
      head_sha: pr.head.sha,
    }, 202);
  },
};

class PayloadTooLargeError extends Error {}

async function readBodyLimited(request, limit) {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError(`Webhook payload exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requireEnv(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing Worker secret: ${key}`);
  return value;
}

async function createInstallationToken(installationId, appJwt) {
  const result = await githubApi(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    token: appJwt,
    body: {},
  });
  if (!result.token) throw new Error('GitHub did not return an installation token');
  return result.token;
}

async function hasPublishedReviewForComment(targetRepo, prNumber, commentId, token) {
  const marker = sourceCommentMarker(commentId);
  for (let page = 1; page <= 100; page += 1) {
    const reviews = await githubApi(`/repos/${targetRepo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`, { token });
    if (!Array.isArray(reviews)) throw new Error('GitHub pull request reviews response was not an array');
    if (reviews.some((review) => typeof review.body === 'string' && review.body.includes(marker))) return true;
    if (reviews.length < 100) return false;
  }
  throw new Error('Pull request review pagination exceeded safety limit');
}

function sourceCommentMarker(commentId) {
  return `<!-- claude-review-source-comment:${String(commentId)} -->`;
}

async function githubApi(path, { method = 'GET', token, body, expectNoContent = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'claude-review-bot',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (expectNoContent && response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function verifyWebhook(bodyBytes, signatureHeader, secret) {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const signature = hexToBytes(signatureHeader.slice(7));
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('HMAC', key, signature, bodyBytes);
}

async function createAppJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const unsigned = `${header}.${payload}`;
  const key = await importRsaPrivateKey(pem);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function importRsaPrivateKey(pem) {
  const normalized = pem.replace(/\\n/g, '\n').trim();
  let der;

  if (normalized.includes('-----BEGIN PRIVATE KEY-----')) {
    der = pemBody(normalized, 'PRIVATE KEY');
  } else if (normalized.includes('-----BEGIN RSA PRIVATE KEY-----')) {
    const pkcs1 = pemBody(normalized, 'RSA PRIVATE KEY');
    der = wrapPkcs1AsPkcs8(pkcs1);
  } else {
    throw new Error('Unsupported GitHub App private-key PEM format');
  }

  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function pemBody(pem, label) {
  const base64 = pem
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function wrapPkcs1AsPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const privateKeyOctetString = derElement(0x04, pkcs1);
  return derElement(0x30, concat(version, rsaAlgorithmIdentifier, privateKeyOctetString));
}

function derElement(tag, value) {
  return concat(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length) {
  if (length < 128) return new Uint8Array([length]);
  const bytes = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...arrays) {
  const length = arrays.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const item of arrays) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function base64UrlJson(value) {
  return base64UrlBytes(encoder.encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
