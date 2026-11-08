/**
 * Bot utility helpers.
 */

/**
 * Escape all MarkdownV2 special characters in a string for safe use
 * inside Telegram MarkdownV2 message text (not inside code/pre blocks).
 *
 * Characters that must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}
