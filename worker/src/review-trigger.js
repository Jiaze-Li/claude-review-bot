// Only the first nonblank line is a command. Never trigger from a quotation,
// fenced example, Markdown list, or prose that happens to mention the bot.
// Up to three leading spaces are allowed; four spaces/a tab is Markdown code.
export function parseReviewTrigger(body) {
  if (typeof body !== 'string') return null;
  const firstLine = body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
  if (typeof firstLine !== 'string') return null;

  if (/^ {0,3}@jiaze-claude-review-bot[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'auto' };
  }
  if (/^ {0,3}@jiaze-claude-review-bot[ \t]+claude[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'claude' };
  }
  if (/^ {0,3}@jiaze-claude-review-bot[ \t]+reset[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'reset' };
  }
  if (/^ {0,3}@claude[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'claude' };
  }
  return null;
}

export function isReviewTrigger(body) {
  return parseReviewTrigger(body) !== null;
}
