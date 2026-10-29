// Where Gemini API calls go. The API key is only ever sent to Google's host, or to a local test server.
export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

export function geminiBaseUrl(env = process.env) {
  const value = env.GEMINI_API_BASE_URL;
  if (!value) return GEMINI_HOST;
  if (value === GEMINI_HOST || /^http:\/\/127\.0\.0\.1:\d+$/.test(value)) return value;
  throw new Error('GEMINI_API_BASE_URL must be the Gemini API host or a local test server');
}
