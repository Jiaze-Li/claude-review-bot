// Only the first nonblank line is a command. Never trigger from a quotation,
// fenced example, Markdown list, or prose that happens to mention the bot.
// Up to three leading spaces are allowed; four spaces/a tab is Markdown code.
export function isReviewTrigger(body) {
  if (typeof body !== 'string') return false;
  const firstLine = body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
  return typeof firstLine === 'string'
    && /^ {0,3}@(claude|jiaze-claude-review-bot)[ \t]+review[ \t]*$/i.test(firstLine);
}
